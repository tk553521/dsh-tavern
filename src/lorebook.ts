/**
 * World-book (lorebook) activation: match entry keys against scan text,
 * honor probability/depth/group semantics, and order the active entries for
 * prompt insertion. Modeled on SillyTavern's world-info rules.
 */

import type { WorldBookEntry } from './types.ts'
import { stripPromptVariables } from './prompt.ts'

/** Activation context: the text to scan plus the message depth. */
export interface LoreScan {
  /** Text scanned for keys (recent user/assistant lines, newest last). */
  text: string
  /** Current message depth from the start of the play (0-based). */
  depth: number
  /** RNG for probability rolls; injectable for deterministic tests. */
  roll?: () => number
}

export interface ActivatedEntry {
  entry: WorldBookEntry
  /** Matched keys (for diagnostics). */
  matchedKeys: string[]
}

const DEFAULT_ROLL = () => Math.random()

/** Match one key against the scan text. */
function keyMatches(key: string, scan: LoreScan, entry: WorldBookEntry): boolean {
  if (entry.keyregex) {
    try {
      const flags = entry.caseSensitive ? '' : 'i'
      return new RegExp(entry.keyregex, flags).test(scan.text)
    } catch {
      // Malformed regex degrades to literal matching.
    }
  }
  const caseSensitive = entry.caseSensitive ?? false
  const needle = caseSensitive ? key : key.toLowerCase()
  const haystack = caseSensitive ? scan.text : scan.text.toLowerCase()
  const wholeWords = entry.matchWholeWords ?? false
  if (!wholeWords) return haystack.includes(needle)
  // Whole-word match: boundaries are non-word characters or string edges.
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|[^\\p{L}\\p{N}_])${escaped}(?=[^\\p{L}\\p{N}_]|$)`, 'u').test(haystack)
}

/**
 * Run one book against the scan and return activated entries ordered for
 * insertion (by position ascending, constant entries first).
 */
export function activateBook(
  book: { entries: readonly WorldBookEntry[] },
  scan: LoreScan,
): ActivatedEntry[] {
  const roll = scan.roll ?? DEFAULT_ROLL
  const activated: ActivatedEntry[] = []
  const groupPick = new Map<string, WorldBookEntry>()

  for (const entry of book.entries) {
    if (entry.disable) continue
    if (entry.constant) {
      activated.push({ entry, matchedKeys: [] })
      continue
    }
    // Depth gate: entry.depth is the minimum message depth for activation.
    if (typeof entry.depth === 'number' && entry.depth > 0 && scan.depth < entry.depth) continue
    // Probability gate: absent probability or a successful roll activates.
    const prob = entry.useProbability ? entry.probability : undefined
    if (typeof prob === 'number' && prob < 100 && roll() * 100 > prob) continue

    const keys = [...(entry.key ?? [])]
    if (entry.keysecondary && entry.keysecondary.length > 0) keys.push(...entry.keysecondary)
    const matched = keys.filter(key => key !== '' && keyMatches(key, scan, entry))
    if (matched.length === 0) continue

    if (entry.group !== '') {
      // One member per group: first (by book order) with highest weight wins.
      const current = groupPick.get(entry.group)
      const weight = entry.groupWeight ?? 0
      if (current === undefined || (current.groupWeight ?? 0) < weight) {
        groupPick.set(entry.group, entry)
      }
      continue
    }
    activated.push({ entry, matchedKeys: matched })
  }

  for (const entry of groupPick.values()) {
    activated.push({ entry, matchedKeys: [] })
  }

  // Insertion order: lower position number = earlier in the prompt block.
  activated.sort((a, b) => {
    const pa = a.entry.extensions?.position ?? a.entry.position ?? 0
    const pb = b.entry.extensions?.position ?? b.entry.position ?? 0
    return pa - pb
  })
  return activated
}

/** Render active entries into one world-info text block. */
export function renderWorldInfo(activated: readonly ActivatedEntry[]): string {
  if (activated.length === 0) return ''
  const lines = activated.map(({ entry }) => stripPromptVariables(entry.content.trim()))
  return [
    '[世界书 / World Info]',
    ...lines.map(line => `- ${line}`),
  ].join('\n')
}
