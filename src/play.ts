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
import type { MessageId, UserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { CharacterRecord, Play, Preset, WorldBookRecord } from './types.ts'
import { TavernStorage, newId } from './storage.ts'
import { activateBook, renderWorldInfo, type ActivatedEntry } from './lorebook.ts'

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
   * survives restarts; otherwise a fresh session is created.
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
    const setup: AgentSetup = (agentCtx) => {
      agentCtx.systemPrompt.section({
        name: 'tavern:director',
        order: -1000,
        complete: true,
        text: directorSystem,
      })
      if (loreContext !== null) {
        agentCtx.systemPrompt.context(loreContext)
      }
    }

    // Resume the persisted session when present; fall back to creation.
    const agentOptions = {
      ...(model.provider === undefined ? {} : { provider: model.provider }),
      ...(model.model === undefined ? {} : { model: model.model }),
      ...(model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens }),
    }
    let handle: AgentHandle
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
        setup,
        ...(play.greeting !== undefined && play.greeting !== ''
          ? { seed: greetingSeed(play.greeting, model.provider ?? 'default', model.model ?? 'default') }
          : {}),
      })
    }
    this.directors.set(play.id, handle)
    return handle
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
  ): { name: string; order: number; text: (context: { agent?: Agent }) => string } | null {
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
    const setup: AgentSetup = (agentCtx) => {
      agentCtx.systemPrompt.section({
        name: 'tavern:character',
        order: -1000,
        complete: true,
        text: system,
      })
      if (loreContext !== null) {
        agentCtx.systemPrompt.context(loreContext)
      }
    }

    // Resume the persisted session when present; fall back to creation.
    let handle: AgentHandle
    try {
      handle = await this.deps.agents.resume({
        resumeSessionId: sessionId,
        agentOptions: {
          ...(model.provider === undefined ? {} : { provider: model.provider }),
          ...(model.model === undefined ? {} : { model: model.model }),
          ...(model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens }),
        },
        setup,
      })
    } catch (error: unknown) {
      this.deps.logger.warn(`tavern: resume character failed (${String(error)}); creating fresh session`)
      handle = await this.deps.agents.create({
        sessionId,
        agentOptions: {
          ...(model.provider === undefined ? {} : { provider: model.provider }),
          ...(model.model === undefined ? {} : { model: model.model }),
          ...(model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens }),
        },
        setup,
      })
    }
    byPlay.set(character.id, handle)
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
