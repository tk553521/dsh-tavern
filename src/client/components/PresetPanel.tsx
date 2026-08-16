/**
 * Preset panel: preset list, sampler editor, import/export.
 */
import { useState } from 'react'
import type { Preset } from '../../types.ts'
import { fileToText, type TavernApi } from '../api.ts'
import css from '../TavernView.module.css'
import { Button, Empty, Field, TextArea, TextInput, confirmAction } from './common.tsx'

export interface PresetPanelProps {
  api: TavernApi
  presets: Preset[]
  selectedId: string | null
  defaultPresetId?: string
  onSelect: (id: string | null) => void
  onChanged: () => Promise<void>
  onError: (message: string) => void
}

export function PresetPanel(props: PresetPanelProps) {
  const selected = props.presets.find(preset => preset.id === props.selectedId) ?? null
  const [importText, setImportText] = useState('')
  const [newName, setNewName] = useState('')

  const importPreset = async (text: string): Promise<void> => {
    try {
      const raw = JSON.parse(text)
      await props.api.createPreset({ preset: raw, name: newName.trim() || undefined })
      setImportText('')
      setNewName('')
      await props.onChanged()
    } catch (error) {
      props.onError(error instanceof Error ? error.message : String(error))
    }
  }

  const deleteSelected = async (): Promise<void> => {
    if (selected === null) return
    if (!confirmAction(`删除预设「${selected.name}」？`)) return
    await props.api.deletePreset(selected.id)
    props.onSelect(null)
    await props.onChanged()
  }

  return (
    <div className={css.body}>
      <div className={css.sidebar}>
        <div className={css.sidebarHead}>
          <span className={css.sidebarTitle}>预设（{props.presets.length}）</span>
        </div>
        <div className={css.list}>
          {props.presets.length === 0 && <Empty text="还没有预设" />}
          {props.presets.map(preset => (
            <button
              key={preset.id}
              type="button"
              className={`${css.listItem} ${preset.id === props.selectedId ? css.listItemActive : ''}`}
              onClick={() => props.onSelect(preset.id)}
            >
              <span className={css.listItemName}>
                {preset.name}
                {preset.id === props.defaultPresetId ? ' ★' : ''}
              </span>
            </button>
          ))}
        </div>
      </div>

      <div className={css.content}>
        {selected === null ? (
          <div className={css.section}>
            <div className={css.sectionTitle}>导入预设</div>
            <span className={css.hint}>
              支持 SillyTavern / TauriTavern 预设 JSON（OpenAI / TextGen / Kobold 等类型均可）。
              采样参数（温度、top_p、重复惩罚等）与模型路由会在生成时应用。
            </span>
            <Field label="预设名（可选，留空用 JSON 内 name）">
              <TextInput value={newName} onChange={setNewName} placeholder="例如：角色扮演-创意" />
            </Field>
            <Field label="预设 JSON">
              <TextArea
                value={importText}
                onChange={setImportText}
                rows={8}
                placeholder='{"temp": 1.1, "top_p": 0.95, "rep_pen": 1.08, …}'
              />
            </Field>
            <div className={css.row}>
              <Button
                variant="primary"
                disabled={importText.trim() === ''}
                onClick={() => void importPreset(importText)}
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
                      void fileToText(file).then(text => importPreset(text)).catch(error => {
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
          </div>
        ) : (
          <PresetEditor
            api={props.api}
            preset={selected}
            isDefault={selected.id === props.defaultPresetId}
            onChanged={props.onChanged}
            onError={props.onError}
            onDelete={deleteSelected}
          />
        )}
      </div>
    </div>
  )
}

function numberField(value: number | undefined): string {
  return value === undefined ? '' : String(value)
}

function parseNumber(text: string): number | null | undefined {
  if (text.trim() === '') return null
  const value = Number(text)
  return Number.isFinite(value) ? value : undefined
}

function PresetEditor(props: {
  api: TavernApi
  preset: Preset
  isDefault: boolean
  onChanged: () => Promise<void>
  onError: (message: string) => void
  onDelete: () => Promise<void>
}) {
  const preset = props.preset
  const [name, setName] = useState(preset.name)
  const [model, setModel] = useState(preset.model ?? '')
  const [provider, setProvider] = useState(preset.provider ?? '')
  const [maxTokens, setMaxTokens] = useState(numberField(preset.maxTokens))
  const [temperature, setTemperature] = useState(numberField(preset.temperature))
  const [topP, setTopP] = useState(numberField(preset.topP))
  const [topK, setTopK] = useState(numberField(preset.topK))
  const [topA, setTopA] = useState(numberField(preset.topA))
  const [typicalP, setTypicalP] = useState(numberField(preset.typicalP))
  const [minP, setMinP] = useState(numberField(preset.minP))
  const [repPen, setRepPen] = useState(numberField(preset.repPen))
  const [repPenRange, setRepPenRange] = useState(numberField(preset.repPenRange))
  const [repPenSlope, setRepPenSlope] = useState(numberField(preset.repPenSlope))
  const [presencePenalty, setPresencePenalty] = useState(numberField(preset.presencePenalty))
  const [frequencyPenalty, setFrequencyPenalty] = useState(numberField(preset.frequencyPenalty))
  const [systemPrompt, setSystemPrompt] = useState(preset.systemPrompt ?? '')
  const [saving, setSaving] = useState(false)

  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      await props.api.updatePreset(preset.id, {
        name: name.trim() || preset.name,
        model: model.trim() === '' ? null : model.trim(),
        provider: provider.trim() === '' ? null : provider.trim(),
        maxTokens: parseNumber(maxTokens),
        temperature: parseNumber(temperature),
        topP: parseNumber(topP),
        topK: parseNumber(topK),
        topA: parseNumber(topA),
        typicalP: parseNumber(typicalP),
        minP: parseNumber(minP),
        repPen: parseNumber(repPen),
        repPenRange: parseNumber(repPenRange),
        repPenSlope: parseNumber(repPenSlope),
        presencePenalty: parseNumber(presencePenalty),
        frequencyPenalty: parseNumber(frequencyPenalty),
        systemPrompt,
      })
      await props.onChanged()
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
          <span className={css.sectionTitle} style={{ border: 'none', padding: 0 }}>
            {preset.name} {props.isDefault ? '（默认）' : ''}
          </span>
        </div>
        <div className={css.row}>
          <Button
            onClick={() => {
              const anchor = document.createElement('a')
              anchor.href = props.api.exportPresetUrl(preset.id)
              anchor.download = `${preset.name}.json`
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

      <div className={css.row}>
        <Field label="名称">
          <TextInput value={name} onChange={setName} />
        </Field>
        <Field label="模型（custom_model）">
          <TextInput value={model} onChange={setModel} placeholder="例如 deepseek-chat" />
        </Field>
        <Field label="Provider（DSH 路由）">
          <TextInput value={provider} onChange={setProvider} placeholder="留空用默认" />
        </Field>
      </div>

      <div className={css.sectionTitle}>采样参数</div>
      <div className={css.row}>
        <Field label="温度 temp">
          <TextInput value={temperature} onChange={setTemperature} placeholder="1.0" />
        </Field>
        <Field label="top_p">
          <TextInput value={topP} onChange={setTopP} placeholder="0.95" />
        </Field>
        <Field label="top_k">
          <TextInput value={topK} onChange={setTopK} placeholder="0" />
        </Field>
        <Field label="top_a">
          <TextInput value={topA} onChange={setTopA} placeholder="0" />
        </Field>
      </div>
      <div className={css.row}>
        <Field label="typical_p">
          <TextInput value={typicalP} onChange={setTypicalP} placeholder="1" />
        </Field>
        <Field label="min_p">
          <TextInput value={minP} onChange={setMinP} placeholder="0" />
        </Field>
        <Field label="重复惩罚 rep_pen">
          <TextInput value={repPen} onChange={setRepPen} placeholder="1.08" />
        </Field>
        <Field label="rep_pen_range">
          <TextInput value={repPenRange} onChange={setRepPenRange} placeholder="1024" />
        </Field>
      </div>
      <div className={css.row}>
        <Field label="rep_pen_slope">
          <TextInput value={repPenSlope} onChange={setRepPenSlope} placeholder="0.7" />
        </Field>
        <Field label="存在惩罚">
          <TextInput value={presencePenalty} onChange={setPresencePenalty} placeholder="0" />
        </Field>
        <Field label="频率惩罚">
          <TextInput value={frequencyPenalty} onChange={setFrequencyPenalty} placeholder="0" />
        </Field>
        <Field label="max_tokens">
          <TextInput value={maxTokens} onChange={setMaxTokens} placeholder="模型默认" />
        </Field>
      </div>

      <Field label="系统提示覆盖（叠加在角色卡之上）">
        <TextArea value={systemPrompt} onChange={setSystemPrompt} rows={3} />
      </Field>

      <div className={css.row}>
        <Button variant="primary" disabled={saving} onClick={() => void save()}>
          {saving ? '保存中…' : '保存预设'}
        </Button>
      </div>
    </div>
  )
}
