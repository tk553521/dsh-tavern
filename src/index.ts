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
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
// Type-only side-effect imports: these pull each package's `declare module
// '@deepseek-ai/cordis'` augmentation into the program (ctx.agents,
// ctx.webServer, ctx.agentPresets, ctx.dshHomePath, …). They bind no names,
// and erase completely — see the note above on runtime resolution.
//
// NOTE the package name: the service is `ctx.agentPresets`, but the package
// that declares it is `@deepseek-ai/dsh-agent-preset-registry`.
// `@deepseek-ai/dsh-agent-presets` does not exist in 0.2.2-alpha.3, and a
// type-only import of a missing package is still a hard type error.
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-app-boot'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { TavernStorage, type TavernDatabase } from './storage.ts'
import { LibraryStore, migrateLegacyLibrary, type LegacyLibrary } from './library.ts'
import { PrefsStore } from './prefs.ts'
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
  'agents',
  'agentDefaultModel',
  'tools',
  'dshHomePath',
  'agentPresets',
  'sessionPersistence',
]

/** Plugin config schema; cordis validates the loader row's `config:` against it. */
export { Config }

/**
 * Validate one decoded legacy library document.
 *
 * Permissive on purpose: the arrays and the two preferences are what the
 * migration knows how to move, and an unknown field must not abort it.
 * @param input - the decoded `tavern` section of an old settings document.
 * @returns the library part, or undefined when the value is not a document.
 */
export function legacyLibraryOf(input: unknown): LegacyLibrary | undefined {
  if (input === undefined || input === null) return undefined
  if (typeof input !== 'object' || Array.isArray(input)) return undefined
  const doc = input as Partial<TavernDatabase>
  if (doc.version !== undefined && doc.version !== 1) return undefined
  return {
    ...(Array.isArray(doc.characters) ? { characters: doc.characters } : {}),
    ...(Array.isArray(doc.lorebooks) ? { lorebooks: doc.lorebooks } : {}),
    ...(Array.isArray(doc.presets) ? { presets: doc.presets } : {}),
    ...(Array.isArray(doc.plays) ? { plays: doc.plays } : {}),
    ...(Array.isArray(doc.branches) ? { branches: doc.branches } : {}),
  }
}

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
  private readonly prefs: PrefsStore
  private presetAttempt: Promise<unknown> | undefined

  constructor(ctx: Context, config: TavernConfig) {
    this.ctx = ctx
    this.config = config
    this.prefs = new PrefsStore(ctx.dshHomePath!('tavern', 'prefs.json'), ctx.logger)
    this.avatars = new AvatarStore(ctx.dshHomePath!('tavern', 'avatars'), ctx.logger)
    this.library = new LibraryStore(ctx.dshHomePath!('tavern', 'library'), ctx.logger)
    this.storage = new TavernStorage(this.library, this.prefs)
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
   * Async bootstrap: load the preferences and library index, recover a
   * pre-0.2 settings-backed library onto disk if one can still be found,
   * extract legacy inline avatars, author the agent preset.
   *
   * Awaited by `apply` before the fiber activates, so completing this is
   * exactly "the tavern is ready to serve". A throw here leaves the fiber
   * FAILED and `ctx.tavern` unresolvable — cordis logs the reason at ERROR,
   * which is the level that actually reaches an exporter.
   */
  async load(): Promise<void> {
    await this.prefs.load()
    await this.library.load()

    const legacy = await this.readLegacySettingsDocument()
    if (legacy !== undefined) {
      try {
        const report = await migrateLegacyLibrary(this.library, legacy, this.ctx.logger)
        if (report.moved) {
          this.ctx.logger.info(
            'tavern library: recovered %s character(s), %s world book(s), %s preset(s), %s play(s), %s branch(es) from the legacy settings document',
            String(report.characters), String(report.lorebooks), String(report.presets),
            String(report.plays), String(report.branches),
          )
        }
      } catch (error: unknown) {
        // A half-migrated legacy document is a data problem, not a reason to
        // leave the tavern unstartable forever: the records that DID land are
        // on disk, and the source document is left untouched for a later retry.
        this.ctx.logger.error('tavern library: legacy recovery incomplete: %s', String(error))
      }
    }

    // Legacy installs stored avatars as base64 data URLs. Extract those files
    // once; retrying is safe because unchanged records are left alone and any
    // failed record keeps its inline fallback.
    try {
      const avatars = await this.migrateLegacyAvatars()
      if (avatars.changed > 0) {
        this.ctx.logger.info('tavern avatar migration: extracted %s avatar file(s)', String(avatars.changed))
      }
    } catch (error: unknown) {
      // Same reasoning as above: an avatar file that cannot be written is a
      // per-record problem, and the inline data URL still renders the avatar.
      this.ctx.logger.error('tavern avatar migration failed: %s', String(error))
    }

    // Register the tavern agent preset up front (idempotent).
    // A failure must NOT keep the tavern from loading: the runtime re-ensures
    // the preset before every play assembly and fails loudly there instead.
    try {
      await this.ensurePreset()
    } catch (error: unknown) {
      // `.error` because a preset that cannot register leaves every play
      // session without its composition — this is a real failure. (Not because
      // WARN would be swallowed: the logger enum is ERROR=0, WARN=1, INFO=2,
      // DEBUG=3 and the filter skips only when `targetLevel < level`, so WARN
      // still prints at the default threshold.)
      this.ctx.logger.error('tavern: agent preset registration failed: %s', String(error))
    }
  }

  /** One preset-registration attempt per process; a rejection allows a retry. */
  private ensurePreset(): Promise<unknown> {
    this.presetAttempt ??= (async () => {
      const dispose = await ensureTavernPreset(this.ctx.agentPresets)
      try {
        // The registry hands back a definition disposer; it belongs to this
        // plugin's effect scope so a reload cannot collide with its own
        // previous registration of the same id.
        this.ctx.effect(() => dispose, 'tavern.agentPreset.registration')
      } catch (error: unknown) {
        // The fiber went inactive while `register()` was in flight, so the
        // effect was refused (INACTIVE_EFFECT) and nobody will ever dispose
        // this definition. The registry rejects a duplicate id, so leaving it
        // behind would make every later `register('tavern')` in this process
        // fail — permanently, for a plugin that is being unloaded anyway.
        await dispose().catch(() => {})
        throw error
      }
    })().catch((error: unknown) => {
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
   * Recover the library a pre-0.2 install kept in the settings document.
   *
   * Two sources, in order:
   *
   * 1. `<dsh home>/tavern/legacy-library.json` — a plain JSON copy in the
   *    database shape, for anyone who exported one before upgrading.
   * 2. The settings document itself, as `SettingsForms.importLegacyDocument`
   *    leaves it: `settings.yaml.imported` (renamed before the first write,
   *    so a partial import never repeats) or `settings.yaml` (a harness that
   *    has not imported yet). Its `tavern:` section is the library.
   *
   * Reading YAML needs a parser this package does not ship, so it is a
   * dynamic optional import: when `yaml` cannot be resolved the tavern still
   * starts, logs one actionable line, and the user can re-import their cards
   * through the TauriTavern importer instead.
   *
   * Never throws: a recovery failure must not keep the tavern from loading.
   * @returns the legacy library section, or undefined when there is none.
   */
  private async readLegacySettingsDocument(): Promise<LegacyLibrary | undefined> {
    const jsonPath = this.ctx.dshHomePath!('tavern', 'legacy-library.json')
    try {
      const text = await readFile(jsonPath, 'utf8')
      const recovered = legacyLibraryOf(JSON.parse(text))
      if (recovered !== undefined) {
        this.ctx.logger.info('tavern library: reading legacy library from %s', jsonPath)
      }
      return recovered
    } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') {
        this.ctx.logger.error('tavern library: cannot read %s: %s', jsonPath, String(error))
      }
    }

    const home = this.ctx.dshHomePath!()
    const candidates = ['settings.yaml.imported', 'settings.yaml']
    const existing: string[] = []
    for (const name of candidates) {
      const path = join(home, name)
      try {
        // A cheap existence probe: only read the (possibly 92 MB) document
        // when there is one.
        await stat(path)
        existing.push(path)
      } catch {
        // Not there.
      }
    }
    if (existing.length === 0) return undefined

    let parse: ((text: string) => unknown) | undefined
    try {
      // Non-literal specifier on purpose: `yaml` is not a declared dependency,
      // so a static import would fail at build time and at load time in most
      // profiles. When the harness's own install happens to expose it, the
      // upgrade install can still recover the old library automatically.
      const specifier = 'yaml'
      const mod = await import(specifier) as { parse?: (text: string) => unknown }
      parse = mod.parse
    } catch {
      parse = undefined
    }
    if (parse === undefined) {
      // INFO, not ERROR: a `settings.yaml` exists in every 0.1 install, whether
      // or not it ever held tavern data, so failing loud here would put a scary
      // line in front of users who lost nothing.
      this.ctx.logger.info(
        'tavern 0.2 upgrade: %s exists but no YAML parser is available, so a pre-0.2 tavern library '
        + '(if any) was not recovered. Re-import cards via 酒馆 → 导入, or write %s with '
        + '{"version":1,"characters":[…]} and restart.',
        existing.join(' / '),
        jsonPath,
      )
      return undefined
    }

    for (const path of existing) {
      try {
        const document = parse(await readFile(path, 'utf8'))
        if (typeof document !== 'object' || document === null) continue
        const section = legacyLibraryOf((document as Record<string, unknown>).tavern)
        if (section !== undefined) {
          this.ctx.logger.info('tavern library: legacy settings section found in %s', path)
          return section
        }
      } catch (error: unknown) {
        this.ctx.logger.error('tavern library: cannot parse %s: %s', path, String(error))
      }
    }
    return undefined
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
        // Optional dependency, probed per request: the host's credential and
        // Host/Origin fence. A profile without a connection service keeps the
        // plugin's own same-origin checks as its only fence (and the route is
        // then reachable only through the host's own loopback binding).
        authorize: (request) => {
          const connection = scoped.get('connection')
          if (connection === undefined) return undefined
          return connection.requestRejection({ headers: request.headers })
        },
      }, req, res),
    }), 'tavern.webServer.route')
  })

  // NOTE: `tavern_speak` is deliberately NOT registered here. From a plain
  // plugin context `ctx.tools.register` registers GLOBALLY, putting the tool in
  // every DSH session's toolset — including ordinary coding sessions that can
  // never use it. It is registered per multi-agent director from the agent
  // scope instead (see TavernSessionRuntime.sessionSetup).
}
