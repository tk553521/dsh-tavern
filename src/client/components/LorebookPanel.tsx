/**
 * World-book (lorebook) panel: book list, entry viewer/editor, import/export.
 */
import { useState } from 'react'
import type { WorldBookEntry, WorldBookRecord } from '../../types.ts'
import { fileToText, type TavernApi } from '../api.ts'
import css from '../TavernView.module.css'
import { Button, Empty, Field, TextArea, TextInput, confirmAction } from './common.tsx'

export interface LorebookPanelProps {
  api: TavernApi
  lorebooks: WorldBookRecord[]
  selectedId: string | null
  onSelect: (id: string | null) => void
  onChanged: () => Promise<void>
  onError: (message: string) => void
}

export function LorebookPanel(props: LorebookPanelProps) {
  const selected = props.lorebooks.find(book => book.id === props.selectedId) ?? null
  const [importText, setImportText] = useState('')
  const [newName, setNewName] = useState('')

  const importBook = async (text: string): Promise<void> => {
    try {
      await props.api.createLorebook({ input: text, name: newName.trim() || undefined })
      setImportText('')
      setNewName('')
      await props.onChanged()
    } catch (error) {
      props.onError(error instanceof Error ? error.message : String(error))
    }
  }

  const deleteSelected = async (): Promise<void> => {
    if (selected === null) return
    if (!confirmAction(`删除世界书「${selected.name}」？使用它的会话将停止注入。`)) return
    try {
      await props.api.deleteLorebook(selected.id)
      props.onSelect(null)
      await props.onChanged()
    } catch (error) {
      props.onError(error instanceof Error ? error.message : String(error))
    }
  }

  return (
    <div className={css.body}>
      <div className={css.sidebar}>
        <div className={css.sidebarHead}>
          <span className={css.sidebarTitle}>世界书（{props.lorebooks.length}）</span>
        </div>
        <div className={css.list}>
          {props.lorebooks.length === 0 && <Empty text="还没有世界书" />}
          {props.lorebooks.map(book => (
            <button
              key={book.id}
              type="button"
              className={`${css.listItem} ${book.id === props.selectedId ? css.listItemActive : ''}`}
              onClick={() => props.onSelect(book.id)}
            >
              <span className={css.listItemName}>{book.name}</span>
              <span className={css.listItemMeta}>{book.book.entries.length} 条</span>
            </button>
          ))}
        </div>
      </div>

      <div className={css.content}>
        {selected === null ? (
          <div className={css.section}>
            <div className={css.sectionTitle}>导入世界书</div>
            <span className={css.hint}>
              支持 SillyTavern / TauriTavern 世界书 JSON
              （entries 为对象或数组均可），也支持角色卡内嵌 character_book 结构。
              世界书条目会在扮演时按关键词自动激活并注入提示词。
            </span>
            <Field label="书名（可选）">
              <TextInput value={newName} onChange={setNewName} placeholder="例如：剑与魔法大陆" />
            </Field>
            <Field label="世界书 JSON">
              <TextArea
                value={importText}
                onChange={setImportText}
                rows={8}
                placeholder='{"entries": {"0": {"key": ["酒馆"], "content": "…"}}}'
              />
            </Field>
            <div className={css.row}>
              <Button
                variant="primary"
                disabled={importText.trim() === ''}
                onClick={() => void importBook(importText)}
              >
                导入
              </Button>
              <Button
                onClick={() => {
                  const input = document.createElement('input')
                  input.type = 'file'
                  input.accept = '.json,application/json'
                  input.onchange = () => {
                    const file = input.files?.[0]
                    if (file !== undefined) {
                      void fileToText(file).then(text => importBook(text)).catch(error => {
                        props.onError(error instanceof Error ? error.message : String(error))
                      })
                    }
                  }
                  input.click()
                }}
              >
                选择文件
              </Button>
            </div>
            {props.lorebooks.length === 0 && <Empty text="左侧选择世界书查看条目" />}
          </div>
        ) : (
          <LorebookEditor
            // The editor seeds its state from the book props; without a key a
            // selection switch would keep editing the previous book and save
            // it over the newly selected one.
            key={selected.id}
            api={props.api}
            book={selected}
            onChanged={props.onChanged}
            onError={props.onError}
            onDelete={deleteSelected}
          />
        )}
      </div>
    </div>
  )
}

function LorebookEditor(props: {
  api: TavernApi
  book: WorldBookRecord
  onChanged: () => Promise<void>
  onError: (message: string) => void
  onDelete: () => Promise<void>
}) {
  const [name, setName] = useState(props.book.name)
  const [entries, setEntries] = useState<WorldBookEntry[]>(props.book.book.entries)
  const [saving, setSaving] = useState(false)

  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      await props.api.updateLorebook(props.book.id, { ...props.book.book, name, entries }, name)
      await props.onChanged()
    } catch (error) {
      props.onError(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }

  const updateEntry = (index: number, patch: Partial<WorldBookEntry>): void => {
    setEntries(prev => prev.map((entry, i) => i === index ? { ...entry, ...patch } : entry))
  }

  const addEntry = (): void => {
    const uid = entries.length > 0 ? Math.max(...entries.map(e => e.uid)) + 1 : 0
    setEntries(prev => [...prev, {
      uid,
      key: [],
      keysecondary: [],
      comment: '',
      content: '',
      constant: false,
      vectorized: false,
      selective: true,
      selectiveLogic: 0,
      addMemo: false,
      order: 100,
      position: 0,
      disable: false,
      ignoreBudget: false,
      excludeRecursion: false,
      preventRecursion: false,
      matchPersonaDescription: false,
      matchCharacterDescription: false,
      matchCharacterPersonality: false,
      matchCharacterDepthPrompt: false,
      matchScenario: false,
      matchCreatorNotes: false,
      delayUntilRecursion: 0,
      probability: 100,
      useProbability: true,
      depth: 4,
      outletName: '',
      group: '',
      groupOverride: false,
      groupWeight: 100,
      scanDepth: null,
      caseSensitive: null,
      matchWholeWords: null,
      useGroupScoring: null,
      automationId: '',
      role: 0,
      sticky: null,
      cooldown: null,
      delay: null,
      triggers: [],
      extensions: {},
    }])
  }

  return (
    <div className={css.editor} style={{ maxWidth: 'none' }}>
      <div className={css.row} style={{ justifyContent: 'space-between' }}>
        <div className={css.row}>
          <span className={css.sectionTitle} style={{ border: 'none', padding: 0 }}>{props.book.name}</span>
          <span className={css.badge}>{entries.length} 条</span>
        </div>
        <div className={css.row}>
          <Button
            onClick={() => {
              const anchor = document.createElement('a')
              anchor.href = props.api.exportLorebookUrl(props.book.id)
              anchor.download = `${props.book.name}.json`
              document.body.appendChild(anchor)
              anchor.click()
              anchor.remove()
            }}
          >
            导出 JSON
          </Button>
          <Button variant="danger" onClick={() => void props.onDelete()}>删除</Button>
        </div>
      </div>

      <Field label="书名">
        <TextInput value={name} onChange={setName} />
      </Field>

      <div className={css.row} style={{ justifyContent: 'space-between' }}>
        <span className={css.sectionTitle}>条目</span>
        <Button onClick={addEntry}>＋ 新条目</Button>
      </div>

      <div className={css.entryList}>
        {entries.length === 0 && <Empty text="还没有条目" />}
        {entries.map((entry, index) => (
          <div key={entry.uid} className={css.entry}>
            <div className={css.entryHead}>
              <span className={css.entryKeys}>
                关键词：{(entry.key ?? []).join('、') || '（无）'}
              </span>
              <Button
                variant="ghost"
                onClick={() => setEntries(prev => prev.filter((_, i) => i !== index))}
              >
                删除
              </Button>
            </div>
            <Field label="关键词（逗号分隔）">
              <TextInput
                value={(entry.key ?? []).join(', ')}
                onChange={value => updateEntry(index, {
                  key: value.split(',').map(s => s.trim()).filter(s => s !== ''),
                })}
              />
            </Field>
            <Field label="内容">
              <TextArea
                value={entry.content}
                onChange={value => updateEntry(index, { content: value })}
                rows={3}
              />
            </Field>
            <div className={css.row}>
              <label className={css.checkRow}>
                <input
                  type="checkbox"
                  checked={entry.constant}
                  onChange={event => updateEntry(index, { constant: event.target.checked })}
                />
                常驻
              </label>
              <label className={css.checkRow}>
                <input
                  type="checkbox"
                  checked={!entry.disable}
                  onChange={event => updateEntry(index, { disable: !event.target.checked })}
                />
                启用
              </label>
            </div>
          </div>
        ))}
      </div>

      <div className={css.row}>
        <Button variant="primary" disabled={saving} onClick={() => void save()}>
          {saving ? '保存中…' : '保存世界书'}
        </Button>
      </div>
    </div>
  )
}
