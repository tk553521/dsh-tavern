/**
 * Tavern view: the conversation-view entry the tavern plugin registers.
 * The chat area renders the CURRENT DSH session (the play's director
 * session) from the client runtime snapshot and sends through the
 * conversation service; the library panels manage characters / world books /
 * presets through the host route.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConversationSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
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

/** Business callbacks injected into the tavern view (session-scoped). */
export interface TavernViewInjected {
  /** Open one DSH session (used to switch to a play's director session). */
  openSession: (sessionId: string) => void
  /** Send one user turn to the CURRENT session through the conversation service. */
  send: (text: string) => Promise<void>
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

export function TavernView({
  useStore,
  actions,
  useSession,
  useSessions,
  openSession,
  send,
}: TavernViewProps) {
  const panel = useStore(s => s.panel)
  const playId = useStore(s => s.playId)
  const selectedCharacterId = useStore(s => s.selectedCharacterId)
  const selectedLorebookId = useStore(s => s.selectedLorebookId)
  const selectedPresetId = useStore(s => s.selectedPresetId)
  const error = useStore(s => s.error)

  const [state, setState] = useState<TavernState | null>(null)
  const [loading, setLoading] = useState(true)
  // Style preference: optimistic local state, seeded from the server snapshot.
  const [style, setStyle] = useState<TavernStyle>('dsh')

  // The current DSH session this view is bound to (session scope).
  const currentSessionId = useSessions(s => s.current)
  const snapshot = useSession(s => s)

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
      // Ensure the director session exists (resume after restart), then open it.
      void tavernApi.activatePlay(playSummary.id).then(() => {
        openSession(playSummary.sessionId)
      }).catch(e => {
        actions.setError(e instanceof Error ? e.message : String(e))
      })
    }
  }, [actions, openSession, state])

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
      openSession(created.sessionId)
    } catch (e) {
      actions.setError(e instanceof Error ? e.message : String(e))
      throw e
    }
  }, [actions, openSession, refresh])

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
  const messages = useMemo(
    () => (currentSessionId === undefined ? [] : extractMessages(snapshot, characterNames)),
    [snapshot, currentSessionId, characterNames],
  )
  const running = snapshot.chat.legacy.runningCalls.length > 0
    || snapshot.queue.length > 0

  const activePlay = playId !== null ? state?.plays.find(p => p.id === playId) ?? null : null

  return (
    <div className={css.view} data-style={style}>
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
            会话 {currentSessionId !== undefined ? currentSessionId.slice(0, 12) : '（无）'}
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
              currentSessionId={currentSessionId}
              running={running}
              onSelectPlay={selectPlay}
              onGoToCharacters={() => actions.setPanel('characters')}
              onGoToLorebooks={() => actions.setPanel('lorebooks')}
              onCreatePlay={createPlay}
              onDeletePlay={deletePlay}
              onSend={async (text) => {
                actions.setError(null)
                try {
                  await send(text)
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
