/**
 * Chat panel: play list, session message thread (from the DSH session
 * snapshot), composer, and play creation. The conversation itself is the
 * DSH session — sending routes through the conversation service.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { PlaySummary } from '../../types.ts'
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
  onSelectPlay: (id: string | null) => void
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
  const bottomRef = useRef<HTMLDivElement | null>(null)

  // Scroll to bottom when the message list grows.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' })
  }, [props.messages.length])

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
    } finally {
      setCreating(false)
    }
  }

  const send = (): void => {
    const content = draft.trim()
    if (content === '' || running) return
    setDraft('')
    void props.onSend(content)
  }

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
            <div className={css.messages}>
              {props.messages.length === 0 && (
                <Empty text="对话尚未开始。发送第一句话开始这场扮演。" />
              )}
              {props.messages.map(message => (
                <MessageRow key={message.id} message={message} />
              ))}
              {running && (
                <div className={css.msg}>
                  <span className={css.msgName}><Spinner /> 角色正在酝酿台词…</span>
                </div>
              )}
              <div ref={bottomRef} />
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
                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault()
                      send()
                    }
                  }}
                />
                <button
                  type="button"
                  className={css.sendBtn}
                  disabled={running || draft.trim() === '' || !inPlaySession}
                  onClick={send}
                >
                  {running ? '…' : '发送'}
                </button>
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

function MessageRow(props: { message: ViewMessage }) {
  const { message } = props
  const cls = message.kind === 'user'
    ? `${css.msg} ${css.msgUser}`
    : message.name === undefined
      ? `${css.msg} ${css.msgNarrator}`
      : css.msg
  return (
    <div className={cls}>
      <span className={css.msgName}>
        {message.kind === 'user' ? '你' : message.name ?? '叙述者'}
      </span>
      <div className={css.msgBubble}>{message.text}</div>
    </div>
  )
}
