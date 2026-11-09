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
 *
 * Everything below the detected directory is untrusted: the directory may be
 * downloaded, shared, or crafted, its contents end up in the settings document
 * (which `GET /tavern/state` hands to the browser), and on Windows an
 * unprivileged user can drop a directory junction anywhere. Every read
 * therefore goes through `readContainedFile`, which refuses non-regular files,
 * oversized files, and anything that resolves outside the detected user
 * directory, and every skip is reported with a fixed reason so the report
 * cannot echo file bytes back to the client.
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'

import { normalizeCard, normalizeWorldBook, importPreset } from './cardcodec.ts'
import { parsePngCard } from './png.ts'
import { newId, nowIso, type TavernStorage } from './storage.ts'
import type { AvatarStore } from './avatarstore.ts'
import type {
  CharacterRecord,
  Preset,
  TauriTavernImportIssue,
  TauriTavernImportReport,
  TauriTavernImportSelection,
  WorldBookRecord,
} from './types.ts'

const DEFAULT_USER_DIR = 'default-user'
const RUNTIME_CONFIG_FILE = 'tauritavern-runtime.json'

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

/**
 * Per-category read caps. Without them a single planted file decides the host's
 * memory footprint: one 400MB file in `characters/` takes RSS from ~110MB to
 * ~920MB before anything is even parsed.
 */
const MAX_PNG_BYTES = 32 * 1024 * 1024
const MAX_JSON_BYTES = 8 * 1024 * 1024
const MAX_RUNTIME_CONFIG_BYTES = 1024 * 1024

/**
 * Issue reasons are fixed strings. The report travels to the browser, and a raw
 * `JSON.parse` message quotes the first bytes of the file it choked on
 * (`Unexpected token 'A', "AKIAIOSFOD"... is not valid JSON`), which would turn
 * every skipped file into a read oracle. Details go to the log instead.
 */
const REASON_UNREADABLE = '文件无法读取，已跳过'
const REASON_INVALID = '文件内容无法解析，已跳过'
const REASON_TOO_LARGE = '文件过大，已跳过'
const REASON_NOT_REGULAR_FILE = '不是常规文件，已跳过'
const REASON_OUTSIDE = '目标不在数据目录内（软链接 / junction），已跳过'
const REASON_NO_CARD = 'PNG 中未找到人物卡数据（chara/ccv3 tEXt 块）'
const REASON_CONFIG_ESCAPE = `${RUNTIME_CONFIG_FILE} 中的 data_root 指向安装目录之外，已忽略`

export interface ResolvedTauriTavernDirectory {
  /** The path the user supplied. */
  input: string
  /** TauriTavern data root (the parent of default-user). */
  root: string
  /** The detected default-user directory, resolved to its real path. */
  userDir: string
  /** Runtime-config redirects that were refused, reported as import issues. */
  refusedConfigs: string[]
}

/** The plugin logger, borrowed from the avatar store the importer receives. */
type ImportLogger = AvatarStore['logger']

/** Shared state for one import run: the boundary, the sinks, the logger. */
interface ImportContext {
  /** Canonical user directory; no read may resolve outside it. */
  userDir: string
  avatars: AvatarStore
  logger: ImportLogger
  issues: TauriTavernImportIssue[]
}

type FileRead = { ok: true; bytes: Buffer } | { ok: false; reason: string }

async function isDirectory(filePath: string): Promise<boolean> {
  try {
    return (await fs.stat(filePath)).isDirectory()
  } catch {
    return false
  }
}

/**
 * Containment test for two already-resolved paths. `path.relative` rather than
 * a string prefix, so that `/data/userX` is not mistaken for a child of
 * `/data/user`.
 */
function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child)
  if (relative === '') return true
  if (relative === '..' || relative.startsWith(`..${path.sep}`)) return false
  return !path.isAbsolute(relative)
}

/**
 * `path.isAbsolute` also accepts UNC and device paths. `\\host\share` makes
 * Windows authenticate to a remote SMB server (handing an attacker the user's
 * NTLM hash) and blocks every `stat` on a network timeout, while `\\.\` and
 * `\\?\` reach raw devices, so only a plain local drive path is allowed here.
 */
function isLocalAbsolutePath(input: string): boolean {
  if (/^[\\/]{2}/.test(input)) return false
  return process.platform === 'win32'
    ? /^[a-zA-Z]:[\\/]/.test(input)
    : path.isAbsolute(input)
}

/**
 * Read a file that has to be a regular file inside `root`.
 *
 * `lstat` first, because a symlink must be refused instead of followed; then
 * `realpath`, because a directory junction in the middle of the path is
 * invisible to any check done on the joined string; then the size, taken from
 * the open handle so the file cannot outgrow the cap between check and read.
 */
async function readContainedFile(
  root: string,
  filePath: string,
  maxBytes: number,
  logger?: ImportLogger,
): Promise<FileRead> {
  try {
    if (!(await fs.lstat(filePath)).isFile()) return { ok: false, reason: REASON_NOT_REGULAR_FILE }
    const real = await fs.realpath(filePath)
    if (!isInside(root, real)) return { ok: false, reason: REASON_OUTSIDE }

    const handle = await fs.open(real, 'r')
    try {
      const stats = await handle.stat()
      if (!stats.isFile()) return { ok: false, reason: REASON_NOT_REGULAR_FILE }
      if (stats.size > maxBytes) return { ok: false, reason: REASON_TOO_LARGE }
      if (stats.size === 0) return { ok: true, bytes: Buffer.alloc(0) }
      const bytes = Buffer.allocUnsafe(stats.size)
      const { bytesRead } = await handle.read(bytes, 0, stats.size, 0)
      return { ok: true, bytes: bytesRead === stats.size ? bytes : bytes.subarray(0, bytesRead) }
    } finally {
      await handle.close()
    }
  } catch (error) {
    logger?.warn('tavern import: cannot read %s: %s', filePath, String(error))
    return { ok: false, reason: REASON_UNREADABLE }
  }
}

/**
 * Read `data_root` from a `tauritavern-runtime.json` file, if present.
 *
 * The file sits in the (untrusted) directory the user pointed at, so it is not
 * allowed to move the import somewhere else: a `data_root` that leaves the app
 * root — absolute, or relative with enough `..` — is refused, not followed.
 */
async function runtimeConfiguredUserDir(
  appRoot: string,
): Promise<{ userDir?: string; refused: boolean }> {
  const read = await readContainedFile(
    appRoot,
    path.join(appRoot, RUNTIME_CONFIG_FILE),
    MAX_RUNTIME_CONFIG_BYTES,
  )
  if (!read.ok) return { refused: false }
  try {
    const config = JSON.parse(stripBom(read.bytes.toString('utf8'))) as { data_root?: unknown }
    if (typeof config.data_root !== 'string' || config.data_root.trim() === '') return { refused: false }
    const dataRoot = path.resolve(appRoot, config.data_root)
    if (!isInside(appRoot, dataRoot)) return { refused: true }
    return { userDir: path.join(dataRoot, DEFAULT_USER_DIR), refused: false }
  } catch {
    return { refused: false }
  }
}

/**
 * Canonicalize the detected directory before handing it out: it becomes the
 * boundary for every later read, and a junction anywhere along the path would
 * survive a comparison made on the unresolved form.
 */
async function resolvedDirectory(
  input: string,
  userDir: string,
  refusedConfigs: string[],
): Promise<ResolvedTauriTavernDirectory> {
  const real = await fs.realpath(userDir).catch(() => path.normalize(userDir))
  return { input, root: path.dirname(real), userDir: real, refusedConfigs }
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
  if (!isLocalAbsolutePath(raw)) {
    throw new Error('TauriTavern 目录必须是本机绝对路径（不支持 \\\\ 开头的网络或设备路径），例如 E:\\TauriTavern')
  }

  const refusedConfigs: string[] = []
  let current = path.normalize(raw)
  while (true) {
    if (await isDirectory(current)) {
      // A custom data root configured through TauriTavern's
      // tauritavern-runtime.json takes precedence for that app root.
      const configured = await runtimeConfiguredUserDir(current)
      if (configured.refused) refusedConfigs.push(path.join(current, RUNTIME_CONFIG_FILE))
      if (configured.userDir !== undefined && await isDirectory(configured.userDir)) {
        return resolvedDirectory(raw, configured.userDir, refusedConfigs)
      }

      const base = path.basename(current).toLowerCase()
      const candidates: string[] = []
      if (base === DEFAULT_USER_DIR) candidates.push(current)
      // Prefer the canonical TauriTavern layout `<app>/data/default-user`
      // when both `default-user` and `data/default-user` happen to exist.
      candidates.push(path.join(current, 'data', DEFAULT_USER_DIR))
      candidates.push(path.join(current, DEFAULT_USER_DIR))
      for (const candidate of candidates) {
        if (await isDirectory(candidate)) return resolvedDirectory(raw, candidate, refusedConfigs)
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
        if (configured.refused) refusedConfigs.push(path.join(base, RUNTIME_CONFIG_FILE))
        if (configured.userDir !== undefined && await isDirectory(configured.userDir)) {
          return resolvedDirectory(raw, configured.userDir, refusedConfigs)
        }
        for (const userDir of [
          path.join(base, 'data', DEFAULT_USER_DIR),
          path.join(base, DEFAULT_USER_DIR),
        ]) {
          if (await isDirectory(userDir)) return resolvedDirectory(raw, userDir, refusedConfigs)
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

/**
 * List the regular files directly inside `dir`.
 *
 * Symlinked entries are dropped, and the directory itself must still resolve
 * inside the user directory: a junction at `<user-dir>/instruct` (no privileges
 * required on Windows) would otherwise point the whole category read at an
 * unrelated part of the disk.
 */
async function listFiles(
  ctx: ImportContext,
  dir: string,
  category: TauriTavernImportIssue['category'],
): Promise<string[]> {
  let entries
  try {
    const real = await fs.realpath(dir)
    if (!isInside(ctx.userDir, real)) {
      ctx.issues.push({ category, file: relativeTo(ctx.userDir, dir), reason: REASON_OUTSIDE })
      return []
    }
    entries = await fs.readdir(real, { withFileTypes: true })
  } catch (error) {
    // Most preset directories simply do not exist; anything else is reported
    // but must not sink the categories that are still readable.
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ENOENT' && code !== 'ENOTDIR') {
      ctx.logger.warn('tavern import: cannot list %s: %s', dir, String(error))
      ctx.issues.push({ category, file: relativeTo(ctx.userDir, dir), reason: REASON_UNREADABLE })
    }
    return []
  }
  return entries
    .filter(entry => entry.isFile())
    .map(entry => entry.name)
    .sort((a, b) => a.localeCompare(b, 'zh-CN'))
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text
}

function relativeTo(userDir: string, filePath: string): string {
  const relative = path.relative(userDir, filePath)
  return relative === '' ? path.basename(filePath) : relative
}

/** Normalize an import source path for case-insensitive comparison. */
function normalizeSource(source: string): string {
  return source.replace(/\\/g, '/').toLowerCase()
}

/** Keep portable relative diagnostics, but namespace persisted identities by real root. */
function importSource(userDir: string, relative: string): string {
  const root = userDir.replace(/\\/g, '/')
  const canonical = process.platform === 'win32' ? root.toLowerCase() : root
  const namespace = createHash('sha256').update(canonical).digest('hex')
  return `tauritavern/${namespace}/${relative.replace(/\\/g, '/')}`
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

/** Store the avatar file now; a failed write keeps the inline data URL. */
async function materializeAvatar(
  ctx: ImportContext,
  record: CharacterRecord,
): Promise<CharacterRecord> {
  try {
    return await ctx.avatars.materializeCharacter(record)
  } catch (error) {
    ctx.logger.warn('tavern import: cannot store avatar for %s: %s', record.source ?? record.id, String(error))
    return record
  }
}

/** Read one normal PNG/JSON character card. */
async function readCharacterFile(
  ctx: ImportContext,
  charactersDir: string,
  file: string,
): Promise<CharacterRecord | undefined> {
  const filePath = path.join(charactersDir, file)
  const source = relativeTo(ctx.userDir, filePath)
  const isPng = file.toLowerCase().endsWith('.png')
  const read = await readContainedFile(
    ctx.userDir,
    filePath,
    isPng ? MAX_PNG_BYTES : MAX_JSON_BYTES,
    ctx.logger,
  )
  if (!read.ok) {
    ctx.issues.push({ category: 'character', file: source, reason: read.reason })
    return undefined
  }

  try {
    let card
    let avatar: string | undefined
    if (isPng) {
      const parsed = parsePngCard(read.bytes)
      if (parsed === null) {
        ctx.issues.push({ category: 'character', file: source, reason: REASON_NO_CARD })
        return undefined
      }
      card = normalizeCard(JSON.parse(parsed.json), source)
      if (parsed.avatar !== undefined) {
        avatar = `data:image/png;base64,${parsed.avatar.toString('base64')}`
      }
    } else {
      card = normalizeCard(JSON.parse(stripBom(read.bytes.toString('utf8'))), source)
    }
    return {
      id: newId('char'),
      source: importSource(ctx.userDir, source),
      ...(avatar !== undefined ? { avatar } : {}),
      createdAt: nowIso(),
      updatedAt: nowIso(),
      card,
    }
  } catch (error) {
    ctx.logger.warn('tavern import: cannot parse character %s: %s', source, String(error))
    ctx.issues.push({ category: 'character', file: source, reason: REASON_INVALID })
    return undefined
  }
}

/**
 * Fallback for TauriTavern data directories that only contain
 * content-addressed `{ key, value }` character journal files and no current
 * PNG cards: import the newest journal record per character file stem.
 */
async function importCharacterJournalRecords(
  ctx: ImportContext,
  charactersDir: string,
  files: readonly string[],
  isImported: (source: string) => boolean,
): Promise<CharacterRecord[]> {
  const latest = new Map<string, { timestamp: number; value: unknown }>()
  for (const file of files) {
    const filePath = path.join(charactersDir, file)
    const source = relativeTo(ctx.userDir, filePath)
    const read = await readContainedFile(ctx.userDir, filePath, MAX_JSON_BYTES, ctx.logger)
    if (!read.ok) {
      ctx.issues.push({ category: 'character', file: source, reason: read.reason })
      continue
    }
    try {
      const parsed = JSON.parse(stripBom(read.bytes.toString('utf8'))) as unknown
      if (typeof parsed !== 'object' || parsed === null) continue
      const record = parsed as { key?: unknown; value?: unknown }
      if (typeof record.key !== 'string') continue
      const stemInfo = characterJournalStem(record.key)
      if (stemInfo === undefined) continue
      const stem = stemInfo.stem.toLowerCase()
      const current = latest.get(stem)
      // The payload is kept here on purpose: re-opening the winning file in the
      // second pass read and parsed every surviving journal record twice.
      if (current === undefined || stemInfo.timestamp > current.timestamp) {
        latest.set(stem, { timestamp: stemInfo.timestamp, value: record.value })
      }
    } catch (error) {
      ctx.logger.warn('tavern import: cannot parse journal record %s: %s', source, String(error))
      ctx.issues.push({ category: 'character', file: source, reason: REASON_INVALID })
    }
  }

  const records: CharacterRecord[] = []
  for (const [stem, entry] of [...latest.entries()].sort(([a], [b]) => a.localeCompare(b, 'zh-CN'))) {
    const source = relativeTo(ctx.userDir, path.join(charactersDir, `${stem}.png`))
    if (isImported(source)) continue
    try {
      const rawCard = typeof entry.value === 'string'
        ? JSON.parse(entry.value) as unknown
        : entry.value
      records.push({
        id: newId('char'),
        source: importSource(ctx.userDir, source),
        createdAt: nowIso(),
        updatedAt: nowIso(),
        card: normalizeCard(rawCard, source),
      })
    } catch (error) {
      ctx.logger.warn('tavern import: cannot normalize journal record %s: %s', source, String(error))
      ctx.issues.push({ category: 'character', file: source, reason: REASON_INVALID })
    }
  }
  return records
}

async function importCharacters(
  ctx: ImportContext,
  charactersDir: string,
  isImported: (source: string) => boolean,
  isLegacyImported: (record: CharacterRecord) => boolean,
): Promise<CharacterRecord[]> {
  const allFiles = await listFiles(ctx, charactersDir, 'character')
  const normalFiles = allFiles.filter(name => /\.(png|json)$/i.test(name))
  const records: CharacterRecord[] = []

  for (const file of normalFiles) {
    if (isImported(relativeTo(ctx.userDir, path.join(charactersDir, file)))) continue
    const record = await readCharacterFile(ctx, charactersDir, file)
    if (record === undefined || isLegacyImported(record)) continue
    // Written to disk before the next card is read: holding every card's base64
    // avatar until the batch ends costs ~1.2GB for 500 one-megabyte cards, and
    // only the on-disk path is persisted anyway.
    records.push(await materializeAvatar(ctx, record))
  }

  // The hash-named `{ key, value }` files in a live TauriTavern characters
  // directory are historical journal entries. When current PNG cards exist
  // they win; the journal is only used as a recovery fallback.
  if (normalFiles.length === 0) {
    const journalFiles = allFiles.filter(name => !/\.(png|json)$/i.test(name))
    const journal = await importCharacterJournalRecords(ctx, charactersDir, journalFiles, isImported)
    records.push(...journal.filter(record => !isLegacyImported(record)))
  }

  return records
}

async function importLorebooks(ctx: ImportContext, worldsDir: string): Promise<WorldBookRecord[]> {
  const records: WorldBookRecord[] = []
  const files = (await listFiles(ctx, worldsDir, 'lorebook'))
    .filter(name => name.toLowerCase().endsWith('.json'))

  for (const file of files) {
    const filePath = path.join(worldsDir, file)
    const source = relativeTo(ctx.userDir, filePath)
    const read = await readContainedFile(ctx.userDir, filePath, MAX_JSON_BYTES, ctx.logger)
    if (!read.ok) {
      ctx.issues.push({ category: 'lorebook', file: source, reason: read.reason })
      continue
    }
    try {
      const raw = JSON.parse(stripBom(read.bytes.toString('utf8'))) as unknown
      const book = normalizeWorldBook(raw)
      const rawName = (raw as { name?: unknown } | null)?.name
      const name = typeof rawName === 'string' && rawName.trim() !== ''
        ? rawName
        : path.basename(file, '.json')
      records.push({
        id: newId('book'),
        name,
        source: importSource(ctx.userDir, source),
        createdAt: nowIso(),
        updatedAt: nowIso(),
        book,
      })
    } catch (error) {
      ctx.logger.warn('tavern import: cannot parse world book %s: %s', source, String(error))
      ctx.issues.push({ category: 'lorebook', file: source, reason: REASON_INVALID })
    }
  }
  return records
}

async function importPresets(ctx: ImportContext): Promise<Preset[]> {
  const records: Preset[] = []

  for (const dirName of TAURITAVERN_PRESET_DIRS) {
    const dir = path.join(ctx.userDir, dirName)
    const files = (await listFiles(ctx, dir, 'preset'))
      .filter(name => name.toLowerCase().endsWith('.json'))
    for (const file of files) {
      const filePath = path.join(dir, file)
      const source = relativeTo(ctx.userDir, filePath)
      const read = await readContainedFile(ctx.userDir, filePath, MAX_JSON_BYTES, ctx.logger)
      if (!read.ok) {
        ctx.issues.push({ category: 'preset', file: source, reason: read.reason })
        continue
      }
      try {
        const raw = JSON.parse(stripBom(read.bytes.toString('utf8'))) as unknown
        const rawName = (raw as { name?: unknown } | null)?.name
        const name = typeof rawName === 'string' && rawName.trim() !== ''
          ? rawName
          : path.basename(file, '.json')
        const preset = importPreset(raw, newId('preset'), name)
        records.push({ ...preset, source: importSource(ctx.userDir, source) })
      } catch (error) {
        ctx.logger.warn('tavern import: cannot parse preset %s: %s', source, String(error))
        ctx.issues.push({ category: 'preset', file: source, reason: REASON_INVALID })
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
  avatars: AvatarStore,
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
  const ctx: ImportContext = { userDir: resolved.userDir, avatars, logger: avatars.logger, issues }
  const report: TauriTavernImportReport = {
    input: resolved.input,
    root: resolved.root,
    userDir: resolved.userDir,
    imported: { characters: 0, lorebooks: 0, presets: 0 },
    issues,
  }

  // Without this the import silently looks empty when a planted runtime config
  // tried to redirect it. `TauriTavernImportIssue` has no config category, so
  // the refusal is filed under the first one.
  for (const configPath of resolved.refusedConfigs) {
    issues.push({
      category: 'character',
      file: relativeTo(resolved.userDir, configPath),
      reason: REASON_CONFIG_ESCAPE,
    })
  }

  if (categories.characters) {
    // Sources already in the library, checked before a card is read so that a
    // re-run neither re-parses nor re-materializes what it imported last time.
    const importedSources = new Set(db.characters
      .map(record => record.source)
      .filter((source): source is string => source !== undefined)
      .map(normalizeSource))
    const legacyCards = new Set(db.characters
      .filter(record => record.source !== undefined && !record.source.startsWith('tauritavern/'))
      .map(record => `${normalizeSource(record.source!)}\u0000${JSON.stringify(record.card)}`))
    const records = await importCharacters(
      ctx,
      path.join(resolved.userDir, 'characters'),
      source => importedSources.has(normalizeSource(importSource(ctx.userDir, source))),
      record => legacyCards.has(`${normalizeSource(record.source!.split('/').slice(2).join('/'))}\u0000${JSON.stringify(record.card)}`),
    )
    await storage.appendCharacters(records)
    report.imported.characters = records.length
  }

  if (categories.lorebooks) {
    const records = dedupeLorebooks(
      db.lorebooks,
      await importLorebooks(ctx, path.join(resolved.userDir, 'worlds')),
    )
    await storage.appendLorebooks(records)
    report.imported.lorebooks = records.length
  }

  if (categories.presets) {
    const records = dedupePresets(db.presets, await importPresets(ctx))
    await storage.appendPresets(records)
    report.imported.presets = records.length
  }

  return report
}
