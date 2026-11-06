// Verification of the world-info activation engine.
// Run with `npm run verify` (needs Node >= 23.6 for native TypeScript).
import { activateBook, activateBooks, renderWorldInfo, hashSeed } from '../../src/lorebook.ts'

const log = []
const check = (name, ok, extra = '') => {
  log.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`)
  if (!ok) process.exitCode = 1
}

let nextUid = 1
/** An entry carrying the same defaults cardcodec.normalize produces. */
const entry = (over = {}) => ({
  uid: nextUid++, key: [], keysecondary: [], comment: '', content: 'C',
  constant: false, vectorized: false, selective: true, selectiveLogic: 0,
  addMemo: false, order: 100, position: 0, disable: false, ignoreBudget: false,
  excludeRecursion: false, preventRecursion: false, matchPersonaDescription: false,
  matchCharacterDescription: false, matchCharacterPersonality: false,
  matchCharacterDepthPrompt: false, matchScenario: false, matchCreatorNotes: false,
  delayUntilRecursion: 0, probability: 100, useProbability: true,
  depth: 4, outletName: '', group: '', groupOverride: false, groupWeight: 100,
  scanDepth: null, caseSensitive: null, matchWholeWords: null, useGroupScoring: null,
  automationId: '', role: 0, sticky: null, cooldown: null, delay: null,
  triggers: [], extensions: {}, ...over,
})
const run = (entries, scan) => activateBook({ entries }, { depth: 0, seed: 1, ...scan })
const runBooks = (books, scan) =>
  activateBooks(books.map(entries => ({ entries })), { depth: 0, seed: 1, ...scan })
const ids = result => result.map(a => a.entry.uid).join(',')

// ── the headline regression: depth no longer gates activation ──
{
  const e = entry({ key: ['dragon'], depth: 4 })
  check('entry with default depth:4 activates on turn 0',
    run([e], { text: 'a dragon appears' }).length === 1)
}
{
  const e = entry({ key: ['dragon'], delay: 3 })
  check('delay gates before its turn', run([e], { text: 'dragon', depth: 1 }).length === 0)
  check('delay opens at its turn', run([e], { text: 'dragon', depth: 3 }).length === 1)
}

// ── selective logic ──
{
  const base = { key: ['alice'], keysecondary: ['sword'], selective: true }
  const text = 'alice holds a sword'
  const onlyPrimary = 'alice waves'
  check('AND_ANY needs a secondary hit',
    run([entry({ ...base, selectiveLogic: 0 })], { text }).length === 1
    && run([entry({ ...base, selectiveLogic: 0 })], { text: onlyPrimary }).length === 0)
  check('NOT_ANY excludes when secondary present',
    run([entry({ ...base, selectiveLogic: 2 })], { text }).length === 0
    && run([entry({ ...base, selectiveLogic: 2 })], { text: onlyPrimary }).length === 1)
  const two = { key: ['alice'], keysecondary: ['sword', 'shield'], selective: true }
  check('AND_ALL needs every secondary',
    run([entry({ ...two, selectiveLogic: 3 })], { text: 'alice sword shield' }).length === 1
    && run([entry({ ...two, selectiveLogic: 3 })], { text: 'alice sword' }).length === 0)
  check('NOT_ALL passes unless every secondary hit',
    run([entry({ ...two, selectiveLogic: 1 })], { text: 'alice sword' }).length === 1
    && run([entry({ ...two, selectiveLogic: 1 })], { text: 'alice sword shield' }).length === 0)
  check('secondary key alone never activates',
    run([entry({ key: ['alice'], keysecondary: ['sword'] })], { text: 'just a sword' }).length === 0)
}

// ── constant passes through probability and groups ──
{
  const e = entry({ constant: true, useProbability: true, probability: 0 })
  check('constant still obeys probability 0', run([e], { text: '' }).length === 0)
  const g1 = entry({ constant: true, group: 'weather', groupWeight: 100 })
  const g2 = entry({ constant: true, group: 'weather', groupWeight: 100 })
  check('constant members of one group are mutually exclusive',
    run([g1, g2], { text: '' }).length === 1)
}

// ── determinism ──
{
  const entries = Array.from({ length: 20 }, () =>
    entry({ key: ['x'], useProbability: true, probability: 50 }))
  const a = ids(run(entries, { text: 'x', seed: 7 }))
  const b = ids(run(entries, { text: 'x', seed: 7 }))
  const c = ids(run(entries, { text: 'x', seed: 8 }))
  check('same seed gives identical activation', a === b, `a=${a.slice(0, 20)}`)
  check('different seed varies activation', a !== c)
  check('probability actually filters', a.split(',').filter(Boolean).length < 20)
}

// ── regex keys ──
{
  const e = entry({ key: [], keyregex: 'drag[oa]n' })
  check('regex-only entry (no literal keys) activates',
    run([e], { text: 'a dragon roars' }).length === 1)
  check('regex-only entry does not over-match',
    run([e], { text: 'a cat' }).length === 0)
  const st = entry({ key: [], keyregex: '/ALICE/i' })
  check('ST /pattern/flags spelling honored', run([st], { text: 'alice' }).length === 1)
}
{
  const evil = entry({ key: [], keyregex: '(a+)+$' })
  const text = 'a'.repeat(2000) + 'b'
  const t0 = Date.now()
  const result = run([evil], { text })
  const ms = Date.now() - t0
  check('catastrophic regex refused, not evaluated', result.length === 0 && ms < 200, `${ms}ms`)
}
// Ambiguous alternation: the body of the group holds no quantifier, so the
// old "nested quantifier" guard never fired and a mere 26 characters already
// cost seconds. Must be refused before compilation, i.e. in microseconds.
{
  for (const pattern of ['(a|a)*c', '(?:a|a)+$', '(a|ab)+$', '(?:(a|b))+$']) {
    const evil = entry({ key: [], keyregex: pattern })
    const text = 'a'.repeat(40)
    const t0 = Date.now()
    const result = run([evil], { text })
    const ms = Date.now() - t0
    check(`ambiguous alternation refused, not evaluated: ${pattern}`,
      result.length === 0 && ms < 50, `${ms}ms`)
  }
}

// ── CJK whole-word matching (ST treats CJK as a word boundary; we must too) ──
{
  const zhang = '张三' // 张三
  const sentence = '我认识张三了' // 我认识张三了
  const e = entry({ key: [zhang], matchWholeWords: true })
  check('CJK whole-word key matches inside a sentence',
    run([e], { text: sentence }).length === 1)
  const en = entry({ key: ['cat'], matchWholeWords: true })
  check('English whole-word still excludes substrings',
    run([en], { text: 'concatenate' }).length === 0
    && run([en], { text: 'a cat sat' }).length === 1)
}
{
  check('keys are trimmed on match',
    run([entry({ key: ['  alice  '] })], { text: 'alice' }).length === 1)
}

// ── groups are weighted, not highest-wins ──
{
  const seen = new Set()
  for (let seed = 0; seed < 200; seed++) {
    const heavy = entry({ uid: 901, key: ['x'], group: 'g', groupWeight: 100 })
    const light = entry({ uid: 902, key: ['x'], group: 'g', groupWeight: 50 })
    const picked = run([heavy, light], { text: 'x', seed })
    picked.forEach(p => seen.add(p.entry.uid))
  }
  check('a lower-weight group member can still win', seen.has(902) && seen.has(901),
    `seen=${[...seen].join(',')}`)
  const over = entry({ uid: 903, key: ['x'], group: 'g', groupWeight: 1, groupOverride: true })
  const plain = entry({ uid: 904, key: ['x'], group: 'g', groupWeight: 999 })
  check('groupOverride wins outright', ids(run([over, plain], { text: 'x' })) === '903')
  const multi = entry({ key: ['x'], group: 'a, b' })
  check('comma-separated group names parse', run([multi], { text: 'x' }).length === 1)
}

// ── ordering uses `order`, not the position enum ──
{
  const first = entry({ uid: 801, key: ['x'], order: 10, position: 4 })
  const second = entry({ uid: 802, key: ['x'], order: 90, position: 0 })
  check('rendered in ascending order (ST appends larger order last)',
    ids(run([second, first], { text: 'x' })) === '801,802')
}

// ── budget ──
{
  const big = Array.from({ length: 50 }, (_, i) =>
    entry({ uid: 700 + i, key: ['x'], order: i, content: 'y'.repeat(500) }))
  const result = run(big, { text: 'x' })
  const text = renderWorldInfo(result)
  check('budget caps the injected block', result.length < 50 && result.length > 0,
    `admitted=${result.length}`)
  check('rendered block stays inside the budget', text.length <= 8000, `chars=${text.length}`)
  // ST admits by DESCENDING order, so the last entries (order 49…) win the
  // budget; uid 700 (order 0) is the first one dropped, not the first kept.
  const orders = result.map(a => a.entry.order)
  check('budget keeps the highest author priority (ST: larger order wins)',
    orders.includes(49) && !orders.includes(0), `orders=${orders.join(',')}`)
}
{
  // The audit's reproduction: two equal entries, a budget that fits one.
  const low = entry({ uid: 811, key: ['x'], order: 10, content: 'y'.repeat(500) })
  const high = entry({ uid: 812, key: ['x'], order: 90, content: 'y'.repeat(500) })
  const result = run([low, high], { text: 'x', budgetChars: 600 })
  check('order 90 survives a 600-char budget, order 10 is dropped',
    result.length === 1 && result[0].entry.uid === 812, ids(result))
}

// ── one budget shared by every book, not one per book ──
{
  const first = Array.from({ length: 30 }, (_, i) =>
    entry({ uid: 1000 + i, key: ['x'], order: i, content: 'y'.repeat(500) }))
  const second = Array.from({ length: 30 }, (_, i) =>
    entry({ uid: 2000 + i, key: ['x'], order: 100 + i, content: 'y'.repeat(500) }))
  const result = runBooks([first, second], { text: 'x', budgetChars: 8000 })
  const rendered = renderWorldInfo(result).length
  check('multi-book budget is shared, not per book',
    rendered <= 8000 && result.length < 60, `entries=${result.length} chars=${rendered}`)
  check('multi-book admission is global by order (book 2 outranks book 1)',
    result.every(a => a.entry.order >= 100),
    `orders=${result.map(a => a.entry.order).join(',')}`)
}

// ── rendering ──
{
  const e = entry({ key: ['x'], content: 'line one\nline two' })
  const text = renderWorldInfo(run([e], { text: 'x' }))
  check('multi-line content is indented under its bullet',
    text.includes('- line one\n  line two'), JSON.stringify(text))
  check('empty activation renders nothing', renderWorldInfo([]) === '')
}

// ── seeding helper ──
{
  check('hashSeed is stable', hashSeed('play-1:3') === hashSeed('play-1:3'))
  check('hashSeed separates turns', hashSeed('play-1:3') !== hashSeed('play-1:4'))
}

console.log(log.join('\n'))
