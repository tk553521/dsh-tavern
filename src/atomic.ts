/**
 * Atomic file replacement, with the two Windows behaviours the naive
 * temp-file-plus-rename pattern gets wrong.
 *
 * 1. **Concurrent replacement of one target fails.** `MoveFileExW` with
 *    `MOVEFILE_REPLACE_EXISTING` (what libuv's `rename` asks for) returns
 *    `EPERM`/`EACCES`/`EBUSY` when another thread is replacing the same target
 *    at the same instant; POSIX `rename(2)` has no equivalent failure. The
 *    tavern writes swipe branches and play records in bursts (a settle writes
 *    the branch, an edit rewrites it, a delete removes it), so this is not
 *    theoretical: 200 concurrent writes of one id failed in 8 of 8 rounds.
 *    Serializing per target removes the race at its source; the retry loop
 *    below covers the residual case where another *process* holds the target.
 * 2. **A failed rename must not leave the temp file behind.** Every failure
 *    path removes it, so a library directory does not accumulate `.tmp` files
 *    that a later load reports as corrupt records.
 *
 * Durability: the bytes are handed to the OS before the rename, so a reader
 * sees either the complete old file or the complete new one. The data is not
 * fsync'd — the tavern is user-facing state, not a write-ahead log, and
 * paying a barrier per card edit makes bulk import unusable.
 */

import { randomUUID } from 'node:crypto'
import { rename, rm, writeFile } from 'node:fs/promises'

/** Errors that mean "the target is momentarily busy", not "this will never work". */
const TRANSIENT = new Set(['EPERM', 'EACCES', 'EBUSY', 'EEXIST', 'ENOTEMPTY'])

/** Attempts per rename, including the first. */
const ATTEMPTS = 6

/** Per-target write tail, so writes to one path cannot overlap. */
const tails = new Map<string, Promise<unknown>>()

/** Sleep between rename attempts (linear, capped). */
function delay(attempt: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 5 * attempt))
}

/** Write the temp file and swap it into place, retrying transient rename failures. */
async function replace(path: string, data: string | Uint8Array): Promise<void> {
  const temp = `${path}.${randomUUID().slice(0, 8)}.tmp`
  try {
    // `fs.writeFile` ignores the encoding argument for binary data, so one
    // call shape serves both the JSON records (text) and the avatar bytes.
    await writeFile(temp, data)
    for (let attempt = 1; ; attempt += 1) {
      try {
        await rename(temp, path)
        return
      } catch (error: unknown) {
        const code = (error as NodeJS.ErrnoException).code ?? ''
        if (attempt >= ATTEMPTS || !TRANSIENT.has(code)) throw error
        await delay(attempt)
      }
    }
  } catch (error: unknown) {
    await rm(temp, { force: true }).catch(() => {})
    throw error
  }
}

/**
 * Replace one file atomically, serialized against other writes to the same path.
 * @param path - the final path.
 * @param data - the complete new content (text or raw bytes).
 * @returns resolution once the new content is in place.
 */
export async function writeAtomic(path: string, data: string | Uint8Array): Promise<void> {
  const previous = tails.get(path) ?? Promise.resolve()
  const run = previous.then(() => undefined, () => undefined).then(() => replace(path, data))
  const settled = run.then(() => undefined, () => undefined)
  tails.set(path, settled)
  void settled.then(() => {
    // Only the last writer in the chain clears the entry, so a burst does not
    // let a later write overtake an earlier one.
    if (tails.get(path) === settled) tails.delete(path)
  })
  return run
}
