// Verification of the cordis plugin lifecycle: readiness gating, route
// wiring, optional dependencies, and disposal.
//
// This runs the BUILT artifact (lib/index.js) inside a real cordis root
// context, so it also guards the constraint that the host half must not
// import @deepseek-ai at runtime — an out-of-tree plugin cannot resolve it.
// Run with `npm run verify` (build first).
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'

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
  let section = { version: 1, characters: [], lorebooks: [], presets: [], plays: [], branches: [] }
  return {
    routes,
    getSection: () => section,
    values: {
      dshHomePath: (...segments) => join(home, ...segments),
      webServer: {
        register: (route) => {
          if (routes.has(route.path)) throw new Error(`duplicate route ${route.path}`)
          routes.set(route.path, route)
          return () => routes.delete(route.path)
        },
      },
      settings: {
        register: () => ({
          get: () => section,
          update: async (patch) => { section = { ...section, ...patch } },
          replace: async (next) => { section = next },
        }),
      },
      agents: { create: async () => {}, resume: async () => {} },
      agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
      tools: { register: () => () => {} },
      agentPresets: { mount: async () => {} },
      sessionPersistence: { inspect: async () => { throw new Error('not persisted') } },
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

  const tavern = root.get('tavern')
  check('library loaded and readable', Array.isArray(tavern.listCharacters()))
  check('config defaults applied', tavern.config.maxSwipeVariants === 12
    && tavern.config.scanMessages === 12
    && tavern.config.speakTimeoutMs === 120000)

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
