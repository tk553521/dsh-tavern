import test from 'node:test'
import assert from 'node:assert/strict'
import { TavernSessionRuntime } from '../../src/play.ts'
import { normalizeCard } from '../../src/cardcodec.ts'
import { normalizeConfig } from '../../src/config.ts'

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const play = { id: 'play-a', sessionId: 'director-a', title: 'Test', characterIds: ['char-a'],
  multiAgent: true, narratorEnabled: false, createdAt: '2026-01-01', updatedAt: '2026-01-01' }
const character = { id: 'char-a', card: normalizeCard({ name: 'Alice' }), createdAt: '', updatedAt: '' }
function fixture(create, ensurePreset = async () => {}) {
  const handles = []
  const runtime = new TavernSessionRuntime({
    storage: { listPlays: () => [play], getCharacter: () => character, getPreset: () => undefined, getLorebook: () => undefined },
    agents: { create: async options => {
      const handle = create ? await create(options) : {
        agent: { id: options.sessionId, session: { snapshotEvents: () => [] } },
        disposals: 0, async dispose() { this.disposals++ },
      }
      handles.push(handle)
      return handle
    } },
    agentPresets: {}, ensurePreset, workspace: () => undefined,
    sessionPersistence: { open: async () => { const error = new Error('missing'); error.name = 'SessionPersistenceNotFoundError'; throw error } },
    defaultModel: () => ({ provider: 'p', model: 'm' }),
    config: normalizeConfig({}), logger: { warn() {}, error() {}, info() {} },
  })
  return { runtime, handles }
}

test('disposing runtime waits for in-flight director creation and releases its late handle', async () => {
  const started = deferred(), gate = deferred()
  const handle = { agent: { id: play.sessionId }, disposals: 0, async dispose() { this.disposals++ } }
  const { runtime } = fixture(async () => { started.resolve(); await gate.promise; return handle })
  const pending = runtime.ensureDirector(play)
  const rejected = assert.rejects(pending)
  await started.promise
  const disposed = runtime.dispose()
  gate.resolve()
  await Promise.all([rejected, disposed])
  assert.equal(handle.disposals, 1)
  assert.equal(runtime.getDirector(play.id), undefined)
  await assert.rejects(runtime.ensureDirector(play))
})

test('dropping play cancels in-flight role creation and a later activation remains possible', async () => {
  const started = deferred(), gate = deferred()
  let first = true
  const stale = { agent: { id: 'role-a' }, disposals: 0, async dispose() { this.disposals++ } }
  const { runtime, handles } = fixture(async options => {
    if (first) { first = false; started.resolve(); await gate.promise; return stale }
    return { agent: { id: options.sessionId }, async dispose() {} }
  })
  const pending = runtime.speakFor({ agent: { id: play.sessionId }, signal: new AbortController().signal }, {})
  const rejected = assert.rejects(pending)
  await started.promise
  const dropped = runtime.dropPlay(play.id)
  gate.resolve()
  await Promise.all([rejected, dropped])
  assert.equal(stale.disposals, 1)
  const director = await runtime.ensureDirector(play)
  assert.equal(runtime.getDirector(play.id), director.agent)
  assert.equal(handles.length, 2)
  await runtime.dispose()
})

test('dispose interrupts assembly waiting on preset registration before any agent is created', async () => {
  const started = deferred(), gate = deferred()
  const { runtime, handles } = fixture(undefined, async () => { started.resolve(); await gate.promise })
  const pending = runtime.ensureDirector(play)
  const rejected = assert.rejects(pending)
  await started.promise
  const disposed = runtime.dispose()
  gate.resolve()
  await Promise.all([rejected, disposed])
  assert.equal(handles.length, 0)
})

test('speakFor propagates generation failure instead of returning historical text', async () => {
  const events = [{ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'OLD_REPLY' }] } } }]
  const agent = {
    id: 'role-a', session: { snapshotEvents: () => [...events] },
    followup() {}, whenIdle: () => Promise.reject(new Error('provider failed')), cancel() {},
  }
  const { runtime } = fixture(async () => ({ agent, async dispose() {} }))
  try {
    await assert.rejects(runtime.speakFor({ agent: { id: play.sessionId }, signal: new AbortController().signal }, {}), /provider failed/)
  } finally {
    await runtime.dispose()
  }
})

for (const kind of ['completed', 'max-tokens']) {
  test(`speakFor waits for the new ${kind} turn and returns only its reply`, async () => {
    const gate = deferred(), woke = deferred()
    const events = [{ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'OLD_REPLY' }] } } }]
    let submitted = false
    const agent = {
      id: 'role-a', session: { snapshotEvents: () => [...events] }, cancel() {},
      followup() { submitted = true; woke.resolve() },
      async whenIdle() {
        assert.equal(submitted, true, 'idle subscription must follow wake')
        await gate.promise
        events.push({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'NEW_REPLY' }] } } })
        events.push({ type: 'turn/end', data: { reason: { kind } } })
      },
    }
    const { runtime } = fixture(async () => ({ agent, async dispose() {} }))
    try {
      let finished = false
      const pending = runtime.speakFor({ agent: { id: play.sessionId }, signal: new AbortController().signal }, {})
      void pending.then(() => { finished = true })
      await woke.promise
      await Promise.resolve()
      assert.equal(finished, false)
      gate.resolve()
      assert.deepEqual(await pending, { reply: 'NEW_REPLY' })
    } finally {
      gate.resolve()
      await runtime.dispose()
    }
  })
}

for (const mode of ['no-reply', 'error']) {
  test(`speakFor never returns history when the current turn has ${mode}`, async () => {
    const events = [{ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'OLD_REPLY' }] } } }]
    const agent = {
      id: 'role-a', session: { snapshotEvents: () => [...events] }, followup() {}, cancel() {},
      async whenIdle() {
        if (mode === 'error') events.push({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'PARTIAL_REPLY' }] } } })
        events.push({ type: 'turn/end', data: { reason: { kind: mode === 'error' ? 'error' : 'completed' } } })
      },
    }
    const { runtime } = fixture(async () => ({ agent, async dispose() {} }))
    try {
      await assert.rejects(runtime.speakFor({ agent: { id: play.sessionId }, signal: new AbortController().signal }, {}))
    } finally {
      await runtime.dispose()
    }
  })
}
