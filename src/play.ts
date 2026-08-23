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
import type { AgentPresets } from '@deepseek-ai/dsh-agent-presets'
import type { MessageId, UserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type SessionPersistence from '@deepseek-ai/dsh-session-persistence'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { WorkspaceRegistry } from '@deepseek-ai/dsh-workspace'
import type { CharacterRecord, Play, Preset, SwipeBranch, WorldBookRecord } from './types.ts'
import { TavernStorage, newId, nowIso } from './storage.ts'
import { activateBook, hashSeed, renderWorldInfo, type ActivatedEntry } from './lorebook.ts'
import { TAVERN_PRESET_ID } from './tavern-preset.ts'
import { badRequest, conflict, notFound } from './errors.ts'
import type { TavernConfig } from './config.ts'
import {
  buildCharacterSystem, buildClassicSystem, characterProfile, createFence,
  neutralizeDelimiters, stripPromptVariables, type PromptFence,
} from './prompt.ts'

/**
 * The system-prompt persona slot the tavern director/character prompts take
 * over. Mirrors `PERSONA_SECTION`/`PERSONA_ORDER` from dsh-system-prompt
 * (hardcoded to keep the host half free of @deepseek-ai runtime imports):
 * registering under this name shadows the preset persona in the agent scope,
 * so the tavern prompt and the preset's fixed persona never fight over the
 * complete-section slot.
 */
const PERSONA_SECTION = 'deployment:persona'
const PERSONA_ORDER = 0

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
  agentPresets: AgentPresets
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

/** Build a user message carrying tavern plugin provenance. */
function userMessage(content: string): UserMessage {
  return {
    id: crypto.randomUUID() as MessageId,
    role: 'user',
    content: [{ type: 'text', text: content }],
    source: { kind: 'plugin', plugin: 'dsh-tavern' },
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
export function lastAssistantText(session: Session): string {
  const events = session.events
  for (let index = events.length - 1; index >= 0; index--) {
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

/** Build a balanced completed-turn seed carrying the greeting. */
function greetingSeed(greeting: string, provider: string, model: string): SessionEvent[] {
  const safeGreeting = stripPromptVariables(greeting)
  const time = Date.now()
  const assistant: SessionEvent = {
    type: 'assistant/message',
    seq: 2,
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
    },
    surfaceOp: 'append',
  }
  return [
    { type: 'turn/start', seq: 0, time, data: { turn: 1 } },
    { type: 'user/message', seq: 1, time, data: userMessage('[开场] 扮演开始。'), surfaceOp: 'append' },
    assistant,
    { type: 'turn/end', seq: 3, time, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
}

/** Dynamic world-book context for one play's agent assembly. */
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

  constructor(private readonly deps: PlayRuntimeDeps) {}

  /**
   * Dispose every live agent, awaiting each one.
   *
   * Called from the plugin's teardown effect. It used to fire-and-forget
   * (`void handle.dispose().catch(...)`), so plugin unload returned before a
   * single agent had actually released its session — a reload could then race
   * the old agents against the new ones over the same session ids.
   */
  async dispose(): Promise<void> {
    const handles: AgentHandle[] = [...this.directors.values()]
    for (const byPlay of this.roles.values()) handles.push(...byPlay.values())
    this.directors.clear()
    this.roles.clear()
    this.speakQueues.clear()
    const settled = await Promise.allSettled(handles.map(handle => handle.dispose()))
    for (const result of settled) {
      if (result.status === 'rejected') {
        this.deps.logger.error(`tavern: agent disposal failed: ${String(result.reason)}`)
      }
    }
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
    const existing = this.directors.get(play.id)
    if (existing !== undefined) return existing
    // Concurrent activations (double-click, a retry racing a select) share
    // one in-flight assembly; without this, two creators both pass the
    // map check, run agents.create/resume twice, and the loser leaks an
    // orphan agent nobody can dispose.
    const inflight = this.directorInflight.get(play.id)
    if (inflight !== undefined) return inflight
    const attempt = this.createDirector(play, seedOverride)
    this.directorInflight.set(play.id, attempt)
    try {
      return await attempt
    } finally {
      this.directorInflight.delete(play.id)
    }
  }

  /** The single assembly attempt behind {@link ensureDirector}. */
  private async createDirector(play: Play, seedOverride?: readonly SessionEvent[]): Promise<AgentHandle> {
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
    const persistedPreset = await this.persistedPreset(sessionId)
    const setup = this.sessionSetup(
      persistedPreset ?? TAVERN_PRESET_ID,
      directorSystem,
      loreContext,
      play.multiAgent ? this.speakToolDefinition() : undefined,
    )

    const agentOptions = {
      ...(model.provider === undefined ? {} : { provider: model.provider }),
      ...(model.model === undefined ? {} : { model: model.model }),
      ...(model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens }),
    }
    let handle: AgentHandle
    if (persistedPreset !== undefined) {
      try {
        handle = await this.deps.agents.resume({
          resumeSessionId: sessionId,
          agentOptions,
          setup,
        })
      } catch (error: unknown) {
        this.deps.logger.warn(`tavern: resume director failed (${String(error)}); creating fresh session`)
        handle = await this.deps.agents.create({
          sessionId,
          agentOptions,
          meta: { agentPreset: persistedPreset },
          setup,
          ...(play.greeting !== undefined && play.greeting !== ''
            ? { seed: greetingSeed(play.greeting, model.provider ?? 'default', model.model ?? 'default') }
            : {}),
        })
      }
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
    this.directors.set(play.id, handle)
    await this.hideFromWorkspace(sessionId)
    return handle
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
   * Probe the persisted session for the preset it was produced under.
   * @param sessionId - the session to probe.
   * @returns the recorded preset id, or undefined when the session is not
   * persisted (a fresh play) or has none recorded (legacy).
   */
  private async persistedPreset(sessionId: SessionId): Promise<string | undefined> {
    try {
      const inspected = await this.deps.sessionPersistence.inspect(sessionId)
      return this.recordedPreset(inspected.meta, inspected.events)
    } catch {
      return undefined
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
      // The persona slot shadows the preset's fixed persona (nearest scope
      // wins), so the character-card composition is the single complete
      // section and the play's prompt never collides with the preset's.
      agentCtx.systemPrompt.section({
        name: PERSONA_SECTION,
        order: PERSONA_ORDER,
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
        const depth = agent.session.events.filter(e => e.type === 'user/message').length
        // Seed from the play plus the turn count: stable across the several
        // assemblies of one turn (so tool-call steps see the same world), and
        // re-rolled per turn the way ST re-rolls per generation.
        const seed = hashSeed(`${play.id}:${depth}`)
        const activated: ActivatedEntry[] = lorebooks.flatMap(book => activateBook(book.book, {
          text: scanText,
          depth,
          seed,
          budgetChars: this.deps.config.worldInfoBudgetChars,
        }))
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
    for (const event of session.events) {
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

    const instruction = args.instruction ?? `请以${target.card.data.name}的身份说下一句台词。`
    const handle = await this.ensureRoleAgent(play, target)
    return this.enqueueSpeak(String(handle.agent.id), async () => {
      const signal = exec.signal
      const done = handle.agent.whenIdle()
      try {
        handle.agent.followup(userMessage(instruction))
      } catch (error: unknown) {
        // A disposed agent rejects synchronously; surface a readable error
        // instead of leaking the raw disposal failure.
        throw new Error(
          `${target.card.data.name} 的角色会话不可用：${error instanceof Error ? error.message : String(error)}`,
        )
      }
      const wait = done.catch(() => {})
      let onAbort: (() => void) | undefined
      const timeout = new Promise<never>((_, reject) => {
        const timer = setTimeout(() => reject(new Error('角色回应超时')), this.deps.config.speakTimeoutMs)
        onAbort = () => {
          clearTimeout(timer)
          reject(new Error('调用已取消'))
        }
        if (signal.aborted) {
          onAbort()
          return
        }
        signal.addEventListener('abort', onAbort, { once: true })
        void wait.then(() => {
          clearTimeout(timer)
          signal.removeEventListener('abort', onAbort!)
        })
      })
      await Promise.race([wait, timeout])
      const reply = lastAssistantText(handle.agent.session)
      if (reply.trim() === '') {
        throw new Error(`${target.card.data.name} 没有产出回复`)
      }
      return { reply: reply.trim() }
    })
  }

  /** Create (or reuse) the character agent for one play (multi-agent mode). */
  private async ensureRoleAgent(play: Play, character: CharacterRecord): Promise<AgentHandle> {
    {
      const existing = this.roles.get(play.id)?.get(character.id)
      if (existing !== undefined) return existing
    }
    const key = `${play.id}:${character.id}`
    // Same in-flight dedupe as the director: two tavern_speak calls landing
    // on an unchecked map must not spawn a second, orphaned agent.
    const inflight = this.roleInflight.get(key)
    if (inflight !== undefined) return inflight
    const attempt = this.createRoleAgent(play, character)
    this.roleInflight.set(key, attempt)
    try {
      return await attempt
    } finally {
      this.roleInflight.delete(key)
    }
  }

  /** The single assembly attempt behind {@link ensureRoleAgent}. */
  private async createRoleAgent(play: Play, character: CharacterRecord): Promise<AgentHandle> {
    let byPlay = this.roles.get(play.id)
    if (byPlay === undefined) {
      byPlay = new Map()
      this.roles.set(play.id, byPlay)
    }
    const existing = byPlay.get(character.id)
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
    const persistedPreset = await this.persistedPreset(sessionId)
    const setup = this.sessionSetup(persistedPreset ?? TAVERN_PRESET_ID, system, loreContext)

    const agentOptions = {
      ...(model.provider === undefined ? {} : { provider: model.provider }),
      ...(model.model === undefined ? {} : { model: model.model }),
      ...(model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens }),
    }
    let handle: AgentHandle
    if (persistedPreset !== undefined) {
      try {
        handle = await this.deps.agents.resume({
          resumeSessionId: sessionId,
          agentOptions,
          setup,
        })
      } catch (error: unknown) {
        this.deps.logger.warn(`tavern: resume character failed (${String(error)}); creating fresh session`)
        handle = await this.deps.agents.create({
          sessionId,
          agentOptions,
          meta: { agentPreset: persistedPreset },
          setup,
        })
      }
    } else {
      handle = await this.deps.agents.create({
        sessionId,
        agentOptions,
        meta: { agentPreset: TAVERN_PRESET_ID },
        setup,
      })
    }
    byPlay.set(character.id, handle)
    await this.hideFromWorkspace(sessionId)
    return handle
  }

  /** Drop the live agents of one play (play deleted). */
  async dropPlay(playId: string): Promise<void> {
    const director = this.directors.get(playId)
    if (director !== undefined) {
      this.directors.delete(playId)
      this.speakQueues.delete(String(director.agent.id))
      await director.dispose()
    }
    const byPlay = this.roles.get(playId)
    if (byPlay !== undefined) {
      this.roles.delete(playId)
      for (const handle of byPlay.values()) {
        this.speakQueues.delete(String(handle.agent.id))
        await handle.dispose()
      }
    }
  }

  // ── Retry / swipe / edit (session forks) ────────────────────────────────

  /**
   * The play session's current event log, live when a director is running.
   * @param play - the play whose log is read.
   * @returns the events in seq order.
   * @throws while a generation is still running (the log is mid-turn).
   */
  private async liveEvents(play: Play): Promise<SessionEvent[]> {
    const handle = this.directors.get(play.id)
    if (handle !== undefined) {
      if (handle.agent.status !== 'idle') {
        throw conflict('角色正在输出中，请先停止或等待其完成')
      }
      return [...handle.agent.session.events]
    }
    try {
      const inspected = await this.deps.sessionPersistence.inspect(play.sessionId as SessionId)
      return [...inspected.events]
    } catch (error: unknown) {
      // A play whose session was never persisted (created but never spoken to)
      // has nothing to inspect. That is a caller-visible state, not a server
      // fault — surfacing it as a 500 told the user nothing.
      this.deps.logger.warn(`tavern: inspect session "${play.sessionId}" failed: ${String(error)}`)
      throw badRequest('这场扮演还没有可用的对话记录，请先发送一条消息')
    }
  }

  /**
   * Move one play onto a fresh DSH session seeded with the given history
   * (session logs are append-only, so edits and retries fork instead). The
   * new session resumes under the tavern preset on later restarts like any
   * other play session.
   * @param play - the play to rebase.
   * @param seed - a balanced completed-turn event prefix.
   * @returns the updated play carrying the new session id.
   */
  private async rebasePlaySession(play: Play, seed: readonly SessionEvent[]): Promise<Play> {
    const old = this.directors.get(play.id)
    if (old !== undefined) {
      this.directors.delete(play.id)
      this.speakQueues.delete(String(old.agent.id))
      await old.dispose()
    }
    const rebased: Play = {
      ...play,
      sessionId: `tavern-${newId('fork').replace('fork-', '')}`,
      updatedAt: nowIso(),
    }
    await this.deps.storage.upsertPlay(rebased)
    try {
      await this.ensureDirector(rebased, seed)
    } catch (error: unknown) {
      // The old session log is untouched; restore the pointer so the play
      // stays usable (the next activate resumes the old session).
      await this.deps.storage.upsertPlay(play)
      throw error
    }
    return rebased
  }

  /**
   * Plan a retry of the last assistant turn: the balanced prefix before the
   * question turn, the question text to replay, and the current tail.
   * @param events - the play session's current events.
   * @returns the reroll plan.
   */
  private planReroll(events: readonly SessionEvent[]): {
    prefix: SessionEvent[]
    userText: string
    tail: SessionEvent[]
  } {
    let assistantIndex = -1
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i]
      if (event?.type === 'assistant/message' && event.surfaceOp === 'append') {
        assistantIndex = i
        break
      }
    }
    if (assistantIndex < 0) throw badRequest('当前还没有可重试的回复')
    let turnStart = -1
    for (let i = assistantIndex; i >= 0; i--) {
      if (events[i]?.type === 'turn/start') {
        turnStart = i
        break
      }
    }
    if (turnStart < 0) throw badRequest('会话日志不完整，无法重试')
    const prefix = events.slice(0, turnStart)
    if (prefix.length > 0 && prefix[prefix.length - 1]?.type !== 'turn/end') {
      throw badRequest('会话日志存在未闭合的轮次，无法重试')
    }
    const tail = events.slice(turnStart)
    let userText = ''
    for (const event of tail) {
      if (event?.type !== 'user/message') continue
      userText = event.data.content
        .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
        .map(block => block.text)
        .join('')
      if (userText.trim() !== '') break
    }
    if (userText.trim() === '') throw badRequest('找不到可重放的用户消息')
    return { prefix, userText, tail }
  }

  /**
   * Regenerate the last assistant reply as a NEW swipe variant: the current
   * turn tail is stored as one variant, the play is rebased to the shared
   * prefix, and a fresh generation is kicked off in the background.
   * @param playId - the play to reroll.
   * @returns the rebased play and the updated swipe branch (busy).
   */
  async reroll(playId: string): Promise<{ play: Play; branch: SwipeBranch }> {
    const play = this.deps.storage.getPlay(playId)
    if (play === undefined) throw notFound('酒馆会话不存在')
    const events = await this.liveEvents(play)
    const plan = this.planReroll(events)
    const key = String(plan.prefix.length)
    const existing = this.deps.storage.getSwipeBranch(playId, key)
    if (existing?.busy === true) throw conflict('上一次尝试还在生成中，请稍候')
    // Skip re-appending the current variant when nothing changed since it was
    // stored — otherwise spamming retry duplicates the same tail endlessly
    // (the branch variants are persisted in full, so this also bounds their
    // growth to genuinely distinct attempts).
    const currentTail = existing?.variants[existing.current] as readonly SessionEvent[] | undefined
    const lastEvent = (events: readonly SessionEvent[]): SessionEvent | undefined => events[events.length - 1]
    const sameTail = currentTail !== undefined
      && currentTail.length === plan.tail.length
      && lastEvent(currentTail)?.seq === lastEvent(plan.tail)?.seq
    // The currently displayed turn becomes the newest stored variant; one
    // empty slot follows for the in-flight generation.
    const grown = existing === undefined
      ? [plan.tail, []]
      : sameTail
        ? [...existing.variants, []]
        : [...existing.variants, plan.tail, []]
    // Every variant is a full event tail on disk, so the list needs a ceiling:
    // without one, holding down 重试 grows the record without bound. Drop the
    // oldest attempts; `current` stays the last slot either way.
    const cap = this.deps.config.maxSwipeVariants
    const variants = grown.length > cap
      ? grown.slice(grown.length - cap)
      : grown
    const branch: SwipeBranch = {
      playId,
      key,
      prefix: [...plan.prefix],
      userText: plan.userText,
      variants,
      current: variants.length - 1,
      busy: true,
      updatedAt: nowIso(),
    }
    // Persist the busy flag BEFORE the fork: the flag is the only guard
    // against a second retry racing the slow session rebase.
    await this.deps.storage.upsertSwipeBranch(branch)
    try {
      const rebased = await this.rebasePlaySession(play, plan.prefix)
      this.kickSwipeGeneration(rebased, branch)
      return { play: rebased, branch }
    } catch (error: unknown) {
      // Roll the branch back so a failed fork never strands a stuck `busy`.
      if (existing !== undefined) {
        await this.deps.storage.upsertSwipeBranch(existing)
      } else {
        await this.deps.storage.deleteSwipeBranch(playId, key)
      }
      throw error
    }
  }

  /**
   * Drive one swipe generation in the background and record its tail (or
   * failure) into the branch once the director settles.
   * @param play - the rebased play.
   * @param branch - the branch whose `current` slot receives the result.
   */
  private kickSwipeGeneration(play: Play, branch: SwipeBranch): void {
    const handle = this.directors.get(play.id)
    if (handle === undefined) {
      // Returning here used to strand `busy: true` forever: nothing would ever
      // settle the branch, the UI showed "生成中" permanently, and every later
      // retry was rejected by the busy guard with no way to clear it.
      void this.settleSwipe(
        play.id,
        branch.key,
        branch.current,
        () => [],
        new Error('扮演会话未处于活动状态，无法生成'),
      )
      return
    }
    const prefixLength = branch.prefix.length
    const target = branch.current
    // Capture THIS generation's handle: a concurrent swipe on another branch
    // rebases the play and replaces the live director, so re-reading
    // `this.directors.get(playId)` at settle time would record a foreign
    // session's events into this branch's slot.
    const readTail = (): SessionEvent[] => [...handle.agent.session.events].slice(prefixLength)
    const done = handle.agent.whenIdle()
    try {
      handle.agent.followup(userMessage(branch.userText))
    } catch (error: unknown) {
      void this.settleSwipe(play.id, branch.key, target, readTail, error)
      return
    }
    void done.then(
      () => this.settleSwipe(play.id, branch.key, target, readTail),
      (error: unknown) => this.settleSwipe(play.id, branch.key, target, readTail, error),
    )
  }

  /**
   * Record one settled swipe attempt into its branch slot.
   * @param playId - owning play.
   * @param key - branch key.
   * @param index - variant slot to fill.
   * @param readTail - reader of the settling generation's own session events
   *   (captured at kick time; immune to later director replacement).
   * @param error - generation failure, when the drive rejected.
   */
  private async settleSwipe(
    playId: string,
    key: string,
    index: number,
    readTail: () => SessionEvent[],
    error?: unknown,
  ): Promise<void> {
    const branch = this.deps.storage.getSwipeBranch(playId, key)
    if (branch === undefined) return
    const tail = error !== undefined ? [] : readTail()
    const variants = [...branch.variants]
    if (index >= variants.length) return
    variants[index] = tail
    const next: SwipeBranch = {
      ...branch,
      variants,
      current: index,
      busy: false,
      updatedAt: nowIso(),
    }
    if (error !== undefined) {
      next.error = error instanceof Error ? error.message : String(error)
    } else {
      delete next.error
    }
    await this.deps.storage.upsertSwipeBranch(next).catch((saveError: unknown) => {
      this.deps.logger.warn(`tavern: failed to persist swipe branch: ${String(saveError)}`)
    })
  }

  /**
   * Materialize another stored swipe variant as the play's live session.
   * @param playId - the play.
   * @param key - branch key (from the state snapshot's swipe summary).
   * @param step - relative movement (+1 next, -1 previous, wraps around).
   * @returns the rebased play and the updated branch.
   */
  async swipe(playId: string, key: string, step: number): Promise<{ play: Play; branch: SwipeBranch }> {
    const play = this.deps.storage.getPlay(playId)
    if (play === undefined) throw notFound('酒馆会话不存在')
    const branch = this.deps.storage.getSwipeBranch(playId, key)
    if (branch === undefined) throw badRequest('这条回复还没有可切换的尝试')
    if (branch.busy) throw conflict('上一次尝试还在生成中，请稍候')
    if (branch.variants.length === 0) throw badRequest('这条回复还没有可切换的尝试')
    const target = ((branch.current + step) % branch.variants.length + branch.variants.length)
      % branch.variants.length
    const tail = branch.variants[target]
    if (tail === undefined || tail.length === 0) throw badRequest('该次尝试还没有内容')
    const seed = [...branch.prefix, ...structuredClone(tail)] as SessionEvent[]
    const rebased = await this.rebasePlaySession(play, seed)
    const next: SwipeBranch = { ...branch, current: target, updatedAt: nowIso() }
    await this.deps.storage.upsertSwipeBranch(next)
    return { play: rebased, branch: next }
  }

  /**
   * Edit one assistant reply in place: the play's session forks to a copy
   * whose target message text is replaced. Stale swipe branches are dropped.
   * @param playId - the play.
   * @param messageId - the durable assistant message id.
   * @param text - the new reply text.
   * @returns the rebased play.
   */
  async editAssistant(playId: string, messageId: string, text: string): Promise<Play> {
    const play = this.deps.storage.getPlay(playId)
    if (play === undefined) throw notFound('酒馆会话不存在')
    if (text.trim() === '') throw badRequest('内容不能为空')
    const events = await this.liveEvents(play)
    const index = events.findIndex(event =>
      event.type === 'assistant/message' && String(event.data.message.id) === messageId)
    if (index < 0) throw notFound('找不到这条回复（可能已被新的尝试替换）')
    const next = events.map((event, i) => {
      if (i !== index || event.type !== 'assistant/message') return event
      return {
        ...event,
        data: {
          ...event.data,
          message: {
            ...event.data.message,
            content: [{ type: 'text' as const, text }],
          },
        },
      }
    })
    await this.deps.storage.deleteSwipeBranches(playId)
    return this.rebasePlaySession(play, next)
  }

  /**
   * Edit one user message: the session is rebased to just before that
   * message's turn and the edited text is replayed, regenerating the answer.
   * @param playId - the play.
   * @param messageId - the user message id.
   * @param text - the edited message text.
   * @returns the rebased play (generation continues in the background).
   */
  async editUserAndRetry(playId: string, messageId: string, text: string): Promise<Play> {
    const play = this.deps.storage.getPlay(playId)
    if (play === undefined) throw notFound('酒馆会话不存在')
    if (text.trim() === '') throw badRequest('内容不能为空')
    const events = await this.liveEvents(play)
    const index = events.findIndex(event =>
      event.type === 'user/message' && String(event.data.id) === messageId)
    if (index < 0) throw notFound('找不到这条消息')
    let turnStart = -1
    for (let i = index; i >= 0; i--) {
      if (events[i]?.type === 'turn/start') {
        turnStart = i
        break
      }
    }
    if (turnStart < 0) throw badRequest('会话日志不完整，无法编辑')
    const prefix = events.slice(0, turnStart)
    if (prefix.length > 0 && prefix[prefix.length - 1]?.type !== 'turn/end') {
      throw badRequest('会话日志存在未闭合的轮次，无法编辑')
    }
    await this.deps.storage.deleteSwipeBranches(playId)
    const rebased = await this.rebasePlaySession(play, prefix)
    const handle = this.directors.get(rebased.id)
    if (handle !== undefined) {
      const done = handle.agent.whenIdle()
      try {
        handle.agent.followup(userMessage(text))
      } catch (error: unknown) {
        this.deps.logger.warn(`tavern: edited-message replay failed: ${String(error)}`)
        throw error
      }
      void done.catch((error: unknown) => {
        this.deps.logger.warn(`tavern: edited-message turn failed: ${String(error)}`)
      })
    }
    return rebased
  }
}
