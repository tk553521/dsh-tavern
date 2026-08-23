/**
 * The tavern agent preset: the composition the tavern session runtime mounts
 * for every play session (director and character agents).
 *
 * The preset deliberately mounts NO tools. A play session's system prompt is
 * a `complete` persona section assembled from imported character cards, i.e.
 * fully attacker-controlled text whenever a user imports a card from the
 * internet. Handing that prompt a shell and a filesystem editor turns "import
 * a cute character card" into arbitrary command execution on the user's
 * machine, so the roleplay agents get the persona slot and nothing else.
 *
 * Why a custom preset instead of the shipped `minimal` one: minimal disables
 * dynamic runtime-context snapshots (`includeRuntimeContext: false`), which
 * would also suppress the world-book context the tavern injects. This preset
 * exists purely to keep that one setting on.
 *
 * The preset's persona row is a fallback only: the tavern setup registers the
 * play's own system prompt into the same `deployment:persona` slot on the
 * agent scope, which shadows the preset persona (nearest scope wins), so the
 * model always sees the character-card composition instead of this text.
 *
 * The preset is authored into the harness-home user root (`.agent-presets`),
 * the same place a person or an agent would author a preset by hand. Writing
 * is non-clobbering with one exception: a file whose bytes still match a
 * composition THIS plugin shipped earlier is ours, not the user's, and is
 * upgraded in place — that is how the tool-granting legacy composition gets
 * retired from installs that already have it on disk.
 */

import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'

/** Preset id (directory name) under the user preset root. */
export const TAVERN_PRESET_ID = 'tavern'

/** Composition file: the persona slot only, no tool rows. */
export const TAVERN_PRESET_COMPOSITION = `# The tavern agent preset: persona slot only, runtime-context injection enabled.
#
# Managed by dsh-tavern (written once when missing). Edit freely: the plugin
# mounts this preset as it stands and never overwrites your edits.
#
# NO TOOLS ARE MOUNTED HERE, on purpose. A tavern session's system prompt is
# assembled from imported character cards — untrusted third-party text. Adding
# a shell or filesystem row below would let a malicious card run commands on
# this machine. Add tools only if you understand and accept that.
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
`

/**
 * Compositions this plugin shipped in earlier versions. A file matching one of
 * these byte-for-byte was written by us and never touched by the user, so it
 * is safe — and necessary — to replace.
 *
 * The v0.1 composition mirrored `minimal`'s tool rows (persistent bash + local
 * filesystem + editor). Those rows were copied over incidentally, purely to
 * follow minimal's shape; the tavern never used them, while they handed every
 * imported character card a shell.
 */
const LEGACY_COMPOSITIONS: readonly string[] = [
  `# The tavern agent preset: minimal-like, runtime-context injection enabled.
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
`,
]

/** Display metadata beside the composition. */
export const TAVERN_PRESET_METADATA = `name: 酒馆极简模式
description: 酒馆角色扮演专用预设（仅人格槽位、不挂载任何工具），开启动态上下文注入。
order: 4
`

/** Metadata files shipped by earlier versions (see {@link LEGACY_COMPOSITIONS}). */
const LEGACY_METADATA: readonly string[] = [
  `name: 酒馆极简模式
description: 酒馆角色扮演专用极简预设（持久 bash + 编辑器），开启动态上下文注入。
order: 4
`,
]

/** What {@link ensurePresetFile} did to one file. */
type EnsureOutcome = 'created' | 'upgraded' | 'repaired' | 'kept'

/** The preset directory under the harness home. */
function presetDirectory(home: (...segments: string[]) => string): string {
  return home('.agent-presets', TAVERN_PRESET_ID)
}

/**
 * Line-ending-insensitive comparison. The plugin always writes LF, but an
 * editor or a checkout can rewrite the file to CRLF without the user having
 * changed a single character — that must still count as "ours".
 */
function sameText(a: string, b: string): boolean {
  return a.replace(/\r\n/g, '\n') === b.replace(/\r\n/g, '\n')
}

/**
 * Write one file so a reader only ever observes the complete old content or
 * the complete new content.
 *
 * `open(path, 'wx')` makes only the CREATE atomic, not the write: between the
 * create and the write the file is observably empty, and a concurrent caller
 * that got EEXIST there would conclude the preset is ready and mount a
 * zero-byte composition. Writing a temp file and renaming closes that window.
 * @param path - the final path.
 * @param content - the complete file content.
 */
async function writeAtomic(path: string, content: string): Promise<void> {
  const temp = `${path}.${randomUUID().slice(0, 8)}.tmp`
  const handle = await open(temp, 'wx')
  try {
    await handle.writeFile(content, 'utf8')
  } finally {
    await handle.close()
  }
  try {
    // rename(2) replaces an existing target on POSIX, and libuv asks for
    // MOVEFILE_REPLACE_EXISTING on win32, so this is a true swap on both.
    await rename(temp, path)
  } catch (error: unknown) {
    await rm(temp, { force: true }).catch(() => {})
    throw error
  }
}

/**
 * Bring one preset file to its intended content without clobbering user edits.
 * @param path - the file to author.
 * @param content - the content this version ships.
 * @param legacy - contents shipped by earlier versions, safe to replace.
 * @returns what happened, for the caller's log line.
 */
async function ensurePresetFile(
  path: string,
  content: string,
  legacy: readonly string[],
): Promise<EnsureOutcome> {
  let existing: string | undefined
  try {
    existing = await readFile(path, 'utf8')
  } catch (error: unknown) {
    // Anything other than "not there" — a permission problem, a directory in
    // the way — is a real failure the caller must see.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (existing === undefined) {
    await writeAtomic(path, content)
    return 'created'
  }
  // A zero-byte file is the fingerprint of an interrupted legacy write (the
  // old non-atomic path could leave one behind permanently, because every
  // later run saw EEXIST and returned "ready"). Repair it.
  if (existing.trim() === '') {
    await writeAtomic(path, content)
    return 'repaired'
  }
  if (sameText(existing, content)) return 'kept'
  if (legacy.some(candidate => sameText(existing, candidate))) {
    await writeAtomic(path, content)
    return 'upgraded'
  }
  // Genuinely user-edited: leave it exactly as it stands.
  return 'kept'
}

/** Outcome of one {@link ensureTavernPreset} run, for the caller's log. */
export interface EnsurePresetReport {
  composition: EnsureOutcome
  metadata: EnsureOutcome
}

/**
 * Author the tavern preset into the harness-home user root. Idempotent; user
 * edits survive, but a composition still byte-identical to one this plugin
 * shipped earlier is upgraded (that is how the tool-granting legacy preset is
 * retired from existing installs).
 * @param home - the harness home path resolver (ctx.dshHomePath).
 * @returns what happened to each file.
 */
export async function ensureTavernPreset(
  home: (...segments: string[]) => string,
): Promise<EnsurePresetReport> {
  const dir = presetDirectory(home)
  await mkdir(dir, { recursive: true })
  const composition = await ensurePresetFile(
    join(dir, 'agent.cordis.yml'),
    TAVERN_PRESET_COMPOSITION,
    LEGACY_COMPOSITIONS,
  )
  const metadata = await ensurePresetFile(
    join(dir, 'preset.yml'),
    TAVERN_PRESET_METADATA,
    LEGACY_METADATA,
  )
  return { composition, metadata }
}

/**
 * Whether a usable tavern preset already exists on disk.
 * @param home - the harness home path resolver (ctx.dshHomePath).
 * @returns true when both preset files are present and non-empty. A zero-byte
 * file reads as absent: that is exactly the broken state a probe must report,
 * not hide.
 */
export async function tavernPresetExists(home: (...segments: string[]) => string): Promise<boolean> {
  try {
    const dir = presetDirectory(home)
    const composition = await readFile(join(dir, 'agent.cordis.yml'), 'utf8')
    const metadata = await readFile(join(dir, 'preset.yml'), 'utf8')
    return composition.trim() !== '' && metadata.trim() !== ''
  } catch {
    return false
  }
}
