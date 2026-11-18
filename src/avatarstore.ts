/**
 * Tavern avatar storage: character avatars are written as image files under
 * `<dsh-home>/tavern/avatars/`, while the settings document stores only the
 * short relative path (`tavern/avatars/<character-id>.png`).  Legacy data URLs
 * are migrated off the settings document on startup and whenever a character
 * is created/updated/imported.
 */

import { mkdir, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import type { LoggerService } from '@deepseek-ai/cordis'
import type { CharacterRecord } from './types.ts'
import { writeAtomic } from './atomic.ts'

/** Directory prefix persisted in `character.avatar` (portable, `/`-separated). */
export const AVATAR_DIR_RELATIVE = 'tavern/avatars'

const SAFE_FILE_RE = /^[a-zA-Z0-9_-]+\.(?:png|jpg|jpeg|webp|gif)$/i
const DATA_URL_RE = /^data:(image\/(?:png|jpeg|jpg|webp|gif));base64,([A-Za-z0-9+/=\r\n]+)$/i
const MIME_TYPES: Record<string, string> = {
  'image/png': 'image/png',
  'image/jpeg': 'image/jpeg',
  'image/jpg': 'image/jpeg',
  'image/webp': 'image/webp',
  'image/gif': 'image/gif',
}

/**
 * Largest decoded avatar this store accepts.  The settings document is
 * rewritten in full on every library mutation, so an inline value that never
 * makes it onto disk is copied again on every later write; anything past the
 * cap is dropped instead of being carried around forever.
 */
const MAX_AVATAR_BYTES = 8 * 1024 * 1024
/** base64 spends 4 characters per 3 bytes: bound the string before decoding. */
const MAX_AVATAR_DATA_URL_LENGTH = Math.ceil(MAX_AVATAR_BYTES / 3) * 4 + 64

function extensionForMime(mime: string): string {
  return mime === 'image/jpeg' || mime === 'image/jpg' ? 'jpg' : mime.slice('image/'.length)
}

function decodeDataUrl(value: string): { bytes: Buffer; mime: string; extension: string } | undefined {
  const trimmed = value.trim()
  // Checked before `Buffer.from`, which would otherwise allocate the whole
  // payload only to have it rejected on the next line.
  if (trimmed.length > MAX_AVATAR_DATA_URL_LENGTH) return undefined
  const match = DATA_URL_RE.exec(trimmed)
  if (match === null || match[1] === undefined || match[2] === undefined) return undefined
  const mime = match[1].toLowerCase()
  const bytes = Buffer.from(match[2], 'base64')
  if (bytes.length === 0 || bytes.length > MAX_AVATAR_BYTES) return undefined
  return { bytes, mime, extension: extensionForMime(mime) }
}

/** Strip the avatar entirely (the key is omitted, not set to `null`). */
function withoutAvatar(record: CharacterRecord): CharacterRecord {
  const { avatar: _dropped, ...rest } = record
  return rest
}

function safeFile(id: string, extension: string): string | undefined {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) return undefined
  return `${id}.${extension}`
}

function relativeAvatar(file: string): string {
  return `${AVATAR_DIR_RELATIVE}/${file}`
}

function fileFromAvatar(avatar: string | undefined): string | undefined {
  if (avatar === undefined) return undefined
  const normalized = avatar.replace(/\\/g, '/')
  if (!normalized.startsWith(`${AVATAR_DIR_RELATIVE}/`)) return undefined
  const file = normalized.slice(AVATAR_DIR_RELATIVE.length + 1)
  return SAFE_FILE_RE.test(file) ? file : undefined
}

/** Files are owned by the record whose id is their filename stem. */
function ownsFile(id: string, file: string): boolean {
  const stem = file.slice(0, file.lastIndexOf('.'))
  if (stem === id) return true // Legacy unversioned avatar.
  return stem.startsWith(`${id}--`) && /^[a-f0-9]{64}$/.test(stem.slice(id.length + 2))
}

/** Options for {@link AvatarStore.materializeCharacter}. */
export interface MaterializeAvatarOptions {
  /**
   * Keep an unsupported, oversized, or undecodable inline avatar on the record
   * instead of dropping it.  Dropping is right for an incoming HTTP payload
   * (the settings document must stay bounded), but wrong for a startup
   * migration: the inline value may be the user's only copy and the migration
   * result is persisted immediately.
   */
  keepUnsupported?: boolean
}

/**
 * File-backed avatar store.  Persisted paths are always relative to the DSH
 * home directory so the settings document stays host-independent.
 */
export class AvatarStore {
  /** Per-character write tail, so concurrent saves cannot interleave disk work. */
  private readonly tails = new Map<string, Promise<unknown>>()

  constructor(
    readonly root: string,
    /**
     * The plugin logger.  Public because the TauriTavern importer runs as plain
     * functions with no logger of their own and already receives this store.
     */
    readonly logger: Pick<LoggerService, 'warn' | 'error'>,
  ) {}

  private filePath(file: string): string {
    return path.join(this.root, file)
  }

  private async ensureRoot(): Promise<void> {
    await mkdir(this.root, { recursive: true })
  }

  /** Run `task` after every previous task for the same character has settled. */
  private async serialize<T>(id: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(id) ?? Promise.resolve()
    const run = previous.then(() => undefined, () => undefined).then(task)
    const settled = run.then(() => undefined, () => undefined)
    this.tails.set(id, settled)
    void settled.then(() => {
      // Only the last writer in the chain clears the entry.
      if (this.tails.get(id) === settled) this.tails.delete(id)
    })
    return run
  }

  /**
   * Replace a character's data-URL avatar with an on-disk file and return the
   * record that should be persisted.  Records that already use a relative path
   * (or have no avatar) are returned unchanged.  A value this store could never
   * have produced is dropped rather than written back (unless the caller opts
   * into `keepUnsupported` for a migration): the HTTP body cap is the only
   * limit on what a client can put in `avatar`, and whatever lands in the
   * settings document is re-serialized on every later library mutation.
   *
   * Staging writes use immutable content-addressed filenames and writeAtomic.
   * Call persistCharacter for an update: it serializes staging, durable JSON
   * publication and old-file retirement as one per-character operation.
   */
  async materializeCharacter(
    record: CharacterRecord,
    previous?: CharacterRecord,
    options: MaterializeAvatarOptions = {},
  ): Promise<CharacterRecord> {
    const avatar = record.avatar
    if (avatar === undefined) return record
    if (!avatar.startsWith('data:')) {
      const sourceFile = fileFromAvatar(avatar)
      if (sourceFile !== undefined) {
        if (ownsFile(record.id, sourceFile)) return record
        // Old shared references and copied cards retain their image, but each
        // record gets its own file before it may update or delete that image.
        const source = await this.read(sourceFile)
        if (source !== undefined && source.bytes.length <= MAX_AVATAR_BYTES) {
          return this.materializeCharacter({
            ...record,
            avatar: `data:${source.contentType};base64,${source.bytes.toString('base64')}`,
          }, previous, options)
        }
      }
      if (options.keepUnsupported === true) {
        this.logger.error('tavern avatar: cannot migrate unrecognized avatar for character %s; keeping it unchanged', record.id)
        return record
      }
      this.logger.warn('tavern avatar: dropping unrecognized avatar value for character %s', record.id)
      return withoutAvatar(record)
    }

    const decoded = decodeDataUrl(avatar)
    if (decoded === undefined) {
      if (options.keepUnsupported === true) {
        this.logger.error('tavern avatar: cannot migrate unsupported or oversized avatar for character %s; keeping the inline value', record.id)
        return record
      }
      this.logger.warn('tavern avatar: dropping unsupported or oversized avatar for character %s', record.id)
      return withoutAvatar(record)
    }

    const digest = createHash('sha256').update(decoded.bytes).digest('hex')
    const file = safeFile(`${record.id}--${digest}`, decoded.extension)
    if (file === undefined) {
      this.logger.warn('tavern avatar: character id %s is not filename-safe; leaving avatar inline', record.id)
      return record
    }

    // Materialization is staging only. Content-addressed files are immutable:
    // it must neither replace nor delete an image referenced by durable JSON.
    await this.ensureRoot()
    await writeAtomic(this.filePath(file), decoded.bytes)
    return { ...record, avatar: relativeAvatar(file) }
  }

  /** Stage an immutable image, commit JSON, then retire the previous image.
   * The entire operation is serialized per character, including publication.
   * `current` is read inside the queue so concurrent requests cannot roll back
   * or remove another request's committed image.
   */
  async persistCharacter(
    record: CharacterRecord,
    persist: (next: CharacterRecord) => Promise<void>,
    current: () => CharacterRecord | undefined,
    options: MaterializeAvatarOptions = {},
  ): Promise<CharacterRecord> {
    return this.serialize(record.id, async () => {
      const previous = current()
      const next = await this.materializeCharacter(record, previous, options)
      try {
        await persist(next)
      } catch (error: unknown) {
        // Only a newly staged version is disposable. Never delete a file
        // referenced by the current committed record or an incoming old path.
        if (next.avatar !== previous?.avatar && next.avatar !== record.avatar) {
          const file = fileFromAvatar(next.avatar)
          if (file !== undefined && ownsFile(record.id, file)) {
            await rm(this.filePath(file), { force: true }).catch(() => void 0)
          }
        }
        throw error
      }
      if (next.avatar !== previous?.avatar) {
        await this.removePrevious(fileFromAvatar(next.avatar), previous)
      }
      return next
    })
  }

  /**
   * Delete the file the record pointed at before the new one became durable.
   *
   * Only that exact file is removed.  The old code swept every known extension
   * for the id, which deleted the copy a concurrent save had just written —
   * two tabs saving the same character as png and jpg left both records
   * pointing at a 404.  An orphaned file from a changed extension is left
   * behind on purpose: a stray byte costs nothing, a missing avatar does not
   * come back.
   */
  private async removePrevious(current: string | undefined, previous?: CharacterRecord): Promise<void> {
    const previousFile = previous !== undefined ? fileFromAvatar(previous.avatar) : undefined
    if (previousFile === undefined || previous === undefined
      || !ownsFile(previous.id, previousFile)
      || (current !== undefined && (!ownsFile(previous.id, current) || previousFile.toLowerCase() === current.toLowerCase()))) return
    await rm(this.filePath(previousFile), { force: true }).catch(() => void 0)
  }

  /**
   * Materialize every data-URL avatar in one batch (used by the importer).
   * Settled, not `all`: one unwritable avatar (EACCES/ENOSPC) used to reject the
   * whole call, which aborted the import before anything was persisted and left
   * the user with an empty result and no explanation.
   */
  async materializeCharacters(records: CharacterRecord[]): Promise<CharacterRecord[]> {
    const settled = await Promise.allSettled(records.map(record => this.materializeCharacter(record)))
    return settled.map((result, index) => {
      const record = records[index]!
      if (result.status === 'fulfilled') return result.value
      this.logger.warn('tavern avatar: failed to store avatar for %s: %s', record.id, String(result.reason))
      return record
    })
  }

  /**
   * Migrate legacy inline avatars out of the settings document.
   *
   * A migration is a data move, never a cleanup: if the value cannot be
   * decoded or written, the original record is returned untouched and the
   * inline avatar stays in the library.  The previous behaviour dropped an
   * oversized or non-whitelisted avatar and then persisted the loss, which
   * destroyed the only copy on the first startup after upgrading.
   * @returns the records to persist, how many gained a file, and how many kept
   * their inline value for a later run.
   */
  async migrateLegacyCharacters(
    records: CharacterRecord[],
  ): Promise<{ characters: CharacterRecord[]; changed: number; skipped: number }> {
    const characters: CharacterRecord[] = []
    let changed = 0
    let skipped = 0
    for (const record of records) {
      try {
        const next = await this.materializeCharacter(record, record, { keepUnsupported: true })
        if (next.avatar !== record.avatar) changed += 1
        else if (record.avatar !== undefined && fileFromAvatar(record.avatar) === undefined) skipped += 1
        characters.push(next)
      } catch (error) {
        // A write error must also keep the original value: the inline data URL
        // is still the only copy, and the next startup can retry.
        this.logger.error('tavern avatar: failed to migrate avatar for %s: %s', record.id, String(error))
        skipped += 1
        characters.push(record)
      }
    }
    return { characters, changed, skipped }
  }

  /** Read a stored avatar for the HTTP route. */
  async read(file: string): Promise<{ bytes: Buffer; contentType: string } | undefined> {
    if (!SAFE_FILE_RE.test(file)) return undefined
    try {
      const bytes = await readFile(this.filePath(file))
      const extension = file.split('.').pop()?.toLowerCase() ?? 'png'
      const contentType = MIME_TYPES[`image/${extension}`] ?? MIME_TYPES['image/png']!
      return { bytes, contentType }
    } catch {
      return undefined
    }
  }

  /** Read the bytes backing a character record (legacy inline or on-disk). */
  async readCharacter(record: CharacterRecord): Promise<Buffer | undefined> {
    const avatar = record.avatar
    if (avatar === undefined) return undefined
    if (avatar.startsWith('data:')) {
      return decodeDataUrl(avatar)?.bytes
    }
    const file = fileFromAvatar(avatar)
    if (file === undefined) return undefined
    return (await this.read(file))?.bytes
  }

  /** Remove the on-disk avatar for a deleted character. */
  async removeCharacter(record: CharacterRecord): Promise<void> {
    const file = fileFromAvatar(record.avatar)
    if (file === undefined || !ownsFile(record.id, file)) return
    await this.serialize(record.id, () => rm(this.filePath(file), { force: true }).catch(() => void 0))
  }
}
