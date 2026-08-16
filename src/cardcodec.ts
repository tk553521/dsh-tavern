/**
 * Tavern format codecs: character-card import (v1/v2/v3, JSON or PNG),
 * world-book conversion (ST uid-keyed object ↔ tavern array), preset import
 * from SillyTavern JSON, and chat jsonl import/export.
 */

import type {
  CharacterCard, CharacterCardData, PlayMessage, Preset, WorldBook, WorldBookEntry,
} from './types.ts'
import { parsePngCard } from './png.ts'

// ── Character cards ────────────────────────────────────────────────────────

const V2_REQUIRED: readonly (keyof CharacterCardData)[] = [
  'name', 'description', 'personality', 'scenario', 'first_mes', 'mes_example',
  'creator_notes', 'system_prompt', 'post_history_instructions',
  'alternate_greetings', 'tags', 'creator', 'character_version', 'extensions',
]

/** Normalize raw card JSON (v1/v2/v3) into a canonical v2 card. */
export function normalizeCard(raw: unknown, sourceName?: string): CharacterCard {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('人物卡 JSON 无效：不是对象')
  }
  const obj = raw as Record<string, unknown>
  const spec = typeof obj.spec === 'string' ? obj.spec : undefined
  const dataRaw = (spec !== undefined && typeof obj.data === 'object' && obj.data !== null)
    ? obj.data as Record<string, unknown>
    : obj
  const data: CharacterCardData = {
    name: str(dataRaw.name),
    description: str(dataRaw.description),
    personality: str(dataRaw.personality),
    scenario: str(dataRaw.scenario),
    first_mes: str(dataRaw.first_mes),
    mes_example: str(dataRaw.mes_example),
    creator_notes: str(dataRaw.creator_notes),
    system_prompt: str(dataRaw.system_prompt),
    post_history_instructions: str(dataRaw.post_history_instructions),
    alternate_greetings: strArray(dataRaw.alternate_greetings),
    ...(Array.isArray(dataRaw.group_only_greetings)
      ? { group_only_greetings: strArray(dataRaw.group_only_greetings) }
      : {}),
    ...(isWorldBookish(dataRaw.character_book)
      ? { character_book: normalizeWorldBook(dataRaw.character_book) }
      : {}),
    tags: strArray(dataRaw.tags),
    creator: str(dataRaw.creator),
    character_version: str(dataRaw.character_version),
    extensions: typeof dataRaw.extensions === 'object' && dataRaw.extensions !== null
      ? dataRaw.extensions as Record<string, unknown>
      : {},
  }
  // v1 cards lack the data wrapper; fill every required key.
  for (const key of V2_REQUIRED) {
    const value = data[key]
    if (value === undefined) {
      (data as unknown as Record<string, unknown>)[key] = Array.isArray(value)
        ? []
        : key === 'extensions' ? {} : ''
    }
  }
  if (data.name.trim() === '') {
    throw new Error(`人物卡缺少名称${sourceName !== undefined ? `（${sourceName}）` : ''}`)
  }
  return {
    spec: 'chara_card_v2',
    spec_version: typeof obj.spec_version === 'string' ? obj.spec_version : '2.0',
    data,
  }
}

/** Parse a character card from JSON text or PNG bytes. */
export function parseCardInput(input: string | Uint8Array, sourceName?: string): CharacterCard {
  if (typeof input === 'string') {
    return normalizeCard(JSON.parse(input), sourceName)
  }
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input)
  const png = parsePngCard(buffer)
  if (png !== null) {
    return normalizeCard(JSON.parse(png.json), sourceName)
  }
  // Not a PNG: treat as UTF-8 JSON text.
  return normalizeCard(JSON.parse(buffer.toString('utf8')), sourceName)
}

/** Extract an avatar data URL from PNG bytes (or undefined). */
export function avatarDataUrl(bytes: Uint8Array): string | undefined {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
  const png = parsePngCard(buffer)
  if (png?.avatar !== undefined) {
    return `data:image/png;base64,${png.avatar.toString('base64')}`
  }
  return undefined
}

function isWorldBookish(value: unknown): boolean {
  return typeof value === 'object' && value !== null
    && ('entries' in value)
}

// ── World books ────────────────────────────────────────────────────────────

const ENTRY_DEFAULTS = (uid: number): WorldBookEntry => ({
  uid,
  key: [],
  keysecondary: [],
  comment: '',
  content: '',
  constant: false,
  vectorized: false,
  selective: true,
  selectiveLogic: 0,
  addMemo: false,
  order: 100,
  position: 0,
  disable: false,
  ignoreBudget: false,
  excludeRecursion: false,
  preventRecursion: false,
  matchPersonaDescription: false,
  matchCharacterDescription: false,
  matchCharacterPersonality: false,
  matchCharacterDepthPrompt: false,
  matchScenario: false,
  matchCreatorNotes: false,
  delayUntilRecursion: 0,
  probability: 100,
  useProbability: true,
  depth: 4,
  outletName: '',
  group: '',
  groupOverride: false,
  groupWeight: 100,
  scanDepth: null,
  caseSensitive: null,
  matchWholeWords: null,
  useGroupScoring: null,
  automationId: '',
  role: 0,
  sticky: null,
  cooldown: null,
  delay: null,
  triggers: [],
  extensions: {},
})

/** Convert one raw entry (ST top-level + snake_case extensions) to canonical form. */
function normalizeEntry(raw: Record<string, unknown>, uid: number): WorldBookEntry {
  const entry = ENTRY_DEFAULTS(uid)
  const ext = typeof raw.extensions === 'object' && raw.extensions !== null
    ? raw.extensions as Record<string, unknown>
    : {}
  const pick = (top: string, snake: string): unknown => {
    const value = raw[top]
    if (value !== undefined) return value
    const mirrored = ext[snake]
    if (mirrored !== undefined) return mirrored
    return undefined
  }
  const bool = (v: unknown, fallback: boolean): boolean => typeof v === 'boolean' ? v : fallback
  const num = (v: unknown, fallback: number): number => typeof v === 'number' && Number.isFinite(v) ? v : fallback
  const nullableNum = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) ? v : null

  entry.key = strArray(raw.key)
  entry.keysecondary = strArray(raw.keysecondary)
  entry.comment = str(raw.comment)
  entry.content = str(raw.content)
  entry.constant = bool(raw.constant, false)
  entry.vectorized = bool(pick('vectorized', 'vectorized'), false)
  entry.selective = bool(raw.selective, true)
  entry.selectiveLogic = num(pick('selectiveLogic', 'selectiveLogic'), 0)
  entry.addMemo = bool(raw.addMemo, false)
  entry.order = num(raw.order, 100)
  entry.position = num(pick('position', 'position'), 0)
  entry.disable = bool(raw.disable, false)
  entry.ignoreBudget = bool(pick('ignoreBudget', 'ignore_budget'), false)
  entry.excludeRecursion = bool(pick('excludeRecursion', 'exclude_recursion'), false)
  entry.preventRecursion = bool(pick('preventRecursion', 'prevent_recursion'), false)
  entry.matchPersonaDescription = bool(pick('matchPersonaDescription', 'match_persona_description'), false)
  entry.matchCharacterDescription = bool(pick('matchCharacterDescription', 'match_character_description'), false)
  entry.matchCharacterPersonality = bool(pick('matchCharacterPersonality', 'match_character_personality'), false)
  entry.matchCharacterDepthPrompt = bool(pick('matchCharacterDepthPrompt', 'match_character_depth_prompt'), false)
  entry.matchScenario = bool(pick('matchScenario', 'match_scenario'), false)
  entry.matchCreatorNotes = bool(pick('matchCreatorNotes', 'match_creator_notes'), false)
  entry.delayUntilRecursion = num(pick('delayUntilRecursion', 'delay_until_recursion'), 0)
  entry.probability = num(pick('probability', 'probability'), 100)
  entry.useProbability = bool(pick('useProbability', 'useProbability'), true)
  entry.depth = num(pick('depth', 'depth'), 4)
  entry.outletName = str(pick('outletName', 'outlet_name'))
  entry.group = str(pick('group', 'group'))
  entry.groupOverride = bool(pick('groupOverride', 'group_override'), false)
  entry.groupWeight = num(pick('groupWeight', 'group_weight'), 100)
  entry.scanDepth = nullableNum(pick('scanDepth', 'scan_depth'))
  entry.caseSensitive = nullableNum(pick('caseSensitive', 'case_sensitive')) === null
    ? null
    : bool(pick('caseSensitive', 'case_sensitive'), false)
  entry.matchWholeWords = nullableNum(pick('matchWholeWords', 'match_whole_words')) === null
    ? null
    : bool(pick('matchWholeWords', 'match_whole_words'), false)
  entry.useGroupScoring = nullableNum(pick('useGroupScoring', 'use_group_scoring')) === null
    ? null
    : bool(pick('useGroupScoring', 'use_group_scoring'), false)
  entry.automationId = str(pick('automationId', 'automation_id'))
  entry.role = num(pick('role', 'role'), 0)
  entry.sticky = nullableNum(pick('sticky', 'sticky'))
  entry.cooldown = nullableNum(pick('cooldown', 'cooldown'))
  entry.delay = nullableNum(pick('delay', 'delay'))
  entry.triggers = strArray(pick('triggers', 'triggers'))
  entry.keyregex = typeof raw.keyregex === 'string' ? raw.keyregex : undefined
  // Keep the extension block for round-trip fidelity.
  entry.extensions = { ...ext }
  return entry
}

/**
 * Normalize a world book: accepts the ST uid-keyed object form
 * `{ entries: { "0": {...}, ... } }`, the array form, and the embedded
 * character_book form `{ entries: [...] }` (camelCase field names).
 */
export function normalizeWorldBook(raw: unknown): WorldBook {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('世界书 JSON 无效：不是对象')
  }
  const obj = raw as Record<string, unknown>
  const entriesRaw = obj.entries
  let entries: WorldBookEntry[]
  if (Array.isArray(entriesRaw)) {
    entries = entriesRaw
      .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
      .map((item, index) => {
        const uid = typeof item.uid === 'number' && Number.isSafeInteger(item.uid) ? item.uid : index
        return normalizeEntry(item, uid)
      })
  } else if (typeof entriesRaw === 'object' && entriesRaw !== null) {
    // ST world-info file: entries keyed by string uid.
    entries = Object.entries(entriesRaw as Record<string, unknown>)
      .filter(([, item]) => typeof item === 'object' && item !== null)
      .map(([uid, item], index) => {
        const parsed = Number(uid)
        return normalizeEntry(item as Record<string, unknown>, Number.isSafeInteger(parsed) ? parsed : index)
      })
  } else {
    entries = []
  }
  return {
    ...(typeof obj.name === 'string' ? { name: obj.name } : {}),
    ...(typeof obj.description === 'string' ? { description: obj.description } : {}),
    ...(typeof obj.scan_depth === 'number' ? { scan_depth: obj.scan_depth } : {}),
    ...(typeof obj.token_budget === 'number' ? { token_budget: obj.token_budget } : {}),
    ...(typeof obj.recursive_scanning === 'boolean' ? { recursive_scanning: obj.recursive_scanning } : {}),
    ...(typeof obj.extensions === 'object' && obj.extensions !== null
      ? { extensions: obj.extensions as Record<string, unknown> }
      : {}),
    entries,
  }
}

/** Serialize a tavern book into the ST world-info file form (uid-keyed object). */
export function serializeWorldBookFile(book: WorldBook): Record<string, unknown> {
  const entries: Record<string, unknown> = {}
  for (const entry of book.entries) {
    entries[String(entry.uid)] = serializeEntry(entry)
  }
  return {
    ...(book.name !== undefined ? { name: book.name } : {}),
    ...(book.description !== undefined ? { description: book.description } : {}),
    ...(book.scan_depth !== undefined ? { scan_depth: book.scan_depth } : {}),
    ...(book.token_budget !== undefined ? { token_budget: book.token_budget } : {}),
    ...(book.recursive_scanning !== undefined ? { recursive_scanning: book.recursive_scanning } : {}),
    ...(book.extensions !== undefined ? { extensions: book.extensions } : {}),
    entries,
  }
}

/** Serialize one entry back to the ST top-level + extensions form. */
function serializeEntry(entry: WorldBookEntry): Record<string, unknown> {
  const ext: Record<string, unknown> = {
    ...entry.extensions,
    position: entry.position,
    exclude_recursion: entry.excludeRecursion,
    display_index: entry.order,
    probability: entry.probability,
    useProbability: entry.useProbability,
    depth: entry.depth,
    selectiveLogic: entry.selectiveLogic,
    outlet_name: entry.outletName,
    group: entry.group,
    group_override: entry.groupOverride,
    group_weight: entry.groupWeight,
    prevent_recursion: entry.preventRecursion,
    delay_until_recursion: entry.delayUntilRecursion,
    scan_depth: entry.scanDepth,
    match_whole_words: entry.matchWholeWords,
    use_group_scoring: entry.useGroupScoring,
    case_sensitive: entry.caseSensitive,
    automation_id: entry.automationId,
    role: entry.role,
    vectorized: entry.vectorized,
    sticky: entry.sticky,
    cooldown: entry.cooldown,
    delay: entry.delay,
    match_persona_description: entry.matchPersonaDescription,
    match_character_description: entry.matchCharacterDescription,
    match_character_personality: entry.matchCharacterPersonality,
    match_character_depth_prompt: entry.matchCharacterDepthPrompt,
    match_scenario: entry.matchScenario,
    match_creator_notes: entry.matchCreatorNotes,
    triggers: entry.triggers,
    ignore_budget: entry.ignoreBudget,
  }
  return {
    uid: entry.uid,
    key: entry.key,
    keysecondary: entry.keysecondary,
    comment: entry.comment,
    content: entry.content,
    constant: entry.constant,
    vectorized: entry.vectorized,
    selective: entry.selective,
    selectiveLogic: entry.selectiveLogic,
    addMemo: entry.addMemo,
    order: entry.order,
    position: entry.position,
    disable: entry.disable,
    ignoreBudget: entry.ignoreBudget,
    excludeRecursion: entry.excludeRecursion,
    preventRecursion: entry.preventRecursion,
    matchPersonaDescription: entry.matchPersonaDescription,
    matchCharacterDescription: entry.matchCharacterDescription,
    matchCharacterPersonality: entry.matchCharacterPersonality,
    matchCharacterDepthPrompt: entry.matchCharacterDepthPrompt,
    matchScenario: entry.matchScenario,
    matchCreatorNotes: entry.matchCreatorNotes,
    delayUntilRecursion: entry.delayUntilRecursion,
    probability: entry.probability,
    useProbability: entry.useProbability,
    depth: entry.depth,
    outletName: entry.outletName,
    group: entry.group,
    groupOverride: entry.groupOverride,
    groupWeight: entry.groupWeight,
    scanDepth: entry.scanDepth,
    caseSensitive: entry.caseSensitive,
    matchWholeWords: entry.matchWholeWords,
    useGroupScoring: entry.useGroupScoring,
    automationId: entry.automationId,
    role: entry.role,
    sticky: entry.sticky,
    cooldown: entry.cooldown,
    delay: entry.delay,
    triggers: entry.triggers,
    ...(entry.keyregex !== undefined ? { keyregex: entry.keyregex } : {}),
    extensions: ext,
  }
}

// ── Presets ────────────────────────────────────────────────────────────────

/** Import a SillyTavern preset JSON (any preset_type) into a tavern preset. */
export function importPreset(raw: unknown, id: string, name: string): Preset {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('预设 JSON 无效：不是对象')
  }
  const obj = raw as Record<string, unknown>
  const num = (key: string): number | undefined => {
    const value = obj[key]
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined
  }
  return {
    id,
    name,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...(typeof obj.custom_model === 'string' && obj.custom_model !== ''
      ? { model: obj.custom_model }
      : {}),
    maxTokens: num('max_tokens'),
    temperature: num('temp'),
    topP: num('top_p'),
    topK: num('top_k'),
    topA: num('top_a'),
    typicalP: num('typical_p'),
    minP: num('min_p'),
    repPen: num('rep_pen'),
    repPenRange: num('rep_pen_range'),
    repPenSlope: num('rep_pen_slope'),
    presencePenalty: num('presence_penalty'),
    frequencyPenalty: num('frequency_penalty'),
    // Keep the full original payload for round-trip export.
    raw: { ...obj },
  }
}

/** Serialize a tavern preset back to ST preset JSON. */
export function serializePreset(preset: Preset): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(preset.raw ?? {}) }
  out.name = preset.name
  const set = (key: string, value: number | undefined): void => {
    if (value !== undefined) out[key] = value
  }
  set('max_tokens', preset.maxTokens)
  set('temp', preset.temperature)
  set('top_p', preset.topP)
  set('top_k', preset.topK)
  set('top_a', preset.topA)
  set('typical_p', preset.typicalP)
  set('min_p', preset.minP)
  set('rep_pen', preset.repPen)
  set('rep_pen_range', preset.repPenRange)
  set('rep_pen_slope', preset.repPenSlope)
  set('presence_penalty', preset.presencePenalty)
  set('frequency_penalty', preset.frequencyPenalty)
  if (preset.model !== undefined) out.custom_model = preset.model
  return out
}

// ── Chat import/export ─────────────────────────────────────────────────────

/** Parse a SillyTavern/TauriTavern chat .jsonl file into play messages. */
export function importChatJsonl(text: string, characterNames: readonly string[]): PlayMessage[] {
  const messages: PlayMessage[] = []
  const isCharacter = (name: string): boolean =>
    characterNames.some(n => n !== '' && name === n)
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    let obj: Record<string, unknown>
    try {
      obj = JSON.parse(trimmed) as Record<string, unknown>
    } catch {
      continue
    }
    const name = typeof obj.name === 'string' ? obj.name : ''
    const mes = typeof obj.mes === 'string' ? obj.mes : ''
    const isUser = obj.is_user === true
    const isSystem = obj.is_system === true
    const kind: PlayMessage['kind'] = isSystem
      ? 'system'
      : isUser || name === '' ? 'user' : isCharacter(name) ? 'character' : 'narrator'
    messages.push({
      id: `import-${messages.length}-${Date.now().toString(36)}`,
      name: name !== '' ? name : undefined,
      kind,
      content: mes,
      createdAt: new Date().toISOString(),
    })
  }
  return messages
}

/** Serialize play messages into the ST/TauriTavern chat jsonl format. */
export function exportChatJsonl(messages: readonly PlayMessage[]): string {
  const lines = messages.map((message) => {
    const isUser = message.kind === 'user'
    const isSystem = message.kind === 'system'
    return JSON.stringify({
      name: message.name ?? (isUser ? 'You' : ''),
      is_user: isUser,
      is_system: isSystem,
      send_date: message.createdAt,
      mes: message.content,
    })
  })
  return lines.join('\n')
}

// ── Helpers ────────────────────────────────────────────────────────────────

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function strArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string')
  }
  if (typeof value === 'string') {
    // Some tools serialize tags as a comma-separated string.
    return value.split(',').map(s => s.trim()).filter(s => s !== '')
  }
  return []
}
