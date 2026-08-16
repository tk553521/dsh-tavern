/**
 * dsh-tavern host half: the tavern roleplay plugin.
 *
 * The tavern play IS a DSH session: creating a play assembles a "director"
 * agent through `ctx.agents` (character cards as its system prompt, world
 * book as a dynamic prompt context, greeting seeded into the session log),
 * and multi-agent mode routes character lines through the `tavern_speak`
 * tool into dedicated character agents. Library data (characters / world
 * books / presets / play bindings) lives on the DSH settings service; the
 * browser manages the library through the /tavern prefix route served by
 * dsh-host-webserver — the DSH process's own HTTP plugin extension point.
 *
 * Everything is effect-scoped: plugin unload disposes the route, the
 * settings namespace, the tool, and every live director/character agent.
 */

import type { Context } from '@deepseek-ai/cordis'
import type Schema from '@deepseek-ai/schemastery'
import type { AgentRegistry } from '@deepseek-ai/dsh-agent'
import type { WebServer } from '@deepseek-ai/dsh-host-webserver'
import type { SettingsNamespace, SettingsScope } from '@deepseek-ai/dsh-settings'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { TavernStorage, EMPTY_DATABASE, type TavernDatabase } from './storage.ts'
import { tavernHandler } from './api.ts'
import { importTauriTavernData } from './tauritavern.ts'
import { TavernSessionRuntime } from './play.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The tavern service: library CRUD plus play/session assembly. */
    tavern: TavernService
  }
}

export const name = 'dsh-tavern'

/** Services required by the host half. */
export const inject = [
  'webServer',
  'settings',
  'agents',
  'agentDefaultModel',
  'tools',
]

/** The settings namespace brand for the tavern document. */
const tavernNamespace = 'tavern' as unknown as SettingsNamespace

/**
 * Schema of the tavern settings namespace (one document per installation).
 * A hand-rolled permissive Standard-Schema callable: out-of-tree plugins
 * cannot resolve @deepseek-ai runtime packages, so the schema carries no
 * schemastery dependency. It validates the version marker and fills missing
 * top-level arrays, accepting unknown fields for forward compatibility.
 */
export const TavernSchema = Object.assign(
  (input: unknown): TavernDatabase => {
    if (input === undefined || input === null) return EMPTY_DATABASE
    if (typeof input !== 'object' || Array.isArray(input)) {
      throw new Error('酒馆数据必须是对象')
    }
    const doc = input as Partial<TavernDatabase>
    if (doc.version !== undefined && doc.version !== 1) {
      throw new Error(`不支持的酒馆数据版本：${String(doc.version)}`)
    }
    return {
      version: 1,
      characters: Array.isArray(doc.characters) ? doc.characters : [],
      lorebooks: Array.isArray(doc.lorebooks) ? doc.lorebooks : [],
      presets: Array.isArray(doc.presets) ? doc.presets : [],
      plays: Array.isArray(doc.plays) ? doc.plays : [],
      defaultPresetId: doc.defaultPresetId,
      style: doc.style === 'dsh' || doc.style === 'classic' ? doc.style : undefined,
    }
  },
  { toJSON: () => ({ type: 'object', properties: {} }) },
) as unknown as Schema<TavernDatabase>

/**
 * The tavern service: library CRUD and the session runtime. The browser
 * talks to the REST route; other host plugins may use this service directly.
 */
export class TavernService {
  readonly storage: TavernStorage
  readonly runtime: TavernSessionRuntime
  private readonly ctx: Context

  constructor(
    ctx: Context,
    settingsScope: SettingsScope<TavernDatabase>,
  ) {
    this.ctx = ctx
    this.storage = new TavernStorage(settingsScope)
    this.runtime = new TavernSessionRuntime({
      storage: this.storage,
      agents: ctx.agents,
      defaultModel: () => {
        const selection = ctx.agentDefaultModel.currentSelection()
        return {
          provider: selection.provider,
          model: selection.model,
          reasoningEffort: selection.reasoningEffort,
        }
      },
      logger: ctx.logger,
    })
  }

  /** All stored characters. */
  listCharacters() {
    return this.storage.listCharacters()
  }

  /** All stored world books. */
  listLorebooks() {
    return this.storage.listLorebooks()
  }

  /** All stored presets. */
  listPresets() {
    return this.storage.listPresets()
  }

  /** All stored plays. */
  listPlays() {
    return this.storage.listPlays()
  }

  /**
   * Import TauriTavern user data from a local installation/data directory
   * (portable app root, data root, default-user, or a child directory).
   */
  importTauriTavern(input: string, selection?: Partial<import('./types.ts').TauriTavernImportSelection>) {
    return importTauriTavernData(this.storage, input, selection)
  }

  /**
   * Whether the agent-loop factory is currently available.
   * `AgentRegistry` has no public factory probe; the stock agent-loop plugin
   * provides the public `agentLoop` Cordis service and registers itself as the
   * factory from that service's effect, so this is the reliable public signal.
   */
  multiAgentAvailable(): boolean {
    // Public signal: the stock agent-loop plugin provides the `agentLoop`
    // service and registers itself as the factory from that service's effect.
    if (this.ctx.get('agentLoop') !== undefined) return true
    // Best-effort fallback for a custom factory registered via
    // `ctx.agents.setFactory()` without the agent-loop service. The slot is
    // TypeScript-private but is an ordinary compiled field in current dsh-agent.
    const agents = this.ctx.agents as unknown as { factory?: unknown }
    return agents.factory !== undefined
  }
}

/** The `tavern_speak` tool: route a character's line through its own agent. */
function defineSpeakTool(service: TavernService): ToolDefinition {
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
      return service.runtime.speakFor(exec, typed)
    },
  }
}

/** Plugin entry: registers the settings namespace, the tool, and the route. */
export function apply(ctx: Context): void {
  // The tavern database namespace: one JSON document for the whole library.
  const scope = ctx.settings.register<TavernDatabase>(tavernNamespace, TavernSchema)

  const service = new TavernService(ctx, scope)
  ctx.provide('tavern', service)

  // The multi-agent tool: every DSH session (not only tavern plays) sees it,
  // but it only acts inside a play-bound director session.
  ctx.tools.register(defineSpeakTool(service))

  // The REST prefix route for library management (dsh-host-webserver
  // extension point). register() returns the disposer; return it from the
  // effect so plugin unload/reload removes the route instead of leaking it.
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/tavern',
    handler: (req, res) => tavernHandler({
      storage: service.storage,
      runtime: service.runtime,
      logger: ctx.logger,
      multiAgentAvailable: () => service.multiAgentAvailable(),
    }, req, res),
  }), 'tavern.webServer.route')

  // Teardown: dispose every live director/character agent with the plugin.
  ctx.effect(() => () => {
    service.runtime.dispose()
  }, 'tavern.runtime.dispose')
}
