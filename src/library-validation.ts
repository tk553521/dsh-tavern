/** Runtime checks shared by library loading, record writes and legacy recovery.
 * These checks guard the shapes consumers dereference, not a versioned allowlist:
 * unknown properties and extension payloads survive unchanged, and bookkeeping
 * added by newer releases is never made mandatory for an older record.
 */

export type LibraryCollection = 'characters' | 'lorebooks' | 'presets' | 'plays' | 'branches'

// Unicode letters/digits keep previously readable local ids (e.g. Chinese)
// portable without allowing separators, control bytes or traversal components.
const SAFE_ID = /^[\p{L}\p{N}._~-]{1,128}$/u

/** Unlike RegExp.test alone, this must not coerce missing/numeric ids to strings. */
export function isSafeLibraryId(value: unknown): value is string {
  return typeof value === 'string' && SAFE_ID.test(value) && value !== '.' && value !== '..'
}

type JsonRecord = Record<string, unknown>

function invalid(field: string, shape: string): never {
  // Only field names and expected shapes are logged, never source file contents.
  throw new Error(`tavern library: invalid record; ${field} must be ${shape}`)
}

function object(value: unknown, field: string): JsonRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid(field, 'an object')
  return value as JsonRecord
}

function string(value: unknown, field: string): void {
  if (typeof value !== 'string') invalid(field, 'a string')
}

function strings(value: unknown, field: string): void {
  if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) invalid(field, 'a string array')
}

function optionalStrings(record: JsonRecord, fields: readonly string[], prefix: string): void {
  for (const field of fields) {
    if (record[field] !== undefined) string(record[field], `${prefix}.${field}`)
  }
}

function optionalNumbers(record: JsonRecord, fields: readonly string[], prefix: string, nullable = false): void {
  for (const field of fields) {
    const value = record[field]
    if (value === undefined || (nullable && value === null)) continue
    if (typeof value !== 'number' || !Number.isFinite(value)) invalid(`${prefix}.${field}`, 'a finite number')
  }
}

function optionalBooleans(record: JsonRecord, fields: readonly string[], prefix: string, nullable = false): void {
  for (const field of fields) {
    const value = record[field]
    if (value === undefined || (nullable && value === null)) continue
    if (typeof value !== 'boolean') invalid(`${prefix}.${field}`, 'a boolean')
  }
}

function optionalObject(record: JsonRecord, field: string, prefix: string): void {
  if (record[field] !== undefined) object(record[field], `${prefix}.${field}`)
}

function worldBook(value: unknown, prefix: string): void {
  const book = object(value, prefix)
  optionalStrings(book, ['name', 'description'], prefix)
  optionalNumbers(book, ['scan_depth', 'token_budget'], prefix)
  optionalBooleans(book, ['recursive_scanning'], prefix)
  optionalObject(book, 'extensions', prefix)
  if (!Array.isArray(book.entries)) invalid(`${prefix}.entries`, 'an array')
  for (let index = 0; index < book.entries.length; index++) {
    const field = `${prefix}.entries[${index}]`
    const entry = object(book.entries[index], field)
    if (typeof entry.uid !== 'number' || !Number.isSafeInteger(entry.uid)) invalid(`${field}.uid`, 'a safe integer')
    strings(entry.key, `${field}.key`)
    strings(entry.keysecondary, `${field}.keysecondary`)
    string(entry.comment, `${field}.comment`)
    string(entry.content, `${field}.content`)
    object(entry.extensions, `${field}.extensions`)
    optionalStrings(entry, ['keyregex', 'group', 'outletName', 'automationId', 'name'], field)
    if (entry.triggers !== undefined) strings(entry.triggers, `${field}.triggers`)
    optionalBooleans(entry, [
      'constant', 'vectorized', 'selective', 'addMemo', 'disable', 'ignoreBudget',
      'excludeRecursion', 'preventRecursion', 'matchPersonaDescription',
      'matchCharacterDescription', 'matchCharacterPersonality', 'matchCharacterDepthPrompt',
      'matchScenario', 'matchCreatorNotes', 'useProbability', 'groupOverride',
    ], field)
    optionalBooleans(entry, ['caseSensitive', 'matchWholeWords', 'useGroupScoring'], field, true)
    optionalNumbers(entry, [
      'selectiveLogic', 'order', 'position', 'delayUntilRecursion', 'probability',
      'depth', 'groupWeight', 'role', 'priority',
    ], field)
    optionalNumbers(entry, ['scanDepth', 'sticky', 'cooldown', 'delay'], field, true)
  }
}

function character(record: JsonRecord): void {
  const card = object(record.card, 'character.card')
  const data = object(card.data, 'character.card.data')
  // Canonical cards from every supported source version carry these fields.
  // The envelope is not restricted to one spec literal so future metadata is kept.
  optionalStrings(card, ['spec', 'spec_version'], 'character.card')
  for (const field of [
    'name', 'description', 'personality', 'scenario', 'first_mes', 'mes_example',
    'creator_notes', 'system_prompt', 'post_history_instructions', 'creator', 'character_version',
  ]) string(data[field], `character.card.data.${field}`)
  if ((data.name as string).trim() === '') invalid('character.card.data.name', 'a non-empty string')
  strings(data.alternate_greetings, 'character.card.data.alternate_greetings')
  strings(data.tags, 'character.card.data.tags')
  object(data.extensions, 'character.card.data.extensions')
  if (data.group_only_greetings !== undefined) strings(data.group_only_greetings, 'character.card.data.group_only_greetings')
  if (data.character_book !== undefined) worldBook(data.character_book, 'character.card.data.character_book')
  optionalStrings(record, ['avatar'], 'character')
}

function preset(record: JsonRecord): void {
  string(record.name, 'preset.name')
  optionalStrings(record, ['provider', 'model', 'systemPrompt'], 'preset')
  optionalNumbers(record, [
    'maxTokens', 'temperature', 'topP', 'topK', 'topA', 'typicalP', 'minP',
    'repPen', 'repPenRange', 'repPenSlope', 'presencePenalty', 'frequencyPenalty',
  ], 'preset')
  optionalObject(record, 'raw', 'preset')
}

function play(record: JsonRecord): void {
  string(record.title, 'play.title')
  strings(record.characterIds, 'play.characterIds')
  string(record.sessionId, 'play.sessionId')
  if (record.sessionId === '') invalid('play.sessionId', 'a non-empty string')
  if (record.lorebookIds !== undefined) strings(record.lorebookIds, 'play.lorebookIds')
  optionalStrings(record, ['lorebookId', 'presetId', 'greeting'], 'play')
  optionalBooleans(record, ['multiAgent', 'narratorEnabled'], 'play')
  optionalNumbers(record, ['greetingIndex'], 'play')
}

function branch(record: JsonRecord): string {
  if (!isSafeLibraryId(record.playId)) invalid('branch.playId', 'a filename-safe string id')
  if (!isSafeLibraryId(record.key)) invalid('branch.key', 'a filename-safe string key')
  const key = `${record.playId}~${record.key}`
  if (!isSafeLibraryId(key)) invalid('branch filename', 'a filename-safe key of at most 128 characters')
  if (!Array.isArray(record.prefix)) invalid('branch.prefix', 'an array')
  if (!Array.isArray(record.variants) || record.variants.length === 0 || !record.variants.every(Array.isArray)) {
    invalid('branch.variants', 'a non-empty array of event arrays')
  }
  if (typeof record.current !== 'number' || !Number.isSafeInteger(record.current)
    || record.current < 0 || record.current >= record.variants.length) invalid('branch.current', 'an existing variant index')
  string(record.userText, 'branch.userText')
  optionalStrings(record, ['error'], 'branch')
  optionalBooleans(record, ['busy'], 'branch')
  // Older branches have no lineage ids. When present, these identities are
  // consumed by host/client recovery and must not be coerced or blank.
  for (const field of ['userMessageId', 'sessionId']) {
    if (record[field] !== undefined) {
      string(record[field], `branch.${field}`)
      if ((record[field] as string).trim() === '') invalid(`branch.${field}`, 'a non-empty string')
    }
  }
  // Other future fields pass through. Events are opaque host-owned JSON;
  // do not version-gate their contents here.
  return key
}

/** Validate a record and return its disk/index identity.
 * @param expectedKey The filename stem during load, or the snapshotted key during put.
 * @throws On malformed core fields or a filename/record identity mismatch.
 */
export function validateLibraryRecord(collection: LibraryCollection, value: unknown, expectedKey?: string): string {
  const record = object(value, collection)
  optionalStrings(record, ['source', 'createdAt', 'updatedAt'], collection)
  let key: string
  if (collection === 'branches') {
    key = branch(record)
  } else {
    if (!isSafeLibraryId(record.id)) invalid(`${collection}.id`, 'a filename-safe string id')
    key = record.id
    if (collection === 'characters') character(record)
    else if (collection === 'lorebooks') {
      string(record.name, 'lorebook.name')
      worldBook(record.book, 'lorebook.book')
    } else if (collection === 'presets') preset(record)
    else play(record)
  }
  if (expectedKey !== undefined && (!isSafeLibraryId(expectedKey) || expectedKey !== key)) {
    invalid('record identity', 'equal to its filename key')
  }
  return key
}
