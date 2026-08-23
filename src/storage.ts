/**
 * Tavern database storage.
 *
 * The library (characters, world books, presets, plays, swipe branches) lives
 * as per-record JSON files under `$DSH_HOME/tavern/library/` — see
 * {@link LibraryStore} for why it is not in the settings document any more.
 * Only small preferences (`defaultPresetId`, `style`) remain on the settings
 * service, which is what that service is for.
 *
 * This class keeps the same surface it had when it was settings-backed, so
 * every caller is unchanged: synchronous reads against an in-memory index,
 * promise-returning writes.
 */

import { randomUUID } from 'node:crypto'
import type { SettingsScope } from '@deepseek-ai/dsh-settings'
import type {
  CharacterRecord, Play, Preset, SwipeBranch, TavernStyle, WorldBookRecord,
} from './types.ts'
import type { LibraryStore } from './library.ts'

/**
 * The persisted settings section. The library arrays are still declared so a
 * pre-migration document validates and can be read once, but nothing writes
 * them any more — {@link migrateLegacyLibrary} moves them onto disk and the
 * plugin then clears them.
 */
export interface TavernDatabase {
  version: 1
  characters: CharacterRecord[]
  lorebooks: WorldBookRecord[]
  presets: Preset[]
  plays: Play[]
  /** Alternative generations (swipe variants) keyed by play + fork point. */
  branches?: SwipeBranch[]
  defaultPresetId?: string
  /** Tavern view style preference. */
  style?: TavernStyle
}

/** A fresh empty database. */
export function emptyDatabase(): TavernDatabase {
  return {
    version: 1,
    characters: [],
    lorebooks: [],
    presets: [],
    plays: [],
  }
}

/**
 * @deprecated Use {@link emptyDatabase}. Kept as a frozen value so the old
 * shared-singleton hazard (every caller receiving the same mutable object) is
 * a loud failure rather than silent cross-talk.
 */
export const EMPTY_DATABASE: TavernDatabase = Object.freeze(emptyDatabase())

/** Generate a reasonably unique local id (CSPRNG; collision-safe). */
export function newId(prefix: string): string {
  return `${prefix}-${randomUUID()}`
}

/** Timestamp helper (ISO string). */
export function nowIso(): string {
  return new Date().toISOString()
}

/** Storage facade over the library file store plus the preferences section. */
export class TavernStorage {
  private readonly library: LibraryStore
  private readonly prefs: SettingsScope<TavernDatabase>

  constructor(library: LibraryStore, prefs: SettingsScope<TavernDatabase>) {
    this.library = library
    this.prefs = prefs
  }

  /**
   * A database-shaped view for callers that still want one snapshot (the
   * `/tavern/state` response). Assembled per call from the index; nothing is
   * copied to disk.
   */
  snapshot(): TavernDatabase {
    const section = this.prefs.get()
    return {
      version: 1,
      characters: this.library.characters(),
      lorebooks: this.library.lorebooks(),
      presets: this.library.presets(),
      plays: this.library.plays(),
      branches: this.library.branches(),
      ...(section.defaultPresetId !== undefined ? { defaultPresetId: section.defaultPresetId } : {}),
      ...(section.style !== undefined ? { style: section.style } : {}),
    }
  }

  // ── characters ──

  listCharacters(): CharacterRecord[] {
    return this.library.characters()
  }

  getCharacter(id: string): CharacterRecord | undefined {
    return this.library.character(id)
  }

  upsertCharacter(record: CharacterRecord): Promise<void> {
    return this.library.putCharacter(record)
  }

  /** Persist the complete character array (used by avatar-file migration). */
  async replaceCharacters(records: CharacterRecord[]): Promise<void> {
    await this.library.putCharacters(records)
  }

  /** Bulk-append imported character records. */
  async appendCharacters(records: CharacterRecord[]): Promise<void> {
    await this.library.putCharacters(records)
  }

  async deleteCharacter(id: string): Promise<void> {
    await this.library.dropCharacter(id)
    // Remove the binding from plays; the DSH session log itself is untouched.
    for (const play of this.library.plays()) {
      if (!play.characterIds.includes(id)) continue
      await this.library.putPlay({
        ...play,
        characterIds: play.characterIds.filter(cid => cid !== id),
      })
    }
  }

  // ── lorebooks ──

  listLorebooks(): WorldBookRecord[] {
    return this.library.lorebooks()
  }

  getLorebook(id: string): WorldBookRecord | undefined {
    return this.library.lorebook(id)
  }

  upsertLorebook(record: WorldBookRecord): Promise<void> {
    return this.library.putLorebook(record)
  }

  /** Bulk-append imported lorebook records. */
  async appendLorebooks(records: WorldBookRecord[]): Promise<void> {
    for (const record of records) await this.library.putLorebook(record)
  }

  async deleteLorebook(id: string): Promise<void> {
    await this.library.dropLorebook(id)
    for (const play of this.library.plays()) {
      const boundLegacy = play.lorebookId === id
      const boundArray = play.lorebookIds?.includes(id) ?? false
      if (!boundLegacy && !boundArray) continue
      const next: Play = { ...play }
      if (boundLegacy) delete next.lorebookId
      if (next.lorebookIds !== undefined) {
        const lorebookIds = next.lorebookIds.filter(bid => bid !== id)
        if (lorebookIds.length > 0) next.lorebookIds = lorebookIds
        else delete next.lorebookIds
      }
      await this.library.putPlay(next)
    }
  }

  // ── presets ──

  listPresets(): Preset[] {
    return this.library.presets()
  }

  getPreset(id: string): Preset | undefined {
    return this.library.preset(id)
  }

  upsertPreset(preset: Preset): Promise<void> {
    return this.library.putPreset(preset)
  }

  /** Bulk-append imported preset records. */
  async appendPresets(records: Preset[]): Promise<void> {
    for (const record of records) await this.library.putPreset(record)
  }

  async deletePreset(id: string): Promise<void> {
    await this.library.dropPreset(id)
    for (const play of this.library.plays()) {
      if (play.presetId !== id) continue
      const next: Play = { ...play }
      // Delete the key rather than setting it to undefined: a persisted
      // `presetId: undefined` is meaningless in JSON.
      delete next.presetId
      await this.library.putPlay(next)
    }
    const section = this.prefs.get()
    if (section.defaultPresetId === id) await this.setDefaultPreset(undefined)
  }

  // ── plays ──

  listPlays(): Play[] {
    return this.library.plays()
  }

  getPlay(id: string): Play | undefined {
    return this.library.play(id)
  }

  upsertPlay(play: Play): Promise<void> {
    return this.library.putPlay(play)
  }

  async deletePlay(id: string): Promise<void> {
    await this.library.dropPlay(id)
    await this.library.dropBranchesOf(id)
  }

  // ── swipe branches ──

  /** Every swipe branch of one play. */
  listSwipeBranches(playId: string): SwipeBranch[] {
    return this.library.branches().filter(b => b.playId === playId)
  }

  /** The branch of one fork point, when it exists. */
  getSwipeBranch(playId: string, key: string): SwipeBranch | undefined {
    return this.library.branch(playId, key)
  }

  upsertSwipeBranch(branch: SwipeBranch): Promise<void> {
    return this.library.putBranch(branch)
  }

  /** Remove exactly one branch (retry rollback after a failed session fork). */
  deleteSwipeBranch(playId: string, key: string): Promise<void> {
    return this.library.dropBranch(playId, key)
  }

  /** Drop one play's branches (edits rebase history; old variants go stale). */
  deleteSwipeBranches(playId: string): Promise<void> {
    return this.library.dropBranchesOf(playId)
  }

  async setDefaultPreset(id: string | undefined): Promise<void> {
    if (id === undefined) {
      // A patch cannot express key removal — the settings service strips
      // `undefined` from patches so a sparse patch cannot erase lower keys —
      // so the section is replaced instead.
      const section = this.prefs.get()
      const next: TavernDatabase = { ...emptyDatabase(), ...section }
      delete next.defaultPresetId
      await this.prefs.replace(next)
      return
    }
    await this.prefs.update({ defaultPresetId: id })
  }

  /** Persist the tavern view style preference. */
  async setStyle(style: TavernStyle): Promise<void> {
    await this.prefs.update({ style })
  }
}
