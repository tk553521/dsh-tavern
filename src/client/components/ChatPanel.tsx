/**
 * Chat panel: play list, session message thread (from the DSH session
 * snapshot), composer, and play creation. The conversation itself is the
 * DSH session — sending routes through the conversation service.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PlaySummary, SwipeBranchSummary } from '../../types.ts'
import type { TavernApi } from '../api.ts'
import { avatarSrc } from '../avatar.ts'
import type { ViewMessage } from '../TavernView.tsx'
import css from '../TavernView.module.css'
import { Button, Empty, Field, Select, Spinner, confirmAction } from './common.tsx'

/** A compact character card view used by the cast picker. */
export interface CharacterChoice {
  id: string
  name: string
  avatar?: string
  description?: string
  personality?: string
  tags?: string[]
}

export interface LorebookChoice {
  id: string
  name: string
  description?: string
  entryCount?: number
}

export interface ChatPanelProps {
  api: TavernApi
  plays: PlaySummary[]
  characters: CharacterChoice[]
  lorebooks: LorebookChoice[]
  presets: { id: string; name: string }[]
  activePlayId: string | null
  activePlayTitle: string | undefined
  /** Whether the agent-loop factory is live; multi-agent creation requires it. */
  multiAgentAvailable: boolean
  /** Messages projected from the active play session snapshot (the only display source). */
  messages: ViewMessage[]
  /** Active play's DSH session id once it is available for direct binding. */
  activeSessionId: string | undefined
  running: boolean
  /** Current swipe branch of the active play (alternative generations). */
  swipe?: SwipeBranchSummary
  /** True while a retry/swipe/edit request is in flight. */
  branching: boolean
  onSelectPlay: (id: string | null) => void
  /** Regenerate the last assistant reply (stores the current one as a swipe). */
  onRetry: () => void
  /** Switch to another stored swipe variant (step ±1, wraps). */
  onSwipe: (step: 1 | -1) => void
  /** Abort the in-flight generation. */
  onCancel: () => void
  /** Save an edited assistant reply (in place). */
  onEditAssistant: (messageId: string, text: string) => void
  /** Save an edited user message and regenerate from it. */
  onEditUserRetry: (messageId: string, text: string) => void
  onCreatePlay: (
    title: string,
    characterIds: string[],
    lorebookIds: string[],
    presetId: string | undefined,
    narratorEnabled: boolean,
    multiAgent: boolean,
  ) => Promise<void>
  onDeletePlay: (id: string) => Promise<void>
  onSend: (content: string) => Promise<void>
  /** Open the character library when the user has no cards to pick from. */
  onGoToCharacters: () => void
  /** Open the world-book library when no books are available. */
  onGoToLorebooks: () => void
}

function firstGrapheme(value: string): string {
  const trimmed = value.trim()
  return trimmed === '' ? '?' : Array.from(trimmed)[0] ?? '?'
}

function compactText(value: string | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim()
}

function matchesCharacter(character: CharacterChoice, query: string): boolean {
  return [
    character.name,
    character.description ?? '',
    character.personality ?? '',
    ...(character.tags ?? []),
  ].join('\n').toLowerCase().includes(query)
}

function matchesLorebook(book: LorebookChoice, query: string): boolean {
  return [book.name, book.description ?? ''].join('\n').toLowerCase().includes(query)
}

/** Markup tags allowed in chat bubbles; everything else is dropped or unwrapped. */
const HTML_ALLOWED_TAGS = new Set([
  'p', 'br', 'div', 'span', 'blockquote', 'hr',
  'b', 'strong', 'i', 'em', 'u', 's', 'del', 'font', 'code', 'pre',
  'a', 'img', 'ul', 'ol', 'li',
  'h1', 'h2', 'h3', 'h4',
  'table', 'thead', 'tbody', 'tr', 'td', 'th',
])

/** Per-tag attribute whitelist; all other attributes (incl. on*) are removed. */
const HTML_ALLOWED_ATTRS: Record<string, string[]> = {
  a: ['href', 'title'],
  img: ['src', 'alt', 'title', 'width', 'height'],
  font: ['color'],
  td: ['colspan', 'rowspan'],
  th: ['colspan', 'rowspan'],
}

/** Quick tag sniff to distinguish HTML markup from plain narrative text. */
const HTML_TAG_RE = /<\s*(a|img|div|span|p|br|hr|table|tr|td|th|ul|ol|li|blockquote|code|pre|font|b|i|u|em|strong|s|del|h[1-4])\b[^>]*>/i

/** Hard cap on inline data-URL media in message bubbles (memory bound). */
const MAX_DATA_IMAGE_BYTES = 512 * 1024

function safeUrl(value: string, allowDataImage: boolean): string | null {
  const trimmed = value.trim()
  if (/^(https?:|mailto:)/i.test(trimmed)) return trimmed
  if (allowDataImage) {
    // Bitmap data URLs only: `data:image/svg+xml` (and its Base64 form) is
    // rejected so a crafted message cannot smuggle an SVG script payload or
    // an arbitrarily large inline resource into the bubble.
    const match = /^data:image\/(png|jpeg|jpg|webp|gif);base64,([A-Za-z0-9+/=]+)$/i.exec(trimmed)
    if (match !== null && match[2]!.length <= Math.ceil(MAX_DATA_IMAGE_BYTES * 4 / 3) + 4) {
      return trimmed
    }
  }
  return null
}

/**
 * Elements dropped with their subtree instead of being unwrapped.
 *
 * Beyond the obviously active ones (script/style/iframe/…), this covers every
 * element whose children the HTML parser treats as raw text or as an inert
 * sub-document. Those parse differently in the DOMParser document used here
 * (scripting disabled, no template contents in the main tree) than in the live
 * document the fragment is later injected into, which is the classic mXSS
 * lever: unwrapping `<noscript>` hands back markup that never went through the
 * whitelist. Nothing in a roleplay bubble legitimately needs them.
 */
const STRIP_CONTENT = new Set([
  'script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'select', 'textarea',
  'noscript', 'template', 'noembed', 'noframes', 'xmp', 'plaintext', 'title',
])

/** One whitelist pass over `html`; returns the serialized sanitized body. */
function sanitizePass(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const sanitizeNode = (node: Node): void => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === 1) {
        const el = child as HTMLElement
        const tag = el.tagName.toLowerCase()
        if (STRIP_CONTENT.has(tag)) {
          el.remove()
          continue
        }
        if (!HTML_ALLOWED_TAGS.has(tag)) {
          // Unwrap unknown tags but keep their (sanitized) children.
          sanitizeNode(el)
          while (el.firstChild !== null) el.parentNode!.insertBefore(el.firstChild, el)
          el.remove()
          continue
        }
        for (const attr of Array.from(el.attributes)) {
          const allowed = HTML_ALLOWED_ATTRS[tag] ?? []
          if (!allowed.includes(attr.name.toLowerCase())) {
            el.removeAttribute(attr.name)
            continue
          }
          if (tag === 'a' && attr.name === 'href') {
            const url = safeUrl(attr.value, false)
            if (url === null) el.removeAttribute('href')
            else el.setAttribute('href', url)
          }
          if (tag === 'img' && attr.name === 'src') {
            const url = safeUrl(attr.value, true)
            if (url === null) el.removeAttribute('src')
            else el.setAttribute('src', url)
          }
        }
        if (tag === 'a') {
          el.setAttribute('target', '_blank')
          el.setAttribute('rel', 'noopener noreferrer')
        }
        sanitizeNode(el)
      }
    }
  }
  sanitizeNode(doc.body)
  return doc.body.innerHTML
}

/**
 * Sanitize roleplay HTML into a whitelist-only fragment safe for innerHTML.
 * Returns null when the result cannot be trusted; callers must then render the
 * message as plain text.
 *
 * Message text is model output steered by imported character cards, i.e.
 * attacker-controllable, and there is no DOMPurify here to lean on. So the
 * whitelist pass is followed by a fixed-point check: feeding the serialized
 * output back through the parser must be a no-op. Any mutation means the
 * browser reads the sanitized string differently from the tree that was
 * sanitized (namespace confusion, raw-text re-interpretation, entity
 * round-tripping) — the general shape of every mXSS bypass — and the safe
 * answer is to publish nothing rather than guess which reading wins.
 */
export function sanitizeMessageHtml(html: string): string | null {
  const first = sanitizePass(html)
  const second = sanitizePass(first)
  return second === first ? first : null
}

/** Whether the message contains HTML markup worth rendering as markup. */
export function looksLikeHtml(text: string): boolean {
  return HTML_TAG_RE.test(text)
}

export function ChatPanel(props: ChatPanelProps) {
  const { running } = props
  const [draft, setDraft] = useState('')
  const [title, setTitle] = useState('')
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [characterQuery, setCharacterQuery] = useState('')
  const [lorebookIds, setLorebookIds] = useState<string[]>([])
  const [lorebookQuery, setLorebookQuery] = useState('')
  const [presetId, setPresetId] = useState<string | undefined>(undefined)
  const [narratorEnabled, setNarratorEnabled] = useState(false)
  const [multiAgent, setMultiAgent] = useState(true)
  const [creating, setCreating] = useState(false)
  const listRef = useRef<HTMLDivElement | null>(null)

  // Scroll-follow contract: the list pins to the bottom only while the user
  // is already reading the tail. Scrolling up while streaming un-pins it, so
  // reading older messages is never yanked back down; a newly appended
  // message (send/reply) or a play switch always snaps to the end. Scroll
  // only this column; never the shell scrollport (tab bar/sidebar stay put).
  const pinnedRef = useRef(true)
  const lastRef = useRef<{ playKey: string | null; count: number }>({ playKey: null, count: 0 })
  useEffect(() => {
    const list = listRef.current
    if (list === null) return
    const prev = lastRef.current
    const newPlay = prev.playKey !== props.activePlayId
    const appended = props.messages.length > prev.count
    lastRef.current = { playKey: props.activePlayId, count: props.messages.length }
    // A new message only forces the pin when the user just sent it (the last
    // row is the user's own); assistant/observer rows respect the pin state.
    const last = props.messages[props.messages.length - 1]
    const ownSend = appended && last?.kind === 'user'
    if (newPlay || ownSend || pinnedRef.current) {
      list.scrollTop = list.scrollHeight
    }
  }, [props.messages, running, props.activePlayId])

  const selectedCharacters = selectedIds
    .map(id => props.characters.find(character => character.id === id))
    .filter((character): character is CharacterChoice => character !== undefined)

  const selectedLorebooks = lorebookIds
    .map(id => props.lorebooks.find(book => book.id === id))
    .filter((book): book is LorebookChoice => book !== undefined)

  const visibleCharacters = useMemo(() => {
    const query = characterQuery.trim().toLowerCase()
    const selected = new Set(selectedIds)
    const matched = query === ''
      ? props.characters
      : props.characters.filter(character => matchesCharacter(character, query))
    // Keep the chosen cast on top in pick order, then source order.
    return [
      ...matched.filter(character => selected.has(character.id)),
      ...matched.filter(character => !selected.has(character.id)),
    ]
  }, [characterQuery, props.characters, selectedIds])

  const visibleLorebooks = useMemo(() => {
    const query = lorebookQuery.trim().toLowerCase()
    const selected = new Set(lorebookIds)
    const matched = query === ''
      ? props.lorebooks
      : props.lorebooks.filter(book => matchesLorebook(book, query))
    const byId = new Map(matched.map(book => [book.id, book]))
    return [
      ...lorebookIds
        .map(id => byId.get(id))
        .filter((book): book is LorebookChoice => book !== undefined),
      ...matched.filter(book => !selected.has(book.id)),
    ]
  }, [lorebookQuery, lorebookIds, props.lorebooks])

  const toggleSelect = (id: string): void => {
    setSelectedIds(prev => prev.includes(id)
      ? prev.filter(cid => cid !== id)
      : [...prev, id])
  }

  const toggleLorebook = (id: string): void => {
    setLorebookIds(prev => prev.includes(id)
      ? prev.filter(bid => bid !== id)
      : [...prev, id])
  }

  const clearLorebooks = (): void => {
    setLorebookIds([])
  }

  const makeMain = (id: string): void => {
    setSelectedIds(prev => prev[0] === id
      ? prev
      : [id, ...prev.filter(cid => cid !== id)])
  }

  const clearSelection = (): void => {
    setSelectedIds([])
  }

  const submitCreate = async (): Promise<void> => {
    if (selectedCharacters.length === 0) return
    setCreating(true)
    try {
      await props.onCreatePlay(
        title.trim(),
        selectedCharacters.map(character => character.id),
        selectedLorebooks.map(book => book.id),
        presetId,
        narratorEnabled,
        multiAgent && props.multiAgentAvailable,
      )
      setTitle('')
      setSelectedIds([])
      setCharacterQuery('')
      setLorebookIds([])
      setLorebookQuery('')
      setPresetId(undefined)
    } catch {
      // The error is already surfaced through the nav error slot; swallow
      // here so the fire-and-forget click path never rejects unhandled.
    } finally {
      setCreating(false)
    }
  }

  const send = (): void => {
    const content = draft.trim()
    if (content === '' || running) return
    // Clear optimistically so the composer feels instant, but a rejected send
    // means the text never reached the session: hand it back instead of
    // destroying it. Only refill an untouched composer — the user may have
    // started typing the next line while the failing send was in flight, and
    // that draft outranks the one we are returning.
    setDraft('')
    void props.onSend(content).catch(() => {
      setDraft(prev => (prev === '' ? content : prev))
    })
  }

  // Resolve the retry/swipe seat once per transcript instead of re-scanning the
  // tail from inside the row map: that scan was O(n²) and reran on every
  // streamed token. Equivalent to the old per-row predicate — the seat is the
  // row with no assistant row after it, and only once it has settled.
  const lastAssistantIndex = useMemo(() => {
    for (let index = props.messages.length - 1; index >= 0; index -= 1) {
      if (props.messages[index]!.kind === 'assistant') return index
    }
    return -1
  }, [props.messages])

  // MessageRow is memoized, so every callback it receives has to survive a
  // re-render identical or the memo never hits. Rows hand their own address up
  // instead of each one closing over its message.
  const saveEdit = useCallback((messageId: string, kind: ViewMessage['kind'], text: string): void => {
    if (kind === 'user') props.onEditUserRetry(messageId, text)
    else props.onEditAssistant(messageId, text)
  }, [props.onEditUserRetry, props.onEditAssistant])

  const inPlaySession = props.activeSessionId !== undefined

  return (
    <div className={css.body}>
      {/* Play list */}
      <div className={css.sidebar}>
        <div className={css.sidebarHead}>
          <span className={css.sidebarTitle}>酒馆会话</span>
          {props.activePlayId !== null && (
            <Button variant="ghost" onClick={() => props.onSelectPlay(null)}>＋ 新建</Button>
          )}
        </div>
        <div className={css.list}>
          {props.plays.length === 0 && <Empty text="还没有会话，从右侧挑选角色开始第一场扮演" />}
          {props.plays.map(play => {
            const cast = play.characterIds
              .map(id => props.characters.find(character => character.id === id))
              .filter((character): character is CharacterChoice => character !== undefined)
            return (
              <button
                key={play.id}
                type="button"
                className={`${css.listItem} ${play.id === props.activePlayId ? css.listItemActive : ''}`}
                onClick={() => props.onSelectPlay(play.id)}
              >
                <span className={css.playAvatarStack} aria-hidden="true">
                  {cast.slice(0, 3).map(character => (
                    character.avatar !== undefined
                      ? <img key={character.id} className={css.playAvatar} src={avatarSrc(character.avatar)} alt="" />
                      : (
                          <span key={character.id} className={css.playAvatar}>
                            {firstGrapheme(character.name)}
                          </span>
                        )
                  ))}
                  {cast.length > 3 && <span className={css.playAvatarMore}>+{cast.length - 3}</span>}
                </span>
                <span className={css.listItemBody}>
                  <span className={css.playTitle}>{play.title}</span>
                  <span className={css.playMeta}>
                    {cast.length > 0
                      ? `${cast.slice(0, 3).map(character => character.name).join(' · ')}${cast.length > 3 ? ' …' : ''}`
                      : `${play.characterIds.length} 位角色`}
                  </span>
                  <span className={css.listItemMeta}>
                    {play.characterIds.length} 角{play.multiAgent ? '·多 agent' : '·经典'}
                    {(play.lorebookIds?.length ?? 0) > 0 ? `·${play.lorebookIds?.length} 书` : ''}
                    {play.narratorEnabled ? '·叙' : ''}
                  </span>
                </span>
              </button>
            )
          })}
        </div>
      </div>

      {/* Chat area */}
      <div className={css.chat}>
        {props.activePlayId === null ? (
          <div className={css.content}>
            <div className={css.createSheet}>
              <div className={css.createHeader}>
                <div className={css.createHeaderText}>
                  <div className={css.createTitle}>✦ 开启新扮演</div>
                  <div className={css.createSubtitle}>
                    新扮演会创建一个 DSH 会话（导演 agent）：角色卡组成系统提示，世界书按关键词自动注入，
                    聊天记录与轨迹完全走 DSH 会话。
                  </div>
                </div>
                <span className={`${css.castCount} ${selectedCharacters.length === 0 ? css.castCountEmpty : ''}`}>
                  {selectedCharacters.length === 0 ? '尚未选择角色' : `已选 ${selectedCharacters.length} 位`}
                </span>
              </div>

              <div className={css.createBasics}>
                <Field label="会话标题（留空使用第一位角色名）">
                  <input
                    className={css.fieldInput}
                    value={title}
                    placeholder="例如：酒馆之夜"
                    onChange={event => setTitle(event.target.value)}
                  />
                </Field>
                <Field label="预设">
                  <Select
                    value={presetId}
                    onChange={setPresetId}
                    options={props.presets.map(preset => ({ value: preset.id, label: preset.name }))}
                    placeholder="（使用默认模型）"
                  />
                </Field>
              </div>

              <div className={css.lorebookPicker}>
                <div className={css.lorebookPickerHead}>
                  <div className={css.lorebookPickerTitleRow}>
                    <span className={css.lorebookPickerTitle}>世界书（可多选）</span>
                    <span className={css.lorebookPickerHint}>按选择顺序合并注入，自动关键词激活</span>
                  </div>
                  <div className={css.lorebookPickerActions}>
                    <input
                      className={css.castSearch}
                      value={lorebookQuery}
                      placeholder="搜索世界书…"
                      aria-label="搜索世界书"
                      onChange={event => setLorebookQuery(event.target.value)}
                    />
                    {selectedLorebooks.length > 0 && (
                      <Button variant="ghost" onClick={clearLorebooks}>清空</Button>
                    )}
                    <span className={`${css.castCount} ${selectedLorebooks.length === 0 ? css.castCountEmpty : ''}`}>
                      {selectedLorebooks.length === 0 ? '未选择' : `已选 ${selectedLorebooks.length} 本`}
                    </span>
                  </div>
                </div>

                {selectedLorebooks.length > 0 && (
                  <div className={css.lorebookOrder}>
                    <span className={css.lorebookOrderLabel}>注入顺序</span>
                    {selectedLorebooks.map((book, index) => (
                      <button
                        key={book.id}
                        type="button"
                        className={css.lorebookOrderItem}
                        onClick={() => toggleLorebook(book.id)}
                        title={`点击移除「${book.name}」`}
                      >
                        <span className={css.lorebookOrderRank}>{index + 1}</span>
                        <span className={css.lorebookOrderName}>{book.name}</span>
                        <span className={css.lorebookOrderRemove} aria-hidden="true">×</span>
                      </button>
                    ))}
                  </div>
                )}

                {props.lorebooks.length === 0 ? (
                  <div className={css.castEmpty}>
                    <span className={css.castEmptyIcon}>✦</span>
                    <div className={css.castEmptyTitle}>还没有世界书</div>
                    <span className={css.hint}>导入 ST 世界书 JSON 后，可以在这里一次挂载多本。</span>
                    <Button variant="primary" onClick={props.onGoToLorebooks}>去「世界书」页导入</Button>
                  </div>
                ) : visibleLorebooks.length === 0 ? (
                  <div className={css.castEmpty}>
                    <span className={css.castEmptyIcon}>✦</span>
                    <div className={css.castEmptyTitle}>没有找到匹配的世界书</div>
                    <span className={css.hint}>试试其他书名或描述关键词。</span>
                    <Button onClick={() => setLorebookQuery('')}>清除搜索</Button>
                  </div>
                ) : (
                  <div className={css.lorebookGrid}>
                    {visibleLorebooks.map(book => {
                      const rank = lorebookIds.indexOf(book.id)
                      const isSelected = rank >= 0
                      const description = compactText(book.description)
                      return (
                        <button
                          key={book.id}
                          type="button"
                          className={`${css.lorebookCard} ${isSelected ? css.lorebookCardSelected : ''}`}
                          aria-pressed={isSelected}
                          title={isSelected ? `点击移除「${book.name}」` : `点击挂载「${book.name}」`}
                          onClick={() => toggleLorebook(book.id)}
                        >
                          <span className={css.lorebookCardCheck} aria-hidden="true">
                            {isSelected ? '✓' : ''}
                          </span>
                          <span className={css.lorebookCardBody}>
                            <span className={css.lorebookCardName}>{book.name}</span>
                            <span className={css.lorebookCardMeta}>
                              {book.entryCount ?? 0} 个条目{description !== '' ? ` · ${description}` : ''}
                            </span>
                          </span>
                          {isSelected && <span className={css.lorebookRank}>#{rank + 1}</span>}
                        </button>
                      )
                    })}
                  </div>
                )}
              </div>

              <div className={css.createModes}>
                <button
                  type="button"
                  className={`${css.modeCard} ${multiAgent && props.multiAgentAvailable ? css.modeCardOn : ''}`}
                  disabled={!props.multiAgentAvailable}
                  aria-pressed={multiAgent && props.multiAgentAvailable}
                  onClick={() => setMultiAgent(prev => !prev)}
                  title={props.multiAgentAvailable ? '每个角色使用独立的 DSH agent 与记忆' : '当前未检测到 agent-loop 工厂，不可用'}
                >
                  <span className={css.modeCardTitle}>多 agent 模式</span>
                  <span className={css.modeCardText}>
                    每个角色是独立的 DSH agent，导演通过 tavern_speak 工具调遣
                    {!props.multiAgentAvailable ? '（不可用）' : ''}
                  </span>
                </button>
                <button
                  type="button"
                  className={`${css.modeCard} ${narratorEnabled ? css.modeCardOn : ''}`}
                  aria-pressed={narratorEnabled}
                  onClick={() => setNarratorEnabled(prev => !prev)}
                  title="导演额外描写场景与旁白"
                >
                  <span className={css.modeCardTitle}>叙述者</span>
                  <span className={css.modeCardText}>导演负责描写场景过渡与旁白</span>
                </button>
              </div>

              <div className={css.castPicker}>
                <div className={css.castPickerHead}>
                  <div className={css.castPickerTitleRow}>
                    <span className={css.castPickerTitle}>登场角色</span>
                    <span className={css.castPickerHint}>点击卡片加入或移除 · 第 1 位为主角</span>
                  </div>
                  <div className={css.castPickerActions}>
                    <input
                      className={css.castSearch}
                      value={characterQuery}
                      placeholder="搜索名字、标签或设定…"
                      aria-label="搜索角色"
                      onChange={event => setCharacterQuery(event.target.value)}
                    />
                    {selectedCharacters.length > 0 && (
                      <Button variant="ghost" onClick={clearSelection}>清空</Button>
                    )}
                  </div>
                </div>

                {selectedCharacters.length > 0 && (
                  <div className={css.castOrder}>
                    <span className={css.castOrderLabel}>出场顺序</span>
                    {selectedCharacters.map((character, index) => (
                      <button
                        key={character.id}
                        type="button"
                        className={`${css.castOrderItem} ${index === 0 ? css.castOrderItemMain : ''}`}
                        onClick={() => makeMain(character.id)}
                        title={index === 0 ? '当前主角（第 1 位）' : `点击将「${character.name}」设为主角`}
                      >
                        {character.avatar !== undefined
                          ? <img className={css.castOrderAvatar} src={avatarSrc(character.avatar)} alt="" />
                          : <span className={css.castOrderAvatar}>{firstGrapheme(character.name)}</span>}
                        <span className={css.castOrderName}>{character.name}</span>
                        <span className={css.castOrderRank}>{index === 0 ? '★ 主角' : `#${index + 1}`}</span>
                      </button>
                    ))}
                  </div>
                )}

                {props.characters.length === 0 ? (
                  <div className={css.castEmpty}>
                    <span className={css.castEmptyIcon}>✦</span>
                    <div className={css.castEmptyTitle}>角色库还是空的</div>
                    <span className={css.hint}>
                      导入 SillyTavern / TauriTavern 人物卡后，就能在这里挑选登场角色。
                    </span>
                    <Button variant="primary" onClick={props.onGoToCharacters}>去「角色」页导入</Button>
                  </div>
                ) : visibleCharacters.length === 0 ? (
                  <div className={css.castEmpty}>
                    <span className={css.castEmptyIcon}>✦</span>
                    <div className={css.castEmptyTitle}>没有找到匹配的角色</div>
                    <span className={css.hint}>试试其他名字、标签或设定关键词。</span>
                    <Button onClick={() => setCharacterQuery('')}>清除搜索</Button>
                  </div>
                ) : (
                  <div className={css.castGrid}>
                    {visibleCharacters.map(character => {
                      const rank = selectedIds.indexOf(character.id)
                      const isSelected = rank >= 0
                      const summary = compactText(character.description)
                        || compactText(character.personality)
                        || '暂无设定摘要，点击选择这位角色'
                      return (
                        <button
                          key={character.id}
                          type="button"
                          className={`${css.castCard} ${isSelected ? css.castCardSelected : ''}`}
                          aria-pressed={isSelected}
                          title={isSelected ? `点击移除「${character.name}」` : `点击选择「${character.name}」`}
                          onClick={() => toggleSelect(character.id)}
                        >
                          <span className={css.castCardMedia}>
                            {character.avatar !== undefined
                              ? <img className={css.castCardAvatar} src={avatarSrc(character.avatar)} alt="" />
                              : <span className={css.castCardAvatar}>{firstGrapheme(character.name)}</span>}
                          </span>
                          {isSelected && (
                            <span className={`${css.castRank} ${rank === 0 ? css.castRankMain : ''}`}>
                              {rank === 0 ? '★ 主角' : `#${rank + 1}`}
                            </span>
                          )}
                          <span className={css.castCheck} aria-hidden="true">
                            {isSelected ? '✓' : ''}
                          </span>
                          <span className={css.castCardBody}>
                            <span className={css.castCardName}>{character.name}</span>
                            <span className={css.castCardDesc}>{summary}</span>
                            {(character.tags?.length ?? 0) > 0 && (
                              <span className={css.castCardTags}>
                                {character.tags!.slice(0, 3).map(tag => `#${tag}`).join(' ')}
                              </span>
                            )}
                          </span>
                        </button>
                      )
                    })}
                  </div>
                )}
              </div>

              <div className={css.createFooter}>
                <Button
                  variant="primary"
                  disabled={selectedCharacters.length === 0 || creating}
                  onClick={() => void submitCreate()}
                >
                  {creating ? <Spinner /> : '开始扮演'}
                </Button>
                <span className={css.hint}>
                  {selectedCharacters.length === 0
                    ? '至少选择一位角色才能开场。'
                    : selectedCharacters[0] !== undefined
                      ? `第一位「${selectedCharacters[0].name}」将作为主角。`
                      : ''}
                </span>
              </div>
            </div>
          </div>
        ) : (
          <>
            <div className={css.chatHead}>
              <span className={css.chatTitle}>{props.activePlayTitle ?? '酒馆会话'}</span>
              {!inPlaySession && (
                <span className={css.badge}>当前会话未绑定，请从左侧选择</span>
              )}
              <div style={{ flex: 1 }} />
              <Button
                variant="danger"
                onClick={() => {
                  if (confirmAction(`删除会话「${props.activePlayTitle ?? ''}」？`)) {
                    void props.onDeletePlay(props.activePlayId!)
                  }
                }}
              >
                删除
              </Button>
            </div>
            <div
              className={css.messages}
              ref={listRef}
              onScroll={event => {
                const el = event.currentTarget
                pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
              }}
            >
              {props.messages.length === 0 && (
                <Empty text="对话尚未开始。发送第一句话开始这场扮演。" />
              )}
              {props.messages.map((message, index) => (
                <MessageRow
                  key={message.id}
                  message={message}
                  isLastAssistant={index === lastAssistantIndex && message.status !== 'streaming'}
                  busy={props.branching}
                  running={running}
                  swipe={props.swipe}
                  onRetry={props.onRetry}
                  onSwipe={props.onSwipe}
                  onSaveEdit={saveEdit}
                />
              ))}
              <div aria-hidden="true" />
            </div>
            <div className={css.composer}>
              <div className={css.composerRow}>
                <textarea
                  className={css.composerInput}
                  value={draft}
                  placeholder={inPlaySession ? '对角色说话…' : '请先在左侧选择一个酒馆会话'}
                  disabled={running || !inPlaySession}
                  onChange={event => setDraft(event.target.value)}
                  onKeyDown={event => {
                    // Enter also commits an IME candidate: a Chinese/Japanese
                    // user pressing it to pick a character must not send the
                    // half-composed pinyin. keyCode 229 is the legacy signal
                    // browsers still emit for the composition keystroke.
                    if (event.nativeEvent.isComposing || event.keyCode === 229) return
                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault()
                      send()
                    }
                  }}
                />
                {running ? (
                  <button
                    type="button"
                    className={`${css.sendBtn} ${css.stopBtn}`}
                    onClick={() => props.onCancel()}
                    title="停止当前输出"
                  >
                    停止
                  </button>
                ) : (
                  <button
                    type="button"
                    className={css.sendBtn}
                    disabled={props.branching || draft.trim() === '' || !inPlaySession}
                    onClick={send}
                  >
                    发送
                  </button>
                )}
              </div>
              <div className={css.modeRow}>
                <span>聊天通过 DSH 会话进行：回复会记录在会话日志（轨迹）中；酒馆会话只显示在本页，不会出现在「对话」页。</span>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

/** Collapsible reasoning (思维链) block for one reply. */
function ThinkingBlock(props: { text: string; streaming: boolean }) {
  const [open, setOpen] = useState(false)
  return (
    <div className={`${css.thinking} ${open ? css.thinkingOpen : ''}`}>
      <button
        type="button"
        className={css.thinkingToggle}
        onClick={() => setOpen(prev => !prev)}
        aria-expanded={open}
      >
        <span className={css.thinkingCaret}>{open ? '▾' : '▸'}</span>
        {props.streaming ? '思维链 · 思考中…' : '思维链'}
      </button>
      {open && <div className={css.thinkingBody}>{props.text}</div>}
    </div>
  )
}

/** Status label of one reply row (streaming / stopped / truncated / error). */
function StatusLine(props: { message: ViewMessage }) {
  const { message } = props
  if (message.kind !== 'assistant') return null
  if (message.status === 'streaming') {
    return <span className={css.msgStatusStreaming}><Spinner /> 正在输出…</span>
  }
  if (message.status === 'stopped') {
    return <span className={`${css.msgStatus} ${css.msgStatusWarn}`}>⏸ 已停止</span>
  }
  if (message.status === 'truncated') {
    return <span className={`${css.msgStatus} ${css.msgStatusWarn}`}>⚠ 已达长度上限，输出被截断</span>
  }
  if (message.status === 'error') {
    return (
      <span className={`${css.msgStatus} ${css.msgStatusError}`} title={message.errorText}>
        ✕ 生成出错：{message.errorText ?? '未知错误'}
      </span>
    )
  }
  return null
}

interface MessageRowProps {
  message: ViewMessage
  /** Whether this row is the final settled assistant reply (retry/swipe seat). */
  isLastAssistant: boolean
  busy: boolean
  running: boolean
  swipe?: SwipeBranchSummary
  onRetry: () => void
  onSwipe: (step: 1 | -1) => void
  /** Save an edit; the row reports its own address so the parent needs no closure. */
  onSaveEdit: (messageId: string, kind: ViewMessage['kind'], text: string) => void
}

/**
 * Rows are re-projected from the session snapshot on every streamed token, so
 * `message` is a fresh object each time even when the row it describes did not
 * change. Compare it field-wise: without this the memo would never hit during
 * streaming and the whole transcript would re-render per token.
 */
function sameMessageRow(prev: MessageRowProps, next: MessageRowProps): boolean {
  const a = prev.message
  const b = next.message
  return prev.isLastAssistant === next.isLastAssistant
    && prev.busy === next.busy
    && prev.running === next.running
    && prev.swipe === next.swipe
    && prev.onRetry === next.onRetry
    && prev.onSwipe === next.onSwipe
    && prev.onSaveEdit === next.onSaveEdit
    && a.id === b.id
    && a.kind === b.kind
    && a.name === b.name
    && a.text === b.text
    && a.thinking === b.thinking
    && a.status === b.status
    && a.errorText === b.errorText
    && a.messageId === b.messageId
    && a.stepText === b.stepText
}

const MessageRow = memo(function MessageRow(props: MessageRowProps) {
  const { message } = props
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const cls = message.kind === 'user'
    ? `${css.msg} ${css.msgUser}`
    : message.name === undefined
      ? `${css.msg} ${css.msgNarrator}`
      : css.msg
  const canEdit = message.messageId !== undefined && !props.running && !props.busy
  const showSwipe = props.isLastAssistant && props.swipe !== undefined && props.swipe.count > 1
  const showRetry = props.isLastAssistant && !props.running
  const streaming = message.status === 'streaming'
  // Rich rendering is per message and conditional twice over: the text has to
  // look like markup, and the sanitizer has to vouch for its own output (null
  // = could not, so show the source verbatim). Memoized because sanitizing is
  // a double DOM parse and the row also re-renders while its editor is open.
  const richHtml = useMemo(
    () => (looksLikeHtml(message.text) ? sanitizeMessageHtml(message.text) : null),
    [message.text],
  )

  const startEdit = (): void => {
    // Edits address the whole assistant step, so seed from the step text when
    // the row is only one speaker's slice of it.
    setDraft(message.stepText ?? message.text)
    setEditing(true)
  }

  return (
    <div className={cls}>
      <span className={css.msgName}>
        {message.kind === 'user' ? '你' : message.name ?? '叙述者'}
        {streaming && <Spinner />}
      </span>
      {message.thinking !== undefined && (
        <ThinkingBlock text={message.thinking} streaming={streaming} />
      )}
      {message.text !== '' && (editing ? (
        <div className={css.editArea}>
          <textarea
            className={css.editInput}
            value={draft}
            rows={Math.min(12, draft.split('\n').length + 1)}
            disabled={props.busy}
            onChange={event => setDraft(event.target.value)}
          />
          <div className={css.msgActions}>
            <Button
              variant="primary"
              disabled={props.busy || draft.trim() === ''}
              onClick={() => {
                if (message.messageId !== undefined) {
                  props.onSaveEdit(message.messageId, message.kind, draft.trim())
                }
                setEditing(false)
              }}
            >
              {message.kind === 'user' ? '保存并重新生成' : '保存'}
            </Button>
            <Button variant="ghost" disabled={props.busy} onClick={() => setEditing(false)}>取消</Button>
          </div>
        </div>
      ) : richHtml !== null ? (
        <div
          className={`${css.msgBubble} ${css.msgRich}`}
          dangerouslySetInnerHTML={{ __html: richHtml }}
        />
      ) : (
        <div className={css.msgBubble}>{message.text}</div>
      ))}
      <StatusLine message={message} />
      {!editing && (showRetry || canEdit) && (
        <div className={css.msgActions}>
          {showSwipe && (
            <span className={css.swipeNav}>
              <button
                type="button"
                className={css.swipeBtn}
                disabled={props.busy || props.swipe!.busy}
                onClick={() => props.onSwipe(-1)}
                title="上一条回复"
              >
                ‹
              </button>
              <span className={css.swipeCount}>
                {props.swipe!.current + 1}/{props.swipe!.count}
                {props.swipe!.busy ? ' ·生成中' : ''}
              </span>
              <button
                type="button"
                className={css.swipeBtn}
                disabled={props.busy || props.swipe!.busy}
                onClick={() => props.onSwipe(1)}
                title="下一条回复"
              >
                ›
              </button>
            </span>
          )}
          {showRetry && (
            <button
              type="button"
              className={css.msgActionBtn}
              disabled={props.busy || props.swipe?.busy === true}
              onClick={() => props.onRetry()}
              title="重新生成这条回复（旧回复保留在左右切换中）"
            >
              ↻ 重试
            </button>
          )}
          {canEdit && (
            <button
              type="button"
              className={css.msgActionBtn}
              onClick={startEdit}
              title={message.kind === 'user' ? '修改这条消息并重新生成' : '直接修改这条回复'}
            >
              ✎ 编辑
            </button>
          )}
          {props.swipe?.error !== undefined && props.isLastAssistant && (
            <span className={`${css.msgStatus} ${css.msgStatusError}`} title={props.swipe.error}>
              ✕ 上次重试失败
            </span>
          )}
        </div>
      )}
    </div>
  )
}, sameMessageRow)
