import test from 'node:test'
import assert from 'node:assert/strict'
import { setImmediate as tick } from 'node:timers/promises'
import { TavernSessionRuntime, greetingSeed } from '../../src/play.ts'
import { normalizeCard } from '../../src/cardcodec.ts'
import { normalizeConfig } from '../../src/config.ts'
import { comparableForkEvents, sameReplyTail, swipeUserMessageId } from '../../src/swipe.ts'

const deferred = () => Promise.withResolvers()
const question = { id: 'question-a', role: 'user', content: [{ type: 'text', text: 'QUESTION_A' }], source: { kind: 'user' } }
function completedTurn(message, answer, turn = 1) {
  const events = greetingSeed(answer, 'p', 'm')
  events[1].data = structuredClone(message)
  events[2].data.message.id = `answer-${message.id}`
  for (const event of events) if ('turn' in event.data) event.data.turn = turn
  return events
}
const original = completedTurn(question, 'ANSWER_A')
function branch() { return { playId: 'play-a', key: '0', prefix: [], userText: 'QUESTION_A',
  variants: [original, completedTurn({ ...question, id: 'question-alt' }, 'ANSWER_ALT')], current: 0, busy: false, updatedAt: '' } }
function fixture({ phase, createGate, failCreate, failPointer, failBranch, failSubmit, addSeedMarker = true } = {}) {
  let play = { id: 'play-a', title: 'Fixture', sessionId: 'director-a', characterIds: ['char-a'],
    multiAgent: false, narratorEnabled: false, createdAt: '', updatedAt: '' }
  const branches = new Map(), handles = [], calls = { create: 0, resume: 0, open: 0, close: 0 }
  const failure = new Error(`fixture ${phase ?? 'failure'}`)
  const initialEvents = structuredClone(original)
  const logger = { warn() {}, error() {}, info() {} }
  const append = (agent, event) => agent.events.push({ ...structuredClone(event), seq: agent.events.length })
  function handleFor(options, seed, fresh) {
    const pending = []
    for (const event of seed) if (event.type === 'agent/inbox/spliced' && event.data.target === 'next-turn') {
      pending.splice(event.data.start, event.data.removedCount ?? 0, ...(event.data.inserted ?? []))
    }
    const agent = {
      id: options.sessionId ?? options.resumeSessionId, events: structuredClone(seed), status: 'idle', activityDone: Promise.resolve(),
      session: { snapshotEvents: () => structuredClone(agent.events) },
      inbox: { get nextTurn() { return pending }, nextStep: [], clear() {
        if (pending.length) { append(agent, { type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, removedCount: pending.length, outcome: 'canceled' } }); pending.length = 0 }
      } },
      async whenIdle() { let activity; do { await (activity = this.activityDone) } while (activity !== this.activityDone) },
      followup(message) {
        if (failSubmit && fresh) throw failure
        pending.push(message)
        append(this, { type: 'agent/inbox/spliced', data: { target: 'next-turn', start: pending.length - 1, inserted: [message] } })
        this.status = 'running'
        const done = deferred(); this.activityDone = done.promise; this.finish = done.resolve
        queueMicrotask(() => {
          if (this.status === 'idle') return
          const message = pending.shift()
          const turn = this.events.filter(e => e.type === 'turn/start').length + 1
          const events = completedTurn(message, 'NEW_ANSWER', turn)
          append(this, events[0])
          append(this, { type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, removedCount: 1 } })
          for (const event of events.slice(1)) append(this, event)
          this.status = 'idle'; done.resolve()
        })
      },
      cancel() { this.status = 'idle'; this.finish?.() },
    }
    if (fresh && addSeedMarker) append(agent, { type: 'session/end-seed', data: {} })
    const handle = { agent, disposals: 0, async dispose() { this.disposals++; agent.cancel() } }
    handles.push(handle)
    return handle
  }
  const storage = {
    getPlay: () => structuredClone(play), listPlays: () => [structuredClone(play)],
    getCharacter: () => ({ id: 'char-a', card: normalizeCard({ name: 'Alice' }) }), getPreset: () => undefined, getLorebook: () => undefined,
    listSwipeBranches: () => [...branches.values()].map(value => structuredClone(value)),
    getSwipeBranch: (_p, key) => branches.has(key) ? structuredClone(branches.get(key)) : undefined,
    async upsertPlay(next) { if (failPointer && next.sessionId !== 'director-a') throw failure; play = structuredClone(next) },
    async upsertSwipeBranch(value) { if (failBranch && value.sessionId) throw failure; branches.set(value.key, structuredClone(value)) },
    async deleteSwipeBranch(_p, key) { branches.delete(key) }, async deleteSwipeBranches() { branches.clear() },
  }
  const runtime = new TavernSessionRuntime({ storage, logger, config: normalizeConfig({}),
    defaultModel: () => ({ provider: 'p', model: 'm' }), workspace: () => undefined, agentPresets: {}, ensurePreset: async () => {},
    agents: {
      async create(options) { calls.create++; await createGate?.promise; if (failCreate) throw failure; return handleFor(options, options.seed ?? [], true) },
      async resume(options) { calls.resume++; if (phase === 'resume') throw failure; return handleFor(options, initialEvents, false) },
    },
    sessionPersistence: { async open(id) {
      calls.open++
      if (phase === 'open') throw failure
      if (id !== 'director-a' && !phase) { const e = new Error('missing'); e.name = 'SessionPersistenceNotFoundError'; throw e }
      return { header: {}, async read() { if (phase === 'read') throw failure; return { events: initialEvents } }, async close() { calls.close++ } }
    } },
  })
  return { runtime, storage, branches, handles, calls, failure, initialEvents, play: () => structuredClone(play) }
}
async function opened(f) { return (await f.runtime.ensureDirector(f.play())).agent }
async function settled(f) { await f.runtime.getDirector('play-a').whenIdle(); await tick() }

for (const kind of ['director', 'character']) for (const phase of ['open', 'read', 'resume']) {
  test(`${kind} preserves ${phase} failure without creating a replacement`, async () => {
    const f = fixture({ phase })
    try {
      const activate = () => kind === 'director' ? f.runtime.ensureDirector(f.play())
        : f.runtime.speakFor({ agent: { id: 'director-a' }, signal: new AbortController().signal }, {})
      await assert.rejects(activate(), e => e === f.failure)
      assert.equal(f.calls.create, 0); assert.equal(f.calls.close, phase === 'open' ? 0 : 1)
      assert.equal(f.calls.resume, phase === 'resume' ? 1 : 0)
    } finally { await f.runtime.dispose() }
  })
}

test('cold editing preserves read failure and closes the reader', async () => {
  const f = fixture({ phase: 'read' })
  try { await assert.rejects(f.runtime.editAssistant('play-a', 'answer-question-a', 'EDIT'), e => e === f.failure); assert.equal(f.calls.close, 1); assert.equal(f.calls.create, 0) }
  finally { await f.runtime.dispose() }
})

for (const operation of ['assistant', 'user']) for (const failure of ['prepare', 'pointer', 'submit']) {
  if (operation === 'assistant' && failure === 'submit') continue
  test(`${operation} edit ${failure} failure preserves old pointer, live handle and variants`, async () => {
    const f = fixture({ failCreate: failure === 'prepare', failPointer: failure === 'pointer', failSubmit: failure === 'submit' })
    try {
      const old = await opened(f); f.branches.set('0', branch())
      const before = structuredClone(f.branches.get('0'))
      const edit = operation === 'assistant' ? f.runtime.editAssistant('play-a', 'answer-question-a', 'EDIT', 'director-a')
        : f.runtime.editUserAndRetry('play-a', 'question-a', 'EDIT', 'director-a')
      await assert.rejects(edit, e => e === f.failure)
      assert.equal(f.play().sessionId, 'director-a'); assert.equal(f.runtime.getDirector('play-a'), old)
      assert.equal(f.handles[0].disposals, 0); assert.deepEqual(f.branches.get('0'), before)
      for (const handle of f.handles.slice(1)) assert.equal(handle.disposals, 1)
    } finally { await f.runtime.dispose() }
  })
}

test('successful user edit clears inherited question enqueue and submits only edited text', async () => {
  const f = fixture()
  // Real followup enqueues before turn/start. The selected prefix can retain that enqueue.
  f.initialEvents.unshift({ type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, inserted: [question] } })
  f.initialEvents.splice(2, 0, { type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, removedCount: 1 } })
  f.initialEvents.forEach((e, seq) => e.seq = seq)
  try {
    await opened(f); f.branches.set('0', branch())
    await f.runtime.editUserAndRetry('play-a', 'question-a', 'EDITED_ONLY')
    await settled(f)
    const users = f.runtime.getDirector('play-a').session.snapshotEvents().filter(e => e.type === 'user/message')
    assert.equal(users.length, 1); assert.equal(users[0].data.content[0].text, 'EDITED_ONLY'); assert.equal(f.branches.size, 0)
  } finally { await f.runtime.dispose() }
})

test('repeated retry reuses one branch despite seed and inbox markers', async () => {
  const f = fixture()
  try {
    await opened(f)
    const first = await f.runtime.reroll('play-a', 'director-a'); await settled(f)
    const second = await f.runtime.reroll('play-a', first.play.sessionId); await settled(f)
    assert.equal(first.branch.key, second.branch.key); assert.equal(f.branches.size, 1)
    const branch = f.branches.get(second.branch.key)
    assert.equal(branch.variants.length, 3); assert.equal(branch.busy, false)
    assert.equal(swipeUserMessageId(branch), second.branch.userMessageId)
    assert.equal(branch.sessionId, second.play.sessionId)
  } finally { await f.runtime.dispose() }
})

test('legacy swipe derives selected question identity and commits the target identity', async () => {
  const f = fixture()
  try {
    await opened(f); f.branches.set('0', branch())
    const result = await f.runtime.swipe('play-a', '0', 1, 'director-a')
    assert.equal(result.branch.userMessageId, 'question-alt'); assert.equal(result.branch.sessionId, result.play.sessionId)
    assert.ok(JSON.stringify(f.runtime.getDirector('play-a').session.snapshotEvents()).includes('ANSWER_ALT'))
  } finally { await f.runtime.dispose() }
})

test('old swipe after a later reply rejects without truncating or disposing', async () => {
  const f = fixture()
  try {
    const agent = await opened(f); f.branches.set('0', branch())
    for (const event of completedTurn({ ...question, id: 'question-b' }, 'ANSWER_B', 2)) agent.events.push({ ...event, seq: agent.events.length })
    const before = agent.session.snapshotEvents()
    await assert.rejects(f.runtime.swipe('play-a', '0', 1), e => e.status === 409)
    assert.deepEqual(agent.session.snapshotEvents(), before); assert.equal(f.handles[0].disposals, 0); assert.equal(f.calls.create, 0)
  } finally { await f.runtime.dispose() }
})

for (const reason of ['running', 'stale-session', 'invalid-step']) {
  test(`swipe rejects ${reason} before preparing a new session`, async () => {
    const f = fixture()
    try {
      const agent = await opened(f); f.branches.set('0', branch())
      if (reason === 'running') agent.status = 'running'
      await assert.rejects(f.runtime.swipe('play-a', '0', reason === 'invalid-step' ? NaN : 1,
        reason === 'stale-session' ? 'wrong-session' : undefined), e => e.status === (reason === 'invalid-step' ? 400 : 409))
      assert.equal(f.calls.create, 0); assert.equal(f.handles[0].disposals, 0)
    } finally { await f.runtime.dispose() }
  })
}

test('swipe branch write failure leaves the old director and pointer usable', async () => {
  const f = fixture({ failBranch: true })
  try {
    const old = await opened(f); f.branches.set('0', branch())
    await assert.rejects(f.runtime.swipe('play-a', '0', 1), e => e === f.failure)
    assert.equal(f.runtime.getDirector('play-a'), old); assert.equal(f.play().sessionId, 'director-a')
    assert.equal(f.branches.get('0').current, 0); assert.equal(f.handles[0].disposals, 0)
  } finally { await f.runtime.dispose() }
})

test('overlapping edit/retry admission rejects before a second fork starts', async () => {
  const gate = deferred(), f = fixture({ createGate: gate })
  try {
    await opened(f)
    const first = f.runtime.editAssistant('play-a', 'answer-question-a', 'EDIT')
    const second = f.runtime.reroll('play-a')
    await assert.rejects(second, e => e.status === 409)
    gate.resolve(); await first
    assert.equal(f.calls.create, 1)
  } finally { gate.resolve(); await f.runtime.dispose() }
})

for (const mode of ['drop', 'dispose']) {
  test(`${mode} waits for an in-flight prepared director and prevents late publication`, async () => {
    const gate = deferred(), f = fixture({ createGate: gate })
    try {
      await opened(f)
      const edit = f.runtime.editAssistant('play-a', 'answer-question-a', 'EDIT')
      const rejected = assert.rejects(edit, e => e.status === 409)
      await tick()
      const stopped = mode === 'drop' ? f.runtime.dropPlay('play-a') : f.runtime.dispose()
      gate.resolve(); await Promise.all([rejected, stopped])
      assert.equal(f.runtime.getDirector('play-a'), undefined)
      assert.equal(f.play().sessionId, 'director-a')
      assert.ok(f.handles.every(h => h.disposals === 1))
    } finally { gate.resolve(); await f.runtime.dispose() }
  })
}

test('legacy raw-count branch survives repeated forks without a duplicate branch', async () => {
  const f = fixture()
  f.initialEvents.unshift({ type: 'session/end-seed', data: {} })
  f.initialEvents.forEach((event, seq) => { event.seq = seq })
  try {
    await opened(f)
    f.branches.set('1', { ...branch(), key: '1', prefix: [f.initialEvents[0]], variants: [f.initialEvents.slice(1)] })
    const first = await f.runtime.reroll('play-a'); await settled(f)
    const second = await f.runtime.reroll('play-a'); await settled(f)
    assert.equal(first.branch.key, '1'); assert.equal(second.branch.key, '1'); assert.equal(f.branches.size, 1)
    assert.equal(f.branches.get('1').variants.length, 3)
  } finally { await f.runtime.dispose() }
})

test('pending native input blocks an edit instead of discarding the queue', async () => {
  const f = fixture()
  try {
    const agent = await opened(f)
    agent.inbox.nextTurn.push({ ...question, id: 'pending-question' })
    await assert.rejects(f.runtime.editAssistant('play-a', 'answer-question-a', 'EDIT'), e => e.status === 409)
    assert.equal(f.calls.create, 0); assert.equal(agent.inbox.nextTurn.length, 1)
  } finally { await f.runtime.dispose() }
})

test('source traffic arriving during fork preparation leaves the old conversation active', async () => {
  const gate = deferred(), f = fixture({ createGate: gate })
  try {
    const agent = await opened(f)
    const edit = f.runtime.editAssistant('play-a', 'answer-question-a', 'EDIT')
    const rejected = assert.rejects(edit, e => e.status === 409)
    await tick()
    agent.followup({ ...question, id: 'arriving-question' })
    await agent.whenIdle()
    gate.resolve(); await rejected
    assert.equal(f.runtime.getDirector('play-a'), agent); assert.equal(f.play().sessionId, 'director-a')
    assert.equal(f.handles[0].disposals, 0)
  } finally { gate.resolve(); await f.runtime.dispose() }
})

test('a later failed turn without an assistant cannot swipe the previous answer away', async () => {
  const f = fixture()
  try {
    const agent = await opened(f); f.branches.set('0', branch())
    for (const event of completedTurn({ ...question, id: 'failed-question' }, 'unused', 2).filter(e => e.type !== 'assistant/message')) {
      agent.events.push({ ...event, seq: agent.events.length })
    }
    await assert.rejects(f.runtime.swipe('play-a', '0', 1), e => e.status === 409)
    assert.equal(f.handles[0].disposals, 0)
  } finally { await f.runtime.dispose() }
})

test('a turn with additional steering is not silently replayed or truncated', async () => {
  const f = fixture()
  try {
    const agent = await opened(f); f.branches.set('0', branch())
    agent.events.splice(2, 0, { type: 'user/message', data: { ...question, id: 'steering-question' }, surfaceOp: 'append' })
    agent.events.forEach((event, seq) => { event.seq = seq })
    await assert.rejects(f.runtime.reroll('play-a'), e => e.status === 409)
    await assert.rejects(f.runtime.swipe('play-a', '0', 1), e => e.status === 409)
    assert.equal(f.calls.create, 0); assert.equal(f.handles[0].disposals, 0)
  } finally { await f.runtime.dispose() }
})

test('failed stale-branch cleanup after a committed edit cannot undo that edited reply', async () => {
  const f = fixture()
  try {
    await opened(f); f.branches.set('0', branch())
    f.storage.deleteSwipeBranches = async () => { throw new Error('cleanup unavailable') }
    const edited = await f.runtime.editAssistant('play-a', 'answer-question-a', 'COMMITTED_EDIT')
    assert.notEqual(edited.sessionId, 'director-a')
    await assert.rejects(f.runtime.swipe('play-a', '0', 1), e => e.status === 409)
    assert.equal(f.calls.create, 1)
    assert.ok(JSON.stringify(f.runtime.getDirector('play-a').session.snapshotEvents()).includes('COMMITTED_EDIT'))
  } finally { await f.runtime.dispose() }
})

test('reply identity ignores incidental metadata but detects changed message contents', () => {
  assert.equal(sameReplyTail([...original, { type: 'metadata-fixture', data: {} }], original), true)
  const edited = structuredClone(original); edited[2].data.message.content[0].text = 'EDITED'
  assert.equal(sameReplyTail(edited, original), false)
})

test('fork comparison ignores only lineage-neutral seed/inbox markers', () => {
  assert.deepEqual(comparableForkEvents([...original, { type: 'session/end-seed' }, { type: 'agent/inbox/spliced' }]), comparableForkEvents(original))
})
