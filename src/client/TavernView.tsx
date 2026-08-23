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
import type { ConversationSnapshot, SessionFace } from '@deepseek-ai/dsh-client-runtime/client'
import type { IConversation } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { PlaySummary, SwipeBranchSummary, TavernState, TavernStyle } from '../types.ts'
import { tavernApi, type TavernApi } from './api.ts'
import type { createTavernStore } from './store.ts'
import { ChatPanel } from './components/ChatPanel.tsx'
import { CharacterPanel } from './components/CharacterPanel.tsx'
import { LorebookPanel } from './components/LorebookPanel.tsx'
import { PresetPanel } from './components/PresetPanel.tsx'
import { TauriTavernImportPanel } from './components/TauriTavernImportPanel.tsx'
import { Empty } from './components/common.tsx'
import css from './TavernView.module.css'

/** The concrete session methods needed to load a non-current play session. */
export type OpenableSession = SessionFace & { open(): Promise<void> }

/** Business callbacks injected into the tavern view (session-scoped). */
export interface TavernViewInjected {
  /** Resolve a play session's live snapshot source without changing the global current session. */
  getSession: (sessionId: string) => OpenableSession | undefined
  /** Resolve a play session's conversation service for sending. */
  getConversation: (sessionId: string) => IConversation
}

/** Full props: framework runtime share + store share + inject face. */
export type TavernViewProps =
  & ConvViewProps
  & PropsStore<ReturnType<typeof createTavernStore>>
  & TavernViewInjected

/** Lifecycle status of one projected reply row. */
export type ViewStatus = 'streaming' | 'done' | 'stopped' | 'truncated' | 'error'

/** One message row projected from the session snapshot for tavern display. */
export interface ViewMessage {
  id: string
  kind: 'user' | 'assistant'
  name?: string
  text: string
  /** Model thinking (reasoning) text, rendered as a collapsible block. */
  thinking?: string
  /** Generation status of the row (user rows are always 'done'). */
  status: ViewStatus
  /** Failure text when status is 'error'. */
  errorText?: string
  /** Durable message id: the edit/retry address (absent on streaming rows). */
  messageId?: string
  /**
   * Whole-step text behind `messageId`. A classic-mode step can render as
   * several speaker rows (and a single row has its `角色名：` prefix stripped),
   * so the editor must round-trip the stored step text instead of this row's
   * display text — otherwise saving an edit would drop the other speakers.
   * Only set on the row that carries `messageId`.
   */
  stepText?: string
}

/** Shape read from `assistant-step` chat nodes (mirrors AssistantChatData). */
interface ChatAssistantStepData {
  status?: 'running' | 'settled' | 'interrupted'
  turn?: number
  blocks?: readonly { kind: string; text?: string }[]
  finalNode?: { messageId?: string }
}

/** Extract text blocks from a content block list. */
function blocksToText(blocks: readonly { type: string; text?: string }[]): string {
  return blocks
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('')
}

/** Join one kind of assistant blocks (text / reasoning). */
function joinBlocks(blocks: readonly { kind: string; text?: string }[], kind: string): string {
  return blocks
    .filter(block => block.kind === kind && typeof block.text === 'string')
    .map(block => block.text)
    .join('')
}

/** One contiguous stretch of a reply spoken by the same character. */
interface SpeakerRun {
  /** Undefined for narration / an unrecognized prefix (rendered as 叙述者). */
  name?: string
  text: string
}

/** `角色名：台词` line prefix that the classic-mode prompt asks the model for. */
const SPEAKER_LINE_RE = /^\s*([^：:\n]{1,20})[：:]\s*([\s\S]*)$/

/**
 * Split a classic-mode reply into consecutive speaker runs.
 *
 * In classic (single-agent) mode one assistant step contains the whole cast's
 * lines, each prefixed with `角色名：` per `buildClassicSystem`. Matching only
 * the head of the step would file every line under the first speaker, so scan
 * line by line and start a new run whenever a line opens with a name the play
 * actually knows. Unknown prefixes (`注意：`, a colon mid-sentence) are not
 * speakers and keep flowing into the current run, which preserves the previous
 * behaviour — one nameless row holding the entire reply — for replies that
 * never name a character.
 */
function splitSpeakerRuns(text: string, characterNames: readonly string[]): SpeakerRun[] {
  const runs: { name?: string; lines: string[] }[] = []
  for (const line of text.split('\n')) {
    const match = SPEAKER_LINE_RE.exec(line)
    const speaker = match !== null && characterNames.includes(match[1]!.trim())
      ? match[1]!.trim()
      : undefined
    if (speaker !== undefined) runs.push({ name: speaker, lines: [match![2]!] })
    else if (runs.length === 0) runs.push({ lines: [line] })
    else runs[runs.length - 1]!.lines.push(line)
  }
  const out = runs
    .map(run => ({
      ...(run.name !== undefined ? { name: run.name } : {}),
      text: run.lines.join('\n').trim(),
    }))
    .filter(run => run.text !== '')
  // A step that is nothing but bare labels still needs a row to host its
  // thinking block, status line and retry seat.
  return out.length > 0 ? out : [{ text: text.trim() }]
}

/**
 * Project ordered user/assistant rows from the session snapshot, attaching
 * per-row generation status (streaming / stopped / truncated / error) and
 * thinking text from the chat node's turn metadata.
 */
export function extractMessages(
  snapshot: ConversationSnapshot,
  characterNames: readonly string[],
): ViewMessage[] {
  // First pass: collect turn-level end markers (max-token truncation / error).
  const turnMarks = new Map<number, { truncated?: true; error?: string }>()
  for (const key of snapshot.chat.order) {
    const node = snapshot.chat.nodes.get(key)
    if (node === undefined) continue
    const data = node.data as { turn?: number; message?: string }
    if (node.kind === 'turn-max-tokens' && typeof data.turn === 'number') {
      turnMarks.set(data.turn, { ...turnMarks.get(data.turn), truncated: true })
    } else if (node.kind === 'turn-error' && typeof data.turn === 'number') {
      const error = typeof data.message === 'string' && data.message !== '' ? data.message : '生成失败'
      turnMarks.set(data.turn, { ...turnMarks.get(data.turn), error })
    }
  }

  const out: ViewMessage[] = []
  for (const key of snapshot.chat.order) {
    const node = snapshot.chat.nodes.get(key)
    if (node === undefined) continue
    if (node.kind === 'user' || node.kind === 'steering') {
      const data = node.data as { content?: readonly { type: string; text?: string }[] }
      const text = blocksToText(data.content ?? []).trim()
      if (text !== '' && text !== '[开场] 扮演开始。') {
        out.push({ id: key, kind: 'user', text, status: 'done', messageId: node.id })
      }
    } else if (node.kind === 'assistant-step') {
      const data = node.data as ChatAssistantStepData
      const blocks = data.blocks ?? []
      const thinking = joinBlocks(blocks, 'reasoning').trim()
      const text = joinBlocks(blocks, 'text').trim()
      if (text === '' && thinking === '') continue
      let status: ViewStatus = data.status === 'running'
        ? 'streaming'
        : data.status === 'interrupted'
          ? 'stopped'
          : 'done'
      let errorText: string | undefined
      const mark = typeof data.turn === 'number' ? turnMarks.get(data.turn) : undefined
      if (status === 'done' && mark?.truncated === true) status = 'truncated'
      if (mark?.error !== undefined) {
        status = 'error'
        errorText = mark.error
      }
      const runs = splitSpeakerRuns(text, characterNames)
      runs.forEach((run, index) => {
        const isTail = index === runs.length - 1
        out.push({
          // Suffix every run: the key stays unique across a multi-speaker step
          // and stable as later runs stream in (row `i` keeps `key#i`).
          id: `${key}#${index}`,
          kind: 'assistant',
          ...(run.name !== undefined ? { name: run.name } : {}),
          text: run.text,
          // Reasoning belongs to the step rather than to one speaker: render it
          // once, above the first line the step produced.
          ...(thinking !== '' && index === 0 ? { thinking } : {}),
          // Generation continues at the tail, so only the tail shows the live
          // status; the runs before it are finished lines.
          status: isTail ? status : 'done',
          ...(isTail && errorText !== undefined ? { errorText } : {}),
          // `messageId` addresses the whole step (edit / retry / swipe), so at
          // most one row may own it, and it must be the tail: that is where the
          // retry and swipe seat belongs (`isLastAssistant`), and an edit saved
          // from any earlier row would rewrite the step to that row alone.
          ...(isTail && data.finalNode?.messageId !== undefined
            ? { messageId: data.finalNode.messageId, stepText: text }
            : {}),
        })
      })
    }
  }
  return out
}

/** Load the full tavern state snapshot. */
async function loadState(api: TavernApi): Promise<TavernState> {
  return api.state()
}

/** Subscribe to an arbitrary session snapshot without making it the global current session. */
function useSessionSnapshot(session: OpenableSession | undefined): ConversationSnapshot | undefined {
  return useSyncExternalStore(
    useCallback(
      (onStoreChange: () => void) => session?.subscribe(onStoreChange) ?? (() => {}),
      [session],
    ),
    useCallback(() => session?.getSnapshot(), [session]),
  )
}

export function TavernView({
  useStore,
  actions,
  useSessions,
  getSession,
  getConversation,
}: TavernViewProps) {
  const panel = useStore(s => s.panel)
  const playId = useStore(s => s.playId)
  const selectedCharacterId = useStore(s => s.selectedCharacterId)
  const selectedLorebookId = useStore(s => s.selectedLorebookId)
  const selectedPresetId = useStore(s => s.selectedPresetId)
  const error = useStore(s => s.error)

  const [state, setState] = useState<TavernState | null>(null)
  const [loading, setLoading] = useState(true)
  const rootRef = useRef<HTMLDivElement | null>(null)
  // Style preference: optimistic local state, seeded from the server snapshot.
  const [style, setStyle] = useState<TavernStyle>('dsh')

  // The current DSH session this view is bound to (session scope).
  const currentSessionId = useSessions(s => s.current)
  // Re-resolve the active play session when the session list changes.
  const sessionIds = useSessions(s => s.ids)

  const refresh = useCallback(async (): Promise<void> => {
    const next = await loadState(tavernApi)
    setState(next)
    setLoading(false)
  }, [])

  useEffect(() => {
    void refresh().catch(e => {
      actions.setError(e instanceof Error ? e.message : String(e))
      setLoading(false)
    })
  }, [refresh, actions])

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
  const activeSession = useMemo(
    () => activePlay === null ? undefined : getSession(activePlay.sessionId),
    [activePlay, getSession, sessionIds],
  )
  const activeSnapshot = useSessionSnapshot(activeSession)
  const activeSessionId = activeSession?.sessionId
  const displaySessionId = activeSessionId ?? currentSessionId

  // Open the selected play session's history in the background. Unlike
  // `sessions.open`, this does not change the global current session, so an
  // archived tavern session does not kick the UI back to the workspace home.
  useEffect(() => {
    if (activeSession === undefined) return
    void activeSession.open().catch(e => {
      actions.setError(e instanceof Error ? e.message : String(e))
    })
  }, [activeSession, actions])

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
    () => (activeSnapshot === undefined ? [] : extractMessages(activeSnapshot, characterNames)),
    [activeSnapshot, characterNames],
  )
  const running = (activeSnapshot?.running ?? false)
    || (activeSnapshot !== undefined && activeSnapshot.chat.legacy.partial !== null)

  // The latest swipe branch of the active play (its generation progress).
  const swipe = useMemo<SwipeBranchSummary | undefined>(() => {
    if (playId === null || state === null) return undefined
    const branches = state.swipes.filter(branch => branch.playId === playId)
    if (branches.length === 0) return undefined
    return branches.reduce((a, b) => (a.updatedAt >= b.updatedAt ? a : b))
  }, [state, playId])
  // Serializes swipe/reroll/edit calls so the client and host never fork twice.
  const [branching, setBranching] = useState(false)

  // A busy swipe branch settles on the host in the background; poll the tavern
  // state until the branch leaves its in-flight slot so 3/3 生成中 clears and
  // switch buttons unlock even when the model turn errored.
  useEffect(() => {
    if (swipe?.busy !== true) return
    const timer = setTimeout(() => {
      void refresh().catch(() => {})
    }, 800)
    return () => clearTimeout(timer)
  }, [swipe?.busy, running, refresh, swipe])

  const runBranchOp = useCallback((op: () => Promise<unknown>): void => {
    if (branching) return
    setBranching(true)
    actions.setError(null)
    void op()
      .then(() => refresh())
      .catch(e => actions.setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBranching(false))
  }, [actions, branching, refresh])

  const retryReply = useCallback((): void => {
    if (activePlay === null) return
    runBranchOp(() => tavernApi.retryReply(activePlay.id))
  }, [activePlay, runBranchOp])

  const swipeReply = useCallback((step: 1 | -1): void => {
    if (activePlay === null || swipe === undefined) return
    runBranchOp(() => tavernApi.swipeReply(activePlay.id, swipe.key, step))
  }, [activePlay, swipe, runBranchOp])

  const editAssistant = useCallback((messageId: string, text: string): void => {
    if (activePlay === null) return
    runBranchOp(() => tavernApi.editAssistantMessage(activePlay.id, messageId, text))
  }, [activePlay, runBranchOp])

  const editUserRetry = useCallback((messageId: string, text: string): void => {
    if (activePlay === null) return
    runBranchOp(() => tavernApi.editUserMessageAndRetry(activePlay.id, messageId, text))
  }, [activePlay, runBranchOp])

  const cancelRun = useCallback((): void => {
    if (activeSession === undefined) return
    getConversation(activeSession.sessionId).cancel().catch(e => {
      actions.setError(e instanceof Error ? e.message : String(e))
    })
  }, [activeSession, actions, getConversation])

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
              activeSessionId={activeSessionId}
              running={running}
              swipe={swipe}
              branching={branching}
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
              onSend={async (text) => {
                actions.setError(null)
                try {
                  if (activePlay === null || activeSession === undefined) {
                    throw new Error('请先选择一个酒馆会话')
                  }
                  await getConversation(activeSession.sessionId).send(text)
                } catch (e) {
                  actions.setError(e instanceof Error ? e.message : String(e))
                  // Surface *and* reject (same contract as onCreatePlay): the
                  // nav slot shows why, and the composer learns the text never
                  // left the client so it can hand the draft back.
                  throw e
                }
              }}
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
