// CI guard for the two module-boundary invariants that `scripts/verify/plugin.mjs`
// can only check when a local `@deepseek-ai` tree is linked.
//
//   1. The host bundle must not import `@deepseek-ai/*` at runtime. An out-of-tree
//      plugin is installed into a profile that cannot resolve the host's own
//      packages, so a single runtime import makes the whole plugin fail to load.
//      (`import type` is erased at build time, so any remaining specifier is real.)
//   2. The browser bundle reaches the platform modules through the host module
//      table only. A specifier outside that table cannot be resolved in the page.
//
// Run after `npm run build`: `node scripts/ci/check-host-bundle.mjs`.
import { readFileSync } from 'node:fs'

const HOST_BUNDLE = new URL('../../lib/index.js', import.meta.url)
const CLIENT_BUNDLE = new URL('../../lib/client.js', import.meta.url)
/** Modules the host puts on the browser module table (see src/client/vendor.d.ts). */
const CLIENT_ALLOWED = new Set([
	'react',
	'react/jsx-runtime',
	'react-dom',
	'react-dom/client',
	'@deepseek-ai/dsh-client-store',
])
/**
 * Optional dynamic imports the host bundle is allowed to attempt. `yaml` is
 * imported inside try/catch on purpose (see `src/index.ts`): it is not a declared
 * dependency, and a missing one only skips the pre-0.2 library recovery.
 */
const HOST_OPTIONAL = new Set(['yaml'])

const failures = []
const check = (name, ok, detail = '') => {
	if (!ok) failures.push(`${name}${detail ? `\n    ${detail}` : ''}`)
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? ` — ${detail}` : ''}`)
}

const host = readFileSync(HOST_BUNDLE, 'utf8')
const client = readFileSync(CLIENT_BUNDLE, 'utf8')

const hostSpecifiers = [...host.matchAll(/^import\s+(?:[^'";]*?\s+from\s+)?["']([^"']+)["'];?$/gm)].map(m => m[1])
check('host bundle has static imports', hostSpecifiers.length > 0, `found ${hostSpecifiers.length}`)

const hostHostImports = hostSpecifiers.filter(specifier => !specifier.startsWith('node:'))
check(
	'host bundle imports only node: built-ins',
	hostHostImports.length === 0,
	hostHostImports.join(', '),
)

const hostDynamic = [...host.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)].map(m => m[1])
const hostDynamicUnexpected = hostDynamic.filter(
	specifier => !specifier.startsWith('node:') && !HOST_OPTIONAL.has(specifier),
)
check(
	'host bundle dynamic imports are node: built-ins or the optional `yaml`',
	hostDynamicUnexpected.length === 0,
	hostDynamicUnexpected.join(', '),
)

const clientSpecifiers = [...client.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)].map(m => m[1])
const clientUnknown = clientSpecifiers.filter(specifier => !CLIENT_ALLOWED.has(specifier))
check(
	'client bundle requires only host module-table modules',
	clientUnknown.length === 0,
	clientUnknown.join(', '),
)

if (failures.length > 0) {
	console.error(`\n${failures.length} module-boundary check(s) failed:\n${failures.map(f => `  - ${f}`).join('\n')}`)
	process.exit(1)
}
console.log('\nmodule boundaries intact')
