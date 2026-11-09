/**
 * Tavern preferences: the two small values that are not part of the library.
 *
 * ## Why not `ctx.settings`
 *
 * DSH 0.1 exposed a key/value settings service: `ctx.settings.register(ns,
 * schema)` returned an object with `get()`/`update()`/`replace()` over one
 * document. That is what this plugin used, and it is gone. In `0.2.2-alpha.3`
 * `ctx.settings` is `SettingsForms`: it derives a form from a plugin's *own*
 * `Config` schema, registers nothing for a namespace the caller names, and
 * exposes no `get()`. `@deepseek-ai/dsh-settings` no longer exports
 * `SettingsScope` either.
 *
 * The two remaining preferences are tiny (`defaultPresetId`, `style`), so they
 * are one JSON file under `<dsh home>/tavern/prefs.json` next to the library
 * they belong to. The library itself is one file per record — see
 * {@link LibraryStore} for why it left the settings document when it was still
 * the size problem that mattered.
 *
 * Reads are synchronous from an in-memory copy (every caller expects that);
 * writes are atomic and serialized through {@link writeAtomic}.
 */

import { readFile } from 'node:fs/promises'
import type { LoggerService } from '@deepseek-ai/cordis'
import { emptyDatabase } from './storage.ts'
import type { TavernDatabase } from './storage.ts'
import type { TavernStyle } from './types.ts'
import { writeAtomic } from './atomic.ts'

/** The preferences document: exactly the non-library part of the old section. */
export interface PrefsDocument {
  version: 1
  defaultPresetId?: string
  /** Tavern view style preference. */
  style?: TavernStyle
}

/**
 * The preferences face {@link TavernStorage} needs.
 *
 * Declared structurally (rather than importing a service type) so the storage
 * facade does not care whether the values come from a file, a test double, or
 * some future DSH store.
 */
export interface PrefsScope {
  /** Current values; never undefined (an unreadable file yields defaults). */
  get(): TavernDatabase
  /** Merge a sparse patch; `undefined` values are ignored, as in a settings patch. */
  update(patch: Partial<TavernDatabase>): Promise<void>
  /** Optional targeted removal; legacy settings adapters can still replace. */
  clearDefaultPreset?(): Promise<void>
  /** Replace the whole document. */
  replace(next: TavernDatabase): Promise<void>
}

/** Empty preferences document. */
function emptyPrefs(): PrefsDocument {
  return { version: 1 }
}

/**
 * Validate one decoded preferences document.
 *
 * Permissive like the old settings schema: unknown fields are dropped, wrong
 * types fall back to absent, and only a non-object is a hard failure. A stale
 * document written by a newer build must not keep the tavern from loading.
 * @param input - the decoded JSON, or undefined when the file is absent.
 * @returns a normalized document.
 */
export function normalizePrefs(input: unknown): PrefsDocument {
  if (input === undefined || input === null) return emptyPrefs()
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('酒馆偏好必须是对象')
  }
  const raw = input as Record<string, unknown>
  const prefs = emptyPrefs()
  if (typeof raw.defaultPresetId === 'string' && raw.defaultPresetId !== '') {
    prefs.defaultPresetId = raw.defaultPresetId
  }
  if (raw.style === 'dsh' || raw.style === 'classic') prefs.style = raw.style
  return prefs
}

/** File-backed preferences with an in-memory read copy. */
export class PrefsStore implements PrefsScope {
  private readonly path: string
  private readonly logger: LoggerService
  private current: PrefsDocument = emptyPrefs()
  private tail: Promise<void> = Promise.resolve()

  /** Serialize the entire read/merge/persist transaction, not just the bytes. */
  private enqueue(task: () => Promise<void>): Promise<void> {
    const run = this.tail.then(task)
    this.tail = run.catch(() => {})
    return run
  }

  /**
   * @param path - absolute path of `prefs.json`.
   * @param logger - warnings for a file that exists but cannot be read.
   */
  constructor(path: string, logger: LoggerService) {
    this.path = path
    this.logger = logger
  }

  /**
   * Read the document, tolerating every failure mode.
   *
   * Absent is normal (first run). Unparseable or wrong-shaped content is a
   * warning, not a failure: the plugin's readiness gate is `apply()`, and one
   * corrupt preference file must not make the whole tavern unusable.
   */
  async load(): Promise<void> {
    let text: string
    try {
      text = await readFile(this.path, 'utf8')
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        // `.error` because this IS a failure, not because WARN would be
        // swallowed: the enum is ERROR=0, WARN=1, INFO=2, DEBUG=3 and the
        // filter skips only when `targetLevel < level`, so the default INFO
        // threshold still prints WARN and drops DEBUG. (The original code
        // here asserted the opposite, which is why every diagnostic in this
        // plugin was pushed up to `.error`.)
        this.logger.error('tavern prefs: cannot read %s: %s', this.path, String(error))
      }
      return
    }
    try {
      this.current = normalizePrefs(JSON.parse(text))
    } catch (error: unknown) {
      this.logger.error('tavern prefs: ignoring unreadable %s: %s', this.path, String(error))
    }
  }

  /** Current preferences as the database-shaped view callers expect. */
  get(): TavernDatabase {
    return {
      ...emptyDatabase(),
      ...(this.current.defaultPresetId !== undefined
        ? { defaultPresetId: this.current.defaultPresetId }
        : {}),
      ...(this.current.style !== undefined ? { style: this.current.style } : {}),
    }
  }

  /** Merge a sparse patch and persist the result. */
  update(patch: Partial<TavernDatabase>): Promise<void> {
    const supplied = { ...patch }
    return this.enqueue(async () => {
      const next = emptyPrefs()
      const defaultPresetId = supplied.defaultPresetId ?? this.current.defaultPresetId
      const style = supplied.style ?? this.current.style
      if (defaultPresetId !== undefined) next.defaultPresetId = defaultPresetId
      if (style !== undefined) next.style = style
      await this.write(next)
    })
  }

  /** Remove only the preset key, merging against the latest queued state. */
  clearDefaultPreset(): Promise<void> {
    return this.enqueue(async () => {
      const next = { ...this.current }
      delete next.defaultPresetId
      await this.write(next)
    })
  }

  /** Replace the document wholesale. */
  async replace(next: TavernDatabase): Promise<void> {
    const document = emptyPrefs()
    if (next.defaultPresetId !== undefined) document.defaultPresetId = next.defaultPresetId
    if (next.style !== undefined) document.style = next.style
    await this.enqueue(() => this.write(document))
  }

  /**
   * Persist one document.
   *
   * The in-memory copy is updated only after the write lands, so a failed
   * write leaves readers on the value that is still true on disk.
   * @param document - the complete document to store.
   */
  private async write(document: PrefsDocument): Promise<void> {
    await writeAtomic(this.path, `${JSON.stringify(document, null, 2)}\n`)
    this.current = document
  }
}
