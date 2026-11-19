/** Identity helpers for persisted swipe tails (legacy branches have no metadata). */
import type { SwipeBranch } from './types.ts'

/** Read the first ordinary user's durable id without trusting old JSON shapes. */
export function tailUserMessageId(events: readonly unknown[]): string | undefined {
  for (const value of events) {
    if (typeof value !== 'object' || value === null) continue
    const event = value as { type?: unknown; data?: unknown }
    if (event.type !== 'user/message' || typeof event.data !== 'object' || event.data === null) continue
    const id = (event.data as { id?: unknown }).id
    if (typeof id === 'string' && id !== '') return id
  }
  return undefined
}

/** Busy attempts carry their planned id; old settled records derive it from the selected tail. */
export function swipeUserMessageId(branch: SwipeBranch): string | undefined {
  return branch.userMessageId ?? tailUserMessageId(branch.variants[branch.current] ?? [])
}

/** Fork seed markers are log-only boundaries, not a different question lineage. */
export function comparableForkEvents(events: readonly unknown[]): unknown[] {
  return events.filter(value => typeof value === 'object' && value !== null
    && (value as { type?: unknown }).type !== 'session/end-seed'
    && (value as { type?: unknown }).type !== 'agent/inbox/spliced')
    .map((value, seq) => ({ ...(value as Record<string, unknown>), seq }))
}

export function sameForkHistory(a: readonly unknown[], b: readonly unknown[]): boolean {
  return JSON.stringify(comparableForkEvents(a)) === JSON.stringify(comparableForkEvents(b))
}

/** Bind a selected reply by durable message data, not incidental log-only metadata. */
export function sameReplyTail(a: readonly unknown[], b: readonly unknown[]): boolean {
  const messages = (events: readonly unknown[]): unknown[] => events
    .filter(value => typeof value === 'object' && value !== null
      && ((value as { type?: unknown }).type === 'user/message' || (value as { type?: unknown }).type === 'assistant/message'))
    .map(value => {
      const event = value as { type: string; data: unknown }
      return { type: event.type, data: event.data }
    })
  return JSON.stringify(messages(a)) === JSON.stringify(messages(b))
}
