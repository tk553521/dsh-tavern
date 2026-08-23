/**
 * dsh-tavern data model: SillyTavern/TauriTavern compatible character cards,
 * world books (lorebooks), presets, and chat messages.
 */

// ── Character cards (chara_card_v2) ────────────────────────────────────────

/** The character card body, compatible with SillyTavern chara_card_v2. */
export interface CharacterCardData {
  name: string
  description: string
  personality: string
  scenario: string
  first_mes: string
  mes_example: string
  creator_notes: string
  system_prompt: string
  post_history_instructions: string
  alternate_greetings: string[]
  group_only_greetings?: string[]
  character_book?: WorldBook
  tags: string[]
  creator: string
  character_version: string
  /** Free-form extension map kept verbatim for round-trip fidelity. */
  extensions: Record<string, unknown>
}

/** The full chara_card_v2 envelope. */
export interface CharacterCard {
  spec: 'chara_card_v2'
  spec_version: string
  data: CharacterCardData
}

/** A tavern-managed character: the card plus local bookkeeping. */
export interface CharacterRecord {
  id: string
  /** Import source display name (file name or manual). */
  source?: string
  /**
   * Avatar as a data URL (legacy inline) or as a DSH-home-relative file path
   * (`tavern/avatars/<character-id>.png`).  The client and export route resolve
   * the path through the `/tavern/avatars/...` HTTP route.
   */
  avatar?: string
  /** When this record was created, ISO string. */
  createdAt: string
  /** When this record was last edited, ISO string. */
  updatedAt: string
  card: CharacterCard
}

// ── World books (lorebooks) ────────────────────────────────────────────────

/** One world-info entry, SillyTavern field names (camelCase top level). */
export interface WorldBookEntry {
  uid: number
  /** Primary match keys. */
  key: string[]
  /** Secondary match keys. */
  keysecondary: string[]
  /** Editor comment (also shown to the model when addMemo). */
  comment: string
  content: string
  /** Always active regardless of key matching. */
  constant: boolean
  vectorized: boolean
  selective: boolean
  /** AND_ANY=0, NOT_ALL=1, NOT_ANY=2, AND_ALL=3. */
  selectiveLogic: number
  addMemo: boolean
  /** Display order in the editor (insertion order default 100). */
  order: number
  /** Insert position: 0=before, 1=after (2..7 are AN/EM/atDepth/outlet variants). */
  position: number
  disable: boolean
  ignoreBudget: boolean
  excludeRecursion: boolean
  preventRecursion: boolean
  matchPersonaDescription: boolean
  matchCharacterDescription: boolean
  matchCharacterPersonality: boolean
  matchCharacterDepthPrompt: boolean
  matchScenario: boolean
  matchCreatorNotes: boolean
  /** Delay in messages before recursive insertion applies. */
  delayUntilRecursion: number
  /** Activation probability in percent. */
  probability: number
  useProbability: boolean
  /** Minimum message depth for activation (default 4). */
  depth: number
  outletName: string
  /** Group id (string in ST; one member activates at a time). */
  group: string
  groupOverride: boolean
  groupWeight: number
  scanDepth: number | null
  caseSensitive: boolean | null
  matchWholeWords: boolean | null
  useGroupScoring: boolean | null
  automationId: string
  /** SYSTEM=0, USER=1, ASSISTANT=2, NARRATOR=3. */
  role: number
  sticky: number | null
  cooldown: number | null
  delay: number | null
  /** Generated-content triggers (rarely used). */
  triggers: string[]
  /** Persisted snake_case metadata mirror (SillyTavern world-info format). */
  extensions: WorldBookEntryExtensions
  /** Regex key alternative. */
  keyregex?: string
}

/** One world-info entry extension block (snake_case, ST world-info files). */
export interface WorldBookEntryExtensions {
  position?: number
  exclude_recursion?: boolean
  display_index?: number
  probability?: number
  useProbability?: boolean
  depth?: number
  selectiveLogic?: number
  outlet_name?: string
  group?: string
  group_override?: boolean
  group_weight?: number
  prevent_recursion?: boolean
  delay_until_recursion?: number
  scan_depth?: number | null
  match_whole_words?: boolean | null
  use_group_scoring?: boolean | null
  case_sensitive?: boolean | null
  automation_id?: string
  role?: number
  vectorized?: boolean
  sticky?: number | null
  cooldown?: number | null
  delay?: number | null
  match_persona_description?: boolean
  match_character_description?: boolean
  match_character_personality?: boolean
  match_character_depth_prompt?: boolean
  match_scenario?: boolean
  match_creator_notes?: boolean
  triggers?: string[]
  ignore_budget?: boolean
  /** Extra unknown keys pass through untouched. */
  [key: string]: unknown
}

/** A full world book (lorebook) in tavern-internal array form. */
export interface WorldBook {
  name?: string
  description?: string
  scan_depth?: number
  token_budget?: number
  recursive_scanning?: boolean
  extensions?: Record<string, unknown>
  /** Entries in array form (converted from ST's uid-keyed object on import). */
  entries: WorldBookEntry[]
}

/** A tavern-managed world book plus local bookkeeping. */
export interface WorldBookRecord {
  id: string
  name: string
  /** Import source path (worlds/<file>); used to make re-import idempotent. */
  source?: string
  createdAt: string
  updatedAt: string
  book: WorldBook
}

// ── Presets ────────────────────────────────────────────────────────────────

/** AI preset: sampling knobs plus DSH model routing. */
export interface Preset {
  id: string
  name: string
  /** Import source path (preset dir/<file>); used to make re-import idempotent. */
  source?: string
  createdAt: string
  updatedAt: string
  /** DSH provider route; absent = session default. */
  provider?: string
  /** DSH model id; absent = session default. */
  model?: string
  maxTokens?: number
  temperature?: number
  topP?: number
  topK?: number
  topA?: number
  typicalP?: number
  minP?: number
  repPen?: number
  repPenRange?: number
  repPenSlope?: number
  presencePenalty?: number
  frequencyPenalty?: number
  /** System prompt override layered over the character card. */
  systemPrompt?: string
  /** Free-form extras kept for round-trip fidelity. */
  raw?: Record<string, unknown>
}

// ── Chat ───────────────────────────────────────────────────────────────────

/** One chat message inside a play. */
export interface PlayMessage {
  id: string
  /** Speaker display name; absent for system rows. */
  name?: string
  /** 'user' | 'character' | 'narrator' | 'system' */
  kind: 'user' | 'character' | 'narrator' | 'system'
  /** Character record id when spoken by a character agent. */
  characterId?: string
  content: string
  createdAt: string
}

/**
 * One roleplay session ("play"): characters + world book + preset bound to a
 * DSH session. The conversation itself lives in the DSH session log — the
 * tavern plugin only supplies the composition (prompts, world book, model
 * route) and the multi-agent tooling.
 */
export interface Play {
  id: string
  title: string
  /** Character record ids in the scene, first = main character. */
  characterIds: string[]
  /**
   * World book record ids bound to this play (multiple books are merged in
   * selection order when the prompt is assembled).
   */
  lorebookIds?: string[]
  /** @deprecated Legacy single-book field, kept to read plays persisted before multi-select. */
  lorebookId?: string
  /** Preset record id; absent = defaults. */
  presetId?: string
  /** Whether the director agent narrates scene transitions. */
  narratorEnabled: boolean
  /** Multi-agent mode: characters are separate DSH agents via tavern_speak. */
  multiAgent: boolean
  /** The bound DSH session id (the director agent's session). */
  sessionId: string
  /** Selected greeting (first_mes or alternate); used as the opening seed. */
  greetingIndex?: number
  /** The greeting text chosen for this play. */
  greeting?: string
  createdAt: string
  updatedAt: string
}

// ── Swipe branches (重试 / 左右切换的多次尝试) ──────────────────────────────

/**
 * One swipe branch: every alternative generation of the same assistant reply,
 * forked from a shared balanced session-log prefix. Because DSH session logs
 * are append-only, regenerating forks a NEW session per variant; the branch
 * keeps the prefix plus each variant's event tail so any alternative can be
 * re-materialized as a live session. Event numbers and texts are plain JSON
 * (`unknown[]`) so swapping variants needs no host-round-trip of typed data.
 */
export interface SwipeBranch {
  /** Play this branch belongs to. */
  playId: string
  /**
   * Stable branch identity: the event count of the fork prefix. One active
   * lineage has exactly one branch per user turn; edits delete stale ones.
   */
  key: string
  /** Balanced completed-turn prefix shared by every variant. */
  prefix: unknown[]
  /** The user message text replayed when a variant is generated. */
  userText: string
  /**
   * One event tail per attempt, from the question turn's `turn/start` through
   * its `turn/end`. An empty array marks an in-flight generation.
   */
  variants: unknown[][]
  /** Index of the variant currently materialized as the play's session. */
  current: number
  /** Whether a generation for `variants[current]` is still running. */
  busy: boolean
  /** Generation error of the last attempt, when it failed before settling. */
  error?: string
  updatedAt: string
}

/** Compact per-branch summary for the client (no event payloads). */
export interface SwipeBranchSummary {
  playId: string
  key: string
  count: number
  current: number
  busy: boolean
  error?: string
  updatedAt: string
}

// ── API wire types ─────────────────────────────────────────────────────────

/** Tavern view style: DSH-token look or the legacy dark-gold palette. */
export type TavernStyle = 'dsh' | 'classic'

/** Full tavern state snapshot served to the browser. */
export interface TavernState {
  characters: CharacterRecord[]
  lorebooks: WorldBookRecord[]
  presets: Preset[]
  plays: PlaySummary[]
  /** Default preset id (user preference). */
  defaultPresetId?: string
  /** Tavern view style preference. */
  style?: TavernStyle
  /** Whether the agent factory (agent-loop) is available for multi-agent plays. */
  multiAgentAvailable: boolean
  /** Swipe-branch summaries across plays (retry alternatives metadata only). */
  swipes: SwipeBranchSummary[]
}

// ── Local TauriTavern data-directory import ───────────────────────────────

/** Categories selected for a local TauriTavern data-directory import. */
export interface TauriTavernImportSelection {
  characters: boolean
  lorebooks: boolean
  presets: boolean
}

/** One file that could not be imported (the rest of the import continues). */
export interface TauriTavernImportIssue {
  category: 'character' | 'lorebook' | 'preset'
  /** Path relative to the detected TauriTavern user directory. */
  file: string
  reason: string
}

/** Result of one local TauriTavern data-directory import. */
export interface TauriTavernImportReport {
  /** The path the user supplied. */
  input: string
  /** Detected TauriTavern data root (parent of default-user). */
  root: string
  /** Detected TauriTavern user directory (contains characters/worlds/...). */
  userDir: string
  imported: {
    characters: number
    lorebooks: number
    presets: number
  }
  issues: TauriTavernImportIssue[]
}

/** Play summary for the state snapshot (no message bodies). */
export interface PlaySummary {
  id: string
  title: string
  characterIds: string[]
  /** World book record ids bound to this play. */
  lorebookIds?: string[]
  narratorEnabled: boolean
  multiAgent: boolean
  /** The bound DSH session id. */
  sessionId: string
  /** Whether the session is currently live in the agent registry. */
  live: boolean
  updatedAt: string
}

/** One generated reply chunk pushed to the browser. */
export interface ReplyEvent {
  kind: 'message' | 'done' | 'error'
  /** Message body for kind=message; error text for kind=error. */
  text?: string
  /** Speaker name for kind=message. */
  name?: string
  message?: PlayMessage
}
