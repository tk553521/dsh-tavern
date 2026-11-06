/**
 * The tavern agent preset: the composition the tavern session runtime mounts
 * for every play session (director and character agents).
 *
 * The preset deliberately mounts NO tools. A play session's system prompt is a
 * `complete` section assembled from imported character cards, i.e. fully
 * attacker-controlled text whenever a user imports a card from the internet.
 * Handing that prompt a shell and a filesystem editor turns "import a cute
 * character card" into arbitrary command execution on the user's machine, so
 * the roleplay agents get the persona slot and nothing else.
 *
 * ## How the preset reaches the host (changed in DSH 0.2)
 *
 * This used to write `$DSH_HOME/.agent-presets/<id>/{agent.cordis.yml,preset.yml}`
 * and let the harness discover it on the next boot. Nothing in 0.2.2-alpha.3
 * reads that directory any more — a preset is a *declaration*, registered by a
 * plugin through `ctx.agentPresets.register(definition)` (`AgentPresetRegistry`,
 * `lib/types/index.d.ts`). The old files are still repaired by nothing and read
 * by nothing, so writing them now would only leave litter in the user's home;
 * the definition below is the source of truth and is registered at plugin load.
 *
 * ## Why the persona row carries no text
 *
 * Two independent reasons, both of which break every play session otherwise:
 *
 * 1. `@deepseek-ai/dsh-persona` declares `prefix` (required), `suffix`,
 *    `complete`, `includeRuntimeContext`. There is no `text` key. An unknown
 *    key fails the row's config validation, the whole mount fails, and every
 *    tavern session silently runs without its preset.
 * 2. The tavern runtime registers the play's own prompt as the session's ONE
 *    `complete` section. `dsh-system-prompt` refuses to assemble a prompt with
 *    more than one active `complete` section, so a preset row that also marks
 *    itself `complete` makes assembly throw for every turn.
 *
 * An empty `prefix` still shadows the deployment persona for this agent, so a
 * tavern session never inherits the host's generic persona, and an empty
 * section is dropped at render. `includeRuntimeContext: true` is the one
 * setting that has to stay on: it keeps dynamic context injection (the world
 * book) flowing into tavern sessions.
 */

import type { AgentPresetRegistry, PresetDefinition } from '@deepseek-ai/dsh-agent-preset-registry'

/** Preset id (identity shown in the harness preset roster). */
export const TAVERN_PRESET_ID = 'tavern'

/**
 * The preset declaration.
 *
 * `plugins` is the same row shape a profile patch uses, so a user who wants to
 * change the tavern composition can copy it into their own preset instead; the
 * plugin only ever registers this id.
 */
export const TAVERN_PRESET_DEFINITION: PresetDefinition = {
  id: TAVERN_PRESET_ID,
  name: '酒馆极简模式',
  description: '酒馆角色扮演专用预设（不挂载任何工具，只保留动态上下文注入）。',
  order: 4,
  plugins: [{
    name: '@deepseek-ai/dsh-persona',
    config: {
      prefix: '',
      complete: false,
      includeRuntimeContext: true,
    },
  }],
}

/**
 * Register the tavern preset with the host registry.
 *
 * Idempotent per process from the caller's point of view: the caller memoizes
 * one attempt and retries only after a rejection. The returned disposer
 * unregisters the definition, and belongs to its caller's effect scope.
 * @param registry - the host's preset registry (`ctx.agentPresets`).
 * @returns the disposer that removes the definition again.
 */
export async function ensureTavernPreset(
  registry: AgentPresetRegistry,
): Promise<() => Promise<void>> {
  return registry.register(TAVERN_PRESET_DEFINITION)
}
