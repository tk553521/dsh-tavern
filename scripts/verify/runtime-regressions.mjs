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
function fixture(create, ensurePreset = async () => {}, sessionIO = {}) {
  const handles = []
  const runtime = new TavernSessionRuntime({
    storage: { getPlay: () => play, listPlays: () => [play], getCharacter: () => character, getPreset: () => undefined, getLorebook: () => undefined },
    agents: { resume: sessionIO.resume, create: async options => {
      const handle = create ? await create(options) : {
        agent: { id: options.sessionId, session: { snapshotEvents: () => [] } },
        disposals: 0, async dispose() { this.disposals++ },
      }
      handles.push(handle)
      return handle
    } },
    agentPresets: {}, ensurePreset, workspace: () => undefined,
    sessionPersistence: { open: sessionIO.open ?? (async () => { const error = new Error('missing'); error.name = 'SessionPersistenceNotFoundError'; throw error }) },
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

for (const kind of ['director', 'character']) {
  for (const phase of ['open', 'read', 'resume']) {
    test(`existing ${kind} fails closed when session ${phase} fails`, async () => {
      const failure = new Error('session ' + phase + ' failed')
      let opens = 0, closes = 0, resumes = 0
      const { runtime, handles } = fixture(undefined, undefined, {
        async open(_id, mode) {
          assert.equal(mode, 'read')
          opens++
          if (phase === 'open') throw failure
          return {
            header: {},
            async read() {
              if (phase === 'read') throw failure
              return { events: [] }
            },
            async close() { closes++ },
          }
        },
        async resume() { resumes++; throw failure },
      })
      try {
        const activate = () => kind === 'director'
          ? runtime.ensureDirector(play)
          : runtime.speakFor({ agent: { id: play.sessionId }, signal: new AbortController().signal }, {})
        for (let attempt = 1; attempt <= 2; attempt++) {
          await assert.rejects(activate(), error => error === failure)
          assert.equal(opens, attempt)
          assert.equal(closes, phase === 'open' ? 0 : attempt)
          assert.equal(resumes, phase === 'resume' ? attempt : 0)
          assert.equal(handles.length, 0)
        }
      } finally {
        await runtime.dispose()
      }
    })
  }
}

test('editing stored history preserves a read error and closes the reader', async () => {
  const failure = new Error('damaged session history')
  let closed = false
  const { runtime, handles } = fixture(undefined, undefined, {
    async open() {
      return {
        async read() { throw failure },
        async close() { closed = true },
      }
    },
  })
  try {
    await assert.rejects(runtime.editAssistant(play.id, 'message-a', 'new text'), error => error === failure)
    assert.equal(closed, true)
    assert.equal(handles.length, 0)
  } finally {
    await runtime.dispose()
  }
})

test('editing a play without saved history still returns a caller-facing error', async () => {
  const { runtime } = fixture()
  try {
    await assert.rejects(runtime.editAssistant(play.id, 'message-a', 'new text'), {
      name: 'TavernUserError',
      status: 400,
      message: /还没有可用的对话记录/,
    })
  } finally {
    await runtime.dispose()
  }
})
