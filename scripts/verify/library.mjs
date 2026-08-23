// Verification of the library file store + settings migration.
// Run with `npm run verify` (needs Node >= 23.6 for native TypeScript).
import { mkdtempSync, rmSync, readdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LibraryStore, migrateLegacyLibrary } from '../../src/library.ts'
import { TavernStorage, emptyDatabase, EMPTY_DATABASE, newId, nowIso } from '../../src/storage.ts'

const log = []
const check = (name, ok, extra = '') => {
  log.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' 鈥?' + extra : ''}`)
  if (!ok) process.exitCode = 1
}
const quiet = { warn: () => {}, info: () => {} }
const warnings = []
const noisy = { warn: m => warnings.push(m), info: () => {} }

const root = mkdtempSync(join(tmpdir(), 'tavlib-'))
const card = (id, name) => ({
  id, source: 'test', createdAt: nowIso(), updatedAt: nowIso(),
  card: { spec: 'chara_card_v2', spec_version: '2.0', data: { name, description: 'd', personality: '', scenario: '', first_mes: 'hi', mes_example: '', creator_notes: '', system_prompt: '', post_history_instructions: '', alternate_greetings: [], tags: [], creator: '', character_version: '', extensions: {} } },
})
const book = (id, name) => ({ id, name, createdAt: nowIso(), updatedAt: nowIso(), book: { entries: [] } })
const preset = (id, name) => ({ id, name, createdAt: nowIso(), updatedAt: nowIso() })
const play = (id, characterIds, presetId) => ({
  id, title: 't', characterIds, narratorEnabled: false, multiAgent: true,
  sessionId: 'tavern-x', createdAt: nowIso(), updatedAt: nowIso(),
  ...(presetId ? { presetId } : {}),
})

// 鈹€鈹€ 1. round trip through disk 鈹€鈹€
{
  const dir = join(root, 'roundtrip')
  const a = await LibraryStore.open(dir, quiet)
  await a.putCharacter(card('char-1', 'Alice'))
  await a.putLorebook(book('book-1', 'World'))
  await a.putPreset(preset('preset-1', 'P'))
  await a.putPlay(play('play-1', ['char-1']))
  await a.putBranch({ playId: 'play-1', key: '4', prefix: [], userText: 'u', variants: [[]], current: 0, busy: false, updatedAt: nowIso() })
  const b = await LibraryStore.open(dir, quiet)
  check('reload sees every record', b.size() === 5, `size=${b.size()}`)
  check('character round trips', b.character('char-1')?.card.data.name === 'Alice')
  check('branch round trips by play+key', b.branch('play-1', '4')?.userText === 'u')
  check('no temp files left', readdirSync(join(dir, 'characters')).every(f => f.endsWith('.json')))
}

// 鈹€鈹€ 2. corrupt record is skipped, not fatal 鈹€鈹€
{
  const dir = join(root, 'corrupt')
  const a = await LibraryStore.open(dir, quiet)
  await a.putCharacter(card('char-good', 'Good'))
  writeFileSync(join(dir, 'characters', 'char-bad.json'), '{ this is not json')
  warnings.length = 0
  const b = await LibraryStore.open(dir, noisy)
  check('corrupt file skipped, rest survive', b.characters().length === 1 && b.character('char-good') !== undefined)
  check('corrupt file warned about', warnings.some(w => w.includes('char-bad')))
}

// 鈹€鈹€ 3. unsafe ids cannot escape the collection directory 鈹€鈹€
{
  const dir = join(root, 'traversal')
  const a = await LibraryStore.open(dir, quiet)
  let rejected = 0
  for (const bad of ['../escape', 'a/b', '..', 'x\\y', '']) {
    try { await a.putCharacter(card(bad, 'X')) } catch { rejected += 1 }
  }
  check('all traversal-shaped ids rejected', rejected === 5, `rejected=${rejected}`)
}

// 鈹€鈹€ 4. migration from a settings-shaped library 鈹€鈹€
{
  const dir = join(root, 'migrate')
  const store = await LibraryStore.open(dir, quiet)
  const legacy = {
    characters: [card('char-a', 'A'), card('char-b', 'B')],
    lorebooks: [book('book-a', 'BA')],
    presets: [preset('preset-a', 'PA')],
    plays: [play('play-a', ['char-a'], 'preset-a')],
    branches: [{ playId: 'play-a', key: '0', prefix: [], userText: 'q', variants: [[]], current: 0, busy: false, updatedAt: nowIso() }],
  }
  const report = await migrateLegacyLibrary(store, legacy, quiet)
  check('migration reports moved', report.moved && report.characters === 2 && report.branches === 1)
  const reloaded = await LibraryStore.open(dir, quiet)
  check('migrated records are readable from disk', reloaded.size() === 6, `size=${reloaded.size()}`)
  const again = await migrateLegacyLibrary(store, {}, quiet)
  check('empty migration is a no-op', again.moved === false)
}

// 鈹€鈹€ 5. TavernStorage cascades 鈹€鈹€
{
  const dir = join(root, 'cascade')
  const store = await LibraryStore.open(dir, quiet)
  let section = { ...emptyDatabase(), defaultPresetId: 'preset-x' }
  const scope = {
    get: () => section,
    update: async patch => { section = { ...section, ...patch } },
    replace: async next => { section = next },
  }
  const storage = new TavernStorage(store, scope)
  await storage.upsertCharacter(card('char-x', 'X'))
  await storage.upsertCharacter(card('char-y', 'Y'))
  await storage.upsertPreset(preset('preset-x', 'PX'))
  await storage.upsertLorebook(book('book-x', 'BX'))
  await storage.upsertPlay({ ...play('play-x', ['char-x', 'char-y'], 'preset-x'), lorebookIds: ['book-x'] })

  await storage.deleteCharacter('char-x')
  check('deleting a character unbinds it from plays',
    storage.getPlay('play-x').characterIds.join() === 'char-y')
  await storage.deleteLorebook('book-x')
  check('deleting a lorebook unbinds it', storage.getPlay('play-x').lorebookIds === undefined)
  await storage.deletePreset('preset-x')
  const after = storage.getPlay('play-x')
  check('deleting a preset removes the key entirely',
    !('presetId' in after), `keys=${Object.keys(after).join(',')}`)
  check('deleting the default preset clears the preference',
    section.defaultPresetId === undefined)
  check('snapshot assembles library + prefs',
    storage.snapshot().characters.length === 1 && storage.snapshot().version === 1)

  await storage.setStyle('classic')
  check('setStyle persists to the settings section', section.style === 'classic')
}

// 鈹€鈹€ 6. shared-singleton hazard is gone 鈹€鈹€
{
  check('emptyDatabase returns a fresh object', emptyDatabase() !== emptyDatabase())
  check('EMPTY_DATABASE is frozen', Object.isFrozen(EMPTY_DATABASE))
}

// 鈹€鈹€ 7. scale: a real-world library size 鈹€鈹€
{
  const dir = join(root, 'scale')
  const store = await LibraryStore.open(dir, quiet)
  const legacy = {
    characters: Array.from({ length: 176 }, (_, i) => card(newId('char'), `C${i}`)),
    lorebooks: Array.from({ length: 210 }, (_, i) => book(newId('book'), `B${i}`)),
    presets: Array.from({ length: 746 }, (_, i) => preset(newId('preset'), `P${i}`)),
  }
  const t0 = Date.now()
  await migrateLegacyLibrary(store, legacy, quiet)
  const wrote = Date.now() - t0
  const t1 = Date.now()
  const reloaded = await LibraryStore.open(dir, quiet)
  const read = Date.now() - t1
  check('1132-record library round trips', reloaded.size() === 1132, `size=${reloaded.size()}`)
  log.push(`INFO  scale: migrate ${wrote}ms, cold load ${read}ms`)
}

rmSync(root, { recursive: true, force: true })
console.log(log.join('\n'))
