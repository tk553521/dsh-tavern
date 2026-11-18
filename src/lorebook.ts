/**
 * World-book (lorebook) activation: match entry keys against scan text,
 * honor SillyTavern's selective/probability/group semantics, and order the
 * active entries for prompt insertion.
 *
 * Implemented ST semantics: `disable`, `constant`, primary `key` matching,
 * `keysecondary` + `selectiveLogic` (AND_ANY / NOT_ALL / NOT_ANY / AND_ALL),
 * `keyregex` (with a ReDoS guard), `caseSensitive`, `matchWholeWords`,
 * `probability` + `useProbability`, `delay`, inclusion `group` with weighted
 * selection and `groupOverride`, `order` sorting, and a token budget.
 *
 * Deliberately NOT implemented (fields exist on the type and round-trip on
 * import/export, but do not affect activation): recursive scanning
 * (`excludeRecursion` / `preventRecursion` / `delayUntilRecursion`), timed
 * effects (`sticky` / `cooldown`), per-entry `scanDepth`, `vectorized`, the
 * `match*` scan-source switches, `position` placement (everything is rendered
 * into one block), and `role`. Do not assume a field works because it parses.
 */

import type { WorldBookEntry } from './types.ts'
import { stripPromptVariables } from './prompt.ts'

/** Activation context: the text to scan plus the message depth. */
export interface LoreScan {
  /** Text scanned for keys (recent user/assistant lines, newest last). */
  text: string
  /** Current message depth from the start of the play (0-based). */
  depth: number
  /**
   * Seed for probability and group rolls. Rolls must be deterministic for a
   * given (seed, entry): the world book is re-rendered on EVERY prompt
   * assembly, so a `Math.random` roll made an entry blink in and out between
   * turns — the model saw a self-contradicting world — and rewrote the system
   * prompt each time, invalidating the whole session's prefix cache.
   */
  seed?: number
  /** Roll override; injectable for deterministic tests. */
  roll?: (entry: WorldBookEntry) => number
  /**
   * Character ceiling for the rendered block, overriding {@link DEFAULT_BUDGET_CHARS}
   * and any book-level `token_budget`. Supplied from the plugin config so the
   * limit is tunable without editing source. One ceiling covers every book of
   * an {@link activateBooks} call, not one per book.
   */
  budgetChars?: number
}

export interface ActivatedEntry {
  entry: WorldBookEntry
  /** Matched keys (for diagnostics). */
  matchedKeys: string[]
}

/** SillyTavern `selectiveLogic` values. */
const AND_ANY = 0
const NOT_ALL = 1
const NOT_ANY = 2
const AND_ALL = 3

/**
 * Ceiling on rendered world-info characters. ST has a real token budget; this
 * is the cheap equivalent that stops a 25k-entry book whose keys all matched
 * from blowing out the context window. It is ONE ceiling shared by every book
 * bound to a play ({@link activateBooks}): applying it inside each single-book
 * activation multiplied the injected block by the number of books.
 */
const DEFAULT_BUDGET_CHARS = 8000

/** First line of every rendered block; it is charged against the budget too. */
const WORLD_INFO_HEADER = '[世界书 / World Info]'

/** Longest scan text handed to a regex, bounding worst-case backtracking. */
const MAX_REGEX_SCAN = 4000

/** Longest accepted `keyregex` pattern. */
const MAX_REGEX_SOURCE = 256

/** 32-bit string hash (FNV-1a), for seeding the per-entry PRNG. */
function hash32(text: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

/** Derive a {@link LoreScan.seed} from any stable string (play id + turn). */
export function hashSeed(text: string): number {
  return hash32(text)
}

/** mulberry32: small, fast, well-distributed PRNG for reproducible rolls. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** The default deterministic roll for one scan. */
function defaultRoll(seed: number): (entry: WorldBookEntry) => number {
  return entry => mulberry32(hash32(`${seed}:${entry.uid}`))()
}

/** Escape a literal for embedding in a regex. */
function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Reject `keyregex` patterns whose evaluation could blow up.
 *
 * World books are fully third-party content and `activateBook` runs
 * SYNCHRONOUSLY inside prompt assembly, so a catastrophically backtracking
 * pattern freezes the entire host event loop, not just one session (`(a+)+$`
 * against a few hundred characters is already seconds). JavaScript has no
 * regex timeout, so the mitigation is structural: bound the pattern, bound the
 * input per pattern, and refuse the constructs that make exponential
 * backtracking easy.
 *
 * This is a conservative filter, not a proof of safety; it is paired with
 * {@link regexScanLimit}, which is what actually caps the damage.
 */
function regexLooksSafe(source: string): boolean {
  if (source.length > MAX_REGEX_SOURCE) return false
  // Backreferences force the engine into backtracking search.
  if (/\\[1-9]/.test(source)) return false
  // A quantified group whose body is itself quantified — the classic (a+)+.
  if (/\([^)]*[+*}][^)]*\)\s*[+*{]/.test(source)) return false
  // Unbounded repetition counts, e.g. {1,}{2,}.
  if (/\{\d+,\}\s*[+*{]/.test(source)) return false
  // Ambiguous alternation: a REPEATED group whose body offers several
  // alternatives — (a|a)*c, (?:a|ab)+$ — backtracks exponentially even though
  // the body holds no quantifier of its own, which is exactly why the rule
  // above never fired on it. A flat regex cannot see through nesting, so walk
  // the pattern; refusing `(foo|bar)+` as well is the accepted trade-off.
  if (hasRepeatedAlternation(source)) return false
  return true
}

/**
 * Whether any repeated group can be matched by more than one decomposition.
 *
 * Walks the pattern once (honoring escapes and character classes) and marks
 * every open group whose body contains an alternation or a quantifier. A group
 * that is followed by `*`, `+` or `{` and carries such a body is ambiguous:
 * `(a|a)*` can split `aaaa` into 2^n ways, and `(aa|a)+` does the same with a
 * different spelling. The mark propagates outward, so `((a|b)c)+` is caught
 * too.
 */
function hasRepeatedAlternation(source: string): boolean {
  // One flag per open group: does its body offer alternatives?
  const groups: boolean[] = []
  let inClass = false
  for (let index = 0; index < source.length; index++) {
    const char = source[index]!
    if (char === '\\') {
      index++
      continue
    }
    if (inClass) {
      if (char === ']') inClass = false
      continue
    }
    if (char === '[') {
      inClass = true
      continue
    }
    if (char === '(') {
      groups.push(false)
      continue
    }
    if (char === ')') {
      const ambiguous = groups.pop() ?? false
      // A quantifier on the closing paren repeats an ambiguous body.
      const quantified = /[*+{]/.test(source[index + 1] ?? '')
      if (ambiguous && quantified) return true
      if (groups.length > 0 && (ambiguous || quantified)) {
        groups[groups.length - 1] = true
      }
      continue
    }
    if (char === '|' || char === '*' || char === '+' || char === '{') {
      if (groups.length > 0) groups[groups.length - 1] = true
    }
  }
  return false
}

/**
 * Scan-text ceiling for one compiled pattern.
 *
 * Backtracking cost grows with the input, so a flat {@link MAX_REGEX_SCAN} is
 * no bound at all once the engine goes exponential: a short key gets ~200
 * characters of context, every extra pattern character buys 40 more, and the
 * flat maximum is still the hard top.
 */
function regexScanLimit(patternLength: number): number {
  return Math.min(MAX_REGEX_SCAN, 200 + 40 * patternLength)
}

/** Compiled-regex cache; recompiling per entry per assembly is pure waste. */
const regexCache = new Map<string, RegExp | null>()

/**
 * Compile one `keyregex`, honoring ST's `/pattern/flags` spelling.
 * @returns the compiled regex, or null when absent, malformed, or unsafe.
 */
function compileKeyRegex(source: string, caseSensitive: boolean): RegExp | null {
  const cacheKey = `${caseSensitive ? 'S' : 'i'}\u0000${source}`
  const cached = regexCache.get(cacheKey)
  if (cached !== undefined) return cached
  let pattern = source
  let flags = caseSensitive ? '' : 'i'
  // ST stores regex keys as /pattern/flags; honor the author's own flags
  // instead of overriding them with the entry's caseSensitive setting.
  const delimited = /^\/(.+)\/([gimsuy]*)$/s.exec(source)
  if (delimited !== null) {
    pattern = delimited[1]!
    flags = delimited[2]!.replace(/[gy]/g, '')
    if (!caseSensitive && !flags.includes('i')) flags += 'i'
  }
  let compiled: RegExp | null = null
  if (regexLooksSafe(pattern)) {
    try {
      compiled = new RegExp(pattern, flags)
    } catch {
      compiled = null
    }
  }
  if (regexCache.size > 512) regexCache.clear()
  regexCache.set(cacheKey, compiled)
  return compiled
}

/**
 * Whole-word match with SillyTavern's boundary class.
 *
 * ST uses `\W`, under which CJK characters ARE boundaries. An earlier
 * `[^\p{L}\p{N}_]` class treated them as word characters, so the key `张三`
 * failed to match `我认识张三了` — whole-word matching was effectively broken
 * for every Chinese key. ST also skips whole-word logic for keys containing
 * whitespace, falling back to substring matching.
 */
function wholeWordMatch(needle: string, haystack: string): boolean {
  if (/\s/.test(needle)) return haystack.includes(needle)
  return new RegExp(`(?:^|\\W)${escapeRegex(needle)}(?=\\W|$)`).test(haystack)
}

/** Match one literal key against the scan text. */
function literalMatches(key: string, scan: LoreScan, entry: WorldBookEntry): boolean {
  const caseSensitive = entry.caseSensitive ?? false
  const needle = caseSensitive ? key : key.toLowerCase()
  const haystack = caseSensitive ? scan.text : scan.text.toLowerCase()
  if (needle === '') return false
  return (entry.matchWholeWords ?? false)
    ? wholeWordMatch(needle, haystack)
    : haystack.includes(needle)
}

/** Trimmed, non-empty key list. ST trims keys; imports routinely carry " Alice". */
function cleanKeys(keys: readonly string[] | undefined): string[] {
  return (keys ?? []).map(key => key.trim()).filter(key => key !== '')
}

/**
 * Whether one entry's keys select it for this scan.
 * @returns the matched primary keys, or null when the entry does not activate.
 */
function matchKeys(entry: WorldBookEntry, scan: LoreScan): string[] | null {
  // A regex key is its own branch. It used to be evaluated inside the literal
  // key loop, which never ran when `key` was empty — the natural way to author
  // a regex-only entry — so those entries could never activate at all.
  let matched: string[]
  if (typeof entry.keyregex === 'string' && entry.keyregex !== '') {
    const compiled = compileKeyRegex(entry.keyregex, entry.caseSensitive ?? false)
    if (compiled === null) return null
    // Bound input before matching; regex hits still obey secondary filters.
    const limit = regexScanLimit(compiled.source.length)
    const text = scan.text.length > limit ? scan.text.slice(-limit) : scan.text
    if (!compiled.test(text)) return null
    matched = [entry.keyregex]
  } else {
    const primary = cleanKeys(entry.key)
    if (primary.length === 0) return null
    matched = primary.filter(key => literalMatches(key, scan, entry))
    if (matched.length === 0) return null
  }

  // Secondary keys FILTER a primary hit; they never activate on their own.
  // Merging both lists into one OR set (the previous behaviour) both
  // over-activated and inverted NOT_ANY / NOT_ALL, turning an author's
  // deliberate spoiler guard into a spoiler leak.
  const secondary = cleanKeys(entry.keysecondary)
  if (!entry.selective || secondary.length === 0) return matched
  const hits = secondary.filter(key => literalMatches(key, scan, entry))
  let passes: boolean
  switch (entry.selectiveLogic) {
    case NOT_ALL:
      passes = hits.length < secondary.length
      break
    case NOT_ANY:
      passes = hits.length === 0
      break
    case AND_ALL:
      passes = hits.length === secondary.length
      break
    case AND_ANY:
    default:
      // AND_ANY (0) is ST's default, and the safe reading of an unknown value.
      passes = hits.length > 0
      break
  }
  return passes ? [...matched, ...hits] : null
}

/** Inclusion-group names of one entry (ST allows a comma-separated list). */
function groupNames(entry: WorldBookEntry): string[] {
  return (entry.group ?? '')
    .split(',')
    .map(name => name.trim())
    .filter(name => name !== '')
}

/** One entry that passed key matching and is competing for its group. */
interface Candidate {
  entry: WorldBookEntry
  matchedKeys: string[]
  /** Position inside its book, used as a stable tie-break. */
  index: number
  /** Position of the owning book in the play's list, tie-break across books. */
  bookIndex: number
}

/**
 * Pick one winner per inclusion group, weighted by `groupWeight`.
 *
 * ST draws a weighted random member; the previous implementation always chose
 * the highest weight, so a `groupWeight: 50` member could never appear and
 * every "random encounter / random weather" group emitted the same entry
 * forever. `groupOverride` members are ST's priority entries and win outright.
 */
function pickGroupWinner(
  members: readonly Candidate[],
  roll: (entry: WorldBookEntry) => number,
): Candidate {
  const overrides = members.filter(member => member.entry.groupOverride)
  const pool = overrides.length > 0 ? overrides : members
  if (pool.length === 1) return pool[0]!
  const weights = pool.map(member => {
    const weight = member.entry.groupWeight
    return typeof weight === 'number' && Number.isFinite(weight) && weight > 0 ? weight : 100
  })
  const total = weights.reduce((sum, weight) => sum + weight, 0)
  // Seed the draw from the group as a whole so the winner is stable within a
  // turn but still evolves with the seed across turns.
  let ticket = roll(pool[0]!.entry) * total
  for (let index = 0; index < pool.length; index++) {
    ticket -= weights[index]!
    if (ticket <= 0) return pool[index]!
  }
  return pool[pool.length - 1]!
}

/**
 * Match one book against the scan and return its candidates before the budget.
 *
 * Inclusion-group selection stays per book (unchanged); admission is global
 * across books, which is why the candidates carry their book index.
 */
function collectBook(
  book: { entries: readonly WorldBookEntry[]; token_budget?: number },
  scan: LoreScan,
  bookIndex: number,
): Candidate[] {
  const roll = scan.roll ?? defaultRoll(scan.seed ?? 0)
  const direct: Candidate[] = []
  const groups = new Map<string, Candidate[]>()

  book.entries.forEach((entry, index) => {
    if (entry.disable) return

    // `delay` is ST's "wait N messages before this may activate". The gate
    // used to read `depth`, which is the @D INSERTION depth and defaults to 4
    // on virtually every imported entry — so every world book silently
    // contributed nothing for the first four user turns, and users reasonably
    // concluded the import had failed.
    const delay = entry.delay
    if (typeof delay === 'number' && delay > 0 && scan.depth < delay) return

    // Probability and group membership apply to constant entries too; only
    // key matching is skipped for them. Gating `constant` before these (the
    // previous order) made `constant + probability: 25` fire 100% of the time
    // and let every constant member of a mutually exclusive group in at once.
    const matchedKeys = entry.constant ? [] : matchKeys(entry, scan)
    if (matchedKeys === null) return

    const probability = entry.useProbability ? entry.probability : undefined
    if (typeof probability === 'number' && probability < 100) {
      if (probability <= 0) return
      if (roll(entry) * 100 >= probability) return
    }

    const candidate: Candidate = { entry, matchedKeys, index, bookIndex }
    const names = groupNames(entry)
    if (names.length === 0) {
      direct.push(candidate)
      return
    }
    for (const name of names) {
      const members = groups.get(name)
      if (members === undefined) groups.set(name, [candidate])
      else members.push(candidate)
    }
  })

  const chosen = new Map<number, Candidate>()
  for (const candidate of direct) chosen.set(candidate.index, candidate)
  for (const members of groups.values()) {
    const winner = pickGroupWinner(members, roll)
    chosen.set(winner.index, winner)
  }
  return [...chosen.values()]
}

/** ST `order` (default 100): the author's injection priority. */
function entryOrder(entry: WorldBookEntry): number {
  return typeof entry.order === 'number' ? entry.order : 100
}

/** Render order: ascending `order`, book order as the stable tie-break. */
function compareRenderOrder(a: Candidate, b: Candidate): number {
  const orderA = entryOrder(a.entry)
  const orderB = entryOrder(b.entry)
  if (orderA !== orderB) return orderA - orderB
  if (a.bookIndex !== b.bookIndex) return a.bookIndex - b.bookIndex
  return a.index - b.index
}

/** Admission priority: descending `order`, then book order, then entry order. */
function compareAdmissionPriority(a: Candidate, b: Candidate): number {
  const orderA = entryOrder(a.entry)
  const orderB = entryOrder(b.entry)
  if (orderA !== orderB) return orderB - orderA
  if (a.bookIndex !== b.bookIndex) return a.bookIndex - b.bookIndex
  return a.index - b.index
}

/**
 * Charge the budget and return the survivors in render order.
 *
 * ST sorts by `b.order - a.order` before its budget loop: a LARGER order number
 * is more important and is what survives when the budget runs out. Admitting
 * ascending (the previous behaviour) dropped exactly the entries the author
 * marked as critical. Rendering is still ascending — ST unshifts higher-order
 * blocks toward the end, so the visible order is the reverse of the priority
 * order.
 */
function admit(candidates: readonly Candidate[], budget: number): ActivatedEntry[] {
  const out: Candidate[] = []
  // The header is part of every rendered block, so charge it before the first
  // entry; otherwise `renderWorldInfo(out).length` overshoots the budget by the
  // header no matter how tight the per-entry accounting is.
  let used = candidates.length === 0 ? 0 : WORLD_INFO_HEADER.length + 1
  for (const candidate of [...candidates].sort(compareAdmissionPriority)) {
    // +1 for the newline that joins this block to the previous one.
    const cost = renderBlock(candidate.entry).length + 1
    if (!candidate.entry.ignoreBudget && used + cost > budget) continue
    used += cost
    out.push(candidate)
  }
  return out.sort(compareRenderOrder).map(({ entry, matchedKeys }) => ({ entry, matchedKeys }))
}

/**
 * Effective character ceiling for one admission pass.
 *
 * An explicit scan budget (plugin config) wins. A book-level `token_budget`
 * only describes one book, so it is honored only when one book is activated;
 * letting every book apply its own number was the N× overshoot.
 */
function resolveBudget(
  scan: LoreScan,
  books: readonly { entries: readonly WorldBookEntry[]; token_budget?: number }[],
): number {
  if (typeof scan.budgetChars === 'number' && scan.budgetChars > 0) return scan.budgetChars
  if (books.length === 1) {
    const own = books[0]!.token_budget
    if (typeof own === 'number' && own > 0) return own * 4 // rough chars-per-token
  }
  return DEFAULT_BUDGET_CHARS
}

/**
 * Run one book against the scan and return activated entries ordered for
 * insertion (ascending `order`, book order as the tie-break).
 */
export function activateBook(
  book: { entries: readonly WorldBookEntry[]; token_budget?: number },
  scan: LoreScan,
): ActivatedEntry[] {
  return admit(collectBook(book, scan, 0), resolveBudget(scan, [book]))
}

/**
 * Run several books against one budget shared by all of them.
 *
 * The ceiling belongs to the play, not to each book: `flatMap(activateBook)`
 * gave every book the full `worldInfoBudgetChars`, so N books injected up to N
 * times the configured limit. Admission ranks globally by (order desc, book
 * order, entry order), so a high-priority entry in a later book still wins the
 * budget against a low-priority entry in an earlier one.
 */
export function activateBooks(
  books: readonly { entries: readonly WorldBookEntry[]; token_budget?: number }[],
  scan: LoreScan,
): ActivatedEntry[] {
  if (books.length === 0) return []
  if (books.length === 1) return activateBook(books[0]!, scan)
  const candidates = books.flatMap((book, bookIndex) => collectBook(book, scan, bookIndex))
  return admit(candidates, resolveBudget(scan, books))
}

/**
 * One entry's rendered block: a bulleted first line plus two-space-indented
 * continuation lines, so a multi-line `content` cannot spill flush-left where
 * a line reading like a section header is indistinguishable from the
 * assembler's own structure.
 *
 * Split out of {@link renderWorldInfo} so the budget is charged exactly what
 * rendering emits: charging `content.length` ignored the memo line, the bullet
 * and every indent, so the "ceiling" overshot on every admitted entry.
 */
function renderBlock(entry: WorldBookEntry): string {
  const content = stripPromptVariables(entry.content.trim())
  const memo = entry.addMemo ? stripPromptVariables(entry.comment.trim()) : ''
  const body = memo !== '' ? `（${memo}）\n${content}` : content
  const [first = '', ...rest] = body.split('\n')
  return [`- ${first}`, ...rest.map(line => `  ${line}`)].join('\n')
}

/**
 * Render active entries into one world-info text block.
 *
 * The caller is still responsible for fencing this block — world books are
 * third-party content.
 */
export function renderWorldInfo(activated: readonly ActivatedEntry[]): string {
  if (activated.length === 0) return ''
  return [WORLD_INFO_HEADER, ...activated.map(({ entry }) => renderBlock(entry))].join('\n')
}
