// Verification of the cordis plugin lifecycle: readiness gating, route
// wiring, optional dependencies, and disposal.
//
// This runs the BUILT artifact (lib/index.js) inside a real cordis root
// context, so it also guards the constraint that the host half must not
// import @deepseek-ai at runtime — an out-of-tree plugin cannot resolve it.
// Run with `npm run verify` (build first).
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
// The host's OWN row validator, so the preset declaration is checked against
// the same rules the loader applies rather than against our expectations of
// them. This is a dev-only script; the shipped host bundle imports nothing
// from @deepseek-ai at runtime (asserted below).
import { entryListProblem } from '@deepseek-ai/dsh-agent-preset-registry'
import { TAVERN_PRESET_DEFINITION } from '../../src/tavern-preset.ts'

const log = []
const check = (name, ok, extra = '') => {
  log.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`)
  if (!ok) process.exitCode = 1
}

// ── the artifact must not import @deepseek-ai at runtime ──
{
  const source = readFileSync('lib/index.js', 'utf8')
  const imports = [...source.matchAll(/^\s*import\s[^\n]*from\s*['"]([^'"]+)['"]/gm)].map(m => m[1])
  const dsh = imports.filter(id => id.startsWith('@deepseek-ai'))
  check('built host bundle imports no @deepseek-ai package', dsh.length === 0, dsh.join(' '))
  check('built host bundle imports only node: builtins',
    imports.every(id => id.startsWith('node:')), imports.filter(i => !i.startsWith('node:')).join(' '))
}

const plugin = await import('../../lib/index.js')

/** Minimal stand-ins for the DSH services the plugin injects. */
function makeStubs(home) {
  const routes = new Map()
  const presetRegistrations = []
  return {
    routes,
    presetRegistrations,
    values: {
      dshHomePath: (...segments) => join(home, ...segments),
      webServer: {
        register: (route) => {
          if (routes.has(route.path)) throw new Error(`duplicate route ${route.path}`)
          routes.set(route.path, route)
          return () => routes.delete(route.path)
        },
      },
      // 0.2.2-alpha.3 contract: a preset is a registered DECLARATION, not a
      // file under `$DSH_HOME/.agent-presets`. The registry returns a disposer.
      agentPresets: {
        register: async (definition) => {
          presetRegistrations.push(definition)
          return async () => {}
        },
        mount: async () => {},
      },
      agents: { create: async () => {}, resume: async () => {} },
      agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
      tools: { register: () => () => {} },
      // 0.2.2-alpha.3 contract: a stored session is addressed through a handle.
      // `inspect()` no longer exists (the old stub implemented it, which is how
      // the plugin could look healthy against a host that had already dropped
      // the API).
      sessionPersistence: {
        open: async () => {
          // The error NAME is part of the contract: the runtime distinguishes
          // "this session was never stored" (create a fresh one) from "stored
          // but unreadable" (assume it exists and resume) by that name.
          const error = new Error('not persisted')
          error.name = 'SessionPersistenceNotFoundError'
          throw error
        },
      },
    },
  }
}

/** Build a root context with the given services provided. */
function makeRoot(stubs, omit = []) {
  const root = new Context()
  for (const [name, value] of Object.entries(stubs.values)) {
    if (omit.includes(name)) continue
    root.provide(name, value)
  }
  return root
}

// ── readiness gating ──
{
  const home = mkdtempSync(join(tmpdir(), 'tavplug-'))
  const stubs = makeStubs(home)
  const root = makeRoot(stubs)

  const fiber = root.plugin(plugin)
  // The plugin body is async, so cordis has not activated the fiber yet.
  check('service is invisible before the bootstrap finishes',
    root.get('tavern') === undefined)
  check('route is not registered before the bootstrap finishes',
    stubs.routes.size === 0, `routes=${stubs.routes.size}`)

  await fiber

  check('service resolves once the fiber is active', root.get('tavern') !== undefined)
  check('route is registered after readiness', stubs.routes.has('/tavern'))
  check('route is a prefix route', stubs.routes.get('/tavern')?.kind === 'prefix')
  // The injected-service list is the contract with the host. `settings` was a
  // key/value store in DSH 0.1; in 0.2.2-alpha.3 it is `SettingsForms`, which
  // registers nothing for a caller-named namespace, so injecting it would keep
  // the plugin PENDING forever on a host that no longer provides that shape.
  check('does not inject the removed settings KV service',
    !Array.isArray(plugin.inject) || !plugin.inject.includes('settings'),
    Array.isArray(plugin.inject) ? plugin.inject.join(',') : 'no inject')
  check('registers the tavern agent preset once',
    stubs.presetRegistrations.length === 1
      && stubs.presetRegistrations[0]?.id === 'tavern',
    JSON.stringify(stubs.presetRegistrations.map(p => p.id)))
  check('the registered preset mounts no tools',
    (stubs.presetRegistrations[0]?.plugins ?? []).every(row => !String(row.name).startsWith('@deepseek-ai/dsh-tool-')),
    JSON.stringify(stubs.presetRegistrations[0]?.plugins ?? []))
  // Validated by the host's own `entryListProblem`, not by us: a row name the
  // host cannot resolve, or a malformed group, must fail here rather than at
  // the first play session's mount.
  check('the preset declaration passes the host row validator',
    entryListProblem(TAVERN_PRESET_DEFINITION.plugins) === undefined,
    String(entryListProblem(TAVERN_PRESET_DEFINITION.plugins)))

  const tavern = root.get('tavern')
  check('library loaded and readable', Array.isArray(tavern.listCharacters()))
  check('config defaults applied', tavern.config.maxSwipeVariants === 12
    && tavern.config.scanMessages === 12
    && tavern.config.speakTimeoutMs === 120000)
  check('preferences start absent beside the library',
    !existsSync(join(home, 'tavern', 'prefs.json')))
  await tavern.storage.setStyle('classic')
  check('preferences persist beside the library',
    JSON.parse(readFileSync(join(home, 'tavern', 'prefs.json'), 'utf8')).style === 'classic')

  await fiber.dispose()
  check('route removed on dispose', !stubs.routes.has('/tavern'), `routes=${stubs.routes.size}`)
  check('service unregistered on dispose', root.get('tavern') === undefined)
  rmSync(home, { recursive: true, force: true })
}

// ── optional dependency: workspaceRegistry is never provided above ──
{
  const home = mkdtempSync(join(tmpdir(), 'tavplug-'))
  const stubs = makeStubs(home)
  const root = makeRoot(stubs)
  const fiber = root.plugin(plugin)
  await fiber
  check('loads without workspaceRegistry (optional dependency)',
    root.get('tavern') !== undefined && stubs.routes.has('/tavern'))
  await fiber.dispose()
  rmSync(home, { recursive: true, force: true })
}

// ── a genuinely required dependency keeps the plugin pending ──
{
  const home = mkdtempSync(join(tmpdir(), 'tavplug-'))
  const stubs = makeStubs(home)
  const root = makeRoot(stubs, ['agentPresets'])
  root.plugin(plugin)
  // Give cordis a few microtasks to settle; a pending fiber never activates.
  await new Promise(resolve => setImmediate(resolve))
  check('stays pending while a required service is missing',
    root.get('tavern') === undefined && stubs.routes.size === 0)
  rmSync(home, { recursive: true, force: true })
}

// ── plugin config flows from the loader row ──
{
  const home = mkdtempSync(join(tmpdir(), 'tavplug-'))
  const stubs = makeStubs(home)
  const root = makeRoot(stubs)
  const fiber = root.plugin(plugin, {
    maxSwipeVariants: 3,
    scanMessages: 40,
    allowedHosts: ['Tavern.Example '],
    speakTimeoutMs: 5000,
  })
  await fiber
  const config = root.get('tavern').config
  check('config from the loader row is applied',
    config.maxSwipeVariants === 3 && config.scanMessages === 40 && config.speakTimeoutMs === 5000,
    JSON.stringify(config))
  check('allowedHosts are trimmed and lowercased',
    config.allowedHosts.join() === 'tavern.example', config.allowedHosts.join())
  check('unspecified fields keep their defaults', config.worldInfoBudgetChars === 8000)
  await fiber.dispose()
  rmSync(home, { recursive: true, force: true })
}

// ── out-of-range config values fall back instead of refusing to start ──
{
  const home = mkdtempSync(join(tmpdir(), 'tavplug-'))
  const stubs = makeStubs(home)
  const root = makeRoot(stubs)
  const fiber = root.plugin(plugin, { maxSwipeVariants: -5, scanMessages: 'lots' })
  await fiber
  const config = root.get('tavern').config
  check('out-of-range / wrong-typed config falls back to defaults',
    config.maxSwipeVariants === 12 && config.scanMessages === 12)
  await fiber.dispose()
  rmSync(home, { recursive: true, force: true })
}

console.log(log.join('\n'))
