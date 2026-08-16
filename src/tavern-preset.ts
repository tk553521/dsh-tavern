/**
 * The tavern agent preset: a minimal-like composition the tavern session
 * runtime mounts for every play session (director and character agents).
 *
 * Why a custom preset instead of the shipped `minimal` one: minimal disables
 * dynamic runtime-context snapshots (`includeRuntimeContext: false`), which
 * would also suppress the world-book context the tavern injects. This preset
 * mirrors minimal's lean tool composition (persistent bash + editor) but
 * keeps runtime-context injection on.
 *
 * The preset's persona row is a fallback only: the tavern setup registers the
 * play's own system prompt into the same `deployment:persona` slot on the
 * agent scope, which shadows the preset persona (nearest scope wins), so the
 * model always sees the character-card composition instead of this text.
 *
 * The preset is authored into the harness-home user root (`.agent-presets`),
 * the same place a person or an agent would author a preset by hand. Writing
 * is non-clobbering: an existing `tavern` preset — the user's own edits
 * included — is left untouched and mounted as it stands.
 */

import { mkdir, open, readFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Preset id (directory name) under the user preset root. */
export const TAVERN_PRESET_ID = 'tavern'

/** Composition file, mirroring the shipped `minimal` preset. */
export const TAVERN_PRESET_COMPOSITION = `# The tavern agent preset: minimal-like, runtime-context injection enabled.
#
# Managed by dsh-tavern (written once when missing). Edit freely: the plugin
# mounts this preset as it stands and never overwrites user edits.
#
# Differs from the shipped \`minimal\` preset in exactly one setting:
# \`includeRuntimeContext: true\` keeps dynamic context injection (the world
# book) flowing into tavern sessions.
#
# The persona row below is a fallback: the tavern setup registers the play's
# own system prompt (character cards etc.) into the \`deployment:persona\` slot
# on the agent scope, which shadows this row's section.
- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    text: You are a helpful assistant.
    complete: true
    includeRuntimeContext: true

# The PTY registry is an agent-owned service, so it lives in an entry-local
# realm. The backend still consumes the host sandbox policy and subprocess
# implementation, while the tool registers into this agent's scoped catalog.
- id: persistent-shell
  name: cordis:group
  group: true
  isolate:
    terminals: true
  config:
    - id: pty
      name: '@deepseek-ai/dsh-terminal'

    - id: terminal-bash
      name: '@deepseek-ai/dsh-terminal-bash'
      config:
        timeoutMs: 300000

    - id: persistent-bash
      name: '@deepseek-ai/dsh-tool-bash-persistent'
      config:
        timeoutMs: 300000
        description: |-
          Run commands in a bash shell
          * When invoking this tool, the contents of the "command" parameter does NOT need to be XML-escaped.
          * You don't have access to the internet via this tool.
          * You do have access to a mirror of common linux and python packages via apt and pip.
          * State is persistent across command calls and discussions with the user.
          * To inspect a particular line range of a file, e.g. lines 10-25, try 'sed -n 10,25p /path/to/the/file'.
          * Please avoid commands that may produce a very large amount of output.
          * Please run long lived commands in the background, e.g. 'sleep 10 &' or start a server in the background.

# The bare local filesystem shadows the host's sandboxed provider only for this
# preset. The editor shares that realm and requires absolute paths.
- id: filesystem
  name: cordis:group
  group: true
  isolate:
    fs: true
  config:
    - id: fs-local
      name: '@deepseek-ai/dsh-fs-local'
      config:
        cwd: !!js process.env.DSH_CWD ?? process.cwd()

    - id: str-replace-editor
      name: '@deepseek-ai/dsh-tool-str-replace-editor'
      config:
        maxOutputChars: 16000
`

/** Display metadata beside the composition. */
export const TAVERN_PRESET_METADATA = `name: 酒馆极简模式
description: 酒馆角色扮演专用极简预设（持久 bash + 编辑器），开启动态上下文注入。
order: 4
`

/** The preset directory under the harness home. */
function presetDirectory(home: (...segments: string[]) => string): string {
  return home('.agent-presets', TAVERN_PRESET_ID)
}

/**
 * Write one preset file when it does not already exist.
 * @param path - target file.
 * @param content - the file content to write.
 */
async function writeIfMissing(path: string, content: string): Promise<void> {
  let handle
  try {
    handle = await open(path, 'wx')
  } catch (error) {
    // EEXIST is the normal case after the first run: the preset is already
    // there (ours or the user's own) and must be left alone. Any other
    // failure — permissions, a directory in the way — propagates.
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return
    throw error
  }
  try {
    await handle.writeFile(content, 'utf8')
  } finally {
    await handle.close()
  }
}

/**
 * Author the tavern preset into the harness-home user root. Idempotent and
 * non-clobbering: existing files are never rewritten.
 * @param home - the harness home path resolver (ctx.dshHomePath).
 */
export async function ensureTavernPreset(home: (...segments: string[]) => string): Promise<void> {
  const dir = presetDirectory(home)
  await mkdir(dir, { recursive: true })
  await writeIfMissing(join(dir, 'agent.cordis.yml'), TAVERN_PRESET_COMPOSITION)
  await writeIfMissing(join(dir, 'preset.yml'), TAVERN_PRESET_METADATA)
}

/**
 * Whether a persisted tavern preset already exists on disk (used to decide
 * whether the roster will resolve it without authoring first).
 * @param home - the harness home path resolver (ctx.dshHomePath).
 * @returns true when both preset files are present.
 */
export async function tavernPresetExists(home: (...segments: string[]) => string): Promise<boolean> {
  try {
    const dir = presetDirectory(home)
    await readFile(join(dir, 'agent.cordis.yml'), 'utf8')
    await readFile(join(dir, 'preset.yml'), 'utf8')
    return true
  } catch {
    return false
  }
}
