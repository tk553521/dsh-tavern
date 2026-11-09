/**
 * Plugin configuration for dsh-tavern.
 *
 * These values were previously module constants and one environment variable,
 * scattered across `play.ts`, `lorebook.ts` and `api.ts`. Cordis reads a
 * plugin's `Config` (a Standard Schema) and validates the loader row's
 * `config:` block against it before the plugin starts
 * (`cordis/src/fiber.ts:50-62`), so this is the framework's own place for
 * them — one declaration, one set of defaults, tunable from the config tree
 * without editing source.
 *
 * The schema is hand-rolled rather than built with schemastery: an
 * out-of-tree plugin cannot resolve `@deepseek-ai/*` at runtime (the
 * installed profile has no top-level `@deepseek-ai`), and `@standard-schema/spec`
 * is likewise not a direct dependency, so the Standard Schema shape is
 * satisfied structurally. Cordis only ever touches `['~standard'].validate`.
 */

/** Tunables for one tavern plugin instance. */
export interface TavernConfig {
  /**
   * Extra `Host` header values accepted for mutating HTTP requests, on top of
   * loopback addresses and `localhost`. Needed only when the DSH web UI is
   * reached through a real hostname; see the DNS-rebinding note in api.ts.
   */
  allowedHosts: string[]
  /**
   * Stored retry attempts per fork point. Every variant is a full session
   * event tail on disk, so this bounds what holding down 重试 can grow to.
   */
  maxSwipeVariants: number
  /** Ceiling on rendered world-info characters per assembly. */
  worldInfoBudgetChars: number
  /** How many recent chat lines the world-book scanner reads. */
  scanMessages: number
  /** How long one `tavern_speak` call waits for its character agent. */
  speakTimeoutMs: number
}

/** The defaults, matching the constants these values replaced. */
export const DEFAULT_CONFIG: Readonly<TavernConfig> = Object.freeze({
  allowedHosts: [],
  maxSwipeVariants: 12,
  worldInfoBudgetChars: 8000,
  scanMessages: 12,
  speakTimeoutMs: 120_000,
})

/** Extra allowed hosts may also come from the environment (pre-config escape hatch). */
const HOST_ALLOW_ENV = 'DSH_TAVERN_ALLOWED_HOSTS'

/** Read a bounded positive integer, falling back when absent or out of range. */
function boundedInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  const rounded = Math.trunc(value)
  if (rounded < min || rounded > max) return fallback
  return rounded
}

/** Read a string list, dropping blanks and lowercasing (host names are case-insensitive). */
function hostList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((entry): entry is string => typeof entry === 'string')
    .map(entry => entry.trim().toLowerCase())
    .filter(entry => entry !== '')
}

/**
 * Normalize a loader-supplied config block.
 *
 * Permissive by design, like the settings schema: an unknown or malformed
 * field falls back to its default rather than refusing to start the plugin.
 * Only a non-object config is rejected outright, because that indicates the
 * config tree is wired wrong rather than merely stale.
 * @param input - the raw `config:` block, or undefined when the row has none.
 * @returns a fully populated config.
 */
export function normalizeConfig(input: unknown): TavernConfig {
  if (input === undefined || input === null) input = {}
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('酒馆插件配置必须是对象')
  }
  const raw = input as Partial<Record<keyof TavernConfig, unknown>>
  // The environment variable predates this schema; keep honoring it so an
  // existing deployment does not silently lose its host allowlist.
  const fromEnv = (process.env[HOST_ALLOW_ENV] ?? '')
    .split(',')
    .map(entry => entry.trim().toLowerCase())
    .filter(entry => entry !== '')
  return {
    allowedHosts: [...new Set([...hostList(raw.allowedHosts), ...fromEnv])],
    maxSwipeVariants: boundedInt(raw.maxSwipeVariants, DEFAULT_CONFIG.maxSwipeVariants, 1, 200),
    worldInfoBudgetChars: boundedInt(raw.worldInfoBudgetChars, DEFAULT_CONFIG.worldInfoBudgetChars, 200, 200_000),
    scanMessages: boundedInt(raw.scanMessages, DEFAULT_CONFIG.scanMessages, 1, 500),
    speakTimeoutMs: boundedInt(raw.speakTimeoutMs, DEFAULT_CONFIG.speakTimeoutMs, 1_000, 600_000),
  }
}

/**
 * The Standard Schema cordis validates the loader row against.
 *
 * Shape only — `@standard-schema/spec` is not a dependency, and cordis reads
 * nothing but `['~standard'].validate` (`cordis/src/fiber.ts:53`).
 */
export const Config = {
  '~standard': {
    version: 1 as const,
    vendor: 'dsh-tavern',
    validate: (value: unknown): { value: TavernConfig } | { issues: { message: string }[] } => {
      try {
        return { value: normalizeConfig(value) }
      } catch (error: unknown) {
        return { issues: [{ message: error instanceof Error ? error.message : String(error) }] }
      }
    },
  },
}
