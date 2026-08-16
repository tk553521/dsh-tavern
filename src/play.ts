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

import type { LoggerService } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle, AgentRegistry, AgentSetup } from '@deepseek-ai/dsh-agent'
import type { AgentPresets } from '@deepseek-ai/dsh-agent-presets'
import type { MessageId, UserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type SessionPersistence from '@deepseek-ai/dsh-session-persistence'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { WorkspaceRegistry } from '@deepseek-ai/dsh-workspace'
import type { CharacterRecord, Play, Preset, WorldBookRecord } from './types.ts'
import { TavernStorage, newId } from './storage.ts'
import { activateBook, renderWorldInfo, type ActivatedEntry } from './lorebook.ts'
import { TAVERN_PRESET_ID } from './tavern-preset.ts'

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
import { buildCharacterSystem, buildClassicSystem, characterProfile, stripPromptVariables } from './prompt.ts'

export interface PlayRuntimeDeps {
  storage: TavernStorage
  agents: AgentRegistry
  /** Agent-preset roster: mounts the tavern preset for play sessions. */
  agentPresets: AgentPresets
  /** Workspace registry: tavern sessions are archived (hidden from every grouping surface). */
  workspace: WorkspaceRegistry
  /** Session persistence: resolves the preset a persisted session was produced under. */
  sessionPersistence: SessionPersistence
  /** Author the tavern preset into the harness-home user root (memoized, non-clobbering). */
  ensurePreset: () => Promise<void>
  /** Default model selection for agents without a preset override. */
  defaultModel: () => { provider: string; model: string; reasoningEffort?: string }
  logger: LoggerService
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

  constructor(private readonly deps: PlayRuntimeDeps) {}

  /** Dispose every live agent (called from the plugin's teardown effect). */
  dispose(): void {
    for (const handle of this.directors.values()) {
      void handle.dispose().catch(() => {})
    }
    this.directors.clear()
    for (const byPlay of this.roles.values()) {
      for (const handle of byPlay.values()) {
        void handle.dispose().catch(() => {})
      }
    }
    this.roles.clear()
    this.speakQueues.clear()
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
  async ensureDirector(play: Play): Promise<AgentHandle> {
    const existing = this.directors.get(play.id)
    if (existing !== undefined) return existing

    const storage = this.deps.storage
    const characters = play.characterIds
      .map(id => storage.getCharacter(id))
      .filter((c): c is CharacterRecord => c !== undefined)
    const lorebooks = this.playLorebooks(play)
    const preset = play.presetId !== undefined ? storage.getPreset(play.presetId) : undefined
    const model = resolveModel(this.deps, preset)
    const sessionId = play.sessionId as SessionId

    const directorSystem = this.buildDirectorSystem(play, characters, preset)
    const loreContext = this.buildLoreContext(lorebooks, characters)
    // A resumed session keeps the preset its history was produced under (a
    // legacy play predating the tavern preset has none recorded and resumes
    // bare, as before); a fresh session composes the tavern preset.
    await this.deps.ensurePreset()
    const persistedPreset = await this.persistedPreset(sessionId)
    const setup = this.sessionSetup(persistedPreset ?? TAVERN_PRESET_ID, directorSystem, loreContext)

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
      handle = await this.deps.agents.create({
        sessionId,
        agentOptions,
        meta: { agentPreset: TAVERN_PRESET_ID },
        setup,
        ...(play.greeting !== undefined && play.greeting !== ''
          ? { seed: greetingSeed(play.greeting, model.provider ?? 'default', model.model ?? 'default') }
          : {}),
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
   * into the persona slot and the world-book dynamic context.
   * @param presetId - preset to mount, or undefined to compose bare (legacy).
   * @param system - the director/character system prompt text.
   * @param loreContext - the world-book dynamic context, or null.
   */
  private sessionSetup(
    presetId: string | undefined,
    system: string,
    loreContext: LoreContext,
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
    }
  }

  /**
   * Archive one play session: tavern sessions are hidden from every workspace
   * grouping surface (the 对话 page) and live inside the tavern page only.
   * Idempotent; failures only log because a play must stay usable.
   * @param sessionId - the session to hide.
   */
  private async hideFromWorkspace(sessionId: SessionId): Promise<void> {
    try {
      await this.deps.workspace.archiveSession(sessionId)
    } catch (error: unknown) {
      this.deps.logger.warn(`tavern: failed to archive session "${sessionId}": ${String(error)}`)
    }
  }

  /** Compose the director's system prompt. */
  private buildDirectorSystem(
    play: Play,
    characters: readonly CharacterRecord[],
    preset: Preset | undefined,
  ): string {
    if (play.multiAgent) {
      const parts: string[] = []
      parts.push('你是一场角色扮演（roleplay）的主持者（director）。')
      const names = play.characterIds
        .map(id => characters.find(c => c.id === id)?.card.data.name)
        .filter((name): name is string => name !== undefined)
        .map(name => stripPromptVariables(name))
      if (names.length > 0) parts.push(`在场角色：${names.join('、')}`)
      for (const character of characters) {
        const data = character.card.data
        parts.push(`【角色 ${stripPromptVariables(data.name)}】\n${characterProfile(character)}`)
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
    return buildClassicSystem(play, characters, renderWorldInfo([]), preset)
  }

  /** Dynamic world-book context for the director's assembly. */
  private buildLoreContext(
    lorebooks: readonly WorldBookRecord[],
    characters: readonly CharacterRecord[],
  ): LoreContext {
    if (lorebooks.length === 0) return null
    return {
      name: 'tavern:world',
      order: 50,
      text: (context) => {
        const agent = context.agent
        if (agent === undefined) return ''
        const scanText = this.recentSessionText(agent.session, characters)
        const depth = agent.session.events.filter(e => e.type === 'user/message').length
        const activated: ActivatedEntry[] = lorebooks.flatMap(book => activateBook(book.book, {
          text: scanText,
          depth,
        }))
        return renderWorldInfo(activated)
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
  private recentSessionText(session: Session, characters: readonly CharacterRecord[]): string {
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
    return lines.slice(-12).join('\n')
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
      handle.agent.followup(userMessage(instruction))
      const wait = done.catch(() => {})
      let onAbort: (() => void) | undefined
      const timeout = new Promise<never>((_, reject) => {
        const timer = setTimeout(() => reject(new Error('角色回应超时')), 120_000)
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
    const system = buildCharacterSystem(
      character,
      '',
      preset,
      names.length > 0 ? [`同场角色：${names.join('、')}`] : [],
    )
    const sessionId = `tavern-role-${play.id.slice(0, 8)}-${character.id.slice(0, 8)}` as SessionId
    const loreContext = this.buildLoreContext(lorebooks, characters)
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
}
