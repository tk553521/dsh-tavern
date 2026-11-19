/**
 * Tavern session runtime (v2): the tavern play IS a DSH session.
 *
 * - Creating a play creates a DSH agent (the "director") whose session id is
 *   bound to the play record. The director's system prompt is assembled from
 *   the character cards; the world book is injected as a dynamic prompt
 *   context activated against recent session traffic; the greeting is seeded
 *   into the session log.
 * - In multi-agent mode the director is told to call the `tavern_speak`
 *   tool; the tool implementation drives the target character agent
 *   (a real DSH agent with its own session and memory) and returns its
 *   lines. In classic mode the director voices every character itself.
 *
 * All agents are created through `ctx.agents`; every handle is disposed with
 * the plugin's teardown effect.
 */

import { createHash } from 'node:crypto'
import type { LoggerService } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle, AgentRegistry, AgentSetup } from '@deepseek-ai/dsh-agent'
import type { AgentPresetRegistry } from '@deepseek-ai/dsh-agent-preset-registry'
import type { MessageId, UserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent, SessionHeader, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type SessionPersistence from '@deepseek-ai/dsh-session-persistence'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { WorkspaceRegistry } from '@deepseek-ai/dsh-workspace'
import type { CharacterRecord, Play, Preset, SwipeBranch, WorldBookRecord } from './types.ts'
import { TavernStorage, newId, nowIso } from './storage.ts'
import { activateBooks, hashSeed, renderWorldInfo, type ActivatedEntry } from './lorebook.ts'
import { TAVERN_PRESET_ID } from './tavern-preset.ts'
import { badRequest, conflict, notFound } from './errors.ts'
import { comparableForkEvents, sameForkHistory, sameReplyTail, swipeUserMessageId, tailUserMessageId } from './swipe.ts'
import type { TavernConfig } from './config.ts'
import {
  buildCharacterSystem, buildClassicSystem, characterProfile, createFence,
  neutralizeDelimiters, stripPromptVariables, type PromptFence,
} from './prompt.ts'

/**
 * The system-prompt section the tavern director/character prompt takes over.
 *
 * The host's own persona sections are `deployment:persona-prefix` and
 * `deployment:persona-suffix` (`dsh-system-prompt` registers them
 * unconditionally). The tavern does NOT reuse either name: a section name is a
 * key in one scope's layer, so reusing it either throws "already registered in
 * this scope" or shadows the host's section depending on which layer the
 * preset mount lands in — neither is a behaviour worth depending on.
 *
 * What actually makes the character-card prompt the whole system prompt is
 * `complete: true` below: prompt assembly folds every other section away when
 * exactly one complete section is active, and refuses to assemble when more
 * than one is. That is why the registered tavern preset marks its own persona
 * row `complete: false` — otherwise every assembly would throw.
 */
const TAVERN_SECTION = 'tavern:persona'
/** Same order as the host's `deployment:persona-prefix` slot (0). */
const TAVERN_ORDER = 0

/** Resolve the effective world-book ids for a play (new array field + legacy scalar field). */
export function playLorebookIds(play: Pick<Play, 'lorebookIds' | 'lorebookId'>): string[] {
  const ids = Array.isArray(play.lorebookIds)
    ? play.lorebookIds.filter((id): id is string => typeof id === 'string' && id !== '')
    : []
  if (typeof play.lorebookId === 'string' && play.lorebookId !== '' && !ids.includes(play.lorebookId)) {
    ids.unshift(play.lorebookId)
  }
  return [...new Set(ids)]
}

export interface PlayRuntimeDeps {
  storage: TavernStorage
  agents: AgentRegistry
  /** Agent-preset roster: mounts the tavern preset for play sessions. */
  agentPresets: AgentPresetRegistry
  /**
   * Workspace registry probe. Archiving a play session out of the 对话 page is
   * best-effort, so this is an OPTIONAL dependency resolved per call
   * (`ctx.get`) rather than injected — requiring it would stop the whole
   * tavern from loading in a profile that omits it.
   */
  workspace: () => WorkspaceRegistry | undefined
  /** Session persistence: resolves the preset a persisted session was produced under. */
  sessionPersistence: SessionPersistence
  /** Author the tavern preset into the harness-home user root (memoized, non-clobbering). */
  ensurePreset: () => Promise<unknown>
  /** Default model selection for agents without a preset override. */
  defaultModel: () => { provider: string; model: string; reasoningEffort?: string }
  logger: LoggerService
  /** Tunables from the plugin config (swipe cap, scan window, timeouts). */
  config: TavernConfig
}

/**
 * Admit a number as a session event position.
 *
 * Mirrors the host's `SessionSeq()` helper (a `number` brand plus a safety
 * check). It is re-implemented here rather than imported because the host half
 * must not carry ANY runtime `@deepseek-ai` import — the installed profile has
 * no such package tree, so an import would fail module resolution and the
 * plugin would never load (guarded by `scripts/verify/plugin.mjs`).
 * @param value - the event position to admit.
 * @returns the same number, branded.
 */
function sessionSeq(value: number): SessionSeq {
  if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) {
    throw new TypeError(`SessionSeq must be a non-negative safe integer, got ${String(value)}`)
  }
  return value as unknown as SessionSeq
}

/** Build a user message carrying tavern plugin provenance. */
function userMessage(content: string): UserMessage {
  return {
    id: crypto.randomUUID() as MessageId,
    role: 'user',
    content: [{ type: 'text', text: content }],
    // `MessageSourceMap` in 0.2.2-alpha.3 is `user | model | tool |
    // system-prompt`; the old `{ kind: 'plugin', plugin }` arm is gone and a
    // message carrying it is rejected by the session's event validation. A
    // tavern prompt is a user-role prompt injected by the plugin, and `user`
    // is the arm that says "not the model, not a tool".
    source: { kind: 'user' },
  }
}

/**
 * The durable session id of one play's character agent.
 *
 * This must be a pure function of the pair so a restart resumes the same
 * session. The previous derivation was
 * `` `tavern-role-${play.id.slice(0, 8)}-${character.id.slice(0, 8)}` ``, but
 * both ids are `<prefix>-<uuid>` and the prefixes are 5 characters, so each
 * side contributed only THREE hex digits — 12 bits. At ~50 plays the birthday
 * probability of two plays sharing a character session (and therefore its
 * memory) is around 30%. Hashing the full pair removes the collision class.
 *
 * Changing the derivation orphans role sessions created by earlier versions:
 * their history stays on disk but is no longer resumed. That is the intended
 * trade — the old ids may already have been cross-contaminating.
 */
function roleSessionId(playId: string, characterId: string): SessionId {
  const digest = createHash('sha256').update(`${playId}\u0000${characterId}`).digest('hex')
  return `tavern-role-${digest.slice(0, 24)}` as SessionId
}

/** Extract the final assistant text from an agent's session log. */
export function lastAssistantText(session: Session, after = 0): string {
  // `Session.events` is gone in 0.2.2-alpha.3; the log is read through
  // `snapshotEvents()` (a frozen, detached array of the selected range).
  const events = session.snapshotEvents()
  for (let index = events.length - 1; index >= after; index--) {
    const event = events[index]
    if (event === undefined) continue
    if (event.type !== 'assistant/message') continue
    const blocks = event.data.message.content
    const text = blocks
      .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
      .map(block => block.text)
      .join('')
    if (text.trim() !== '') return text
  }
  return ''
}

/** Resolve the effective model selection for one generation. */
function resolveModel(
  deps: PlayRuntimeDeps,
  preset: Preset | undefined,
): { provider?: string; model?: string; reasoningEffort?: string; maxTokens?: number } {
  if (preset?.provider && preset.model) {
    return {
      provider: preset.provider,
      model: preset.model,
      maxTokens: preset.maxTokens,
    }
  }
  const fallback = deps.defaultModel()
  return {
    provider: preset?.provider ?? fallback.provider,
    model: preset?.model ?? fallback.model,
    reasoningEffort: fallback.reasoningEffort,
    maxTokens: preset?.maxTokens,
  }
}

/**
 * Build a balanced completed-turn seed carrying the greeting.
 *
 * Exported so `scripts/verify/seed.mjs` can push the exact same events through
 * the host's real `Session.create` validator: this is the only place the plugin
 * fabricates session events, and a seed the host rejects fails every new play at
 * creation time (the play record is then rolled back by the caller).
 * @param greeting - the card's first message (or an alternate greeting).
 * @param provider - provider route recorded on the assistant message.
 * @param model - model id recorded on the assistant message.
 * @returns four contiguous events: turn/start, user/message, assistant/message, turn/end.
 */
export function greetingSeed(greeting: string, provider: string, model: string): SessionEvent[] {
  const safeGreeting = stripPromptVariables(greeting)
  const time = Date.now()
  const assistant = {
    type: 'assistant/message',
    seq: sessionSeq(2),
    time,
    data: {
      turn: 1,
      step: 1,
      message: {
        id: crypto.randomUUID() as MessageId,
        role: 'assistant',
        content: [{ type: 'text', text: safeGreeting }],
        source: { kind: 'model', provider, model },
      },
      // Session format 4 made the raw stream a required field of
      // `assistant/message` (`stream: AssistantStreamRecord[]`): the durable
      // record is the settlement of a model attempt, and a fabricated greeting
      // has no attempt behind it. An empty stream is the honest encoding of
      // "this text did not come from a provider stream"; the separate
      // `assistant/attempt` event type exists precisely for attempts that
      // produced no message.
      stream: [],
    },
    surfaceOp: 'append',
  } satisfies SessionEvent
  return [
    { type: 'turn/start', seq: sessionSeq(0), time, data: { turn: 1 } },
    {
      type: 'user/message',
      seq: sessionSeq(1),
      time,
      data: userMessage('[开场] 扮演开始。'),
      surfaceOp: 'append',
    },
    assistant,
    { type: 'turn/end', seq: sessionSeq(3), time, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
}

/**
 * What a persisted session probe found.
 *
 * "No session yet" and "a session that records no preset" are different states
 * that both used to collapse into `undefined`; the caller answers `undefined`
 * with `agents.create(...)`, which the store rejects with
 * `SessionAlreadyExistsError` for an id that already exists. A play created
 * before the tavern preset existed (or one whose preset was deleted) would then
 * fail to OPEN on every activation, with no log line explaining why.
 */
export interface PersistedSessionState {
  /** Whether the store has this session at all. */
  exists: boolean
  /** The preset recorded for it, or undefined when it was composed bare. */
  preset: string | undefined
}

/** The dynamic world-book context for one play's agent assembly. */
export type LoreContext = {
  name: string
  order: number
  text: (context: { agent?: Agent }) => string
} | null

/**
 * The tavern session runtime: owns the director and character agents of
 * every play, keyed by play id, and exposes the `tavern_speak` execution.
 */
export class TavernSessionRuntime {
  /** playId → director handle. */
  private readonly directors = new Map<string, AgentHandle>()
  /** playId → (characterId → handle). */
  private readonly roles = new Map<string, Map<string, AgentHandle>>()
  /** agentId → tail promise serializing tavern_speak calls per character agent. */
  private readonly speakQueues = new Map<string, Promise<void>>()
  /** playId → in-flight director assembly; concurrent activations share one attempt. */
  private readonly directorInflight = new Map<string, Promise<AgentHandle>>()
  /** `${playId}:${characterId}` → in-flight role assembly (same race as the director). */
  private readonly roleInflight = new Map<string, Promise<AgentHandle>>()
  private readonly branchOperations = new Map<string, Promise<unknown>>()
  private closed = false
  private disposal: Promise<void> | undefined
  private readonly playEpochs = new Map<string, number>()
  private readonly dropInflight = new Map<string, Promise<void>>()

  private epoch(playId: string): number {
    return this.playEpochs.get(playId) ?? 0
  }

  private assertActive(playId: string, epoch = this.epoch(playId)): void {
    if (this.closed || this.dropInflight.has(playId) || epoch !== this.epoch(playId)) {
      throw conflict('酒馆会话已关闭或正在清理，请重新打开')
    }
  }

  /** Late creations own their handle until it can be safely published. */
  private async completeAssembly(
    playId: string, epoch: number, handle: AgentHandle, sessionId: SessionId,
    publish: () => void,
  ): Promise<AgentHandle> {
    try {
      this.assertActive(playId, epoch)
      await this.hideFromWorkspace(sessionId)
      this.assertActive(playId, epoch)
      publish()
      return handle
    } catch (error: unknown) {
      await handle.dispose().catch(disposeError => {
        this.deps.logger.error(`tavern: late agent disposal failed: ${String(disposeError)}`)
      })
      throw error
    }
  }

  /**
   * Declared explicitly rather than as a constructor parameter property: this
   * module is imported directly by `scripts/verify/*.mjs`, which run under
   * Node's strip-only TypeScript support (parameter properties are the one
   * syntax it rejects). `library.ts` states the same convention.
   */
  private readonly deps: PlayRuntimeDeps

  constructor(deps: PlayRuntimeDeps) {
    this.deps = deps
  }

  /**
   * Dispose every live agent, awaiting each one.
   *
   * Called from the plugin's teardown effect. It used to fire-and-forget
   * (`void handle.dispose().catch(...)`), so plugin unload returned before a
   * single agent had actually released its session — a reload could then race
   * the old agents against the new ones over the same session ids.
   */
  dispose(): Promise<void> {
    if (this.disposal !== undefined) return this.disposal
    this.closed = true
    const handles: AgentHandle[] = [...this.directors.values()]
    for (const byPlay of this.roles.values()) handles.push(...byPlay.values())
    this.directors.clear()
    this.roles.clear()
    this.speakQueues.clear()
    const pending = [...this.directorInflight.values(), ...this.roleInflight.values(), ...this.dropInflight.values(), ...this.branchOperations.values()]
    this.disposal = (async () => {
      const settled = await Promise.allSettled(handles.map(handle => handle.dispose()))
      for (const result of settled) {
        if (result.status === 'rejected') {
          this.deps.logger.error(`tavern: agent disposal failed: ${String(result.reason)}`)
        }
      }
      // Pending assemblies observe closed and release their own late handles.
      await Promise.allSettled(pending)
    })()
    return this.disposal
  }

  /** Run one tavern_speak task after any previous task for the same agent settles. */
  private enqueueSpeak<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.speakQueues.get(key) ?? Promise.resolve()
    const run = previous.catch(() => {}).then(task)
    this.speakQueues.set(key, run.then(() => undefined, () => undefined))
    return run
  }

  /** Live director agent for a play, or undefined. */
  getDirector(playId: string): Agent | undefined {
    return this.directors.get(playId)?.agent
  }

  /**
   * Assemble (create or resume) the director agent for a play. Idempotent per
   * process: the director's session id is the play-bound DSH session. When
   * the persisted session exists (a previous run), it is resumed so history
   * survives restarts; otherwise a fresh session is created. Every play
   * session runs under the tavern agent preset and is archived so the
   * workspace browser (「对话」页) never lists it — the play lives inside the
   * tavern page only.
   */
  async ensureDirector(play: Play, seedOverride?: readonly SessionEvent[]): Promise<AgentHandle> {
    this.assertActive(play.id)
    if (this.branchOperations.has(play.id)) throw conflict('会话正在切换，请稍后重试')
    const epoch = this.epoch(play.id)
    const existing = this.directors.get(play.id)
    if (existing !== undefined) return existing
    // Concurrent activations (double-click, a retry racing a select) share
    // one in-flight assembly; without this, two creators both pass the
    // map check, run agents.create/resume twice, and the loser leaks an
    // orphan agent nobody can dispose.
    const inflight = this.directorInflight.get(play.id)
    if (inflight !== undefined) return inflight
    const attempt = this.createDirector(play, epoch, seedOverride)
    this.directorInflight.set(play.id, attempt)
    try {
      return await attempt
    } finally {
      this.directorInflight.delete(play.id)
    }
  }

  /** The single assembly attempt behind {@link ensureDirector}. */
  private async createDirector(play: Play, epoch: number, seedOverride?: readonly SessionEvent[], publish = true): Promise<AgentHandle> {
    const storage = this.deps.storage
    const characters = play.characterIds
      .map(id => storage.getCharacter(id))
      .filter((c): c is CharacterRecord => c !== undefined)
    const lorebooks = this.playLorebooks(play)
    const preset = play.presetId !== undefined ? storage.getPreset(play.presetId) : undefined
    const model = resolveModel(this.deps, preset)
    const sessionId = play.sessionId as SessionId

    // One fence per assembly, shared by the system prompt and the world-book
    // context so the model is told the rule once and both blocks obey it.
    const fence = createFence()
    const directorSystem = this.buildDirectorSystem(play, characters, preset, fence)
    const loreContext = this.buildLoreContext(play, lorebooks, fence)
    // A resumed session keeps the preset its history was produced under (a
    // legacy play predating the tavern preset has none recorded and resumes
    // bare, as before); a fresh session composes the tavern preset.
    await this.deps.ensurePreset()
    this.assertActive(play.id, epoch)
    const persisted = await this.persistedSession(sessionId)
    this.assertActive(play.id, epoch)
    const setup = this.sessionSetup(
      persisted.preset ?? TAVERN_PRESET_ID,
      directorSystem,
      loreContext,
      play.multiAgent ? this.speakToolDefinition() : undefined,
    )

    const agentOptions = {
      ...(model.provider === undefined ? {} : { provider: model.provider }),
      ...(model.model === undefined ? {} : { model: model.model }),
      ...(model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens }),
      ...(model.reasoningEffort === undefined ? {} : { reasoningEffort: model.reasoningEffort as ReasoningEffortId }),
    }
    let handle: AgentHandle
    if (persisted.exists) {
      handle = await this.deps.agents.resume({
        resumeSessionId: sessionId,
        agentOptions,
        setup,
      })
    } else {
      // A swipe fork supplies the rebased history verbatim; a brand-new play
      // falls back to its greeting seed.
      const seed = seedOverride
        ?? (play.greeting !== undefined && play.greeting !== ''
          ? greetingSeed(play.greeting, model.provider ?? 'default', model.model ?? 'default')
          : undefined)
      handle = await this.deps.agents.create({
        sessionId,
        agentOptions,
        meta: { agentPreset: TAVERN_PRESET_ID },
        setup,
        ...(seed !== undefined ? { seed } : {}),
      })
    }
    return this.completeAssembly(play.id, epoch, handle, sessionId, () => {
      if (publish) this.directors.set(play.id, handle)
    })
  }

  /**
   * The preset a persisted session actually runs, newest selection winning
   * (mirrors `resolveSessionPreset` from dsh-agent-presets; inlined to keep
   * the host half free of @deepseek-ai runtime imports).
   * @param header - the persisted session's creation header.
   * @param events - the persisted session's event log, oldest first.
   * @returns the recorded preset id, or undefined for a session composed bare.
   */
  private recordedPreset(header: SessionHeader, events: readonly SessionEvent[]): string | undefined {
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]
      if (event?.type === 'agent-preset/selected') return event.data.agentPreset
    }
    return header.agentPreset
  }

  /**
   * Whether a session is already stored, and which preset it was produced under.
   *
   * This is deliberately NOT `preset | undefined` (see
   * {@link PersistedSessionState}): "no session yet" and "a session that
   * records no preset" are different states, and the caller answers the first
   * with `agents.create(...)`.
   * @param sessionId - the session to probe.
   * @returns existence plus the recorded preset id.
   */
  private async persistedSession(sessionId: SessionId): Promise<PersistedSessionState> {
    let handle
    try {
      // `SessionPersistence.inspect()` was removed in 0.2: a stored session is
      // addressed through a per-session handle, and a read handle never takes
      // ownership, so it works while the host holds this session for write.
      handle = await this.deps.sessionPersistence.open(sessionId, 'read')
    } catch (error: unknown) {
      // Only a confirmed missing session can start fresh. Preserve storage
      // errors before assembly; unreadable history must never be recreated.
      if ((error as Error | undefined)?.name === 'SessionPersistenceNotFoundError') {
        return { exists: false, preset: undefined }
      }
      throw error
    }
    try {
      const { events } = await handle.read()
      return { exists: true, preset: this.recordedPreset(handle.header, events) }
    } finally {
      await handle.close().catch(() => {})
    }
  }

  /**
   * Compose one play session's scoped world: mount the session's agent
   * preset (when it has one), then register the play's own system prompt
   * into the persona slot, the world-book dynamic context, and — for a
   * multi-agent director — the `tavern_speak` tool.
   * @param presetId - preset to mount, or undefined to compose bare (legacy).
   * @param system - the director/character system prompt text.
   * @param loreContext - the world-book dynamic context, or null.
   * @param speakTool - agent-scoped tool to register, or undefined.
   */
  private sessionSetup(
    presetId: string | undefined,
    system: string,
    loreContext: LoreContext,
    speakTool?: ToolDefinition,
  ): AgentSetup {
    return async (agentCtx) => {
      if (presetId !== undefined) {
        try {
          await this.deps.agentPresets.mount(agentCtx, presetId)
        } catch (error: unknown) {
          // A resumed session whose preset disappeared must stay usable: the
          // tavern prompt still installs, the session just runs without the
          // preset's tool rows. Fresh sessions fail loud instead (see the
          // create path, which resolves the preset before publishing).
          this.deps.logger.warn(`tavern: preset "${presetId}" failed to mount (${String(error)}); session runs without it`)
        }
      }
      // The character-card composition is the session's ONE complete section,
      // which is what folds the host persona and every preset section away
      // (assembly rejects two complete sections, so the tavern preset's persona
      // row is registered non-complete).
      agentCtx.systemPrompt.section({
        name: TAVERN_SECTION,
        order: TAVERN_ORDER,
        complete: true,
        text: system,
      })
      if (loreContext !== null) {
        agentCtx.systemPrompt.context(loreContext)
      }
      // Registering from the AGENT scope (rather than the plugin context)
      // scopes the tool to this agent alone. Registering it globally, as an
      // earlier version did, put `tavern_speak` in the toolset of every DSH
      // session in the process — including ordinary coding sessions that can
      // never use it — and in every character agent, where it only ever
      // errors out.
      if (speakTool !== undefined) {
        agentCtx.tools.register(speakTool)
      }
    }
  }

  /**
   * Archive one play session: tavern sessions are hidden from every workspace
   * grouping surface (the 对话 page) and live inside the tavern page only.
   * Idempotent; failures only log because a play must stay usable.
   * @param sessionId - the session to hide.
   */
  private async hideFromWorkspace(sessionId: SessionId): Promise<void> {
    const workspace = this.deps.workspace()
    // Optional dependency: a profile without the workspace registry simply
    // does not archive, which only affects whether the session also shows up
    // on the 对话 page.
    if (workspace === undefined) return
    try {
      await workspace.archiveSession(sessionId)
    } catch (error: unknown) {
      this.deps.logger.warn(`tavern: failed to archive session "${sessionId}": ${String(error)}`)
    }
  }

  /** Compose the director's system prompt. */
  private buildDirectorSystem(
    play: Play,
    characters: readonly CharacterRecord[],
    preset: Preset | undefined,
    fence: PromptFence,
  ): string {
    if (play.multiAgent) {
      const parts: string[] = []
      parts.push('你是一场角色扮演（roleplay）的主持者（director）。')
      parts.push(fence.contract)
      const names = play.characterIds
        .map(id => characters.find(c => c.id === id)?.card.data.name)
        .filter((name): name is string => name !== undefined)
        .map(name => neutralizeDelimiters(stripPromptVariables(name)))
      if (names.length > 0) parts.push(`在场角色：${names.join('、')}`)
      for (const character of characters) {
        const data = character.card.data
        // The card profile is third-party text and must be fenced. This was
        // the one assembly path that pasted it in raw.
        parts.push(`【角色 ${neutralizeDelimiters(stripPromptVariables(data.name))}】`)
        const profile = characterProfile(character)
        if (profile !== '') parts.push(fence.wrap(profile))
      }
      const presetSystem = stripPromptVariables(preset?.systemPrompt ?? '').trim()
      if (presetSystem !== '') {
        parts.push(presetSystem)
      }
      parts.push([
        '主持规则：',
        `- 当剧情需要角色发言时，调用 tavern_speak 工具（参数 characterName=角色名、instruction=你想让角色表达的内容），工具会返回该角色的台词，你直接把它写进回复。`,
        `- 你可以描写场景、环境、NPC 与旁白（${play.narratorEnabled ? '叙述者功能已启用，请经常描写场景' : '叙述保持克制，以对话为主'}）。`,
        '- 台词直接输出，动作与神态描写用 *斜体* 或括号括起。',
        '- 保持各角色设定一致，不要替角色编造与其性格冲突的发言。',
      ].join('\n'))
      return parts.join('\n\n')
    }
    return buildClassicSystem(play, characters, renderWorldInfo([]), preset, fence)
  }

  /** Dynamic world-book context for one play's assembly. */
  private buildLoreContext(
    play: Play,
    lorebooks: readonly WorldBookRecord[],
    fence: PromptFence,
  ): LoreContext {
    if (lorebooks.length === 0) return null
    return {
      name: 'tavern:world',
      order: 50,
      text: (context) => {
        const agent = context.agent
        if (agent === undefined) return ''
        const scanText = this.recentSessionText(agent.session)
        const depth = agent.session.snapshotEvents().filter(e => e.type === 'user/message').length
        // Seed from the play plus the turn count: stable across the several
        // assemblies of one turn (so tool-call steps see the same world), and
        // re-rolled per turn the way ST re-rolls per generation.
        const seed = hashSeed(`${play.id}:${depth}`)
        // One budget for the whole play: activating each book on its own handed
        // every book the full ceiling, so N books injected up to N times it.
        const activated: ActivatedEntry[] = activateBooks(
          lorebooks.map(book => book.book),
          { text: scanText, depth, seed, budgetChars: this.deps.config.worldInfoBudgetChars },
        )
        const rendered = renderWorldInfo(activated)
        // World books are imported third-party content just like cards, and
        // this text lands in the model context unfenced otherwise.
        return rendered === '' ? '' : fence.wrap(rendered)
      },
    }
  }

  /** Resolve the world-book records bound to one play, in play order. */
  private playLorebooks(play: Play): WorldBookRecord[] {
    return playLorebookIds(play)
      .map(id => this.deps.storage.getLorebook(id))
      .filter((book): book is WorldBookRecord => book !== undefined)
  }

  /** Recent user/assistant text of a session, newest last (world-book scan). */
  private recentSessionText(session: Session): string {
    const lines: string[] = []
    for (const event of session.snapshotEvents()) {
      if (event.type === 'user/message') {
        const text = event.data.content
          .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
          .map(block => block.text)
          .join('')
        lines.push(text)
      } else if (event.type === 'assistant/message') {
        const text = event.data.message.content
          .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
          .map(block => block.text)
          .join('')
        if (text.trim() !== '') lines.push(text)
      }
    }
    return lines.slice(-this.deps.config.scanMessages).join('\n')
  }

  /**
   * The `tavern_speak` tool definition, registered per multi-agent director
   * from {@link sessionSetup}. It is deliberately NOT registered on the plugin
   * context: a global registration puts it in every DSH session's toolset,
   * including sessions that have no play behind them.
   */
  speakToolDefinition(): ToolDefinition {
    return {
      name: 'tavern_speak',
      description:
        '让在场角色说出台词。传入角色名或角色 id（两者可选，都不传时使用第一个在场角色），'
        + '以及你想让角色表达的内容、情绪或所处情境；工具会让该角色以自身的性格与记忆回应，并返回其台词。',
      parameters: {
        type: 'object',
        properties: {
          characterName: { type: 'string', description: '在场角色的名字' },
          characterId: { type: 'string', description: '角色的内部 id（可选，与 characterName 二选一）' },
          instruction: { type: 'string', description: '你想让角色表达的内容、情绪或当前情境' },
        },
        required: [],
      } as unknown as Record<string, unknown>,
      output: {
        schema: {
          type: 'object',
          properties: {
            reply: { type: 'string', description: '角色说出的台词' },
          },
          required: ['reply'],
          additionalProperties: false,
        },
        render: (args, value) => {
          const name = (args as { characterName?: string }).characterName ?? '角色'
          const reply = (value as { reply?: string }).reply ?? ''
          return [{ type: 'text', text: `${name}：${reply}` }]
        },
      },
      execute: async (args, exec) => {
        const typed = args as { characterName?: string; characterId?: string; instruction?: string }
        return this.speakFor(exec, typed)
      },
    }
  }

  /**
   * Execute one tavern_speak call: route to the named character agent (in
   * multi-agent mode), or fall back to the director's own voice.
   * @param exec - tool execution context (its agent is the director).
   * @param args - characterName/characterId plus the instruction.
   * @returns the character's lines.
   */
  async speakFor(
    exec: ToolRunContext,
    args: { characterName?: string; characterId?: string; instruction?: string },
  ): Promise<{ reply: string }> {
    const director = exec.agent
    if (director === undefined) {
      throw new Error('tavern_speak: 只能在扮演会话中调用')
    }
    const play = this.deps.storage.listPlays().find(p => p.sessionId === director.id)
    if (play === undefined) {
      throw new Error('tavern_speak: 找不到该会话对应的酒馆配置')
    }
    const characters = play.characterIds
      .map(id => this.deps.storage.getCharacter(id))
      .filter((c): c is CharacterRecord => c !== undefined)
    const target = characters.find(c =>
      (args.characterId !== undefined && c.id === args.characterId)
      || (args.characterName !== undefined && c.card.data.name === args.characterName),
    ) ?? characters[0]
    if (target === undefined) {
      throw new Error('tavern_speak: 角色列表为空')
    }

    this.assertActive(play.id)
    const epoch = this.epoch(play.id)
    const instruction = args.instruction ?? `请以${target.card.data.name}的身份说下一句台词。`
    const handle = await this.ensureRoleAgent(play, target)
    return this.enqueueSpeak(String(handle.agent.id), async () => {
      this.assertActive(play.id, epoch)
      const signal = exec.signal
      if (signal.aborted) throw new Error('调用已取消')
      const boundary = handle.agent.session.snapshotEvents().length
      try {
        handle.agent.followup(userMessage(instruction))
      } catch (error: unknown) {
        // A disposed agent rejects synchronously; surface a readable error
        // instead of leaking the raw disposal failure.
        throw new Error(
          `${target.card.data.name} 的角色会话不可用：${error instanceof Error ? error.message : String(error)}`,
        )
      }
      // whenIdle observes current activity, so subscribe AFTER followup wakes
      // the driver; an idle subscription before followup can settle immediately.
      const wait = handle.agent.whenIdle()
      let onAbort: (() => void) | undefined
      let timer: ReturnType<typeof setTimeout> | undefined
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('角色回应超时')), this.deps.config.speakTimeoutMs)
        onAbort = () => reject(new Error('调用已取消'))
        if (signal.aborted) {
          onAbort()
          return
        }
        signal.addEventListener('abort', onAbort, { once: true })
      })
      try {
        await Promise.race([wait, timeout])
      } catch (error: unknown) {
        // Racing away the wait does NOT stop the character agent: it would keep
        // streaming from the provider, finish its turn nobody is waiting for,
        // and the NEXT tavern_speak for this character would queue behind that
        // abandoned turn. Cancel the agent so the upstream request is aborted
        // too (`cancel` takes the first cause for the activity and is a no-op
        // once the agent is idle).
        //
        // The cause is `hook`, not `user`: it lands in the durable `turn/end`,
        // and "the user pressed stop" would be a lie about who cancelled. The
        // inbox is kept because the cancellation is about this one call, not
        // about discarding work the director queued for the character.
        try {
          handle.agent.cancel(
            { kind: 'hook', reason: 'tavern_speak cancelled or timed out' },
            { keepInbox: true },
          )
        } catch {
          // Already disposed: the failure below is the one worth reporting.
        }
        throw error
      } finally {
        if (timer !== undefined) clearTimeout(timer)
        if (onAbort !== undefined) signal.removeEventListener('abort', onAbort)
      }
      this.assertActive(play.id, epoch)
      const events = handle.agent.session.snapshotEvents().slice(boundary)
      const end = [...events].reverse().find(event => event.type === 'turn/end')
      if (end?.type !== 'turn/end'
        || (end.data.reason.kind !== 'completed' && end.data.reason.kind !== 'max-tokens')) {
        throw new Error(`${target.card.data.name} 的本次回复未成功完成`)
      }
      const reply = lastAssistantText(handle.agent.session, boundary)
      if (reply.trim() === '') {
        throw new Error(`${target.card.data.name} 没有产出回复`)
      }
      return { reply: reply.trim() }
    })
  }

  /** Create (or reuse) the character agent for one play (multi-agent mode). */
  private async ensureRoleAgent(play: Play, character: CharacterRecord): Promise<AgentHandle> {
    this.assertActive(play.id)
    const epoch = this.epoch(play.id)
    {
      const existing = this.roles.get(play.id)?.get(character.id)
      if (existing !== undefined) return existing
    }
    const key = `${play.id}:${character.id}`
    // Same in-flight dedupe as the director: two tavern_speak calls landing
    // on an unchecked map must not spawn a second, orphaned agent.
    const inflight = this.roleInflight.get(key)
    if (inflight !== undefined) return inflight
    const attempt = this.createRoleAgent(play, character, epoch)
    this.roleInflight.set(key, attempt)
    try {
      return await attempt
    } finally {
      this.roleInflight.delete(key)
    }
  }

  /** The single assembly attempt behind {@link ensureRoleAgent}. */
  private async createRoleAgent(play: Play, character: CharacterRecord, epoch: number): Promise<AgentHandle> {
    const existing = this.roles.get(play.id)?.get(character.id)
    if (existing !== undefined) return existing

    const lorebooks = this.playLorebooks(play)
    const preset = play.presetId !== undefined ? this.deps.storage.getPreset(play.presetId) : undefined
    const model = resolveModel(this.deps, preset)
    const characters = play.characterIds
      .map(id => this.deps.storage.getCharacter(id))
      .filter((c): c is CharacterRecord => c !== undefined)
    const names = characters.map(c => c.card.data.name).filter(n => n !== character.card.data.name)
    const fence = createFence()
    const system = buildCharacterSystem(
      character,
      '',
      preset,
      names.length > 0 ? [`同场角色：${names.join('、')}`] : [],
      fence,
    )
    const sessionId = roleSessionId(play.id, character.id)
    const loreContext = this.buildLoreContext(play, lorebooks, fence)
    // Same composition rules as the director: resume keeps the recorded
    // preset (legacy role sessions resume bare), fresh sessions compose the
    // tavern preset.
    await this.deps.ensurePreset()
    this.assertActive(play.id, epoch)
    const persisted = await this.persistedSession(sessionId)
    this.assertActive(play.id, epoch)
    const setup = this.sessionSetup(persisted.preset ?? TAVERN_PRESET_ID, system, loreContext)

    const agentOptions = {
      ...(model.provider === undefined ? {} : { provider: model.provider }),
      ...(model.model === undefined ? {} : { model: model.model }),
      ...(model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens }),
      ...(model.reasoningEffort === undefined ? {} : { reasoningEffort: model.reasoningEffort as ReasoningEffortId }),
    }
    let handle: AgentHandle
    if (persisted.exists) {
      handle = await this.deps.agents.resume({
        resumeSessionId: sessionId,
        agentOptions,
        setup,
      })
    } else {
      handle = await this.deps.agents.create({
        sessionId,
        agentOptions,
        meta: { agentPreset: TAVERN_PRESET_ID },
        setup,
      })
    }
    return this.completeAssembly(play.id, epoch, handle, sessionId, () => {
      let byPlay = this.roles.get(play.id)
      if (byPlay === undefined) {
        byPlay = new Map()
        this.roles.set(play.id, byPlay)
      }
      byPlay.set(character.id, handle)
    })
  }

  /** Drop the live agents of one play (play deleted). */
  dropPlay(playId: string): Promise<void> {
    const existing = this.dropInflight.get(playId)
    if (existing !== undefined) return existing
    this.playEpochs.set(playId, this.epoch(playId) + 1)
    const handles: AgentHandle[] = []
    const director = this.directors.get(playId)
    if (director !== undefined) handles.push(director)
    const byPlay = this.roles.get(playId)
    if (byPlay !== undefined) handles.push(...byPlay.values())
    this.directors.delete(playId)
    this.roles.delete(playId)
    for (const handle of handles) this.speakQueues.delete(String(handle.agent.id))
    const pending: Promise<unknown>[] = []
    const branchAttempt = this.branchOperations.get(playId)
    if (branchAttempt !== undefined) pending.push(branchAttempt)
    const directorAttempt = this.directorInflight.get(playId)
    if (directorAttempt !== undefined) pending.push(directorAttempt)
    for (const [key, attempt] of this.roleInflight) {
      if (key.startsWith(`${playId}:`)) pending.push(attempt)
    }
    const run = (async () => {
      const disposed = await Promise.allSettled(handles.map(handle => handle.dispose()))
      await Promise.allSettled(pending)
      const failed = disposed.find(result => result.status === 'rejected')
      if (failed?.status === 'rejected') throw failed.reason
    })()
    this.dropInflight.set(playId, run)
    const clear = (): void => {
      if (this.dropInflight.get(playId) === run) this.dropInflight.delete(playId)
    }
    void run.then(clear, clear)
    return run
  }

  // ── Retry / swipe / edit (session forks) ────────────────────────────────

  /** Reserve admission synchronously; React state or a disk busy flag is not a lock. */
  private async withBranchOperation<T>(playId: string, expectedSessionId: string | undefined, task: () => Promise<T>): Promise<T> {
    this.assertActive(playId)
    if (this.branchOperations.has(playId) || this.directorInflight.has(playId)) {
      throw conflict('会话正在恢复或切换，请稍后重试')
    }
    const epoch = this.epoch(playId)
    const run = Promise.resolve().then(() => {
      this.assertActive(playId, epoch)
      const play = this.deps.storage.getPlay(playId)
      if (play === undefined) throw notFound('酒馆会话不存在')
      if (expectedSessionId !== undefined && expectedSessionId !== play.sessionId) {
        throw conflict('会话已切换，请刷新后重试')
      }
      const handle = this.directors.get(playId)
      if (handle !== undefined && (String(handle.agent.id) !== play.sessionId || handle.agent.status !== 'idle'
        || (handle.agent.inbox?.nextTurn.length ?? 0) > 0 || (handle.agent.inbox?.nextStep.length ?? 0) > 0)) {
        throw conflict('角色正在输出、仍有待处理输入或会话已切换，请先等待其完成')
      }
      return task()
    })
    this.branchOperations.set(playId, run)
    try { return await run } finally {
      if (this.branchOperations.get(playId) === run) this.branchOperations.delete(playId)
    }
  }

  private async liveEvents(play: Play): Promise<SessionEvent[]> {
    const handle = this.directors.get(play.id)
    if (handle !== undefined) {
      if (handle.agent.status !== 'idle') throw conflict('角色正在输出中，请先停止或等待其完成')
      return [...handle.agent.session.snapshotEvents()]
    }
    let stored
    try { stored = await this.deps.sessionPersistence.open(play.sessionId as SessionId, 'read') } catch (error: unknown) {
      if ((error as Error | undefined)?.name === 'SessionPersistenceNotFoundError') {
        throw badRequest('这场扮演还没有可用的对话记录，请先发送一条消息')
      }
      throw error
    }
    try { return [...(await stored.read()).events] } finally { await stored.close().catch(() => {}) }
  }

  /** Prepare first. A failure before commitment leaves the old handle, pointer and variants usable. */
  private async rebasePlaySession(
    play: Play, seed: readonly SessionEvent[], sourceEvents: readonly SessionEvent[],
    options: {
      stage?: (next: Play) => Promise<void>
      rollback?: () => Promise<void>
      submit?: (agent: Agent) => void
    } = {},
  ): Promise<Play> {
    const epoch = this.epoch(play.id)
    const old = this.directors.get(play.id)
    const rebased: Play = { ...play, sessionId: `tavern-${newId('fork').replace('fork-', '')}`, updatedAt: nowIso() }
    const prepared = await this.createDirector(rebased, epoch, seed, false)
    let staged = false, pointerWritten = false
    const checkSource = (): void => {
      this.assertActive(play.id, epoch)
      if (old !== undefined && (this.directors.get(play.id) !== old || old.agent.status !== 'idle'
        || JSON.stringify(old.agent.session.snapshotEvents()) !== JSON.stringify(sourceEvents))) {
        throw conflict('分叉期间对话已改变，请刷新后重试')
      }
    }
    try {
      checkSource()
      // A prefix cut before turn/start can retain the old question's durable
      // enqueue event. Cancel only inherited pending work in the NEW session,
      // otherwise retry/edit would submit both the old and replacement question.
      prepared.agent.inbox?.clear()
      const current = this.deps.storage.getPlay(play.id)
      if (current?.sessionId !== play.sessionId || current.updatedAt !== play.updatedAt) {
        throw conflict('分叉期间会话设置已改变，请刷新后重试')
      }
      if (options.stage !== undefined) { staged = true; await options.stage(rebased) }
      checkSource()
      await this.deps.storage.upsertPlay(rebased)
      pointerWritten = true
      checkSource()
      // followup commits its inbox synchronously. Reject a submission failure
      // before dropping old history; no asynchronous work intervenes before publication.
      options.submit?.(prepared.agent)
      this.assertActive(play.id, epoch)
      this.directors.set(play.id, prepared)
    } catch (error: unknown) {
      if (pointerWritten) await this.deps.storage.upsertPlay(play).catch(rollbackError => {
        this.deps.logger.error(`tavern: failed to restore play pointer: ${String(rollbackError)}`)
      })
      if (staged) await options.rollback?.().catch(rollbackError => {
        this.deps.logger.error(`tavern: failed to restore swipe state: ${String(rollbackError)}`)
      })
      await prepared.dispose().catch(disposeError => {
        this.deps.logger.error(`tavern: prepared director disposal failed: ${String(disposeError)}`)
      })
      throw error
    }
    // Once committed, a cleanup failure must not masquerade as a failed edit.
    if (old !== undefined) {
      this.speakQueues.delete(String(old.agent.id))
      await old.dispose().catch(error => this.deps.logger.warn(`tavern: old director cleanup failed: ${String(error)}`))
    }
    return rebased
  }

  private planReroll(events: readonly SessionEvent[]): { prefix: SessionEvent[]; userText: string; tail: SessionEvent[] } {
    let assistantIndex = -1
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i]?.type === 'assistant/message' && events[i]?.surfaceOp === 'append') { assistantIndex = i; break }
    }
    if (assistantIndex < 0) throw badRequest('当前还没有可重试的回复')
    let turnStart = -1
    for (let i = assistantIndex; i >= 0; i--) {
      if (events[i]?.type === 'turn/start') { turnStart = i; break }
    }
    if (turnStart < 0) throw badRequest('会话日志不完整，无法重试')
    const prefix = events.slice(0, turnStart), tail = events.slice(turnStart)
    if (tail.slice(1).some(event => event.type === 'turn/start')) {
      throw conflict('当前最后一轮没有可重试回复，请勿切换历史回答')
    }
    this.assertBalancedPrefix(prefix)
    if (tail.filter(event => event.type === 'user/message').length !== 1) {
      throw conflict('当前轮次包含追加输入，重试与切换已暂停以保留原对话')
    }
    const question = tail.find(event => event.type === 'user/message')
    const userText = question?.type === 'user/message'
      ? question.data.content.filter(block => block.type === 'text').map(block => block.text).join('') : ''
    if (userText.trim() === '') throw badRequest('找不到可重放的用户消息')
    return { prefix, userText, tail }
  }

  private assertBalancedPrefix(events: readonly SessionEvent[]): void {
    const lastBoundary = [...events].reverse().find(event => event.type === 'turn/start' || event.type === 'turn/end')
    if (lastBoundary?.type === 'turn/start') throw badRequest('会话日志存在未闭合的轮次')
  }

  async reroll(playId: string, expectedSessionId?: string): Promise<{ play: Play; branch: SwipeBranch }> {
    return this.withBranchOperation(playId, expectedSessionId, () => this.rerollIdle(playId))
  }

  private async rerollIdle(playId: string): Promise<{ play: Play; branch: SwipeBranch }> {
    const play = this.deps.storage.getPlay(playId)!
    const events = await this.liveEvents(play), plan = this.planReroll(events)
    // Session.create adds log-only end-seed markers; they must not mint a new branch on every retry.
    const key = String(comparableForkEvents(plan.prefix).length)
    const belongs = (branch: SwipeBranch | undefined): branch is SwipeBranch => branch !== undefined
      && branch.userText === plan.userText && sameForkHistory(branch.prefix, plan.prefix)
      && (branch.busy || swipeUserMessageId(branch) === tailUserMessageId(plan.tail))
    const direct = this.deps.storage.getSwipeBranch(playId, key)
    const legacy = this.deps.storage.getSwipeBranch(playId, String(plan.prefix.length))
    const existing = belongs(direct) ? direct : belongs(legacy) ? legacy
      : this.deps.storage.listSwipeBranches(playId).find(belongs)
    if (existing?.busy) throw conflict('上一次尝试还在生成中，请稍候')
    const currentTail = existing?.variants[existing.current]
    const sameTail = currentTail !== undefined && sameForkHistory(currentTail, plan.tail)
    const grown = existing === undefined ? [plan.tail, []] : sameTail
      ? [...existing.variants, []] : [...existing.variants, plan.tail, []]
    const variants = grown.slice(-this.deps.config.maxSwipeVariants)
    const message = userMessage(plan.userText)
    let branch: SwipeBranch = { playId, key: existing?.key ?? key, prefix: [...plan.prefix], userText: plan.userText,
      userMessageId: String(message.id), variants, current: variants.length - 1, busy: true, updatedAt: nowIso() }
    const rebased = await this.rebasePlaySession(play, plan.prefix, events, {
      stage: async next => { branch = { ...branch, sessionId: next.sessionId }; await this.deps.storage.upsertSwipeBranch(branch) },
      rollback: async () => {
        if (existing !== undefined) await this.deps.storage.upsertSwipeBranch(existing)
        else await this.deps.storage.deleteSwipeBranch(playId, branch.key)
      },
      submit: agent => agent.followup(message),
    })
    this.observeSwipeGeneration(rebased, branch)
    return { play: rebased, branch }
  }

  private observeSwipeGeneration(play: Play, branch: SwipeBranch): void {
    const handle = this.directors.get(play.id)!
    const readTail = (): SessionEvent[] => [...handle.agent.session.snapshotEvents()].slice(branch.prefix.length)
    void handle.agent.whenIdle().then(
      () => this.settleSwipe(play.id, branch.key, branch.current, play.sessionId, readTail),
      (error: unknown) => this.settleSwipe(play.id, branch.key, branch.current, play.sessionId, readTail, error),
    ).catch(error => this.deps.logger.warn(`tavern: swipe settlement failed: ${String(error)}`))
  }

  private async settleSwipe(playId: string, key: string, index: number, sessionId: string,
    readTail: () => SessionEvent[], error?: unknown): Promise<void> {
    const branch = this.deps.storage.getSwipeBranch(playId, key)
    if (branch === undefined || branch.sessionId !== sessionId || index >= branch.variants.length) return
    const tail = error !== undefined ? [] : readTail()
    const end = [...tail].reverse().find(event => event.type === 'turn/end')
    if (error === undefined && (end?.type !== 'turn/end'
      || (end.data.reason.kind !== 'completed' && end.data.reason.kind !== 'max-tokens'))) {
      error = new Error('本次重试未成功完成')
    }
    const variants = [...branch.variants]
    variants[index] = tail
    const next: SwipeBranch = { ...branch, variants, current: index, busy: false, updatedAt: nowIso() }
    if (error !== undefined) next.error = error instanceof Error ? error.message : String(error)
    else delete next.error
    await this.deps.storage.upsertSwipeBranch(next)
  }

  async swipe(playId: string, key: string, step: number, expectedSessionId?: string): Promise<{ play: Play; branch: SwipeBranch }> {
    return this.withBranchOperation(playId, expectedSessionId, () => this.swipeIdle(playId, key, step))
  }

  private async swipeIdle(playId: string, key: string, step: number): Promise<{ play: Play; branch: SwipeBranch }> {
    if (step !== 1 && step !== -1) throw badRequest('移动方向必须为1或-1')
    const play = this.deps.storage.getPlay(playId)!, branch = this.deps.storage.getSwipeBranch(playId, key)
    if (branch === undefined || branch.variants.length === 0) throw badRequest('这条回复还没有可切换的尝试')
    if (branch.busy) throw conflict('上一次尝试还在生成中，请稍候')
    const events = await this.liveEvents(play), plan = this.planReroll(events)
    if ((branch.sessionId !== undefined && branch.sessionId !== play.sessionId)
      || tailUserMessageId(plan.tail) !== swipeUserMessageId(branch) || !sameForkHistory(plan.prefix, branch.prefix)
      || !sameReplyTail(plan.tail, branch.variants[branch.current] ?? [])) {
      throw conflict('这组尝试不属于当前最后一条回复，请刷新后重试')
    }
    const target = (branch.current + step + branch.variants.length) % branch.variants.length
    const tail = branch.variants[target]
    if (tail === undefined || tail.length === 0) throw badRequest('该次尝试还没有内容')
    let next: SwipeBranch = { ...branch, current: target, userMessageId: tailUserMessageId(tail), updatedAt: nowIso() }
    const rebased = await this.rebasePlaySession(play, [...branch.prefix, ...structuredClone(tail)] as SessionEvent[], events, {
      stage: async value => { next = { ...next, sessionId: value.sessionId }; await this.deps.storage.upsertSwipeBranch(next) },
      rollback: () => this.deps.storage.upsertSwipeBranch(branch),
    })
    return { play: rebased, branch: next }
  }

  private async retireEditedBranches(playId: string): Promise<void> {
    await this.deps.storage.deleteSwipeBranches(playId).catch(error => {
      this.deps.logger.warn(`tavern: stale branch cleanup failed after committed edit: ${String(error)}`)
    })
  }

  async editAssistant(playId: string, messageId: string, text: string, expectedSessionId?: string): Promise<Play> {
    return this.withBranchOperation(playId, expectedSessionId, () => this.editAssistantIdle(playId, messageId, text))
  }

  private async editAssistantIdle(playId: string, messageId: string, text: string): Promise<Play> {
    if (text.trim() === '') throw badRequest('内容不能为空')
    const play = this.deps.storage.getPlay(playId)!, events = await this.liveEvents(play)
    const index = events.findIndex(event => event.type === 'assistant/message' && String(event.data.message.id) === messageId)
    if (index < 0) throw notFound('找不到这条回复（可能已被新的尝试替换）')
    const next = events.map((event, i) => i !== index || event.type !== 'assistant/message' ? event : {
      ...event, data: { ...event.data, message: { ...event.data.message, content: [{ type: 'text' as const, text }] } },
    })
    const rebased = await this.rebasePlaySession(play, next, events)
    await this.retireEditedBranches(playId)
    return rebased
  }

  async editUserAndRetry(playId: string, messageId: string, text: string, expectedSessionId?: string): Promise<Play> {
    return this.withBranchOperation(playId, expectedSessionId, () => this.editUserIdle(playId, messageId, text))
  }

  private async editUserIdle(playId: string, messageId: string, text: string): Promise<Play> {
    if (text.trim() === '') throw badRequest('内容不能为空')
    const play = this.deps.storage.getPlay(playId)!, events = await this.liveEvents(play)
    const index = events.findIndex(event => event.type === 'user/message' && String(event.data.id) === messageId)
    if (index < 0) throw notFound('找不到这条消息')
    let turnStart = -1
    for (let i = index; i >= 0; i--) if (events[i]?.type === 'turn/start') { turnStart = i; break }
    if (turnStart < 0) throw badRequest('会话日志不完整，无法编辑')
    const prefix = events.slice(0, turnStart)
    this.assertBalancedPrefix(prefix)
    const rebased = await this.rebasePlaySession(play, prefix, events, { submit: agent => agent.followup(userMessage(text)) })
    await this.retireEditedBranches(playId)
    void this.directors.get(playId)!.agent.whenIdle().catch(error => {
      this.deps.logger.warn(`tavern: edited-message turn failed: ${String(error)}`)
    })
    return rebased
  }
}
