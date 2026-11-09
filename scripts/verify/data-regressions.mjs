import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PrefsStore } from '../../src/prefs.ts'
import { LibraryStore } from '../../src/library.ts'
import { AvatarStore } from '../../src/avatarstore.ts'
import { TavernStorage } from '../../src/storage.ts'
import { importTauriTavernData } from '../../src/tauritavern.ts'
const logger = { warn() {}, error() {}, info() {} }

test('concurrent preference patches preserve independent fields after reload', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tavern-data-regression-'))
  try {
    const path = join(root, 'prefs.json')
    const prefs = new PrefsStore(path, logger)
    await prefs.load()
    await Promise.all([prefs.update({ style: 'classic' }), prefs.update({ defaultPresetId: 'preset-a' })])
    assert.equal(prefs.get().style, 'classic')
    assert.equal(prefs.get().defaultPresetId, 'preset-a')
    const reload = new PrefsStore(path, logger)
    await reload.load()
    assert.equal(reload.get().style, 'classic')
    assert.equal(reload.get().defaultPresetId, 'preset-a')
  } finally {
    await rm(root, { recursive: true, force: true }) // mkdtemp fixture only
  }
})

test('clearing the default preset concurrently with style changes preserves the style', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tavern-prefs-clear-regression-'))
  try {
    const library = new LibraryStore(join(root, 'library'), logger)
    await library.load()
    const prefs = new PrefsStore(join(root, 'prefs.json'), logger)
    await prefs.load()
    const storage = new TavernStorage(library, prefs)
    await storage.setDefaultPreset('preset-a')
    await Promise.all([storage.setStyle('classic'), storage.setDefaultPreset(undefined)])
    assert.equal(storage.snapshot().style, 'classic')
    assert.equal(storage.snapshot().defaultPresetId, undefined)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('deleting a record waits for earlier saves and it stays deleted after reload', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tavern-delete-regression-'))
  try {
    const library = new LibraryStore(root, logger)
    await library.load()
    await library.putCharacter({ id: 'char-a', name: 'old' })
    const saves = Array.from({ length: 20 }, (_, i) => library.putCharacter({
      id: 'char-a', name: `save${i}`, card: { data: { description: 'x'.repeat(65536) } },
    }))
    await library.dropCharacter('char-a')
    await Promise.all(saves)
    assert.equal(library.character('char-a'), undefined)
    const reload = new LibraryStore(root, logger)
    await reload.load()
    assert.equal(reload.character('char-a'), undefined)
    await library.putCharacter({ id: 'char-a', name: 'new' })
    assert.equal(library.character('char-a').name, 'new')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('shared avatar references become owned copies and never delete another character image', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tavern-avatar-regression-'))
  try {
    const avatars = new AvatarStore(root, logger)
    const a = await avatars.materializeCharacter({ id: 'char-a', avatar: 'data:image/png;base64,AQID' })
    const b = await avatars.materializeCharacter({ id: 'char-b', avatar: a.avatar })
    assert.equal(b.avatar, 'tavern/avatars/char-b.png')
    assert.deepEqual(await avatars.readCharacter(b), Buffer.from([1, 2, 3]))
    await avatars.removeCharacter(b)
    assert.deepEqual(await avatars.readCharacter(a), Buffer.from([1, 2, 3]))
    const legacyShared = { id: 'char-c', avatar: a.avatar }
    await avatars.removeCharacter(legacyShared)
    assert.ok(await avatars.readCharacter(a))
    await avatars.materializeCharacter({ id: 'char-c', avatar: 'data:image/jpeg;base64,BAUG' }, legacyShared)
    assert.ok(await avatars.readCharacter(a))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('same relative filenames in different TauriTavern roots import independently and reruns are idempotent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tavern-import-regression-'))
  try {
    const library = new LibraryStore(join(root, 'library'), logger)
    await library.load()
    const prefs = new PrefsStore(join(root, 'prefs.json'), logger)
    await prefs.load()
    const storage = new TavernStorage(library, prefs)
    const avatars = new AvatarStore(join(root, 'avatars'), logger)
    for (const [folder, name] of [['one', 'Alice'], ['two', 'Bob']]) {
      const userDir = join(root, folder, 'default-user')
      for (const dir of ['characters', 'worlds', 'OpenAI Settings']) await mkdir(join(userDir, dir), { recursive: true })
      await writeFile(join(userDir, 'characters', 'same.json'), JSON.stringify({ name, description: name }))
      await writeFile(join(userDir, 'worlds', 'same.json'), JSON.stringify({ name, entries: [] }))
      await writeFile(join(userDir, 'OpenAI Settings', 'same.json'), JSON.stringify({ name, temp: name === 'Alice' ? 0.5 : 0.8 }))
      const imported = await importTauriTavernData(storage, avatars, userDir)
      assert.deepEqual(imported.imported, { characters: 1, lorebooks: 1, presets: 1 })
      const rerun = await importTauriTavernData(storage, avatars, join(userDir, 'characters'))
      assert.deepEqual(rerun.imported, { characters: 0, lorebooks: 0, presets: 0 })
    }
    assert.deepEqual(storage.listCharacters().map(c => c.card.data.name).sort(), ['Alice', 'Bob'])
    assert.equal(storage.listLorebooks().length, 2)
    assert.equal(storage.listPresets().length, 2)
    // Pre-fix records have only relative source paths. Match their content,
    // never let the unscoped path suppress a different installation's card.
    const alice = storage.listCharacters().find(c => c.card.data.name === 'Alice')
    await storage.upsertCharacter({ ...alice, source: 'characters/same.json' })
    const legacyRerun = await importTauriTavernData(storage, avatars, join(root, 'one', 'default-user'))
    assert.equal(legacyRerun.imported.characters, 0)
    assert.equal(storage.listCharacters().length, 2)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
