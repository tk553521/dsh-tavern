/**
 * Character library panel: card grid, import (PNG/JSON), editor, export.
 */
import { useRef, useState } from 'react'
import type { CharacterRecord } from '../../types.ts'
import { fileToDataUrl, fileToText, type TavernApi } from '../api.ts'
import css from '../TavernView.module.css'
import { Button, Empty, Field, Select, TextArea, TextInput, confirmAction } from './common.tsx'

export interface CharacterPanelProps {
  api: TavernApi
  characters: CharacterRecord[]
  selectedId: string | null
  onSelect: (id: string | null) => void
  onChanged: () => Promise<void>
  onError: (message: string) => void
}

export function CharacterPanel(props: CharacterPanelProps) {
  const selected = props.characters.find(c => c.id === props.selectedId) ?? null
  const fileRef = useRef<HTMLInputElement | null>(null)
  const [importing, setImporting] = useState(false)
  const [importText, setImportText] = useState('')
  const [showImport, setShowImport] = useState(false)

  const importFile = async (file: File): Promise<void> => {
    setImporting(true)
    try {
      const isPng = file.type === 'image/png' || file.name.toLowerCase().endsWith('.png')
      const input = isPng ? await fileToDataUrl(file) : await fileToText(file)
      await props.api.createCharacter({ input, source: file.name })
      await props.onChanged()
    } catch (error) {
      props.onError(error instanceof Error ? error.message : String(error))
    } finally {
      setImporting(false)
    }
  }

  const importTextCard = async (): Promise<void> => {
    if (importText.trim() === '') return
    setImporting(true)
    try {
      await props.api.createCharacter({ input: importText.trim(), source: '粘贴' })
      setImportText('')
      setShowImport(false)
      await props.onChanged()
    } catch (error) {
      props.onError(error instanceof Error ? error.message : String(error))
    } finally {
      setImporting(false)
    }
  }

  const deleteSelected = async (): Promise<void> => {
    if (selected === null) return
    if (!confirmAction(`删除角色「${selected.card.data.name}」？相关会话将保留历史但不再指派。`)) return
    await props.api.deleteCharacter(selected.id)
    props.onSelect(null)
    await props.onChanged()
  }

  return (
    <div className={css.body}>
      <div className={css.sidebar}>
        <div className={css.sidebarHead}>
          <span className={css.sidebarTitle}>角色库（{props.characters.length}）</span>
          <Button onClick={() => { setShowImport(prev => !prev) }}>导入</Button>
          <input
            ref={fileRef}
            type="file"
            accept=".png,.json,image/png,application/json"
            style={{ display: 'none' }}
            onChange={event => {
              const file = event.target.files?.[0]
              if (file !== undefined) void importFile(file)
              event.target.value = ''
            }}
          />
          <Button variant="ghost" onClick={() => fileRef.current?.click()} disabled={importing}>
            {importing ? '导入中…' : '选择文件'}
          </Button>
        </div>
        {showImport && (
          <div className={css.section} style={{ padding: '8px 10px', gap: 6 }}>
            <span className={css.hint}>
              支持 SillyTavern / TauriTavern 人物卡：PNG 卡（含 chara 文本块）或 JSON 卡（v1/v2/v3）。
            </span>
            <TextArea
              value={importText}
              onChange={setImportText}
              placeholder='粘贴卡片 JSON…（{"spec":"chara_card_v2",…}）'
              rows={4}
            />
            <div className={css.row}>
              <Button variant="primary" disabled={importing || importText.trim() === ''} onClick={() => void importTextCard()}>
                导入 JSON
              </Button>
              <Button onClick={() => fileRef.current?.click()} disabled={importing}>
                导入 PNG / JSON 文件
              </Button>
            </div>
          </div>
        )}
        <div className={css.list}>
          {props.characters.length === 0 && <Empty text="角色库为空" />}
          {props.characters.map(character => (
            <button
              key={character.id}
              type="button"
              className={`${css.listItem} ${character.id === props.selectedId ? css.listItemActive : ''}`}
              onClick={() => props.onSelect(character.id)}
            >
              {character.avatar !== undefined
                ? <img className={css.listItemAvatar} src={character.avatar} alt="" />
                : <span className={css.listItemAvatar} />}
              <span className={css.listItemName}>{character.card.data.name}</span>
            </button>
          ))}
        </div>
      </div>

      <div className={css.content}>
        {selected === null ? (
          <Empty text="选择左侧角色查看详情，或导入新的人物卡" />
        ) : (
          <CharacterEditor
            key={selected.id}
            api={props.api}
            character={selected}
            onChanged={props.onChanged}
            onError={props.onError}
            onDelete={deleteSelected}
          />
        )}
      </div>
    </div>
  )
}

function CharacterEditor(props: {
  api: TavernApi
  character: CharacterRecord
  onChanged: () => Promise<void>
  onError: (message: string) => void
  onDelete: () => Promise<void>
}) {
  const data = props.character.card.data
  const [name, setName] = useState(data.name)
  const [description, setDescription] = useState(data.description)
  const [personality, setPersonality] = useState(data.personality)
  const [scenario, setScenario] = useState(data.scenario)
  const [firstMes, setFirstMes] = useState(data.first_mes)
  const [mesExample, setMesExample] = useState(data.mes_example)
  const [systemPrompt, setSystemPrompt] = useState(data.system_prompt)
  const [postHistory, setPostHistory] = useState(data.post_history_instructions)
  const [tags, setTags] = useState(data.tags.join(', '))
  const [saving, setSaving] = useState(false)

  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      await props.api.updateCharacter(props.character.id, {
        name: name.trim() || data.name,
        description,
        personality,
        scenario,
        first_mes: firstMes,
        mes_example: mesExample,
        system_prompt: systemPrompt,
        post_history_instructions: postHistory,
        tags: tags.split(',').map(t => t.trim()).filter(t => t !== ''),
        creator: data.creator,
        creator_notes: data.creator_notes,
        character_version: data.character_version,
        alternate_greetings: data.alternate_greetings,
        ...(data.group_only_greetings !== undefined ? { group_only_greetings: data.group_only_greetings } : {}),
        ...(data.character_book !== undefined ? { character_book: data.character_book } : {}),
        extensions: data.extensions,
      })
      await props.onChanged()
      props.onError(null as unknown as string)
    } catch (error) {
      props.onError(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className={css.editor}>
      <div className={css.row} style={{ justifyContent: 'space-between' }}>
        <div className={css.row}>
          {props.character.avatar !== undefined
            ? <img className={css.cardAvatar} src={props.character.avatar} alt="" />
            : <span className={css.cardAvatar} />}
          <span className={css.sectionTitle} style={{ border: 'none', padding: 0 }}>
            {data.name}
          </span>
          <span className={css.badge}>{data.character_version || 'v?'}</span>
        </div>
        <div className={css.row}>
          <Button
            onClick={() => {
              const anchor = document.createElement('a')
              anchor.href = props.api.exportCharacterUrl(props.character.id)
              anchor.download = `${data.name}.png`
              document.body.appendChild(anchor)
              anchor.click()
              anchor.remove()
            }}
          >
            导出 PNG 卡
          </Button>
          <Button variant="danger" onClick={() => void props.onDelete()}>删除</Button>
        </div>
      </div>

      <Field label="名字">
        <TextInput value={name} onChange={setName} />
      </Field>
      <Field label="角色设定（description）">
        <TextArea value={description} onChange={setDescription} rows={5} />
      </Field>
      <Field label="性格（personality）">
        <TextArea value={personality} onChange={setPersonality} rows={4} />
      </Field>
      <Field label="场景（scenario）">
        <TextArea value={scenario} onChange={setScenario} rows={3} />
      </Field>
      <Field label="开场白（first_mes）">
        <TextArea value={firstMes} onChange={setFirstMes} rows={3} />
      </Field>
      <Field label="对话示例（mes_example）">
        <TextArea value={mesExample} onChange={setMesExample} rows={4} />
      </Field>
      <Field label="系统提示（system_prompt）">
        <TextArea value={systemPrompt} onChange={setSystemPrompt} rows={3} />
      </Field>
      <Field label="历史后指令（post_history_instructions）">
        <TextArea value={postHistory} onChange={setPostHistory} rows={2} />
      </Field>
      <Field label="标签（逗号分隔）">
        <TextInput value={tags} onChange={setTags} />
      </Field>
      <div className={css.row}>
        <Button variant="primary" disabled={saving} onClick={() => void save()}>
          {saving ? '保存中…' : '保存修改'}
        </Button>
        <span className={css.hint}>
          多 agent 模式下，每个角色是一个独立的 DSH agent（独立会话与记忆），
          其系统提示由本卡自动组装。
        </span>
      </div>
    </div>
  )
}
