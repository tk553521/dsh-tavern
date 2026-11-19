/**
 * The tavern library as a directory of per-record JSON files under
 * `$DSH_HOME/tavern/library/`.
 *
 * Why not the settings service, which is where this used to live: a settings
 * namespace is one document, and the provider read-modify-writes the WHOLE
 * document on every write. With a real ST library imported (176 cards, 210
 * world books with ~25k entries, 746 presets) the shared `settings.yaml` grew
 * to 92 MB / 1.7M lines, of which the tavern was 99.99%. Every settings write
 * in the entire process — any plugin, changing any preference — then had to
 * re-parse, re-validate, re-serialize and re-persist 92 MB of YAML. Swipe
 * branches, which store whole session-event prefixes, had not even started
 * accumulating yet.
 *
 * One file per record makes a write O(record) instead of O(library), and the
 * avatar store already established the pattern. Small preferences
 * (`defaultPresetId`, `style`) stay in settings, where they belong.
 *
 * Writes are atomic (temp file + rename), so a crash or a full disk can never
 * leave a half-written record behind — a reader sees the old file or the new
 * one. Unreadable records are skipped with a warning rather than failing the
 * whole load: one corrupt card must not cost the user their library.
 */

import { mkdir, readdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { writeAtomic } from './atomic.ts'
import { isSafeLibraryId, validateLibraryRecord, type LibraryCollection } from './library-validation.ts'
import type { CharacterRecord, Play, Preset, SwipeBranch, WorldBookRecord } from './types.ts'

/** Minimal logger surface (matches the host's LoggerService shape we use). */
export interface LibraryLogger {
  warn: (message: string) => void
  info: (message: string) => void
  /**
   * Failures the user has to see. The host logger has this method at the same
   * call shape; test doubles may omit it, which is why {@link LibraryStore}
   * falls back to `warn` when it is absent.
   */
  error?: (message: string) => void
}

/** The record collections held on disk, each in its own subdirectory. */
const COLLECTIONS = ['characters', 'lorebooks', 'presets', 'plays', 'branches'] as const
type Collection = LibraryCollection

/** Filename checks and record shapes live in the shared runtime validator. */
const isSafeId = isSafeLibraryId

/** File-name key of one swipe branch (branches are keyed by play + fork point). */
function branchKey(playId: string, key: string): string {
  return `${playId}~${key}`
}

/**
 * In-memory index over the on-disk library. Reads are synchronous against the
 * index (every caller in the plugin expects that); writes update the index and
 * persist the single affected file.
 */
export class LibraryStore {
  private readonly maps: Record<Collection, Map<string, unknown>> = {
    characters: new Map(),
    lorebooks: new Map(),
    presets: new Map(),
    plays: new Map(),
    branches: new Map(),
  }

  private readonly root: string
  private readonly logger: LibraryLogger
  private readonly mutationTails = new Map<string, Promise<void>>()

  /** Order complete record mutations, including deletion and index publication. */
  private enqueue(collection: Collection, key: string, task: () => Promise<void>): Promise<void> {
    const queueKey = `${collection}/${key}`
    const run = (this.mutationTails.get(queueKey) ?? Promise.resolve()).then(task)
    const settled = run.catch(() => {})
    this.mutationTails.set(queueKey, settled)
    void settled.then(() => {
      if (this.mutationTails.get(queueKey) === settled) this.mutationTails.delete(queueKey)
    })
    return run
  }

  /**
   * Construct the index without touching the disk. The plugin provides its
   * service synchronously, so the store must exist before {@link load} has
   * run; callers gate their first read on the load promise.
   *
   * Fields are declared explicitly rather than as constructor parameter
   * properties so this module runs under Node's strip-only TypeScript support
   * (which rejects parameter properties) — handy for verification scripts.
   */
  constructor(root: string, logger: LibraryLogger) {
    this.root = root
    this.logger = logger
  }

  /** Create the library directories and read every record into the index. */
  async load(): Promise<void> {
    for (const collection of COLLECTIONS) {
      // One unusable collection (a permission problem, a file where the
      // directory should be, a read-only volume) must not take the whole
      // library with it: this method is the plugin's readiness gate, so a
      // throw here leaves the tavern permanently unstartable — and the next
      // boot fails at the same point, with no way out from the UI.
      try {
        await mkdir(join(this.root, collection), { recursive: true })
        await this.loadCollection(collection)
      } catch (error: unknown) {
        const message = `tavern library: cannot open collection "${collection}" under ${this.root}: ${String(error)}`
        if (this.logger.error !== undefined) this.logger.error(message)
        else this.logger.warn(message)
      }
    }
  }

  /** Open (creating if needed) the library directory and load every record. */
  static async open(root: string, logger: LibraryLogger): Promise<LibraryStore> {
    const store = new LibraryStore(root, logger)
    await store.load()
    return store
  }

  /** Read every record of one collection into the index. */
  private async loadCollection(collection: Collection): Promise<void> {
    const dir = join(this.root, collection)
    let names: string[]
    try {
      names = (await readdir(dir, { withFileTypes: true }))
        .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
        .map(entry => entry.name)
    } catch (error: unknown) {
      this.logger.warn(`tavern library: cannot list ${collection}: ${String(error)}`)
      return
    }
    const map = this.maps[collection]
    // Bounded concurrency: a large library is ~1k files and unbounded
    // Promise.all on that many opens exhausts the libuv pool on Windows.
    const BATCH = 64
    for (let start = 0; start < names.length; start += BATCH) {
      const batch = names.slice(start, start + BATCH)
      await Promise.all(batch.map(async (name) => {
        const key = name.slice(0, -'.json'.length)
        try {
          const value: unknown = JSON.parse(await readFile(join(dir, name), 'utf8'))
          validateLibraryRecord(collection, value, key)
          map.set(key, value)
        } catch (error: unknown) {
          // Isolate malformed JSON AND malformed core records, retaining the
          // original file for recovery instead of deleting or rewriting it.
          map.delete(key)
          this.logger.warn(`tavern library: skipping ${collection}/${name}: ${String(error)}`)
        }
      }))
    }
  }

  /** Persist one record and index it. */
  private async put(collection: Collection, value: unknown): Promise<void> {
    const key = validateLibraryRecord(collection, value)
    const data = JSON.stringify(value)
    // Snapshot what will actually be stored: caller mutation or toJSON must
    // not publish an index value that differs from the committed JSON.
    const persisted: unknown = JSON.parse(data)
    validateLibraryRecord(collection, persisted, key)
    await this.enqueue(collection, key, async () => {
      await writeAtomic(join(this.root, collection, `${key}.json`), data)
      this.maps[collection].set(key, persisted)
    })
  }

  /** Remove one record from disk and the index. Missing files are fine. */
  private async drop(collection: Collection, key: string): Promise<void> {
    if (!isSafeId(key)) return
    await this.enqueue(collection, key, async () => {
      try {
        // Earlier saves must settle before deleting both the file and index.
        await rm(join(this.root, collection, `${key}.json`), { force: true })
      } catch (error: unknown) {
        throw new Error(`tavern library: cannot delete ${collection}/${key}: ${String(error)}`)
      }
      this.maps[collection].delete(key)
    })
  }

  private all<T>(collection: Collection): T[] {
    return [...this.maps[collection].values()] as T[]
  }

  // ── characters ──

  characters(): CharacterRecord[] {
    return this.all<CharacterRecord>('characters')
  }

  character(id: string): CharacterRecord | undefined {
    return this.maps.characters.get(id) as CharacterRecord | undefined
  }

  putCharacter(record: CharacterRecord): Promise<void> {
    return this.put('characters', record)
  }

  /** Try every record, then propagate failures instead of reporting false success. */
  async putCharacters(records: readonly CharacterRecord[]): Promise<void> {
    const failures: unknown[] = []
    for (const record of records) {
      try {
        await this.putCharacter(record)
      } catch (error: unknown) {
        failures.push(error)
        this.logger.warn(`tavern library: cannot store character ${String(record?.id)}: ${String(error)}`)
      }
    }
    if (failures.length > 0) throw new AggregateError(failures, `Failed to persist ${failures.length} character record(s)`)
  }

  dropCharacter(id: string): Promise<void> {
    return this.drop('characters', id)
  }

  // ── lorebooks ──

  lorebooks(): WorldBookRecord[] {
    return this.all<WorldBookRecord>('lorebooks')
  }

  lorebook(id: string): WorldBookRecord | undefined {
    return this.maps.lorebooks.get(id) as WorldBookRecord | undefined
  }

  putLorebook(record: WorldBookRecord): Promise<void> {
    return this.put('lorebooks', record)
  }

  dropLorebook(id: string): Promise<void> {
    return this.drop('lorebooks', id)
  }

  // ── presets ──

  presets(): Preset[] {
    return this.all<Preset>('presets')
  }

  preset(id: string): Preset | undefined {
    return this.maps.presets.get(id) as Preset | undefined
  }

  putPreset(record: Preset): Promise<void> {
    return this.put('presets', record)
  }

  dropPreset(id: string): Promise<void> {
    return this.drop('presets', id)
  }

  // ── plays ──

  plays(): Play[] {
    return this.all<Play>('plays')
  }

  play(id: string): Play | undefined {
    return this.maps.plays.get(id) as Play | undefined
  }

  putPlay(record: Play): Promise<void> {
    return this.put('plays', record)
  }

  dropPlay(id: string): Promise<void> {
    return this.drop('plays', id)
  }

  // ── swipe branches ──

  branches(): SwipeBranch[] {
    return this.all<SwipeBranch>('branches')
  }

  branch(playId: string, key: string): SwipeBranch | undefined {
    return this.maps.branches.get(branchKey(playId, key)) as SwipeBranch | undefined
  }

  putBranch(record: SwipeBranch): Promise<void> {
    return this.put('branches', record)
  }

  dropBranch(playId: string, key: string): Promise<void> {
    if (!isSafeId(playId) || !isSafeId(key)) return Promise.resolve()
    return this.drop('branches', branchKey(playId, key))
  }

  /** Drop every branch of one play (an edit rebases history; variants go stale). */
  async dropBranchesOf(playId: string): Promise<void> {
    const stale = this.branches().filter(branch => branch.playId === playId)
    for (const branch of stale) {
      await this.dropBranch(branch.playId, branch.key)
    }
  }

  /** Total record count, used to verify a migration before it drops the source. */
  size(): number {
    return COLLECTIONS.reduce((total, collection) => total + this.maps[collection].size, 0)
  }
}

/** What one settings→files migration moved. */
export interface MigrationReport {
  moved: boolean
  characters: number
  lorebooks: number
  presets: number
  plays: number
  branches: number
}

/** The legacy settings-document shape this migration reads from. */
export interface LegacyLibrary {
  characters?: CharacterRecord[]
  lorebooks?: WorldBookRecord[]
  presets?: Preset[]
  plays?: Play[]
  branches?: SwipeBranch[]
}

/**
 * Move a library that still lives in the settings document onto disk.
 *
 * Runs at most once per installation: it is a no-op when the settings copy is
 * already empty. Records are written first and only reported as migrated once
 * every one of them is readable back from the index, so the caller can clear
 * the settings copy knowing the data landed.
 * @param store - the destination file store.
 * @param legacy - the arrays read out of the settings document.
 * @param logger - progress and per-record failures.
 * @returns what moved; `moved: false` means there was nothing to do.
 */
export async function migrateLegacyLibrary(
  store: LibraryStore,
  legacy: LegacyLibrary,
  logger: LibraryLogger,
): Promise<MigrationReport> {
  const characters = legacy.characters ?? []
  const lorebooks = legacy.lorebooks ?? []
  const presets = legacy.presets ?? []
  const plays = legacy.plays ?? []
  const branches = legacy.branches ?? []
  for (const [collection, records] of [
    ['characters', characters], ['lorebooks', lorebooks], ['presets', presets],
    ['plays', plays], ['branches', branches],
  ] as const) {
    if (!Array.isArray(records)) throw new Error(`tavern library: invalid legacy ${collection}; expected an array; settings copy kept`)
  }
  const total = characters.length + lorebooks.length + presets.length + plays.length + branches.length
  if (total === 0) {
    return { moved: false, characters: 0, lorebooks: 0, presets: 0, plays: 0, branches: 0 }
  }

  logger.info(`tavern library: migrating ${total} record(s) out of the settings document`)
  let failures = 0
  const seen = new Map<Collection, Set<string>>()
  /**
   * Validate and reserve each source identity before its write. A repeated id
   * must not overwrite an earlier source record and then count as two moves.
   * Malformed records remain guarded here so good records can still recover.
   */
  const store1 = async (
    collection: Collection,
    record: unknown,
    write: () => Promise<void>,
  ): Promise<void> => {
    let name = collection as string
    try {
      const key = validateLibraryRecord(collection, record)
      name = `${collection}/${key}`
      const keys = seen.get(collection) ?? new Set<string>()
      if (keys.has(key)) throw new Error(`tavern library: duplicate legacy identity ${name}`)
      keys.add(key)
      seen.set(collection, keys)
      await write()
    } catch (error: unknown) {
      failures += 1
      logger.warn(`tavern library: migration failed for ${name}: ${String(error)}`)
    }
  }

  for (const record of characters) await store1('characters', record, () => store.putCharacter(record))
  for (const record of lorebooks) await store1('lorebooks', record, () => store.putLorebook(record))
  for (const record of presets) await store1('presets', record, () => store.putPreset(record))
  for (const record of plays) await store1('plays', record, () => store.putPlay(record))
  for (const record of branches) await store1('branches', record, () => store.putBranch(record))

  if (failures > 0) {
    // Leave the settings copy alone: it is now the only complete copy.
    throw new Error(`tavern library: ${failures} record(s) failed to migrate; settings copy kept`)
  }
  return {
    moved: true,
    characters: characters.length,
    lorebooks: lorebooks.length,
    presets: presets.length,
    plays: plays.length,
    branches: branches.length,
  }
}
