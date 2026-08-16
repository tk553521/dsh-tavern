/**
 * Local TauriTavern data-directory importer.
 *
 * TauriTavern stores its user data in the SillyTavern layout:
 *
 * - portable install:  <app>/data/default-user
 * - standard install:  <app-data>/data/default-user
 * - selected data root: <configured data_root>/default-user
 *
 * The importer accepts any of the app root, data root, or default-user path
 * (or a child directory such as .../default-user/characters), detects the
 * default-user directory, and batch-imports the tavern-managed categories:
 * character PNG cards, standalone world books, and AI presets.
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'

import { normalizeCard, normalizeWorldBook, importPreset } from './cardcodec.ts'
import { parsePngCard } from './png.ts'
import { newId, nowIso, type TavernStorage } from './storage.ts'
import type {
  CharacterRecord,
  Preset,
  TauriTavernImportIssue,
  TauriTavernImportReport,
  TauriTavernImportSelection,
  WorldBookRecord,
} from './types.ts'

const DEFAULT_USER_DIR = 'default-user'

/** Preset directories used by TauriTavern / SillyTavern. */
export const TAURITAVERN_PRESET_DIRS = [
  'KoboldAI Settings',
  'NovelAI Settings',
  'OpenAI Settings',
  'TextGen Settings',
  'instruct',
  'context',
  'sysprompt',
  'reasoning',
] as const

/** Directories that prove a directory is a TauriTavern user directory. */
const USER_DIR_MARKERS = ['characters', 'worlds', ...TAURITAVERN_PRESET_DIRS] as const

export interface ResolvedTauriTavernDirectory {
  /** The path the user supplied. */
  input: string
  /** TauriTavern data root (the parent of default-user). */
  root: string
  /** The detected default-user directory. */
  userDir: string
}

async function isDirectory(filePath: string): Promise<boolean> {
  try {
    return (await fs.stat(filePath)).isDirectory()
  } catch {
    return false
  }
}

async function isFile(filePath: string): Promise<boolean> {
  try {
    return (await fs.stat(filePath)).isFile()
  } catch {
    return false
  }
}

/** Read `data_root` from a `tauritavern-runtime.json` file, if present. */
async function runtimeConfiguredUserDir(appRoot: string): Promise<string | undefined> {
  const configPath = path.join(appRoot, 'tauritavern-runtime.json')
  if (!await isFile(configPath)) return undefined
  try {
    const config = JSON.parse(await fs.readFile(configPath, 'utf8')) as { data_root?: unknown }
    if (typeof config.data_root !== 'string' || config.data_root.trim() === '') return undefined
    const dataRoot = path.isAbsolute(config.data_root)
      ? path.normalize(config.data_root)
      : path.resolve(appRoot, config.data_root)
    return path.join(dataRoot, DEFAULT_USER_DIR)
  } catch {
    return undefined
  }
}

/**
 * Walk from the supplied path upward and find the TauriTavern
 * `default-user` directory. Supports:
 *
 * - `<app>/data/default-user` (portable / standard app data)
 * - `<app>/default-user` (when the app root is itself the data root)
 * - `<data-root>/default-user` (custom data root selected in TauriTavern)
 * - any child path of the above.
 */
export async function resolveTauriTavernDirectory(input: string): Promise<ResolvedTauriTavernDirectory> {
  const trimmed = input.trim()
  const raw = trimmed.length >= 2
    && ((trimmed[0] === '"' && trimmed.at(-1) === '"')
      || (trimmed[0] === "'" && trimmed.at(-1) === "'"))
    ? trimmed.slice(1, -1).trim()
    : trimmed
  if (raw === '') throw new Error('请输入 TauriTavern 安装目录或数据目录')
  if (!path.isAbsolute(raw)) {
    throw new Error('TauriTavern 目录必须是绝对路径，例如 E:\\TauriTavern')
  }

  let current = path.normalize(raw)
  while (true) {
    if (await isDirectory(current)) {
      // A custom data root configured through TauriTavern's
      // tauritavern-runtime.json takes precedence for that app root.
      const configured = await runtimeConfiguredUserDir(current)
      if (configured !== undefined && await isDirectory(configured)) {
        return {
          input: raw,
          root: path.dirname(configured),
          userDir: configured,
        }
      }

      const base = path.basename(current).toLowerCase()
      const candidates: Array<{ root: string; userDir: string }> = []
      if (base === DEFAULT_USER_DIR) {
        candidates.push({ root: path.dirname(current), userDir: current })
      }
      // Prefer the canonical TauriTavern layout `<app>/data/default-user`
      // when both `default-user` and `data/default-user` happen to exist.
      candidates.push({
        root: path.join(current, 'data'),
        userDir: path.join(current, 'data', DEFAULT_USER_DIR),
      })
      candidates.push({ root: current, userDir: path.join(current, DEFAULT_USER_DIR) })
      for (const candidate of candidates) {
        if (await isDirectory(candidate.userDir)) {
          return { input: raw, root: candidate.root, userDir: candidate.userDir }
        }
      }
    }

    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }

  // Windows standard installs keep user data under %APPDATA%, not next to
  // the executable. If the supplied path points at the TauriTavern program
  // directory, try the standard Tauri app-data locations before giving up.
  if (process.platform === 'win32' && /tauritavern/i.test(path.basename(raw))) {
    const appData = process.env.APPDATA
    if (appData !== undefined && appData !== '') {
      for (const name of ['com.tauritavern.client', 'TauriTavern', 'tauritavern']) {
        const base = path.join(appData, name)
        const configured = await runtimeConfiguredUserDir(base)
        if (configured !== undefined && await isDirectory(configured)) {
          return { input: raw, root: path.dirname(configured), userDir: configured }
        }
        for (const userDir of [
          path.join(base, 'data', DEFAULT_USER_DIR),
          path.join(base, DEFAULT_USER_DIR),
        ]) {
          if (await isDirectory(userDir)) {
            return { input: raw, root: path.dirname(userDir), userDir }
          }
        }
      }
    }
  }

  throw new Error(`未找到 TauriTavern 数据目录（${raw}）。请填写安装目录、data 目录或 default-user 目录`)
}

async function hasSupportedUserData(userDir: string): Promise<boolean> {
  for (const marker of USER_DIR_MARKERS) {
    if (await isDirectory(path.join(userDir, marker))) return true
  }
  return false
}

async function listFiles(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    return entries
      .filter(entry => entry.isFile() || entry.isSymbolicLink())
      .map(entry => entry.name)
      .sort((a, b) => a.localeCompare(b, 'zh-CN'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text
}

function relativeTo(userDir: string, filePath: string): string {
  const relative = path.relative(userDir, filePath)
  return relative === '' ? path.basename(filePath) : relative
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Normalize an import source path for case-insensitive comparison. */
function normalizeSource(source: string): string {
  return source.replace(/\\/g, '/').toLowerCase()
}

/** Keep only incoming records whose source path is not already imported. */
function dedupeBySource<T extends { source?: string }>(
  existing: readonly T[],
  incoming: readonly T[],
): T[] {
  const seen = new Set(existing
    .map(record => record.source)
    .filter((source): source is string => source !== undefined)
    .map(normalizeSource))
  return incoming.filter(record =>
    record.source === undefined || !seen.has(normalizeSource(record.source)))
}

/** Idempotence for world books imported before the source field existed. */
function dedupeLorebooks(
  existing: readonly WorldBookRecord[],
  incoming: readonly WorldBookRecord[],
): WorldBookRecord[] {
  const seen = new Set(existing
    .map(record => record.source !== undefined ? normalizeSource(record.source) : undefined)
    .filter((source): source is string => source !== undefined))
  const signatures = new Set(existing.map(record =>
    `${record.name}\u0000${JSON.stringify(record.book)}`))
  return incoming.filter(record => {
    if (record.source !== undefined && seen.has(normalizeSource(record.source))) return false
    return !signatures.has(`${record.name}\u0000${JSON.stringify(record.book)}`)
  })
}

/** Idempotence for presets imported before the source field existed. */
function dedupePresets(
  existing: readonly Preset[],
  incoming: readonly Preset[],
): Preset[] {
  const seen = new Set(existing
    .map(record => record.source !== undefined ? normalizeSource(record.source) : undefined)
    .filter((source): source is string => source !== undefined))
  const signatures = new Set(existing.map(record =>
    `${record.name}\u0000${JSON.stringify(record.raw ?? {})}`))
  return incoming.filter(record => {
    if (record.source !== undefined && seen.has(normalizeSource(record.source))) return false
    return !signatures.has(`${record.name}\u0000${JSON.stringify(record.raw ?? {})}`)
  })
}

/**
 * Parse the journal key used by TauriTavern's content-addressed character
 * records (`data/default-user/characters/<name>.png-<timestamp>`).
 */
function characterJournalStem(key: string): { stem: string; timestamp: number } | undefined {
  const normalized = key.replace(/\\/g, '/')
  const rel = normalized.startsWith('data/default-user/characters/')
    ? normalized.slice('data/default-user/characters/'.length)
    : normalized
  const match = /^(.+)\.png-(\d+(?:\.\d+)?)$/.exec(rel)
  if (match === null || match[1] === undefined || match[2] === undefined) return undefined
  const stem = match[1]
  if (stem.includes('/') || stem.includes('\\')) return undefined
  const timestamp = Number(match[2])
  if (!Number.isFinite(timestamp)) return undefined
  return { stem, timestamp }
}

/** Read one normal PNG/JSON character card. */
async function readCharacterFile(
  userDir: string,
  charactersDir: string,
  file: string,
): Promise<CharacterRecord> {
  const filePath = path.join(charactersDir, file)
  const source = relativeTo(userDir, filePath)
  const bytes = await fs.readFile(filePath)
  let card
  let avatar: string | undefined
  if (file.toLowerCase().endsWith('.png')) {
    const parsed = parsePngCard(bytes)
    if (parsed === null) {
      throw new Error('PNG 中未找到人物卡数据（chara/ccv3 tEXt 块）')
    }
    card = normalizeCard(JSON.parse(parsed.json), source)
    if (parsed.avatar !== undefined) {
      avatar = `data:image/png;base64,${parsed.avatar.toString('base64')}`
    }
  } else {
    const text = stripBom(bytes.toString('utf8'))
    card = normalizeCard(JSON.parse(text), source)
  }
  return {
    id: newId('char'),
    source,
    ...(avatar !== undefined ? { avatar } : {}),
    createdAt: nowIso(),
    updatedAt: nowIso(),
    card,
  }
}

/**
 * Fallback for TauriTavern data directories that only contain
 * content-addressed `{ key, value }` character journal files and no current
 * PNG cards: import the newest journal record per character file stem.
 */
async function importCharacterJournalRecords(
  userDir: string,
  charactersDir: string,
  files: readonly string[],
  issues: TauriTavernImportIssue[],
): Promise<CharacterRecord[]> {
  const latest = new Map<string, { timestamp: number; file: string }>()
  for (const file of files) {
    const filePath = path.join(charactersDir, file)
    const source = relativeTo(userDir, filePath)
    try {
      const parsed = JSON.parse(stripBom(await fs.readFile(filePath, 'utf8'))) as unknown
      if (typeof parsed !== 'object' || parsed === null) continue
      const record = parsed as { key?: unknown; value?: unknown }
      if (typeof record.key !== 'string') continue
      const stemInfo = characterJournalStem(record.key)
      if (stemInfo === undefined) continue
      const current = latest.get(stemInfo.stem.toLowerCase())
      if (current === undefined || stemInfo.timestamp > current.timestamp) {
        latest.set(stemInfo.stem.toLowerCase(), { timestamp: stemInfo.timestamp, file })
      }
    } catch (error) {
      issues.push({ category: 'character', file: source, reason: errorMessage(error) })
    }
  }

  const records: CharacterRecord[] = []
  for (const [stem, entry] of [...latest.entries()].sort(([a], [b]) => a.localeCompare(b, 'zh-CN'))) {
    const filePath = path.join(charactersDir, entry.file)
    const source = relativeTo(userDir, path.join(charactersDir, `${stem}.png`))
    try {
      const parsed = JSON.parse(stripBom(await fs.readFile(filePath, 'utf8'))) as { value?: unknown }
      const rawCard = typeof parsed.value === 'string'
        ? JSON.parse(parsed.value) as unknown
        : parsed.value
      records.push({
        id: newId('char'),
        source,
        createdAt: nowIso(),
        updatedAt: nowIso(),
        card: normalizeCard(rawCard, source),
      })
    } catch (error) {
      issues.push({ category: 'character', file: source, reason: errorMessage(error) })
    }
  }
  return records
}

async function importCharacters(
  userDir: string,
  charactersDir: string,
  issues: TauriTavernImportIssue[],
): Promise<CharacterRecord[]> {
  const allFiles = await listFiles(charactersDir)
  const normalFiles = allFiles.filter(name => /\.(png|json)$/i.test(name))
  const records: CharacterRecord[] = []

  for (const file of normalFiles) {
    try {
      records.push(await readCharacterFile(userDir, charactersDir, file))
    } catch (error) {
      issues.push({
        category: 'character',
        file: relativeTo(userDir, path.join(charactersDir, file)),
        reason: errorMessage(error),
      })
    }
  }

  // The hash-named `{ key, value }` files in a live TauriTavern characters
  // directory are historical journal entries. When current PNG cards exist
  // they win; the journal is only used as a recovery fallback.
  if (normalFiles.length === 0) {
    const journalFiles = allFiles.filter(name => !/\.(png|json)$/i.test(name))
    records.push(...await importCharacterJournalRecords(userDir, charactersDir, journalFiles, issues))
  }

  return records
}

async function importLorebooks(
  userDir: string,
  worldsDir: string,
  issues: TauriTavernImportIssue[],
): Promise<WorldBookRecord[]> {
  const records: WorldBookRecord[] = []
  const files = (await listFiles(worldsDir)).filter(name => name.toLowerCase().endsWith('.json'))

  for (const file of files) {
    const filePath = path.join(worldsDir, file)
    const source = relativeTo(userDir, filePath)
    try {
      const raw = JSON.parse(stripBom(await fs.readFile(filePath, 'utf8'))) as unknown
      const book = normalizeWorldBook(raw)
      const rawName = (raw as { name?: unknown } | null)?.name
      const name = typeof rawName === 'string' && rawName.trim() !== ''
        ? rawName
        : path.basename(file, '.json')
      records.push({
        id: newId('book'),
        name,
        source,
        createdAt: nowIso(),
        updatedAt: nowIso(),
        book,
      })
    } catch (error) {
      issues.push({ category: 'lorebook', file: source, reason: errorMessage(error) })
    }
  }
  return records
}

async function importPresets(
  userDir: string,
  issues: TauriTavernImportIssue[],
): Promise<Preset[]> {
  const records: Preset[] = []

  for (const dirName of TAURITAVERN_PRESET_DIRS) {
    const dir = path.join(userDir, dirName)
    const files = (await listFiles(dir)).filter(name => name.toLowerCase().endsWith('.json'))
    for (const file of files) {
      const filePath = path.join(dir, file)
      const source = relativeTo(userDir, filePath)
      try {
        const raw = JSON.parse(stripBom(await fs.readFile(filePath, 'utf8'))) as unknown
        const rawName = (raw as { name?: unknown } | null)?.name
        const name = typeof rawName === 'string' && rawName.trim() !== ''
          ? rawName
          : path.basename(file, '.json')
        const preset = importPreset(raw, newId('preset'), name)
        records.push({ ...preset, source })
      } catch (error) {
        issues.push({ category: 'preset', file: source, reason: errorMessage(error) })
      }
    }
  }
  return records
}

/** Normalize an optional boolean selection: absent means true, false disables. */
function selected(value: boolean | undefined): boolean {
  return value !== false
}

/**
 * Import supported TauriTavern user data from a local installation/data
 * directory into the tavern settings store.
 */
export async function importTauriTavernData(
  storage: TavernStorage,
  input: string,
  selection: Partial<TauriTavernImportSelection> = {},
): Promise<TauriTavernImportReport> {
  const categories: TauriTavernImportSelection = {
    characters: selected(selection.characters),
    lorebooks: selected(selection.lorebooks),
    presets: selected(selection.presets),
  }
  if (!categories.characters && !categories.lorebooks && !categories.presets) {
    throw new Error('请至少选择一种要导入的数据')
  }

  const resolved = await resolveTauriTavernDirectory(input)
  if (!await hasSupportedUserData(resolved.userDir)) {
    throw new Error(`目录 ${resolved.userDir} 中未找到 TauriTavern 数据（characters / worlds / 预设目录）`)
  }

  // Read the persisted library once. Every `storage.list*()` call would
  // re-read the whole (potentially large) settings document.
  const db = storage.snapshot()
  const issues: TauriTavernImportIssue[] = []
  const report: TauriTavernImportReport = {
    input: resolved.input,
    root: resolved.root,
    userDir: resolved.userDir,
    imported: { characters: 0, lorebooks: 0, presets: 0 },
    issues,
  }

  if (categories.characters) {
    const records = dedupeBySource(
      db.characters,
      await importCharacters(resolved.userDir, path.join(resolved.userDir, 'characters'), issues),
    )
    await storage.appendCharacters(records)
    report.imported.characters = records.length
  }

  if (categories.lorebooks) {
    const records = dedupeLorebooks(
      db.lorebooks,
      await importLorebooks(resolved.userDir, path.join(resolved.userDir, 'worlds'), issues),
    )
    await storage.appendLorebooks(records)
    report.imported.lorebooks = records.length
  }

  if (categories.presets) {
    const records = dedupePresets(
      db.presets,
      await importPresets(resolved.userDir, issues),
    )
    await storage.appendPresets(records)
    report.imported.presets = records.length
  }

  return report
}
