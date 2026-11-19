import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, readdir, realpath, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname, basename, resolve } from 'node:path'
import { LibraryStore, migrateLegacyLibrary } from '../../src/library.ts'
import { PrefsStore } from '../../src/prefs.ts'
import { TavernStorage } from '../../src/storage.ts'
import { AvatarStore } from '../../src/avatarstore.ts'
import { normalizeCard, normalizeWorldBook } from '../../src/cardcodec.ts'
import { resolveTauriTavernDirectory, importTauriTavernData } from '../../src/tauritavern.ts'

const logger = { warn() {}, error() {}, info() {} }
const collections = ['characters', 'lorebooks', 'presets', 'plays', 'branches']
const character = (id = 'char-a', name = 'Alice') => ({ id, card: normalizeCard({ name }), future: { keep: true } })
const lorebook = (id = 'book-a', name = 'World') => ({ id, name, book: normalizeWorldBook({ entries: [{ uid: 1, key: ['dragon'], content: 'World fixture', extensions: { future: true } }] }) })
const preset = (id = 'preset-a', name = 'Preset') => ({ id, name, raw: { custom_extension: { keep: true } } })
const play = (id = 'play-a', title = 'Play') => ({ id, title, characterIds: ['char-a'], sessionId: 'fixture-session', lorebookId: 'book-a', narratorEnabled: false, multiAgent: false })
const branch = (key = '0', userText = 'Question') => ({ playId: 'play-a', key, prefix: [{ type: 'legacy/event', data: { opaque: true } }], variants: [[{ type: 'legacy/tail', data: {} }]], current: 0, userText, busy: false, future: { keep: true } })
const valid = () => ({ characters: character(), lorebooks: lorebook(), presets: preset(), plays: play(), branches: branch() })
const filename = (collection, record) => collection === 'branches' ? `${record.playId}~${record.key}` : record.id
const put = (store, collection, record) => store[{ characters: 'putCharacter', lorebooks: 'putLorebook', presets: 'putPreset', plays: 'putPlay', branches: 'putBranch' }[collection]](record)

async function fixture(run) {
  const parent = await realpath(tmpdir())
  const root = await mkdtemp(join(parent, 'tavern-stability-data-'))
  const target = await realpath(root)
  assert.equal(dirname(target), parent)
  assert.ok(basename(target).startsWith('tavern-stability-data-'))
  try { await run(root) }
  finally {
    // Verify this exact absolute mkdtemp target immediately before cleanup.
    assert.equal(resolve(root), target)
    assert.equal(await realpath(root), target)
    assert.equal(dirname(target), parent)
    assert.ok(basename(target).startsWith('tavern-stability-data-'))
    await rm(target, { recursive: true, force: true })
  }
}

async function destination(root) {
  const library = await LibraryStore.open(join(root, 'library'), logger)
  const prefs = new PrefsStore(join(root, 'prefs.json'), logger)
  await prefs.load()
  return { library, storage: new TavernStorage(library, prefs), avatars: new AvatarStore(join(root, 'avatars'), logger) }
}

async function userData(root, name = 'Fixture') {
  const user = join(root, 'default-user')
  await mkdir(join(user, 'characters'), { recursive: true })
  await writeFile(join(user, 'characters', 'fixture.json'), JSON.stringify({ name }))
  return user
}

async function directoryLink(target, link) {
  await symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir')
}

test('put rejects coerced/missing ids and malformed core records without writing', async () => fixture(async root => {
  const store = await LibraryStore.open(root, logger)
  for (const id of [undefined, null, 7, true, {}, '', '.', '..', '../outside', 'x/y', 'x\\y', '角色\u0000', '角色\n']) {
    await assert.rejects(store.putCharacter({ ...character(), id }), /invalid record/)
  }
  const bad = {
    characters: [null, [], { id: 'char-a' }, { ...character(), card: { data: [] } }, { ...character(), avatar: {} }],
    lorebooks: [null, [], { ...lorebook(), book: { entries: [null] } }, { ...lorebook(), book: { entries: {} } }],
    presets: [null, [], { id: 'preset-a', name: [] }, { ...preset(), raw: [] }, { ...preset(), temperature: NaN }],
    plays: [null, [], { ...play(), characterIds: null }, { ...play(), sessionId: {} }],
    branches: [null, [], { ...branch(), playId: 1 }, { ...branch(), key: undefined }, { ...branch(), prefix: {} }, { ...branch(), variants: [null] }, { ...branch(), current: 2 }],
  }
  for (const collection of collections) {
    for (const record of bad[collection]) await assert.rejects(put(store, collection, record), /invalid record/)
    assert.deepEqual(await readdir(join(root, collection)), [])
  }
  assert.equal(store.size(), 0)
}))

test('load isolates null/array/shape/key damage in every collection and retains exact source bytes', async () => fixture(async root => {
  const warnings = []
  const log = { ...logger, warn: text => warnings.push(text) }
  const store = await LibraryStore.open(root, log)
  const records = valid(), sources = []
  for (const collection of collections) {
    await put(store, collection, records[collection])
    const damaged = [
      ['bad-null', 'null'], ['bad-array', '[]'], ['bad-shape', JSON.stringify({ id: 'bad-shape', playId: 'bad', key: 'shape' })],
      ['bad-key', JSON.stringify(records[collection])],
    ]
    for (const [key, text] of damaged) {
      const file = join(root, collection, `${key}.json`)
      await writeFile(file, text)
      sources.push([file, text])
    }
  }
  const reload = await LibraryStore.open(root, log)
  assert.equal(reload.size(), 5)
  for (const collection of collections) assert.equal(reload[collection]().length, 1)
  assert.equal(warnings.length, 20)
  for (const [file, text] of sources) assert.equal(await readFile(file, 'utf8'), text)
  assert.doesNotThrow(() => reload.plays().map(record => record.id))
  assert.doesNotThrow(() => reload.branches().map(record => record.variants.length))
}))

test('reloading a formerly valid but now damaged record removes only its cached entry', async () => fixture(async root => {
  const warnings = []
  const store = await LibraryStore.open(root, { ...logger, warn: text => warnings.push(text) })
  await store.putCharacter(character('char-a'))
  await store.putCharacter(character('char-b'))
  const file = join(root, 'characters', 'char-a.json')
  await writeFile(file, 'null')
  await store.load()
  assert.equal(store.character('char-a'), undefined)
  assert.ok(store.character('char-b'))
  assert.equal(await readFile(file, 'utf8'), 'null')
  assert.equal(warnings.length, 1)
}))

test('legacy recovery rejects missing ids instead of reporting two overwriting moves', async () => fixture(async root => {
  const warnings = [], log = { ...logger, warn: text => warnings.push(text) }
  const store = await LibraryStore.open(root, log)
  const first = character(undefined, 'First'), second = character(undefined, 'Second')
  delete first.id; delete second.id
  const legacy = { characters: [first, second, character('char-good', 'Good')] }
  const before = JSON.stringify(legacy)
  await assert.rejects(migrateLegacyLibrary(store, legacy, log), /2 record\(s\).*settings copy kept/)
  assert.equal(JSON.stringify(legacy), before)
  assert.deepEqual(await readdir(join(root, 'characters')), ['char-good.json'])
  assert.equal(store.characters().length, 1)
  assert.equal(warnings.length, 2)
}))

test('legacy recovery catches duplicate identities in all collections and preserves the first copy', async () => fixture(async root => {
  const warnings = [], log = { ...logger, warn: text => warnings.push(text) }
  const store = await LibraryStore.open(root, log)
  const legacy = {
    characters: [character('char-a', 'First'), character('char-a', 'Second')],
    lorebooks: [lorebook('book-a', 'First'), lorebook('book-a', 'Second')],
    presets: [preset('preset-a', 'First'), preset('preset-a', 'Second')],
    plays: [play('play-a', 'First'), play('play-a', 'Second')],
    branches: [branch('0', 'First'), branch('0', 'Second')],
  }
  const before = JSON.stringify(legacy)
  await assert.rejects(migrateLegacyLibrary(store, legacy, log), /5 record\(s\).*settings copy kept/)
  assert.equal(JSON.stringify(legacy), before)
  assert.equal(warnings.filter(text => text.includes('duplicate legacy identity')).length, 5)
  const reload = await LibraryStore.open(root, log)
  assert.equal(reload.size(), 5)
  assert.equal(reload.character('char-a').card.data.name, 'First')
  assert.equal(reload.lorebook('book-a').name, 'First')
  assert.equal(reload.preset('preset-a').name, 'First')
  assert.equal(reload.play('play-a').title, 'First')
  assert.equal(reload.branch('play-a', '0').userText, 'First')
}))

test('valid old records and opaque branch events round trip without newer required fields', async () => fixture(async root => {
  const store = await LibraryStore.open(root, logger), records = valid()
  for (const collection of collections) await put(store, collection, records[collection])
  const reload = await LibraryStore.open(root, logger)
  for (const collection of collections) assert.deepEqual(reload[collection](), [JSON.parse(JSON.stringify(records[collection]))])
  assert.equal(Object.hasOwn(reload.branch('play-a', '0'), 'userMessageId'), false)
  assert.equal(Object.hasOwn(reload.branch('play-a', '0'), 'sessionId'), false)
  assert.equal((await migrateLegacyLibrary(store, {}, logger)).moved, false)
}))

test('Unicode ids remain readable and support save/reload/legacy recovery in every collection', async () => fixture(async root => {
  const store = await LibraryStore.open(root, logger)
  const records = {
    characters: character('人物-张三'), lorebooks: lorebook('世界书-山海'), presets: preset('预设-默认'),
    plays: { ...play('剧本-酒馆'), characterIds: ['人物-张三'], lorebookId: '世界书-山海' },
    branches: { ...branch('分叉-1'), playId: '剧本-酒馆' },
  }
  // Existing readable Unicode files must not be quarantined by a new ASCII gate.
  for (const collection of collections) {
    await writeFile(join(root, collection, `${filename(collection, records[collection])}.json`), JSON.stringify(records[collection]))
  }
  await store.load()
  assert.equal(store.size(), 5)
  for (const collection of collections) await put(store, collection, records[collection])
  const legacy = Object.fromEntries(collections.map(collection => [collection, [records[collection]]]))
  const report = await migrateLegacyLibrary(store, legacy, logger)
  assert.equal(report.moved, true)
  const reload = await LibraryStore.open(root, logger)
  for (const collection of collections) {
    assert.equal(report[collection], 1)
    assert.deepEqual(reload[collection](), [JSON.parse(JSON.stringify(records[collection]))])
  }
}))

test('optional branch lineage ids are non-empty strings when present, not required for old records', async () => fixture(async root => {
  const warnings = [], log = { ...logger, warn: text => warnings.push(text) }
  const store = await LibraryStore.open(root, log)
  for (const field of ['userMessageId', 'sessionId']) {
    for (const value of [null, 7, [], {}, '', '   ']) {
      await assert.rejects(store.putBranch({ ...branch(), [field]: value }), /invalid record/)
    }
  }
  const record = { ...branch(), userMessageId: 'fixture-user-message', sessionId: 'fixture-session' }
  await store.putBranch(record)
  const reload = await LibraryStore.open(root, log)
  assert.deepEqual(reload.branch('play-a', '0'), record)
  const file = join(root, 'branches', 'play-a~0.json'), damaged = JSON.stringify({ ...record, sessionId: 7 })
  await writeFile(file, damaged)
  await reload.load()
  assert.equal(reload.branch('play-a', '0'), undefined)
  assert.equal(await readFile(file, 'utf8'), damaged)
  assert.equal(warnings.length, 1)
}))

test('put validates the JSON snapshot and caller mutation cannot poison publication', async () => fixture(async root => {
  const store = await LibraryStore.open(root, logger)
  const input = character('char-a', 'Committed')
  const pending = store.putCharacter(input)
  input.card.data.name = 'Changed after enqueue'
  input.card = null
  await pending
  assert.equal(store.character('char-a').card.data.name, 'Committed')
  const reload = await LibraryStore.open(root, logger)
  assert.deepEqual(reload.character('char-a'), store.character('char-a'))
  await assert.rejects(store.putCharacter({ ...character('char-b'), toJSON() { return null } }), /invalid record/)
  await assert.rejects(store.putCharacter({ ...character('char-b'), toJSON() { return character('char-other') } }), /filename key/)
  assert.deepEqual(await readdir(join(root, 'characters')), ['char-a.json'])
}))

test('resolver keeps app/data/default-user/child and quoted path support', async () => fixture(async root => {
  const app = join(root, 'app'), data = join(app, 'data'), user = await userData(data)
  for (const input of [app, data, user, join(user, 'characters'), join(user, 'characters', 'fixture.json'), `"${app}"`]) {
    assert.equal((await resolveTauriTavernDirectory(input)).userDir, await realpath(user))
  }
}))

test('contained runtime data_root still wins and accepts relative or in-root absolute paths', async () => fixture(async root => {
  const app = join(root, 'app')
  await userData(join(app, 'data'), 'Canonical')
  const selected = await userData(join(app, 'custom'), 'Configured')
  const config = join(app, 'tauritavern-runtime.json')
  for (const data_root of ['custom', join(app, 'custom')]) {
    await writeFile(config, JSON.stringify({ data_root }))
    assert.equal((await resolveTauriTavernDirectory(app)).userDir, await realpath(selected))
  }
}))

for (const slot of ['data/default-user', 'default-user', 'data']) {
  test(`resolver stops an escaping ${slot} link without widening the ancestor boundary`, async () => fixture(async root => {
    const app = join(root, 'app'), neighbor = join(root, 'neighbor'), outsideUser = await userData(neighbor, 'Outside fixture')
    await mkdir(app, { recursive: true })
    if (slot === 'data/default-user') await mkdir(join(app, 'data'))
    await directoryLink(slot === 'data' ? neighbor : outsideUser, join(app, ...slot.split('/')))
    const expected = /数据目录 .*软链接 \/ junction.*检测根目录之外/
    await assert.rejects(resolveTauriTavernDirectory(app), expected)
    const { storage, avatars, library } = await destination(join(root, 'destination'))
    await assert.rejects(importTauriTavernData(storage, avatars, app), expected)
    assert.equal(library.size(), 0)
  }))
}

test('runtime data_root whose in-root junction escapes is rejected with the candidate path', async () => fixture(async root => {
  const app = join(root, 'app'), neighbor = join(root, 'neighbor')
  await mkdir(app)
  await userData(neighbor)
  await directoryLink(neighbor, join(app, 'custom'))
  await writeFile(join(app, 'tauritavern-runtime.json'), JSON.stringify({ data_root: 'custom' }))
  await assert.rejects(resolveTauriTavernDirectory(app), error => /检测根目录之外/.test(error.message) && error.message.includes(join(app, 'custom', 'default-user')))
}))

test('lexically escaping runtime config is still ignored/reported when canonical data exists', async () => fixture(async root => {
  const app = join(root, 'app'), user = await userData(join(app, 'data'), 'Canonical')
  await userData(join(root, 'neighbor'), 'Outside')
  const config = join(app, 'tauritavern-runtime.json')
  await writeFile(config, JSON.stringify({ data_root: '../neighbor' }))
  const resolved = await resolveTauriTavernDirectory(app)
  assert.equal(resolved.userDir, await realpath(user))
  assert.deepEqual(resolved.refusedConfigs, [config])
  const { storage, avatars } = await destination(join(root, 'destination'))
  const report = await importTauriTavernData(storage, avatars, app, { lorebooks: false, presets: false })
  assert.equal(report.imported.characters, 1)
  assert.equal(report.issues.length, 1)
  assert.match(report.issues[0].reason, /data_root/)
  assert.equal(storage.listCharacters()[0].card.data.name, 'Canonical')
}))

test('contained links and directly selected symlink roots/aliases remain supported', async () => fixture(async root => {
  const app = join(root, 'app'), user = await userData(join(app, 'actual'), 'Direct fixture')
  await directoryLink(join(app, 'actual'), join(app, 'data'))
  assert.equal((await resolveTauriTavernDirectory(app)).userDir, await realpath(user))
  const appAlias = join(root, 'app-alias'), userAlias = join(root, 'selected-user')
  await directoryLink(app, appAlias)
  await directoryLink(user, userAlias)
  for (const input of [appAlias, userAlias, join(userAlias, 'characters')]) {
    assert.equal((await resolveTauriTavernDirectory(input)).userDir, await realpath(user))
  }
  const { storage, avatars } = await destination(join(root, 'destination'))
  const report = await importTauriTavernData(storage, avatars, userAlias, { lorebooks: false, presets: false })
  assert.equal(report.imported.characters, 1)
  assert.deepEqual(report.issues, [])
}))

test('Windows standard APPDATA fallback remains available', { skip: process.platform !== 'win32' }, async () => fixture(async root => {
  const before = process.env.APPDATA
  const appData = join(root, 'AppData'), program = join(root, 'Programs', 'TauriTavern')
  await mkdir(program, { recursive: true })
  const user = await userData(join(appData, 'com.tauritavern.client', 'data'))
  process.env.APPDATA = appData
  try { assert.equal((await resolveTauriTavernDirectory(program)).userDir, await realpath(user)) }
  finally { if (before === undefined) delete process.env.APPDATA; else process.env.APPDATA = before }
}))
