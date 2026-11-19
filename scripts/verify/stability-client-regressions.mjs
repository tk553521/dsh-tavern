import test from 'node:test'
import assert from 'node:assert/strict'
import {
  commitThenRefresh, createComposerDrafts, createMessageEditor, createOperationLock,
  matchingSwipe, operationBlockReason, replySeat, startRetryingPoll,
} from '../../src/client/stability.ts'
import { tavernApi } from '../../src/client/api.ts'
import { extractMessages } from '../../src/client/messages.ts'

// Execute production helpers/API directly. No copied handlers, React/DOM mocks,
// screenshots, HTTP server, profile dependencies or build outputs are involved.
function deferred() {
  let resolve, reject
  const promise = new Promise((a, b) => { resolve = a; reject = b })
  return { promise, resolve, reject }
}
const flush = () => new Promise(resolve => setImmediate(resolve))
const user = id => ({ kind: 'user', messageId: id, status: 'done' })
const assistant = id => ({ kind: 'assistant', messageId: id, status: 'done' })

for (const kind of ['user', 'assistant']) {
  test(`${kind} editor keeps failed draft open and closes only after successful retry`, async () => {
    const editor = createMessageEditor()
    editor.open('original step')
    editor.change('  changed step\nsecond speaker  ')
    const pending = deferred(), calls = []
    const saving = editor.save(text => { calls.push(text); return pending.promise })
    assert.equal(editor.getSnapshot().editing, true)
    assert.equal(editor.getSnapshot().saving, true)
    assert.equal(await editor.save(async () => { calls.push('duplicate') }), false)
    editor.cancel(); editor.change('overwrite while pending')
    assert.equal(editor.getSnapshot().draft, '  changed step\nsecond speaker  ')
    pending.reject(new Error('fixture failed commit'))
    assert.equal(await saving, false)
    assert.equal(editor.getSnapshot().editing, true)
    assert.equal(editor.getSnapshot().saving, false)
    assert.equal(editor.getSnapshot().error, 'fixture failed commit')
    editor.open('server original')
    assert.equal(editor.getSnapshot().draft, '  changed step\nsecond speaker  ')
    assert.deepEqual(calls, ['changed step\nsecond speaker'])
    const success = deferred()
    const retry = editor.save(() => success.promise)
    assert.equal(editor.getSnapshot().editing, true)
    success.resolve()
    assert.equal(await retry, true)
    assert.equal(editor.getSnapshot().editing, false)
    assert.equal(editor.getSnapshot().error, undefined)
  })
}

test('View-owned editor survives play/panel unsubscription and late failed save', async () => {
  for (const destination of ['other-play', 'library-panel']) {
    const drafts = createComposerDrafts()
    const editor = drafts.editor('play-a', 'assistant-step#1')
    const unsubscribe = editor.subscribe(() => {})
    editor.open('original whole step'); editor.change(`failed edit before ${destination}`)
    const pending = deferred(), save = editor.save(() => pending.promise)
    unsubscribe() // MessageRow/ChatPanel leaves, but the View-owned source stays.
    const other = drafts.editor('play-b', 'assistant-step#1')
    const otherSnapshot = other.getSnapshot()
    pending.reject(new Error(`save failed while at ${destination}`))
    assert.equal(await save, false)
    const returned = drafts.editor('play-a', 'assistant-step#1')
    assert.equal(returned, editor)
    assert.equal(returned.getSnapshot().editing, true)
    assert.equal(returned.getSnapshot().saving, false)
    assert.equal(returned.getSnapshot().draft, `failed edit before ${destination}`)
    assert.equal(returned.getSnapshot().error, `save failed while at ${destination}`)
    assert.equal(other.getSnapshot(), otherSnapshot)
    const resubscribe = returned.subscribe(() => {})
    assert.equal(await returned.save(async () => {}), true)
    resubscribe()
  }
})

test('editor registry isolates plays and speaker slices even within one durable step', () => {
  const drafts = createComposerDrafts()
  const first = drafts.editor('play-a', 'assistant-step#0')
  const tail = drafts.editor('play-a', 'assistant-step#1')
  const otherPlay = drafts.editor('play-b', 'assistant-step#0')
  assert.equal(drafts.editor('play-a', 'assistant-step#0'), first)
  assert.notEqual(first, tail)
  assert.notEqual(first, otherPlay)
  first.open('first slice draft')
  assert.equal(tail.getSnapshot().editing, false)
  assert.equal(otherPlay.getSnapshot().editing, false)
  tail.open('whole step draft'); tail.change('tail edit')
  assert.equal(first.getSnapshot().draft, 'first slice draft')
  assert.equal(tail.getSnapshot().draft, 'tail edit')
  assert.notEqual(drafts.editor('play:a', 'row'), drafts.editor('play', 'a:row'), 'tuple addresses do not collide')
})

test('editor handles synchronous commit errors and ignores blank drafts', async () => {
  const editor = createMessageEditor()
  editor.open(' ')
  assert.equal(await editor.save(async () => assert.fail('blank submitted')), false)
  editor.change('keep')
  assert.equal(await editor.save(() => { throw new Error('sync error') }), false)
  assert.equal(editor.getSnapshot().draft, 'keep')
  assert.equal(editor.getSnapshot().error, 'sync error')
})

test('committed edit closes after snapshot failure, while commit failure preserves it', async () => {
  const editor = createMessageEditor(), sequence = [], errors = []
  editor.open('original'); editor.change('changed')
  const saved = await editor.save(() => commitThenRefresh(
    async () => { sequence.push('commit'); return { sessionId: 'new-session' } },
    result => sequence.push(`publish:${result.sessionId}`),
    async () => { sequence.push('refresh'); throw new Error('snapshot unavailable') },
    error => errors.push(error.message),
  ).then(() => {}))
  assert.equal(saved, true)
  assert.equal(editor.getSnapshot().editing, false)
  assert.deepEqual(sequence, ['commit', 'publish:new-session', 'refresh'])
  assert.deepEqual(errors, ['snapshot unavailable'])
  editor.open('changed'); editor.change('keep failed draft')
  assert.equal(await editor.save(() => commitThenRefresh(
    async () => { throw new Error('commit failed') },
    () => assert.fail('failed commit published'),
    async () => assert.fail('failed commit refreshed'),
    () => assert.fail('commit error treated as refresh error'),
  ).then(() => {})), false)
  assert.equal(editor.getSnapshot().editing, true)
  assert.equal(editor.getSnapshot().draft, 'keep failed draft')
})

test('one operation guard rejects busy, running, unbound and stale play/session seats', () => {
  const state = { playId: 'play-a', sessionId: 'session-a', boundSessionId: 'session-a', running: false, busy: false }
  assert.equal(operationBlockReason(state, state), undefined)
  for (const patch of [
    { busy: true }, { running: true }, { boundSessionId: undefined },
    { boundSessionId: 'old-session' }, { playId: null }, { sessionId: undefined },
  ]) assert.equal(typeof operationBlockReason({ ...state, ...patch }), 'string')
  assert.equal(typeof operationBlockReason(state, { playId: 'play-b', sessionId: 'session-a' }), 'string')
  assert.equal(typeof operationBlockReason(state, { playId: 'play-a', sessionId: 'old-session' }), 'string')
})

test('synchronous lock serializes same-tick branch/send paths and releases after failure', async () => {
  const lock = createOperationLock(), pending = deferred(), entered = []
  const first = lock.run(() => { entered.push('branch'); return pending.promise })
  assert.equal(lock.busy, true)
  await assert.rejects(lock.run(async () => { entered.push('send') }), /正在处理/)
  assert.deepEqual(entered, ['branch'])
  pending.reject(new Error('fixture branch failure'))
  await assert.rejects(first, /branch failure/)
  assert.equal(lock.busy, false)
  await assert.rejects(lock.run(() => { throw new Error('sync failure') }), /sync failure/)
  assert.equal(lock.busy, false)
  assert.equal(await lock.run(async () => 'success'), 'success')
})

test('retry seat is only the current tail assistant and shares its nearest user id', () => {
  const messages = [user('question-a'), assistant('run-1'), assistant('run-2')]
  assert.deepEqual(replySeat(messages), { assistantIndex: 2, userMessageId: 'question-a' })
  assert.deepEqual(replySeat([...messages, user('question-b')]), { assistantIndex: -1 })
  assert.deepEqual(replySeat([]), { assistantIndex: -1 })
  assert.deepEqual(replySeat([assistant('opening')]), { assistantIndex: 0 })
})

function chatProjectionFixture(nodes) {
  return { order: nodes.map(([key]) => key), nodes: new Map(nodes) }
}
function openingNodes() {
  return [
    ['opening-user-key', { id: 'opening-user-persistent', kind: 'user', data: { content: [{ type: 'text', text: '[开场] 扮演开始。' }] } }],
    ['opening-step', { id: 'opening-step-node', kind: 'assistant-step', data: {
      status: 'settled', turn: 0, blocks: [
        { kind: 'reasoning', text: 'opening thoughts' },
        { kind: 'text', text: 'Alice：开场第一句\nBob：开场第二句' },
      ], finalNode: { messageId: 'opening-reply-persistent' },
    } }],
  ]
}

test('actual projection retains hidden opening owner and exposes its two-variant Swipe seat', () => {
  const rows = extractMessages(chatProjectionFixture(openingNodes()), ['Alice', 'Bob'])
  assert.equal(rows.length, 2)
  assert.ok(rows.every(row => row.kind === 'assistant'))
  assert.ok(rows.every(row => row.userMessageId === 'opening-user-persistent'))
  assert.deepEqual(rows.map(row => row.id), ['opening-step#0', 'opening-step#1'])
  assert.equal(rows[0].messageId, undefined, 'only the final speaker owns edit/retry')
  assert.equal(rows[1].messageId, 'opening-reply-persistent', 'opening retry remains available')
  assert.equal(rows[1].status, 'done')
  assert.equal(rows[1].stepText, 'Alice：开场第一句\nBob：开场第二句')
  assert.equal(rows[0].thinking, 'opening thoughts')
  assert.equal(rows[1].thinking, undefined)
  assert.deepEqual(replySeat(rows), { assistantIndex: 1, userMessageId: 'opening-user-persistent' })
  assert.deepEqual(replySeat([user('stale-visible-user'), ...rows]), { assistantIndex: 2, userMessageId: 'opening-user-persistent' }, 'assistant ownership outranks visible-user fallback')
  const branch = { playId: 'play-a', key: 'opening-branch', userMessageId: 'opening-user-persistent', sessionId: 'session-a', count: 2, current: 1, updatedAt: '2' }
  assert.equal(matchingSwipe([branch], { playId: 'play-a', sessionId: 'session-a' }, rows), branch)
})

test('actual projection removes opening seat on a new user and addresses subsequent hidden users', () => {
  const nodes = openingNodes()
  const branch = { playId: 'play-a', key: 'opening-branch', userMessageId: 'opening-user-persistent', count: 2, updatedAt: '2' }
  const address = { playId: 'play-a', sessionId: 'session-a' }
  nodes.push(['new-user-key', { id: 'new-user-persistent', kind: 'user', data: { content: [{ type: 'text', text: '下一问' }] } }])
  let rows = extractMessages(chatProjectionFixture(nodes), ['Alice', 'Bob'])
  assert.deepEqual(replySeat(rows), { assistantIndex: -1 })
  assert.equal(matchingSwipe([branch], address, rows), undefined)
  nodes.push(['new-step', { id: 'new-step-node', kind: 'assistant-step', data: {
    status: 'settled', blocks: [{ kind: 'text', text: 'Bob：下一问的回答' }], finalNode: { messageId: 'new-reply' },
  } }])
  rows = extractMessages(chatProjectionFixture(nodes), ['Alice', 'Bob'])
  assert.equal(rows.at(-1).userMessageId, 'new-user-persistent')
  assert.equal(matchingSwipe([branch], address, rows), undefined)
  nodes.push(['empty-steering', { id: 'empty-steering-persistent', kind: 'steering', data: { content: [] } }])
  nodes.push(['steered-step', { id: 'steered-step-node', kind: 'assistant-step', data: {
    status: 'settled', blocks: [{ kind: 'text', text: 'Alice：继续' }], finalNode: { messageId: 'steered-reply' },
  } }])
  rows = extractMessages(chatProjectionFixture(nodes), ['Alice', 'Bob'])
  assert.equal(rows.at(-1).userMessageId, 'empty-steering-persistent')
  assert.equal(replySeat(rows).userMessageId, 'empty-steering-persistent')
})

test('Swipe matches user plus optional session; old A metadata never sits on reply B', () => {
  const address = { playId: 'play-a', sessionId: 'session-a' }
  const valid = { playId: 'play-a', key: 'a', userMessageId: 'question-a', sessionId: 'session-a', updatedAt: '2' }
  const legacy = { playId: 'play-a', key: 'legacy', userMessageId: 'question-a', updatedAt: '1' }
  const wrongSession = { ...valid, key: 'wrong-session', sessionId: 'old-session', updatedAt: '9' }
  const wrongPlay = { ...valid, playId: 'play-b', updatedAt: '9' }
  const unaddressed = { playId: 'play-a', key: 'unaddressed', updatedAt: '9' }
  const branches = [legacy, valid, wrongSession, wrongPlay, unaddressed]
  const a = [user('question-a'), assistant('reply-a')]
  assert.equal(matchingSwipe(branches, address, a), valid)
  assert.equal(matchingSwipe([legacy], address, a), legacy)
  assert.equal(matchingSwipe([wrongSession, unaddressed], address, a), undefined)
  assert.equal(matchingSwipe(branches, address, [...a, user('question-b'), assistant('reply-b')]), undefined)
  assert.equal(matchingSwipe(branches, address, [...a, user('question-b')]), undefined)
  const replayed = { ...valid, userMessageId: 'replayed-question-a', sessionId: 'replayed-session' }
  assert.equal(matchingSwipe([replayed], { playId: 'play-a', sessionId: 'replayed-session' }, [user('replayed-question-a'), assistant('reply-replayed')]), replayed)
})

test('failed send restores exact A draft without changing B, even after subscriber remount', () => {
  const drafts = createComposerDrafts()
  let changes = 0
  const unsubscribe = drafts.subscribe(() => { changes += 1 })
  drafts.set('play-a', '  A question\n ')
  const send = drafts.begin('play-a')
  assert.equal(send.content, 'A question')
  assert.equal(drafts.get('play-a').text, '')
  assert.equal(drafts.begin('play-a'), undefined, 'same-tick second Enter has no text to submit')
  drafts.set('play-b', 'B draft')
  const b = drafts.get('play-b')
  unsubscribe()
  drafts.fail(send, new Error('A failed while B visible'))
  assert.equal(drafts.get('play-a').text, '  A question\n ')
  assert.equal(drafts.get('play-b'), b)
  assert.equal(changes, 3)
  const resubscribe = drafts.subscribe(() => {})
  assert.equal(drafts.get('play-a').error, 'A failed while B visible')
  resubscribe()
})

test('newer/cleared drafts win while failed text remains explicitly recoverable', () => {
  const drafts = createComposerDrafts()
  drafts.set('play-a', 'failed text')
  const send = drafts.begin('play-a')
  drafts.set('play-a', 'new text')
  drafts.fail(send, 'failure')
  assert.equal(drafts.get('play-a').text, 'new text')
  assert.deepEqual(drafts.get('play-a').failures, ['failed text'])
  drafts.recover('play-a')
  assert.equal(drafts.get('play-a').text, 'new text\nfailed text')
  assert.deepEqual(drafts.get('play-a').failures, [])
  const cleared = drafts.begin('play-a')
  drafts.set('play-a', 'intervening text'); drafts.set('play-a', '')
  drafts.fail(cleared, 'late failure')
  assert.equal(drafts.get('play-a').text, '', 'an intentional clear is not mistaken for untouched input')
  assert.equal(drafts.get('play-a').failures.length, 1)
})

function fakeScheduler() {
  const tasks = []
  return {
    tasks,
    schedule(task, delay) {
      const entry = { task, delay, cancelled: false, fired: false }
      tasks.push(entry)
      return () => { entry.cancelled = true }
    },
    async next() {
      const entry = tasks.find(task => !task.cancelled && !task.fired)
      assert.ok(entry, 'expected a scheduled poll')
      entry.fired = true; entry.task(); await flush()
      return entry
    },
  }
}

test('busy polling re-arms after transient failure, backs off and cancels cleanly', async () => {
  const timer = fakeScheduler(), errors = []
  let calls = 0
  const stop = startRetryingPoll(async () => { calls += 1; if (calls === 1) throw new Error('offline') }, error => errors.push(error.message), timer.schedule)
  assert.equal((await timer.next()).delay, 800)
  assert.deepEqual(errors, ['offline'])
  assert.equal((await timer.next()).delay, 1600)
  assert.equal(calls, 2)
  assert.equal(timer.tasks.at(-1).delay, 800)
  stop()
  assert.equal(timer.tasks.at(-1).cancelled, true)
})

test('disposed in-flight poll publishes no late error or replacement timer', async () => {
  const timer = fakeScheduler(), pending = deferred(), errors = []
  const stop = startRetryingPoll(() => pending.promise, error => errors.push(error), timer.schedule)
  await timer.next(); stop()
  pending.reject(new Error('late error')); await flush()
  assert.deepEqual(errors, [])
  assert.equal(timer.tasks.length, 1)
})

test('actual client API carries expectedSessionId for every branch operation and preserves legacy calls', async () => {
  const originalFetch = globalThis.fetch, calls = []
  globalThis.fetch = async (path, init) => {
    calls.push({ path, method: init.method, body: JSON.parse(init.body) })
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
  }
  try {
    await tavernApi.retryReply('play/a', 'session-a')
    await tavernApi.swipeReply('play/a', 'branch-a', -1, 'session-a')
    await tavernApi.editAssistantMessage('play/a', 'message/a', 'edit', 'session-a')
    await tavernApi.editUserMessageAndRetry('play/a', 'message/a', 'edit user', 'session-a')
    assert.deepEqual(calls.map(call => call.body), [
      { expectedSessionId: 'session-a' }, { key: 'branch-a', step: -1, expectedSessionId: 'session-a' },
      { text: 'edit', expectedSessionId: 'session-a' }, { text: 'edit user', expectedSessionId: 'session-a' },
    ])
    assert.ok(calls.every(call => call.path.startsWith('/tavern/plays/play%2Fa/')))
    assert.deepEqual(calls.map(call => call.method), ['POST', 'POST', 'PUT', 'POST'])
    await tavernApi.retryReply('play-a')
    assert.deepEqual(calls.at(-1).body, {})
    globalThis.fetch = async () => new Response('{"error":"stale session"}', { status: 409 })
    await assert.rejects(tavernApi.editAssistantMessage('play-a', 'message-a', 'draft', 'old-session'), /stale session/)
  } finally { globalThis.fetch = originalFetch }
})
