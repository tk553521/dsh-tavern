/**
 * Tavern view: the conversation-view entry the tavern plugin registers.
 * The chat area renders the ACTIVE play's DSH session (the director
 * session) directly from its client runtime snapshot, without switching the
 * global current session, and sends through that session's conversation
 * service; the library panels manage characters / world books / presets
 * through the host route.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { SessionFace, SessionSnapshot } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ChatSnapshot } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { IConversation } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { Play, PlaySummary, SwipeBranchSummary, TavernState, TavernStyle } from '../types.ts'
import { tavernApi, type TavernApi } from './api.ts'
import { createLatestRequest } from './latest-request.ts'
import { extractMessages } from './messages.ts'
import { commitThenRefresh, createComposerDrafts, createOperationLock, matchingSwipe, operationBlockReason, startRetryingPoll, type OperationAddress, type OperationState } from './stability.ts'
import type { createTavernStore } from './store.ts'
import { ChatPanel } from './components/ChatPanel.tsx'
import { CharacterPanel } from './components/CharacterPanel.tsx'
import { LorebookPanel } from './components/LorebookPanel.tsx'
import { PresetPanel } from './components/PresetPanel.tsx'
import { TauriTavernImportPanel } from './components/TauriTavernImportPanel.tsx'
import { Empty } from './components/common.tsx'
import css from './TavernView.module.css'

/**
 * One play session retained by the tavern view, with the live sources the
 * transcript and the composer read.
 *
 * The tavern shows a session that is not the shell's current one (a play may
 * be an archived session), so the view owns a Client reference to it for as
 * long as it displays it. Borrowing instead (`sessions.binding`/`scope`) only
 * resolves a generation somebody else retains and returns `undefined` for
 * every other session — which is exactly the case this view exists for.
 */
export interface TavernSessionHandle {
  /** Retained session face: identity plus lifecycle state (`running`, open state). */
  readonly session: SessionFace
  /** Scope-addressed conversation face used to send into and cancel this play. */
  readonly conversation: IConversation
  /**
   * Chat target of this session's Conversation assembly. Resolves to
   * `undefined` until a Chat view builder has produced a snapshot for the
   * session; subscribing is also what activates the target for a session the
   * Chat tab is not currently rendering.
   */
  readonly chat: ObservableSnapshot<ChatSnapshot | undefined>
  /** Settles when the shared initial open of this session succeeds or fails. */
  readonly ready: Promise<unknown>
  /** Drop this view's retained reference; safe to call once per handle. */
  release(): void
}

/** Business callbacks injected into the tavern view (session-scoped). */
export interface TavernViewInjected {
  /** Retain a play session and resolve its view sources without switching the global current session. */
  retainSession: (sessionId: string) => TavernSessionHandle
}

/** Full props: framework runtime share + store share + inject face. */
export type TavernViewProps =
  & ConvViewProps
  & PropsStore<ReturnType<typeof createTavernStore>>
  & TavernViewInjected

export { extractMessages } from './messages.ts'
export type { ViewMessage, ViewStatus } from './messages.ts'

/** Load the full tavern state snapshot. */
async function loadState(api: TavernApi): Promise<TavernState> {
  return api.state()
}

/** Subscribe to a retained session's lifecycle snapshot. */
function useSessionSnapshot(session: SessionFace | undefined): SessionSnapshot | undefined {
  return useSyncExternalStore(
    useCallback(
      (onStoreChange: () => void) => session?.subscribe(onStoreChange) ?? (() => {}),
      [session],
    ),
    useCallback(() => session?.getSnapshot(), [session]),
  )
}

/** Subscribe to a retained session's Chat target snapshot. */
function useChatSnapshot(source: ObservableSnapshot<ChatSnapshot | undefined> | undefined): ChatSnapshot | undefined {
  return useSyncExternalStore(
    useCallback(
      (onStoreChange: () => void) => source?.subscribe(onStoreChange) ?? (() => {}),
      [source],
    ),
    useCallback(() => source?.getSnapshot(), [source]),
  )
}

export function TavernView({
  useStore,
  actions,
  useSessions,
  retainSession,
}: TavernViewProps) {
  const panel = useStore(s => s.panel)
  const playId = useStore(s => s.playId)
  const selectedCharacterId = useStore(s => s.selectedCharacterId)
  const selectedLorebookId = useStore(s => s.selectedLorebookId)
  const selectedPresetId = useStore(s => s.selectedPresetId)
  const error = useStore(s => s.error)

  const [state, setState] = useState<TavernState | null>(null)
  const composerDrafts = useMemo(() => createComposerDrafts(), [])
  const operationLock = useMemo(() => createOperationLock(), [])
  const [loading, setLoading] = useState(true)
  const rootRef = useRef<HTMLDivElement | null>(null)
  // Style preference: optimistic local state, seeded from the server snapshot.
  const [style, setStyle] = useState<TavernStyle>('dsh')

  const refreshRequests = useMemo(() => createLatestRequest(
    () => loadState(tavernApi),
    next => { setState(next); setLoading(false) },
  ), [])
  const refresh = useCallback((): Promise<void> => refreshRequests.run(), [refreshRequests])

  useEffect(() => {
    void refresh().catch(e => {
      actions.setError(e instanceof Error ? e.message : String(e))
      setLoading(false)
    })
    return () => refreshRequests.invalidate()
  }, [refresh, refreshRequests, actions])

  // Adopt the persisted style once the state snapshot arrives.
  useEffect(() => {
    if (state?.style !== undefined) setStyle(state.style)
  }, [state?.style])

  const changeStyle = useCallback((next: TavernStyle): void => {
    setStyle(next)
    tavernApi.setStyle(next).catch(e => {
      actions.setError(e instanceof Error ? e.message : String(e))
    })
  }, [actions])

  const selectPlay = useCallback((id: string | null): void => {
    actions.setPlayId(id)
    actions.setPanel('chat')
    const playSummary = state?.plays.find(p => p.id === id)
    if (playSummary !== undefined) {
      // Ensure the director session exists (resume after restart). The view
      // binds directly to the play session instead of switching the global
      // current session, so archived tavern sessions stay on the tavern page.
      void tavernApi.activatePlay(playSummary.id).catch(e => {
        actions.setError(e instanceof Error ? e.message : String(e))
      })
    }
  }, [actions, state])

  const createPlay = useCallback(async (
    title: string,
    characterIds: string[],
    lorebookIds: string[],
    presetId: string | undefined,
    narratorEnabled: boolean,
    multiAgent: boolean,
  ): Promise<void> => {
    try {
      const created = await tavernApi.createPlay({ title, characterIds, lorebookIds, presetId, narratorEnabled, multiAgent })
      await refresh()
      actions.setPlayId(created.id)
      actions.setPanel('chat')
    } catch (e) {
      actions.setError(e instanceof Error ? e.message : String(e))
      throw e
    }
  }, [actions, refresh])

  const deletePlay = useCallback(async (id: string): Promise<void> => {
    try {
      await tavernApi.deletePlay(id)
      if (playId === id) actions.setPlayId(null)
      await refresh()
    } catch (e) {
      actions.setError(e instanceof Error ? e.message : String(e))
    }
  }, [actions, playId, refresh])

  const characterNames = useMemo(
    () => state?.characters.map(c => c.card.data.name) ?? [],
    [state],
  )

  const activePlay = playId !== null ? state?.plays.find(p => p.id === playId) ?? null : null
  const playSessionId = activePlay?.sessionId
  // Retain only an id the session list already knows: `sessions.retain` throws
  // for an uncatalogued id (a play whose activate/create round-trip is still in
  // flight), and the list arriving later re-runs the effect below.
  const playSessionKnown = useSessions(
    s => playSessionId !== undefined && s.byId[playSessionId as SessionId] !== undefined,
  )
  const [handle, setHandle] = useState<TavernSessionHandle | undefined>(undefined)

  // Own a reference to the displayed play session for exactly as long as this
  // view displays it. Retaining is what starts the shared initial history open
  // and what keeps the session's Client scope (and its Conversation assembly)
  // alive; React releases the previous reference on switch/unmount, and the
  // plugin's own ctx.effect releases whatever a still-mounted view holds if the
  // whole fiber unloads first.
  useEffect(() => {
    if (playSessionId === undefined || !playSessionKnown) {
      setHandle(undefined)
      return
    }
    let next: TavernSessionHandle
    try {
      next = retainSession(playSessionId)
    } catch (error) {
      // The id can disappear between the list snapshot and this commit.
      actions.setError(error instanceof Error ? error.message : String(error))
      setHandle(undefined)
      return
    }
    setHandle(next)
    // Surface a failed open instead of leaving an empty thread behind. A
    // rejection caused by our own release (play switch / unmount) is not a
    // failure and must not raise an error banner for a view nobody sees.
    let disposed = false
    void next.ready.catch((error: unknown) => {
      if (disposed) return
      actions.setError(error instanceof Error ? error.message : String(error))
    })
    return () => {
      disposed = true
      next.release()
    }
  }, [playSessionId, playSessionKnown, retainSession, actions])

  // Ignore a handle left over from the previous play for the commits between a
  // play switch and the effect that retains the next session.
  const activeHandle = handle !== undefined && handle.session.sessionId === playSessionId
    ? handle
    : undefined
  const sessionSnapshot = useSessionSnapshot(activeHandle?.session)
  const chatSnapshot = useChatSnapshot(activeHandle?.chat)
  const displaySessionId = activeHandle?.session.sessionId

  // The tavern view opts into the shell's composer-overlay contract
  // (`data-conversation-composer-overlay` on the root, the same opt-in the
  // Trajectory view uses): the resident scrollport then constrains the view
  // column to the viewport (viewArea flex 1 1 0 / min-height 0 / overflow
  // hidden), so `.view`'s 100% height chain is definite and only the
  // tavern's own .messages/.content columns scroll — the tab bar and play
  // sidebar stay pinned. Hand-pinning the scrollport here instead (inline
  // overflow hidden) breaks that chain: the view then wraps in
  // height-auto flow, grows with the transcript, and its own .messages
  // scroller never overflows, leaving the conversation un-scrollable.

  // Hide the host conversation composer while the tavern view is active.
  // The tavern page provides its own composer, so the DSH bottom input is
  // redundant. Measure the seat's live height and animate it downward out of
  // view (height collapse + fade + slight downward shift), so the whole
  // duration shows motion instead of a clamped wait; restore on unmount so
  // leaving the tavern tab returns the composer untouched. Use the Web
  // Animations API directly so it works regardless of CSS :has() support in
  // the host shell.
  useLayoutEffect(() => {
    const root = rootRef.current
    const scroll = root?.closest('[data-conversation-scroll]')
    const seat = scroll?.querySelector<HTMLElement>('[data-composer-seat]') ?? document.querySelector<HTMLElement>('[data-composer-seat]')
    if (seat === null || seat === undefined) return
    const startHeight = seat.getBoundingClientRect().height
    if (startHeight <= 0) return
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const previousStyles = {
      maxHeight: seat.style.maxHeight,
      opacity: seat.style.opacity,
      transform: seat.style.transform,
      visibility: seat.style.visibility,
      overflow: seat.style.overflow,
      pointerEvents: seat.style.pointerEvents,
    }
    const restore = (): void => {
      seat.style.maxHeight = previousStyles.maxHeight
      seat.style.opacity = previousStyles.opacity
      seat.style.transform = previousStyles.transform
      seat.style.visibility = previousStyles.visibility
      seat.style.overflow = previousStyles.overflow
      seat.style.pointerEvents = previousStyles.pointerEvents
    }
    if (typeof seat.animate !== 'function') {
      seat.style.maxHeight = '0px'
      seat.style.opacity = '0'
      seat.style.transform = 'translateY(8px)'
      seat.style.visibility = 'hidden'
      seat.style.overflow = 'hidden'
      seat.style.pointerEvents = 'none'
      return restore
    }
    seat.style.overflow = 'hidden'
    seat.style.pointerEvents = 'none'
    const animation = seat.animate(
      [
        { maxHeight: `${startHeight}px`, opacity: '1', transform: 'translateY(0)' },
        { maxHeight: '0px', opacity: '0', transform: 'translateY(8px)' },
      ],
      {
        duration: reduceMotion ? 0 : 200,
        easing: 'ease',
        fill: 'forwards',
      },
    )
    return () => {
      animation.cancel()
      restore()
    }
  }, [])

  const messages = useMemo(
    () => (chatSnapshot === undefined ? [] : extractMessages(chatSnapshot, characterNames)),
    [chatSnapshot, characterNames],
  )
  const running = (sessionSnapshot?.running ?? false)
    || (chatSnapshot !== undefined && chatSnapshot.legacy.partial !== null)

  // A branch belongs to the last reply's user message, not merely to a play.
  const swipe = useMemo<SwipeBranchSummary | undefined>(() => matchingSwipe(
    state?.swipes ?? [], { playId, sessionId: playSessionId }, messages,
  ), [state, playId, playSessionId, messages])
  // Poll busy branches even while their replayed user row is still arriving.
  const busySwipe = state?.swipes.find(branch => branch.playId === playId && branch.busy
    && (branch.sessionId === undefined || branch.sessionId === playSessionId))
  // Includes the send acknowledgment window: all mutation paths share one lock.
  const [branching, setBranching] = useState(false)
  const operationRef = useRef<OperationState & { handle?: TavernSessionHandle }>({
    playId: null, running: false, busy: false,
  })
  operationRef.current = {
    playId, sessionId: playSessionId, boundSessionId: displaySessionId,
    running, busy: busySwipe !== undefined, handle: activeHandle,
  }

  useEffect(() => {
    if (busySwipe === undefined) return
    return startRetryingPoll(refresh, e => actions.setError(e instanceof Error ? e.message : String(e)))
  }, [busySwipe?.key, playId, refresh, actions])

  const requireOperation = useCallback((expected: OperationAddress): TavernSessionHandle => {
    const current = operationRef.current
    const liveChat = current.handle?.chat.getSnapshot()
    const reason = operationBlockReason({
      ...current,
      running: current.running || (current.handle?.session.getSnapshot().running ?? false)
        || (liveChat !== undefined && liveChat.legacy.partial !== null),
      busy: current.busy || operationLock.busy,
    }, expected)
    if (reason !== undefined) throw new Error(reason)
    return current.handle!
  }, [operationLock])

  const reportOperationError = useCallback((expected: OperationAddress, error: unknown): void => {
    // A late failure in A must not replace B's current feedback.
    if (operationRef.current.playId === expected.playId) {
      actions.setError(error instanceof Error ? error.message : String(error))
    }
  }, [actions])

  const runBranchOp = useCallback(async (
    expected: OperationAddress,
    op: (expectedSessionId: string) => Promise<{ play: Play; branch?: SwipeBranchSummary }>,
  ): Promise<void> => {
    try {
      requireOperation(expected)
      await operationLock.run(async () => {
        setBranching(true)
        actions.setError(null)
        try {
          await commitThenRefresh(() => op(expected.sessionId!), result => {
            // Publish the committed identity before a best-effort full refresh.
            // A refresh failure is not a failed edit and must not invite replay.
            refreshRequests.invalidate()
            setState(prev => prev === null ? prev : {
              ...prev,
              plays: prev.plays.map(play => play.id === result.play.id ? { ...play, ...result.play } : play),
              // A branchless result is a committed edit. Retire stale local
              // metadata even when the following state refresh is offline.
              swipes: result.branch === undefined ? prev.swipes.filter(branch => branch.playId !== result.play.id) : [
                ...prev.swipes.filter(branch => branch.playId !== result.branch!.playId || branch.key !== result.branch!.key),
                result.branch,
              ],
            })
            const current = operationRef.current
            if (current.playId === result.play.id && current.sessionId === expected.sessionId) {
              operationRef.current = {
                ...current, sessionId: result.play.sessionId,
                boundSessionId: current.sessionId === result.play.sessionId ? current.boundSessionId : undefined,
              }
            }
          }, refresh, e => reportOperationError(expected, e))
        } finally {
          setBranching(false)
        }
      })
    } catch (e) {
      reportOperationError(expected, e)
      throw e
    }
  }, [actions, operationLock, refresh, refreshRequests, reportOperationError, requireOperation])

  const retryReply = useCallback((): void => {
    void runBranchOp({ playId, sessionId: playSessionId }, expected => tavernApi.retryReply(playId!, expected))
      .catch(() => {}) // The view reports the failure; this click path is void.
  }, [playId, playSessionId, runBranchOp])

  const swipeReply = useCallback((step: 1 | -1): void => {
    if (swipe === undefined) return
    void runBranchOp({ playId, sessionId: playSessionId }, expected => tavernApi.swipeReply(playId!, swipe.key, step, expected))
      .catch(() => {})
  }, [playId, playSessionId, swipe, runBranchOp])

  const editAssistant = useCallback((messageId: string, text: string): Promise<void> => (
    runBranchOp({ playId, sessionId: playSessionId }, expected => tavernApi.editAssistantMessage(playId!, messageId, text, expected))
  ), [playId, playSessionId, runBranchOp])

  const editUserRetry = useCallback((messageId: string, text: string): Promise<void> => (
    runBranchOp({ playId, sessionId: playSessionId }, expected => tavernApi.editUserMessageAndRetry(playId!, messageId, text, expected))
  ), [playId, playSessionId, runBranchOp])

  const sendMessage = useCallback(async (text: string, expected: OperationAddress): Promise<void> => {
    try {
      const current = requireOperation(expected)
      await operationLock.run(async () => {
        setBranching(true)
        actions.setError(null)
        try { await current.conversation.send(text) } finally { setBranching(false) }
      })
    } catch (e) {
      reportOperationError(expected, e)
      throw e
    }
  }, [actions, operationLock, requireOperation, reportOperationError])

  const cancelRun = useCallback((): void => {
    if (activeHandle === undefined) return
    activeHandle.conversation.cancel().catch(e => {
      actions.setError(e instanceof Error ? e.message : String(e))
    })
  }, [activeHandle, actions])

  return (
    <div ref={rootRef} className={css.view} data-style={style} data-conversation-composer-overlay="">
      <div className={css.nav}>
        <span className={css.navTitle}>🏮 酒馆</span>
        {([
          ['chat', '会话'],
          ['characters', '角色'],
          ['lorebooks', '世界书'],
          ['presets', '预设'],
          ['import', '导入'],
        ] as const).map(([key, label]) => (
          <button
            key={key}
            type="button"
            className={`${css.navTab} ${panel === key ? css.navTabActive : ''}`}
            onClick={() => actions.setPanel(key)}
          >
            {label}
          </button>
        ))}
        <span className={css.navSpacer} />
        <label className={css.stylePicker} title="切换酒馆样式（跟随 DSH 主题或经典暗金）">
          <span>样式</span>
          <select
            className={css.styleSelect}
            value={style}
            onChange={event => changeStyle(event.target.value as TavernStyle)}
          >
            <option value="dsh">跟随 DSH</option>
            <option value="classic">经典酒馆</option>
          </select>
        </label>
        {error !== null && (
          <span className={css.navError} title={error}>⚠ {error}</span>
        )}
        {!loading && state !== null && (
          <span className={css.hint} style={{ marginRight: 8 }}>
            会话 {displaySessionId !== undefined ? displaySessionId.slice(0, 12) : '（无）'}
          </span>
        )}
      </div>

      {loading ? (
        <div className={css.content}><Empty text="正在加载酒馆…" /></div>
      ) : state === null ? (
        <div className={css.content}><Empty text="酒馆数据不可用" /></div>
      ) : (
        <div className={css.body} style={{ border: 'none' }}>
          {panel === 'chat' && (
            <ChatPanel
              api={tavernApi}
              composerDrafts={composerDrafts}
              plays={state.plays}
              characters={state.characters.map(c => ({
                id: c.id,
                name: c.card.data.name,
                avatar: c.avatar,
                description: c.card.data.description,
                personality: c.card.data.personality,
                tags: c.card.data.tags,
              }))}
              lorebooks={state.lorebooks.map(b => ({
                id: b.id,
                name: b.name,
                description: b.book.description,
                entryCount: b.book.entries.length,
              }))}
              presets={state.presets.map(p => ({ id: p.id, name: p.name }))}
              activePlayId={playId}
              activePlayTitle={activePlay?.title}
              multiAgentAvailable={state.multiAgentAvailable}
              messages={messages}
              activeSessionId={activeHandle?.session.sessionId}
              running={running}
              swipe={swipe}
              branching={branching || busySwipe !== undefined}
              onRetry={retryReply}
              onSwipe={swipeReply}
              onCancel={cancelRun}
              onEditAssistant={editAssistant}
              onEditUserRetry={editUserRetry}
              onSelectPlay={selectPlay}
              onGoToCharacters={() => actions.setPanel('characters')}
              onGoToLorebooks={() => actions.setPanel('lorebooks')}
              onCreatePlay={createPlay}
              onDeletePlay={deletePlay}
              onSend={sendMessage}
            />
          )}
          {panel === 'characters' && (
            <CharacterPanel
              api={tavernApi}
              characters={state.characters}
              selectedId={selectedCharacterId}
              onSelect={actions.selectCharacter}
              onChanged={refresh}
              onError={actions.setError}
            />
          )}
          {panel === 'lorebooks' && (
            <LorebookPanel
              api={tavernApi}
              lorebooks={state.lorebooks}
              selectedId={selectedLorebookId}
              onSelect={actions.selectLorebook}
              onChanged={refresh}
              onError={actions.setError}
            />
          )}
          {panel === 'presets' && (
            <PresetPanel
              api={tavernApi}
              presets={state.presets}
              selectedId={selectedPresetId}
              defaultPresetId={state.defaultPresetId}
              onSelect={actions.selectPreset}
              onChanged={refresh}
              onError={actions.setError}
            />
          )}
          {panel === 'import' && (
            <TauriTavernImportPanel
              api={tavernApi}
              onChanged={refresh}
              onError={actions.setError}
            />
          )}
        </div>
      )}
    </div>
  )
}
