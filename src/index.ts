/**
 * dsh-tavern host half: the tavern roleplay plugin.
 *
 * The tavern play IS a DSH session: creating a play assembles a "director"
 * agent through `ctx.agents` (character cards as its system prompt, world
 * book as a dynamic prompt context, greeting seeded into the session log),
 * and multi-agent mode routes character lines through the `tavern_speak`
 * tool into dedicated character agents. Library data (characters / world
 * books / presets / play bindings) lives as per-record files under
 * `$DSH_HOME/tavern/library/`; the browser manages it through the /tavern
 * prefix route served by dsh-host-webserver — the DSH process's own HTTP
 * plugin extension point.
 *
 * ## Cordis shape, and why it is not `extends Service`
 *
 * DSH's own plugins define a service class extending cordis's `Service` base.
 * An out-of-tree plugin cannot: `Service` is a runtime value, and the
 * installed profile carries no `@deepseek-ai` tree at all
 * (`$DSH_HOME/profiles/<p>/node_modules/` holds only the plugin and its dev
 * dependencies), so `import { Service } from '@deepseek-ai/cordis'` fails
 * module resolution and the plugin never loads. Every `@deepseek-ai` import
 * here is therefore type-only and erased at build time.
 *
 * The readiness semantics `Service` would have provided are obtained instead
 * from the fiber lifecycle, which needs no import:
 *
 * - `apply` is `async`. Cordis awaits the plugin body (`fiber.ts:656`) before
 *   marking the fiber ACTIVE (`fiber.ts:665`).
 * - A service registered with `ctx.provide` is invisible to injectors while
 *   its owning fiber is not ACTIVE (`reflect.ts:_getImpl` returns undefined
 *   under `strict`).
 * - So awaiting the library load inside `apply` IS the readiness gate, and the
 *   REST route — registered from `ctx.inject(['tavern'], …)` — cannot exist
 *   before the index is loaded. This replaces the hand-rolled `ready` promise
 *   that every request handler used to await, and its 503 branch.
 *
 * Everything is effect-scoped: plugin unload disposes the route, the settings
 * namespace, and every live director/character agent.
 */

import type { Context } from '@deepseek-ai/cordis'
import type Schema from '@deepseek-ai/schemastery'
// Type-only side-effect imports: these pull each package's `declare module
// '@deepseek-ai/cordis'` augmentation into the program (ctx.agents,
// ctx.webServer, ctx.agentPresets, ctx.dshHomePath, …). They bind no names,
// and erase completely — see the note above on runtime resolution.
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-presets'
import type {} from '@deepseek-ai/dsh-app-boot'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type { SettingsNamespace, SettingsScope } from '@deepseek-ai/dsh-settings'
import { TavernStorage, emptyDatabase, type TavernDatabase } from './storage.ts'
import { LibraryStore, migrateLegacyLibrary } from './library.ts'
import { AvatarStore } from './avatarstore.ts'
import { tavernHandler } from './api.ts'
import { importTauriTavernData } from './tauritavern.ts'
import { TavernSessionRuntime } from './play.ts'
import { ensureTavernPreset } from './tavern-preset.ts'
import { Config, normalizeConfig, type TavernConfig } from './config.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The tavern service: library CRUD plus play/session assembly. */
    tavern: TavernService
  }
}

export const name = 'dsh-tavern'

/**
 * Services required by the host half.
 *
 * `workspaceRegistry` is deliberately absent: its only use is archiving a play
 * session out of the 对话 page, which is already best-effort, so requiring it
 * would keep the whole tavern from loading in a profile that omits it. It is
 * probed with `ctx.get()` at the call site instead.
 *
 * NOTE: this fork has no optional-inject syntax. `Inject.resolve`
 * (`cordis/src/registry.ts:71-88`) turns EVERY key of the object form into a
 * required dependency — the object's values are per-service intercept config,
 * not a required/optional split. Writing `{ required: [...], optional: [...] }`
 * would request two services literally named "required" and "optional", and
 * the plugin would sit in PENDING forever without ever reporting an error.
 */
export const inject = [
  'webServer',
  'settings',
  'agents',
  'agentDefaultModel',
  'tools',
  'dshHomePath',
  'agentPresets',
  'sessionPersistence',
]

/** Plugin config schema; cordis validates the loader row's `config:` against it. */
export { Config }

/** The settings namespace brand for the tavern document. */
const tavernNamespace = 'tavern' as unknown as SettingsNamespace

/**
 * Schema of the tavern settings namespace.
 *
 * Only preferences (`defaultPresetId`, `style`) are written here now; the
 * library arrays remain in the schema so a pre-migration document still
 * validates and can be read once by {@link migrateLegacyLibrary}.
 *
 * A hand-rolled permissive Standard-Schema callable, for the same
 * no-runtime-imports reason as {@link Config}. It validates the version marker
 * and fills missing top-level arrays, accepting unknown fields for forward
 * compatibility.
 */
export const TavernSchema = Object.assign(
  (input: unknown): TavernDatabase => {
    // A fresh object per call: returning a shared module-level singleton let
    // the settings service deep-freeze it, and any later mutation of the
    // "empty" default would have been cross-talk between callers.
    if (input === undefined || input === null) return emptyDatabase()
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
      branches: Array.isArray(doc.branches) ? doc.branches : [],
      defaultPresetId: doc.defaultPresetId,
      style: doc.style === 'dsh' || doc.style === 'classic' ? doc.style : undefined,
    }
  },
  { toJSON: () => ({ type: 'object', properties: {} }) },
) as unknown as Schema<TavernDatabase>

/**
 * The tavern service: library CRUD and the session runtime. The browser talks
 * to the REST route; other host plugins may use this service directly by
 * injecting `tavern`, which resolves only once {@link TavernService.load} has
 * finished (see the module note on the readiness gate).
 */
export class TavernService {
  readonly storage: TavernStorage
  readonly runtime: TavernSessionRuntime
  readonly avatars: AvatarStore
  readonly config: TavernConfig

  private readonly ctx: Context
  private readonly library: LibraryStore
  private readonly settings: SettingsScope<TavernDatabase>
  private presetAttempt: Promise<unknown> | undefined

  constructor(ctx: Context, config: TavernConfig) {
    this.ctx = ctx
    this.config = config
    this.settings = ctx.settings.register<TavernDatabase>(tavernNamespace, TavernSchema)
    this.avatars = new AvatarStore(ctx.dshHomePath!('tavern', 'avatars'), ctx.logger)
    this.library = new LibraryStore(ctx.dshHomePath!('tavern', 'library'), ctx.logger)
    this.storage = new TavernStorage(this.library, this.settings)
    this.runtime = new TavernSessionRuntime({
      storage: this.storage,
      agents: ctx.agents,
      agentPresets: ctx.agentPresets,
      // Optional dependency: probed per call rather than injected, so a
      // profile without the workspace registry still runs the tavern.
      workspace: () => ctx.get('workspaceRegistry'),
      sessionPersistence: ctx.sessionPersistence,
      ensurePreset: () => this.ensurePreset(),
      defaultModel: () => {
        const selection = ctx.agentDefaultModel.currentSelection()
        return {
          provider: selection.provider,
          model: selection.model,
          reasoningEffort: selection.reasoningEffort,
        }
      },
      logger: ctx.logger,
      config,
    })
  }

  /**
   * Async bootstrap: load the library index, move a pre-migration settings
   * library onto disk, extract legacy inline avatars, author the agent preset.
   *
   * Awaited by `apply` before the fiber activates, so completing this is
   * exactly "the tavern is ready to serve". A throw here leaves the fiber
   * FAILED and `ctx.tavern` unresolvable — cordis logs the reason at ERROR
   * (`fiber.ts:660`), which is the level that actually reaches an exporter.
   */
  async load(): Promise<void> {
    await this.library.load()

    const section = this.settings.get()
    const report = await migrateLegacyLibrary(this.library, section, this.ctx.logger)
    if (report.moved) {
      this.ctx.logger.info(
        'tavern library: migrated %s character(s), %s world book(s), %s preset(s), %s play(s), %s branch(es) to disk',
        String(report.characters), String(report.lorebooks), String(report.presets),
        String(report.plays), String(report.branches),
      )
      // Only now drop the settings copy: every record above is readable back
      // from the index, so this is what actually reclaims the document.
      await this.settings.replace({
        ...emptyDatabase(),
        ...(section.defaultPresetId !== undefined ? { defaultPresetId: section.defaultPresetId } : {}),
        ...(section.style !== undefined ? { style: section.style } : {}),
      })
      this.ctx.logger.info('tavern library: settings document reclaimed')
    }

    // Legacy installs stored avatars as base64 data URLs. Extract those files
    // once; retrying is safe because unchanged records are left alone and any
    // failed record keeps its inline fallback.
    const avatars = await this.migrateLegacyAvatars()
    if (avatars.changed > 0) {
      this.ctx.logger.info('tavern avatar migration: extracted %s avatar file(s)', String(avatars.changed))
    }

    // Author the tavern agent preset up front (idempotent, non-clobbering).
    // A failure must NOT keep the tavern from loading: the runtime re-ensures
    // the preset before every play assembly and fails loudly there instead.
    try {
      await this.ensurePreset()
    } catch (error: unknown) {
      // `.error`, not `.warn`: the default logger threshold is INFO(1) while
      // WARN is 2, and the filter is `targetLevel < level → skip`, so warnings
      // are discarded outright (`cordis/src/logger.ts:23-26,155-156`).
      this.ctx.logger.error('tavern: agent preset authoring failed: %s', String(error))
    }
  }

  /** One preset-authoring attempt per process; a rejection allows a retry. */
  private ensurePreset(): Promise<unknown> {
    this.presetAttempt ??= ensureTavernPreset(this.ctx.dshHomePath!).catch((error: unknown) => {
      this.presetAttempt = undefined
      throw error
    })
    return this.presetAttempt
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
    return importTauriTavernData(this.storage, this.avatars, input, selection)
  }

  /**
   * One-time (idempotent) migration: extract legacy inline data-URL avatars to
   * `<dsh-home>/tavern/avatars/` and persist only their relative paths.
   */
  async migrateLegacyAvatars(): Promise<{ changed: number }> {
    const characters = this.storage.listCharacters()
    if (characters.length === 0) return { changed: 0 }
    const result = await this.avatars.migrateLegacyCharacters(characters)
    if (result.changed === 0) return result
    await this.storage.replaceCharacters(result.characters)
    return result
  }

  /**
   * Whether the agent-loop factory is currently available.
   *
   * `AgentRegistry.factory` is private with no public probe, so the signal is
   * the `agentLoop` service the stock agent-loop plugin provides — it registers
   * itself as the factory from that service's own effect. An earlier version
   * also poked the private field through a cast; that has been removed rather
   * than depend on a compiled-output detail.
   */
  multiAgentAvailable(): boolean {
    return this.ctx.get('agentLoop') !== undefined
  }
}

/**
 * Plugin entry.
 *
 * `async` on purpose — that is what makes cordis await the bootstrap before
 * activating the fiber, which is what gates `ctx.tavern` (see the module note).
 * It also means the function has no `.prototype`, so cordis calls it plainly
 * rather than with `new`, the way it invokes ordinary `function apply`
 * declarations (`cordis/src/utils.ts:isConstructor`, `fiber.ts:251`).
 *
 * Kept as a named export with NO default export: the loader's `unwrapExports`
 * collapses a module to its default when one exists, discarding `name`,
 * `inject`, and `Config` with it.
 *
 * @param ctx - the plugin's context.
 * @param config - the loader row's `config:`, already validated by {@link Config}.
 */
export async function apply(ctx: Context, config?: TavernConfig): Promise<void> {
  // `config` arrives validated when the loader supplies one; normalize again
  // so a direct `ctx.plugin(module)` call with no config still gets defaults.
  const service = new TavernService(ctx, config ?? normalizeConfig(undefined))
  ctx.provide('tavern', service)

  // Registered BEFORE the bootstrap below: if `load()` throws, the fiber
  // unloads and this still tears down any agent the runtime already created.
  ctx.effect(() => async () => {
    await service.runtime.dispose()
  }, 'tavern.runtime.dispose')

  await service.load()

  // The REST prefix route lives on a child fiber that injects `tavern`, so it
  // is registered only once this fiber is ACTIVE — i.e. after `load()` above —
  // and is torn down and re-registered if the service ever reloads.
  ctx.inject(['tavern'], (scoped) => {
    scoped.effect(() => scoped.webServer.register({
      kind: 'prefix',
      path: '/tavern',
      handler: (req, res) => tavernHandler({
        storage: service.storage,
        runtime: service.runtime,
        avatars: service.avatars,
        logger: scoped.logger,
        config: service.config,
        multiAgentAvailable: () => service.multiAgentAvailable(),
      }, req, res),
    }), 'tavern.webServer.route')
  })

  // NOTE: `tavern_speak` is deliberately NOT registered here. From a plain
  // plugin context `ctx.tools.register` registers GLOBALLY, putting the tool in
  // every DSH session's toolset — including ordinary coding sessions that can
  // never use it. It is registered per multi-agent director from the agent
  // scope instead (see TavernSessionRuntime.sessionSetup).
}
