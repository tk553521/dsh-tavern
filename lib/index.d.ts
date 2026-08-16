import { Context, LoggerService } from "@deepseek-ai/cordis";
import Schema from "@deepseek-ai/schemastery";
import { SettingsScope } from "@deepseek-ai/dsh-settings";
import { dshHomePath } from "@deepseek-ai/dsh-home-paths";
import { Agent, AgentHandle, AgentRegistry } from "@deepseek-ai/dsh-agent";
import { AgentPresets } from "@deepseek-ai/dsh-agent-presets";
import "@deepseek-ai/dsh-session";
import SessionPersistence from "@deepseek-ai/dsh-session-persistence";
import { ToolRunContext } from "@deepseek-ai/dsh-tools";
import { WorkspaceRegistry } from "@deepseek-ai/dsh-workspace";
//#region src/types.d.ts
/**
 * dsh-tavern data model: SillyTavern/TauriTavern compatible character cards,
 * world books (lorebooks), presets, and chat messages.
 */
/** The character card body, compatible with SillyTavern chara_card_v2. */
interface CharacterCardData {
  name: string;
  description: string;
  personality: string;
  scenario: string;
  first_mes: string;
  mes_example: string;
  creator_notes: string;
  system_prompt: string;
  post_history_instructions: string;
  alternate_greetings: string[];
  group_only_greetings?: string[];
  character_book?: WorldBook;
  tags: string[];
  creator: string;
  character_version: string;
  /** Free-form extension map kept verbatim for round-trip fidelity. */
  extensions: Record<string, unknown>;
}
/** The full chara_card_v2 envelope. */
interface CharacterCard {
  spec: 'chara_card_v2';
  spec_version: string;
  data: CharacterCardData;
}
/** A tavern-managed character: the card plus local bookkeeping. */
interface CharacterRecord {
  id: string;
  /** Import source display name (file name or manual). */
  source?: string;
  /**
   * Avatar as a data URL (legacy inline) or as a DSH-home-relative file path
   * (`tavern/avatars/<character-id>.png`).  The client and export route resolve
   * the path through the `/tavern/avatars/...` HTTP route.
   */
  avatar?: string;
  /** When this record was created, ISO string. */
  createdAt: string;
  /** When this record was last edited, ISO string. */
  updatedAt: string;
  card: CharacterCard;
}
/** One world-info entry, SillyTavern field names (camelCase top level). */
interface WorldBookEntry {
  uid: number;
  /** Primary match keys. */
  key: string[];
  /** Secondary match keys. */
  keysecondary: string[];
  /** Editor comment (also shown to the model when addMemo). */
  comment: string;
  content: string;
  /** Always active regardless of key matching. */
  constant: boolean;
  vectorized: boolean;
  selective: boolean;
  /** AND_ANY=0, NOT_ALL=1, NOT_ANY=2, AND_ALL=3. */
  selectiveLogic: number;
  addMemo: boolean;
  /** Display order in the editor (insertion order default 100). */
  order: number;
  /** Insert position: 0=before, 1=after (2..7 are AN/EM/atDepth/outlet variants). */
  position: number;
  disable: boolean;
  ignoreBudget: boolean;
  excludeRecursion: boolean;
  preventRecursion: boolean;
  matchPersonaDescription: boolean;
  matchCharacterDescription: boolean;
  matchCharacterPersonality: boolean;
  matchCharacterDepthPrompt: boolean;
  matchScenario: boolean;
  matchCreatorNotes: boolean;
  /** Delay in messages before recursive insertion applies. */
  delayUntilRecursion: number;
  /** Activation probability in percent. */
  probability: number;
  useProbability: boolean;
  /** Minimum message depth for activation (default 4). */
  depth: number;
  outletName: string;
  /** Group id (string in ST; one member activates at a time). */
  group: string;
  groupOverride: boolean;
  groupWeight: number;
  scanDepth: number | null;
  caseSensitive: boolean | null;
  matchWholeWords: boolean | null;
  useGroupScoring: boolean | null;
  automationId: string;
  /** SYSTEM=0, USER=1, ASSISTANT=2, NARRATOR=3. */
  role: number;
  sticky: number | null;
  cooldown: number | null;
  delay: number | null;
  /** Generated-content triggers (rarely used). */
  triggers: string[];
  /** Persisted snake_case metadata mirror (SillyTavern world-info format). */
  extensions: WorldBookEntryExtensions;
  /** Regex key alternative. */
  keyregex?: string;
}
/** One world-info entry extension block (snake_case, ST world-info files). */
interface WorldBookEntryExtensions {
  position?: number;
  exclude_recursion?: boolean;
  display_index?: number;
  probability?: number;
  useProbability?: boolean;
  depth?: number;
  selectiveLogic?: number;
  outlet_name?: string;
  group?: string;
  group_override?: boolean;
  group_weight?: number;
  prevent_recursion?: boolean;
  delay_until_recursion?: number;
  scan_depth?: number | null;
  match_whole_words?: boolean | null;
  use_group_scoring?: boolean | null;
  case_sensitive?: boolean | null;
  automation_id?: string;
  role?: number;
  vectorized?: boolean;
  sticky?: number | null;
  cooldown?: number | null;
  delay?: number | null;
  match_persona_description?: boolean;
  match_character_description?: boolean;
  match_character_personality?: boolean;
  match_character_depth_prompt?: boolean;
  match_scenario?: boolean;
  match_creator_notes?: boolean;
  triggers?: string[];
  ignore_budget?: boolean;
  /** Extra unknown keys pass through untouched. */
  [key: string]: unknown;
}
/** A full world book (lorebook) in tavern-internal array form. */
interface WorldBook {
  name?: string;
  description?: string;
  scan_depth?: number;
  token_budget?: number;
  recursive_scanning?: boolean;
  extensions?: Record<string, unknown>;
  /** Entries in array form (converted from ST's uid-keyed object on import). */
  entries: WorldBookEntry[];
}
/** A tavern-managed world book plus local bookkeeping. */
interface WorldBookRecord {
  id: string;
  name: string;
  /** Import source path (worlds/<file>); used to make re-import idempotent. */
  source?: string;
  createdAt: string;
  updatedAt: string;
  book: WorldBook;
}
/** AI preset: sampling knobs plus DSH model routing. */
interface Preset {
  id: string;
  name: string;
  /** Import source path (preset dir/<file>); used to make re-import idempotent. */
  source?: string;
  createdAt: string;
  updatedAt: string;
  /** DSH provider route; absent = session default. */
  provider?: string;
  /** DSH model id; absent = session default. */
  model?: string;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  topK?: number;
  topA?: number;
  typicalP?: number;
  minP?: number;
  repPen?: number;
  repPenRange?: number;
  repPenSlope?: number;
  presencePenalty?: number;
  frequencyPenalty?: number;
  /** System prompt override layered over the character card. */
  systemPrompt?: string;
  /** Free-form extras kept for round-trip fidelity. */
  raw?: Record<string, unknown>;
}
/**
 * One roleplay session ("play"): characters + world book + preset bound to a
 * DSH session. The conversation itself lives in the DSH session log — the
 * tavern plugin only supplies the composition (prompts, world book, model
 * route) and the multi-agent tooling.
 */
interface Play {
  id: string;
  title: string;
  /** Character record ids in the scene, first = main character. */
  characterIds: string[];
  /**
   * World book record ids bound to this play (multiple books are merged in
   * selection order when the prompt is assembled).
   */
  lorebookIds?: string[];
  /** @deprecated Legacy single-book field, kept to read plays persisted before multi-select. */
  lorebookId?: string;
  /** Preset record id; absent = defaults. */
  presetId?: string;
  /** Whether the director agent narrates scene transitions. */
  narratorEnabled: boolean;
  /** Multi-agent mode: characters are separate DSH agents via tavern_speak. */
  multiAgent: boolean;
  /** The bound DSH session id (the director agent's session). */
  sessionId: string;
  /** Selected greeting (first_mes or alternate); used as the opening seed. */
  greetingIndex?: number;
  /** The greeting text chosen for this play. */
  greeting?: string;
  createdAt: string;
  updatedAt: string;
}
/** Tavern view style: DSH-token look or the legacy dark-gold palette. */
type TavernStyle = 'dsh' | 'classic';
/** Categories selected for a local TauriTavern data-directory import. */
interface TauriTavernImportSelection {
  characters: boolean;
  lorebooks: boolean;
  presets: boolean;
}
/** One file that could not be imported (the rest of the import continues). */
interface TauriTavernImportIssue {
  category: 'character' | 'lorebook' | 'preset';
  /** Path relative to the detected TauriTavern user directory. */
  file: string;
  reason: string;
}
/** Result of one local TauriTavern data-directory import. */
interface TauriTavernImportReport {
  /** The path the user supplied. */
  input: string;
  /** Detected TauriTavern data root (parent of default-user). */
  root: string;
  /** Detected TauriTavern user directory (contains characters/worlds/...). */
  userDir: string;
  imported: {
    characters: number;
    lorebooks: number;
    presets: number;
  };
  issues: TauriTavernImportIssue[];
}
//#endregion
//#region src/storage.d.ts
/** The persisted tavern database shape. */
interface TavernDatabase {
  version: 1;
  characters: CharacterRecord[];
  lorebooks: WorldBookRecord[];
  presets: Preset[];
  plays: Play[];
  defaultPresetId?: string;
  /** Tavern view style preference. */
  style?: TavernStyle;
}
/**
 * Storage facade over the settings scope. Every mutation replaces whole
 * arrays (the settings patch merges shallowly), so readers always see a
 * consistent snapshot.
 */
declare class TavernStorage {
  private readonly scope;
  constructor(scope: SettingsScope<TavernDatabase>);
  snapshot(): TavernDatabase;
  listCharacters(): CharacterRecord[];
  getCharacter(id: string): CharacterRecord | undefined;
  upsertCharacter(record: CharacterRecord): Promise<void>;
  /** Persist the complete character array (used by avatar-file migration). */
  replaceCharacters(records: CharacterRecord[]): Promise<void>;
  /** Bulk-append imported character records in a single settings write. */
  appendCharacters(records: CharacterRecord[]): Promise<void>;
  deleteCharacter(id: string): Promise<void>;
  listLorebooks(): WorldBookRecord[];
  getLorebook(id: string): WorldBookRecord | undefined;
  upsertLorebook(record: WorldBookRecord): Promise<void>;
  /** Bulk-append imported lorebook records in a single settings write. */
  appendLorebooks(records: WorldBookRecord[]): Promise<void>;
  deleteLorebook(id: string): Promise<void>;
  listPresets(): Preset[];
  getPreset(id: string): Preset | undefined;
  upsertPreset(preset: Preset): Promise<void>;
  /** Bulk-append imported preset records in a single settings write. */
  appendPresets(records: Preset[]): Promise<void>;
  deletePreset(id: string): Promise<void>;
  listPlays(): Play[];
  getPlay(id: string): Play | undefined;
  upsertPlay(play: Play): Promise<void>;
  deletePlay(id: string): Promise<void>;
  setDefaultPreset(id: string | undefined): Promise<void>;
  /** Persist the tavern view style preference. */
  setStyle(style: TavernStyle): Promise<void>;
}
//#endregion
//#region src/avatarstore.d.ts
/**
 * File-backed avatar store.  Persisted paths are always relative to the DSH
 * home directory so the settings document stays host-independent.
 */
declare class AvatarStore {
  readonly root: string;
  private readonly logger;
  constructor(root: string, logger: Pick<LoggerService, 'warn'>);
  private filePath;
  private ensureRoot;
  /**
   * Replace a character's data-URL avatar with an on-disk file and return the
   * record that should be persisted.  Records that already use a relative path
   * (or have no avatar) are returned unchanged.
   */
  materializeCharacter(record: CharacterRecord, previous?: CharacterRecord): Promise<CharacterRecord>;
  /** Materialize every data-URL avatar in one batch (used by the importer). */
  materializeCharacters(records: CharacterRecord[]): Promise<CharacterRecord[]>;
  /**
   * Migrate legacy inline avatars out of the settings document.  A failed file
   * write keeps the original data URL, so a migration is always safe to retry.
   */
  migrateLegacyCharacters(records: CharacterRecord[]): Promise<{
    characters: CharacterRecord[];
    changed: number;
  }>;
  /** Read a stored avatar for the HTTP route. */
  read(file: string): Promise<{
    bytes: Buffer;
    contentType: string;
  } | undefined>;
  /** Read the bytes backing a character record (legacy inline or on-disk). */
  readCharacter(record: CharacterRecord): Promise<Buffer | undefined>;
  /** Remove the on-disk avatar for a deleted character. */
  removeCharacter(record: CharacterRecord): Promise<void>;
}
//#endregion
//#region src/play.d.ts
interface PlayRuntimeDeps {
  storage: TavernStorage;
  agents: AgentRegistry;
  /** Agent-preset roster: mounts the tavern preset for play sessions. */
  agentPresets: AgentPresets;
  /** Workspace registry: tavern sessions are archived (hidden from every grouping surface). */
  workspace: WorkspaceRegistry;
  /** Session persistence: resolves the preset a persisted session was produced under. */
  sessionPersistence: SessionPersistence;
  /** Author the tavern preset into the harness-home user root (memoized, non-clobbering). */
  ensurePreset: () => Promise<void>;
  /** Default model selection for agents without a preset override. */
  defaultModel: () => {
    provider: string;
    model: string;
    reasoningEffort?: string;
  };
  logger: LoggerService;
}
/**
 * The tavern session runtime: owns the director and character agents of
 * every play, keyed by play id, and exposes the `tavern_speak` execution.
 */
declare class TavernSessionRuntime {
  private readonly deps;
  /** playId → director handle. */
  private readonly directors;
  /** playId → (characterId → handle). */
  private readonly roles;
  /** agentId → tail promise serializing tavern_speak calls per character agent. */
  private readonly speakQueues;
  constructor(deps: PlayRuntimeDeps);
  /** Dispose every live agent (called from the plugin's teardown effect). */
  dispose(): void;
  /** Run one tavern_speak task after any previous task for the same agent settles. */
  private enqueueSpeak;
  /** Live director agent for a play, or undefined. */
  getDirector(playId: string): Agent | undefined;
  /**
   * Assemble (create or resume) the director agent for a play. Idempotent per
   * process: the director's session id is the play-bound DSH session. When
   * the persisted session exists (a previous run), it is resumed so history
   * survives restarts; otherwise a fresh session is created. Every play
   * session runs under the tavern agent preset and is archived so the
   * workspace browser (「对话」页) never lists it — the play lives inside the
   * tavern page only.
   */
  ensureDirector(play: Play): Promise<AgentHandle>;
  /**
   * The preset a persisted session actually runs, newest selection winning
   * (mirrors `resolveSessionPreset` from dsh-agent-presets; inlined to keep
   * the host half free of @deepseek-ai runtime imports).
   * @param header - the persisted session's creation header.
   * @param events - the persisted session's event log, oldest first.
   * @returns the recorded preset id, or undefined for a session composed bare.
   */
  private recordedPreset;
  /**
   * Probe the persisted session for the preset it was produced under.
   * @param sessionId - the session to probe.
   * @returns the recorded preset id, or undefined when the session is not
   * persisted (a fresh play) or has none recorded (legacy).
   */
  private persistedPreset;
  /**
   * Compose one play session's scoped world: mount the session's agent
   * preset (when it has one), then register the play's own system prompt
   * into the persona slot and the world-book dynamic context.
   * @param presetId - preset to mount, or undefined to compose bare (legacy).
   * @param system - the director/character system prompt text.
   * @param loreContext - the world-book dynamic context, or null.
   */
  private sessionSetup;
  /**
   * Archive one play session: tavern sessions are hidden from every workspace
   * grouping surface (the 对话 page) and live inside the tavern page only.
   * Idempotent; failures only log because a play must stay usable.
   * @param sessionId - the session to hide.
   */
  private hideFromWorkspace;
  /** Compose the director's system prompt. */
  private buildDirectorSystem;
  /** Dynamic world-book context for the director's assembly. */
  private buildLoreContext;
  /** Resolve the world-book records bound to one play, in play order. */
  private playLorebooks;
  /** Recent user/assistant text of a session, newest last (world-book scan). */
  private recentSessionText;
  /**
   * Execute one tavern_speak call: route to the named character agent (in
   * multi-agent mode), or fall back to the director's own voice.
   * @param exec - tool execution context (its agent is the director).
   * @param args - characterName/characterId plus the instruction.
   * @returns the character's lines.
   */
  speakFor(exec: ToolRunContext, args: {
    characterName?: string;
    characterId?: string;
    instruction?: string;
  }): Promise<{
    reply: string;
  }>;
  /** Create (or reuse) the character agent for one play (multi-agent mode). */
  private ensureRoleAgent;
  /** Drop the live agents of one play (play deleted). */
  dropPlay(playId: string): Promise<void>;
}
//#endregion
//#region src/index.d.ts
declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The tavern service: library CRUD plus play/session assembly. */
    tavern: TavernService;
    /** Resolves a path under the DSH home (provided by app boot). */
    dshHomePath: typeof dshHomePath;
  }
}
declare const name = "dsh-tavern";
/** Services required by the host half. */
declare const inject: string[];
/**
 * Schema of the tavern settings namespace (one document per installation).
 * A hand-rolled permissive Standard-Schema callable: out-of-tree plugins
 * cannot resolve @deepseek-ai runtime packages, so the schema carries no
 * schemastery dependency. It validates the version marker and fills missing
 * top-level arrays, accepting unknown fields for forward compatibility.
 */
declare const TavernSchema: Schema<TavernDatabase>;
/**
 * The tavern service: library CRUD and the session runtime. The browser
 * talks to the REST route; other host plugins may use this service directly.
 */
declare class TavernService {
  readonly storage: TavernStorage;
  readonly runtime: TavernSessionRuntime;
  readonly avatars: AvatarStore;
  private readonly ctx;
  constructor(ctx: Context, settingsScope: SettingsScope<TavernDatabase>, avatars: AvatarStore);
  /** All stored characters. */
  listCharacters(): CharacterRecord[];
  /** All stored world books. */
  listLorebooks(): WorldBookRecord[];
  /** All stored presets. */
  listPresets(): Preset[];
  /** All stored plays. */
  listPlays(): Play[];
  /**
   * Import TauriTavern user data from a local installation/data directory
   * (portable app root, data root, default-user, or a child directory).
   */
  importTauriTavern(input: string, selection?: Partial<TauriTavernImportSelection>): Promise<TauriTavernImportReport>;
  /**
   * One-time (idempotent) migration: extract legacy inline data-URL avatars to
   * `<dsh-home>/tavern/avatars/` and persist only their relative paths.
   */
  migrateLegacyAvatars(): Promise<{
    changed: number;
  }>;
  /**
   * Whether the agent-loop factory is currently available.
   * `AgentRegistry` has no public factory probe; the stock agent-loop plugin
   * provides the public `agentLoop` Cordis service and registers itself as the
   * factory from that service's effect, so this is the reliable public signal.
   */
  multiAgentAvailable(): boolean;
}
/** Plugin entry: registers the settings namespace, the tool, and the route. */
declare function apply(ctx: Context): void;
//#endregion
export { TavernSchema, TavernService, apply, inject, name };