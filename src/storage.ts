/**
 * Tavern database storage over the DSH settings service: one 'tavern'
 * namespace holds the complete library (characters, lorebooks, presets) and
 * every play record. Writes go through the settings scope so persistence,
 * validation, and serialization are the harness's own.
 */

import type { SettingsScope } from '@deepseek-ai/dsh-settings'
import type {
  CharacterRecord, Play, Preset, TavernStyle, WorldBookRecord,
} from './types.ts'

/** The persisted tavern database shape. */
export interface TavernDatabase {
  version: 1
  characters: CharacterRecord[]
  lorebooks: WorldBookRecord[]
  presets: Preset[]
  plays: Play[]
  defaultPresetId?: string
  /** Tavern view style preference. */
  style?: TavernStyle
}

export const EMPTY_DATABASE: TavernDatabase = {
  version: 1,
  characters: [],
  lorebooks: [],
  presets: [],
  plays: [],
}

/** Generate a reasonably unique local id. */
export function newId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 10)
  return `${prefix}-${Date.now().toString(36)}-${rand}`
}

/** Timestamp helper (ISO string). */
export function nowIso(): string {
  return new Date().toISOString()
}

/**
 * Storage facade over the settings scope. Every mutation replaces whole
 * arrays (the settings patch merges shallowly), so readers always see a
 * consistent snapshot.
 */
export class TavernStorage {
  constructor(private readonly scope: SettingsScope<TavernDatabase>) {}

  snapshot(): TavernDatabase {
    return this.scope.get()
  }

  // ── characters ──

  listCharacters(): CharacterRecord[] {
    return this.snapshot().characters
  }

  getCharacter(id: string): CharacterRecord | undefined {
    return this.snapshot().characters.find(c => c.id === id)
  }

  async upsertCharacter(record: CharacterRecord): Promise<void> {
    const db = this.snapshot()
    const index = db.characters.findIndex(c => c.id === record.id)
    const characters = [...db.characters]
    if (index >= 0) characters[index] = record
    else characters.push(record)
    await this.scope.update({ characters })
  }

  /** Persist the complete character array (used by avatar-file migration). */
  async replaceCharacters(records: CharacterRecord[]): Promise<void> {
    await this.scope.update({ characters: records })
  }

  /** Bulk-append imported character records in a single settings write. */
  async appendCharacters(records: CharacterRecord[]): Promise<void> {
    if (records.length === 0) return
    const db = this.snapshot()
    await this.scope.update({ characters: [...db.characters, ...records] })
  }

  async deleteCharacter(id: string): Promise<void> {
    const db = this.snapshot()
    await this.scope.update({
      characters: db.characters.filter(c => c.id !== id),
      // Remove the binding from plays; the DSH session log itself is untouched.
      plays: db.plays.map(p => p.characterIds.includes(id)
        ? { ...p, characterIds: p.characterIds.filter(cid => cid !== id) }
        : p),
    })
  }

  // ── lorebooks ──

  listLorebooks(): WorldBookRecord[] {
    return this.snapshot().lorebooks
  }

  getLorebook(id: string): WorldBookRecord | undefined {
    return this.snapshot().lorebooks.find(b => b.id === id)
  }

  async upsertLorebook(record: WorldBookRecord): Promise<void> {
    const db = this.snapshot()
    const index = db.lorebooks.findIndex(b => b.id === record.id)
    const lorebooks = [...db.lorebooks]
    if (index >= 0) lorebooks[index] = record
    else lorebooks.push(record)
    await this.scope.update({ lorebooks })
  }

  /** Bulk-append imported lorebook records in a single settings write. */
  async appendLorebooks(records: WorldBookRecord[]): Promise<void> {
    if (records.length === 0) return
    const db = this.snapshot()
    await this.scope.update({ lorebooks: [...db.lorebooks, ...records] })
  }

  async deleteLorebook(id: string): Promise<void> {
    const db = this.snapshot()
    await this.scope.update({
      lorebooks: db.lorebooks.filter(b => b.id !== id),
      plays: db.plays.map((p) => {
        const next: Play = { ...p }
        if (p.lorebookId === id) delete next.lorebookId
        if (p.lorebookIds !== undefined) {
          const lorebookIds = p.lorebookIds.filter(bid => bid !== id)
          if (lorebookIds.length > 0) next.lorebookIds = lorebookIds
          else delete next.lorebookIds
        }
        return next
      }),
    })
  }

  // ── presets ──

  listPresets(): Preset[] {
    return this.snapshot().presets
  }

  getPreset(id: string): Preset | undefined {
    return this.snapshot().presets.find(p => p.id === id)
  }

  async upsertPreset(preset: Preset): Promise<void> {
    const db = this.snapshot()
    const index = db.presets.findIndex(p => p.id === preset.id)
    const presets = [...db.presets]
    if (index >= 0) presets[index] = preset
    else presets.push(preset)
    await this.scope.update({ presets })
  }

  /** Bulk-append imported preset records in a single settings write. */
  async appendPresets(records: Preset[]): Promise<void> {
    if (records.length === 0) return
    const db = this.snapshot()
    await this.scope.update({ presets: [...db.presets, ...records] })
  }

  async deletePreset(id: string): Promise<void> {
    const db = this.snapshot()
    await this.scope.update({
      presets: db.presets.filter(p => p.id !== id),
      plays: db.plays.map(p => p.presetId === id ? { ...p, presetId: undefined } : p),
    })
  }

  // ── plays ──

  listPlays(): Play[] {
    return this.snapshot().plays
  }

  getPlay(id: string): Play | undefined {
    return this.snapshot().plays.find(p => p.id === id)
  }

  async upsertPlay(play: Play): Promise<void> {
    const db = this.snapshot()
    const index = db.plays.findIndex(p => p.id === play.id)
    const plays = [...db.plays]
    if (index >= 0) plays[index] = play
    else plays.push(play)
    await this.scope.update({ plays })
  }

  async deletePlay(id: string): Promise<void> {
    const db = this.snapshot()
    await this.scope.update({ plays: db.plays.filter(p => p.id !== id) })
  }

  async setDefaultPreset(id: string | undefined): Promise<void> {
    if (id === undefined) {
      // `update` cannot express key removal; replace the whole section instead.
      await this.scope.replace({ ...this.snapshot(), defaultPresetId: undefined })
      return
    }
    await this.scope.update({ defaultPresetId: id })
  }

  /** Persist the tavern view style preference. */
  async setStyle(style: TavernStyle): Promise<void> {
    await this.scope.update({ style })
  }
}
