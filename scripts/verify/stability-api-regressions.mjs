import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { tavernHandler } from '../../src/api.ts'
import { normalizeConfig } from '../../src/config.ts'

const play = { id: 'play-a', title: 'Fixture', characterIds: ['char-a'], narratorEnabled: false,
  multiAgent: false, sessionId: 'session-a', createdAt: '', updatedAt: '' }
const legacyBranch = { playId: play.id, key: '0', prefix: [], userText: 'Question',
  variants: [[{ type: 'user/message', data: { id: 'question-a' } }]], current: 0, busy: false, updatedAt: '' }
async function withApi(run) {
  const calls = []
  const result = { play, branch: legacyBranch }
  const runtime = { getDirector: () => undefined,
    async reroll(...args) { calls.push(['retry', ...args]); return result },
    async swipe(...args) { calls.push(['swipe', ...args]); return result },
    async editAssistant(...args) { calls.push(['assistant', ...args]); return play },
    async editUserAndRetry(...args) { calls.push(['user', ...args]); return play },
  }
  const deps = { storage: { listCharacters: () => [], listLorebooks: () => [], listPresets: () => [], listPlays: () => [play],
    snapshot: () => ({ branches: [legacyBranch] }) }, runtime, avatars: {}, config: normalizeConfig({}),
    multiAgentAvailable: () => true, logger: { warn() {}, error() {} }, authorize: () => undefined }
  const server = createServer((req, res) => { void tavernHandler(deps, req, res) })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const base = `http://127.0.0.1:${server.address().port}`
  try { await run(base, calls) } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
}
const endpoints = [
  ['retry', '/messages/retry', 'POST', {}],
  ['swipe', '/messages/swipe', 'POST', { key: '0', step: 1 }],
  ['assistant', '/messages/answer-a', 'PUT', { text: 'Edited' }],
  ['user', '/messages/question-a/retry', 'POST', { text: 'Edited' }],
]
for (const [kind, endpoint, method, body] of endpoints) {
  test(`HTTP ${kind} forwards the expected session binding`, async () => withApi(async (base, calls) => {
    const response = await fetch(`${base}/tavern/plays/play-a${endpoint}`, { method,
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, expectedSessionId: 'session-a' }) })
    assert.equal(response.status, 200)
    assert.equal(calls[0][0], kind); assert.equal(calls[0].at(-1), 'session-a')
    const result = await response.json()
    if (kind === 'retry' || kind === 'swipe') assert.equal(result.branch.userMessageId, 'question-a')
  }))
}
test('HTTP invalid identity is a 400 and never invokes a branch mutation', async () => withApi(async (base, calls) => {
  for (const value of [null, 12, '', {}, []]) {
    const response = await fetch(`${base}/tavern/plays/play-a/messages/retry`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedSessionId: value }) })
    assert.equal(response.status, 400)
  }
  assert.equal(calls.length, 0)
}))
test('HTTP legacy retry without a binding remains compatible', async () => withApi(async (base, calls) => {
  const response = await fetch(`${base}/tavern/plays/play-a/messages/retry`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: '{}' })
  assert.equal(response.status, 200); assert.equal(calls[0].at(-1), undefined)
}))
test('HTTP state derives identity for existing branches without rewriting them', async () => withApi(async (base) => {
  const before = structuredClone(legacyBranch)
  const response = await fetch(`${base}/tavern/state`)
  assert.equal(response.status, 200)
  const state = await response.json()
  assert.equal(state.swipes[0].userMessageId, 'question-a'); assert.equal(state.swipes[0].sessionId, undefined)
  assert.deepEqual(legacyBranch, before)
}))
