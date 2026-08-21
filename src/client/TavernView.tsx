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
import type { PlaySummary, TavernState, TavernStyle } from '../types.ts'
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

/** One message row projected from the session snapshot for tavern display. */
export interface ViewMessage {
  id: string
  kind: 'user' | 'assistant'
  name?: string
  text: string
}

/** Extract text blocks from a content block list. */
function blocksToText(blocks: readonly { type: string; text?: string }[]): string {
  return blocks
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('')
}

/** Project ordered user/assistant rows from the session snapshot. */
export function extractMessages(
  snapshot: ConversationSnapshot,
  characterNames: readonly string[],
): ViewMessage[] {
  const out: ViewMessage[] = []
  for (const key of snapshot.chat.order) {
    const node = snapshot.chat.nodes.get(key)
    if (node === undefined) continue
    const data = node.data as { content?: readonly { type: string; text?: string }[]; blocks?: readonly { kind: string; text?: string }[] }
    if (node.kind === 'user') {
      const text = blocksToText(data.content ?? []).trim()
      if (text !== '' && text !== '[开场] 扮演开始。') out.push({ id: key, kind: 'user', text })
    } else if (node.kind === 'assistant-step') {
      const text = (data.blocks ?? [])
        .filter((block): block is { kind: 'text'; text: string } => block.kind === 'text' && typeof block.text === 'string')
        .map(block => block.text)
        .join('')
      const trimmed = text.trim()
      if (trimmed === '') continue
      const match = /^([^：:]{1,20})[：:]\s*([\s\S]+)$/.exec(trimmed)
      const name = match !== null && characterNames.includes(match[1]!.trim())
        ? match[1]!.trim()
        : undefined
      out.push({
        id: key,
        kind: 'assistant',
        ...(name !== undefined ? { name } : {}),
        text: name !== undefined ? match![2]!.trim() : trimmed,
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
  const running = activeSnapshot !== undefined
    && (activeSnapshot.chat.legacy.runningCalls.length > 0 || activeSnapshot.queue.length > 0)

  return (
    <div ref={rootRef} className={css.view} data-style={style}>
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
