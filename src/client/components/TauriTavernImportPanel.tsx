/**
 * Local TauriTavern import panel: points the host plugin at a local
 * TauriTavern installation/data directory and batch-imports the tavern
 * categories it manages (characters, world books, presets).
 */
import { useState } from 'react'
import type { TauriTavernImportReport } from '../../types.ts'
import type { TavernApi } from '../api.ts'
import css from '../TavernView.module.css'
import { Button, Checkbox, Empty, Field, TextInput } from './common.tsx'

export interface TauriTavernImportPanelProps {
  api: TavernApi
  onChanged: () => Promise<void>
  onError: (message: string) => void
}

export function TauriTavernImportPanel(props: TauriTavernImportPanelProps) {
  const [path, setPath] = useState('E:\\TauriTavern')
  const [characters, setCharacters] = useState(true)
  const [lorebooks, setLorebooks] = useState(true)
  const [presets, setPresets] = useState(true)
  const [running, setRunning] = useState(false)
  const [report, setReport] = useState<TauriTavernImportReport | null>(null)

  const startImport = async (): Promise<void> => {
    if (path.trim() === '' || running) return
    setRunning(true)
    setReport(null)
    try {
      const result = await props.api.importTauriTavern({
        path: path.trim(),
        characters,
        lorebooks,
        presets,
      })
      setReport(result)
      await props.onChanged()
      props.onError(null as unknown as string)
    } catch (error) {
      props.onError(error instanceof Error ? error.message : String(error))
    } finally {
      setRunning(false)
    }
  }

  const total = report === null
    ? 0
    : report.imported.characters + report.imported.lorebooks + report.imported.presets

  return (
    <div className={css.content}>
      <div className={css.editor}>
        <span className={css.sectionTitle}>从本地 TauriTavern 目录导入</span>
        <span className={css.hint}>
          读取 DSH 进程所在机器上的原始 TauriTavern 数据目录（不会修改原目录）。
          可填写安装目录、data 目录、default-user 目录，或其下任意子目录。
        </span>

        <Field label="TauriTavern 安装 / 数据目录">
          <TextInput
            value={path}
            onChange={setPath}
            placeholder='例如 E:\TauriTavern 或 E:\TauriTavern\data\default-user'
            disabled={running}
          />
        </Field>

        <div className={css.row}>
          <Checkbox checked={characters} onChange={setCharacters} label="人物卡（characters/*.png、*.json）" />
          <Checkbox checked={lorebooks} onChange={setLorebooks} label="世界书（worlds/*.json）" />
          <Checkbox checked={presets} onChange={setPresets} label="预设（context / instruct / textgen 等）" />
        </div>

        <div className={css.row}>
          <Button
            variant="primary"
            disabled={running || path.trim() === '' || (!characters && !lorebooks && !presets)}
            onClick={() => void startImport()}
          >
            {running ? '导入中…' : '开始导入'}
          </Button>
          <span className={css.hint}>
            数据会追加到酒馆对应资料库；重复执行会自动跳过已导入的同源数据。
          </span>
        </div>

        {report === null ? (
          <Empty text="尚未从本地目录导入" />
        ) : (
          <div className={css.section} style={{ gap: 8 }}>
            <span className={css.sectionTitle} style={{ border: 'none', padding: 0 }}>
              导入完成：共 {total} 条
            </span>
            <span className={css.hint}>识别目录：{report.userDir}</span>
            <span className={css.hint}>
              人物卡 {report.imported.characters} · 世界书 {report.imported.lorebooks} · 预设 {report.imported.presets}
            </span>
            {report.issues.length > 0 && (
              <div className={css.entryList}>
                {report.issues.map((issue, index) => (
                  <div key={`${issue.file}-${index}`} className={css.entry}>
                    <span className={css.entryHead}>
                      <span className={css.entryKeys}>{issue.category} / {issue.file}</span>
                      <span className={css.hint}>跳过</span>
                    </span>
                    <span className={css.entryContent}>{issue.reason}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
