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

const SAFE_FILE_RE = /^[a-zA-Z0-9_-]+\.(?:png|jpg|jpeg|webp|gif)$/i
const DATA_URL_RE = /^data:(image\/(?:png|jpeg|jpg|webp|gif));base64,([A-Za-z0-9+/=\r\n]+)$/i
const MIME_TYPES: Record<string, string> = {
  'image/png': 'image/png',
  'image/jpeg': 'image/jpeg',
  'image/jpg': 'image/jpeg',
  'image/webp': 'image/webp',
  'image/gif': 'image/gif',
}

function extensionForMime(mime: string): string {
  return mime === 'image/jpeg' || mime === 'image/jpg' ? 'jpg' : mime.slice('image/'.length)
}

function decodeDataUrl(value: string): { bytes: Buffer; mime: string; extension: string } | undefined {
  const match = DATA_URL_RE.exec(value.trim())
  if (match === null || match[1] === undefined || match[2] === undefined) return undefined
  const mime = match[1].toLowerCase()
  const bytes = Buffer.from(match[2], 'base64')
  if (bytes.length === 0) return undefined
  return { bytes, mime, extension: extensionForMime(mime) }
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
    private readonly logger: Pick<LoggerService, 'warn'>,
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
   * (or have no avatar) are returned unchanged.
   */
  async materializeCharacter(
    record: CharacterRecord,
    previous?: CharacterRecord,
  ): Promise<CharacterRecord> {
    const avatar = record.avatar
    if (avatar === undefined || !avatar.startsWith('data:')) return record

    const decoded = decodeDataUrl(avatar)
    if (decoded === undefined) {
      this.logger.warn('tavern avatar: unsupported data URL for character %s; leaving it inline', record.id)
      return record
    }

    const file = safeFile(record.id, decoded.extension)
    if (file === undefined) {
      this.logger.warn('tavern avatar: character id %s is not filename-safe; leaving avatar inline', record.id)
      return record
    }

    await this.ensureRoot()
    await writeFile(this.filePath(file), decoded.bytes)

    // The same character id was previously persisted under a different image
    // extension; remove the stale file once the replacement is durable.
    const previousFile = previous !== undefined ? fileFromAvatar(previous.avatar) : undefined
    if (previousFile !== undefined && previousFile.toLowerCase() !== file.toLowerCase()) {
      await rm(this.filePath(previousFile), { force: true }).catch(() => void 0)
    }

    return { ...record, avatar: relativeAvatar(file) }
  }

  /** Materialize every data-URL avatar in one batch (used by the importer). */
  async materializeCharacters(records: CharacterRecord[]): Promise<CharacterRecord[]> {
    return Promise.all(records.map(record => this.materializeCharacter(record)))
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
