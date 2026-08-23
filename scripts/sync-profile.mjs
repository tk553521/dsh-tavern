/**
 * Sync the built `lib/` into the bundle copy `dsh web` actually loads.
 *
 * The plugin installs as a dsh bundle: the running GUI serves
 * `$DSH_HOME/profiles/<profile>/node_modules/dsh-tavern/lib/`, a snapshot
 * taken at install time. Building in the workspace leaves the served copy
 * stale, so GUI changes silently never appear until something re-syncs it.
 * This script copies the fresh build over that copy; it tolerates the copy
 * being missing (fresh machine / different install layout) with a warning
 * instead of failing the build.
 *
 * Override the target with DSH_TAVERN_PROFILE=web to pick another profile.
 */
import { cpSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const home = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh')
const profile = process.env.DSH_TAVERN_PROFILE ?? 'web'
const target = join(home, 'profiles', profile, 'node_modules', 'dsh-tavern')

if (!existsSync(target)) {
  console.warn(`[dsh-tavern] profile copy not found at ${target}; skipping sync`)
  process.exit(0)
}

cpSync('lib', join(target, 'lib'), { recursive: true, force: true })
console.log(`[dsh-tavern] synced lib/ -> ${target}/lib`)
