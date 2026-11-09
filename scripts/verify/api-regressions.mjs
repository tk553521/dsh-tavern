import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LibraryStore } from '../../src/library.ts'
import { PrefsStore } from '../../src/prefs.ts'
import { TavernStorage } from '../../src/storage.ts'
import { tavernHandler } from '../../src/api.ts'
import { normalizeConfig } from '../../src/config.ts'

const logger = { warn() {}, error() {}, info() {} }

test('editing a world book preserves existing book-level metadata through HTTP', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tavern-api-regression-'))
  const library = new LibraryStore(join(root, 'library'), logger)
  await library.load()
  const prefs = new PrefsStore(join(root, 'prefs.json'), logger)
  await prefs.load()
  const storage = new TavernStorage(library, prefs)
  const original = { name: 'Before', description: 'keep description', token_budget: 123,
    scan_depth: 9, recursive_scanning: true, extensions: { custom: 'keep' }, entries: [] }
  await storage.upsertLorebook({ id: 'book-a', name: 'Before', book: original,
    createdAt: '2026-01-01', updatedAt: '2026-01-01' })
  const server = createServer((req, res) => void tavernHandler({ storage, runtime: {}, avatars: {},
    logger, config: normalizeConfig({}), multiAgentAvailable: () => false }, req, res))
  try {
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const response = await fetch(`http://127.0.0.1:${server.address().port}/tavern/lorebooks/book-a`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'After', book: { name: 'After', entries: [] } }),
    })
    assert.equal(response.status, 200)
    const saved = await response.json()
    assert.equal(saved.book.token_budget, 123)
    assert.equal(saved.book.scan_depth, 9)
    assert.equal(saved.book.recursive_scanning, true)
    assert.equal(saved.book.description, 'keep description')
    assert.deepEqual(saved.book.extensions, { custom: 'keep' })
    assert.equal(storage.getLorebook('book-a').name, 'After')
    const reloaded = new LibraryStore(join(root, 'library'), logger)
    await reloaded.load()
    assert.equal(reloaded.lorebook('book-a').book.token_budget, 123)
  } finally {
    server.closeAllConnections()
    if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    await rm(root, { recursive: true, force: true }) // only mkdtemp fixture
  }
})
