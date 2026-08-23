/**
 * Tavern avatar storage: character avatars are written as image files under
 * `<dsh-home>/tavern/avatars/`, while the settings document stores only the
 * short relative path (`tavern/avatars/<character-id>.png`).  Legacy data URLs
 * are migrated off the settings document on startup and whenever a character
 * is created/updated/imported.
 */

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { LoggerService } from '@deepseek-ai/cordis'
import type { CharacterRecord } from './types.ts'

/** Directory prefix persisted in `character.avatar` (portable, `/`-separated). */
export const AVATAR_DIR_RELATIVE = 'tavern/avatars'

/** Every extension this store may write for one character id. */
const AVATAR_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'gif'] as const

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
  const file = normalized.slice(AVATAR_DIR_RELATIVE.length + 1).split('/').pop() ?? ''
  return SAFE_FILE_RE.test(file) ? file : undefined
}

/**
 * File-backed avatar store.  Persisted paths are always relative to the DSH
 * home directory so the settings document stays host-independent.
 */
export class AvatarStore {
  constructor(
    readonly root: string,
    /**
     * The plugin logger.  Public because the TauriTavern importer runs as plain
     * functions with no logger of their own and already receives this store.
     */
    readonly logger: Pick<LoggerService, 'warn'>,
  ) {}

  private filePath(file: string): string {
    return path.join(this.root, file)
  }

  private async ensureRoot(): Promise<void> {
    await mkdir(this.root, { recursive: true })
  }

  /**
   * Replace a character's data-URL avatar with an on-disk file and return the
   * record that should be persisted.  Records that already use a relative path
   * (or have no avatar) are returned unchanged.  A value this store could never
   * have produced is dropped rather than written back: the HTTP body cap is the
   * only limit on what a client can put in `avatar`, and whatever lands in the
   * settings document is re-serialized on every later library mutation.
   */
  async materializeCharacter(
    record: CharacterRecord,
    previous?: CharacterRecord,
  ): Promise<CharacterRecord> {
    const avatar = record.avatar
    if (avatar === undefined) return record
    if (!avatar.startsWith('data:')) {
      if (fileFromAvatar(avatar) !== undefined) return record
      this.logger.warn('tavern avatar: dropping unrecognized avatar value for character %s', record.id)
      return withoutAvatar(record)
    }

    const decoded = decodeDataUrl(avatar)
    if (decoded === undefined) {
      this.logger.warn('tavern avatar: dropping unsupported or oversized avatar for character %s', record.id)
      return withoutAvatar(record)
    }

    const file = safeFile(record.id, decoded.extension)
    if (file === undefined) {
      this.logger.warn('tavern avatar: character id %s is not filename-safe; leaving avatar inline', record.id)
      return record
    }

    await this.ensureRoot()
    await writeFile(this.filePath(file), decoded.bytes)
    await this.removeStale(record.id, file, previous)

    return { ...record, avatar: relativeAvatar(file) }
  }

  /**
   * Drop leftovers for the same character once the replacement is durable.  The
   * id alone defines the candidate names because the bulk import path has no
   * `previous` record to compare against, so a changed image extension would
   * otherwise strand the old file forever.
   */
  private async removeStale(id: string, current: string, previous?: CharacterRecord): Promise<void> {
    const names = new Set(AVATAR_EXTENSIONS
      .map(extension => safeFile(id, extension))
      .filter((name): name is string => name !== undefined))
    const previousFile = previous !== undefined ? fileFromAvatar(previous.avatar) : undefined
    if (previousFile !== undefined) names.add(previousFile)
    for (const name of names) {
      if (name.toLowerCase() === current.toLowerCase()) continue
      await rm(this.filePath(name), { force: true }).catch(() => void 0)
    }
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
   * Migrate legacy inline avatars out of the settings document.  A failed file
   * write keeps the original data URL, so a migration is always safe to retry.
   */
  async migrateLegacyCharacters(records: CharacterRecord[]): Promise<{ characters: CharacterRecord[]; changed: number }> {
    const characters: CharacterRecord[] = []
    let changed = 0
    for (const record of records) {
      try {
        const next = await this.materializeCharacter(record, record)
        if (next.avatar !== record.avatar) changed += 1
        characters.push(next)
      } catch (error) {
        this.logger.warn('tavern avatar: failed to migrate avatar for %s: %s', record.id, String(error))
        characters.push(record)
      }
    }
    return { characters, changed }
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
    if (file === undefined) return
    await rm(this.filePath(file), { force: true }).catch(() => void 0)
  }
}
