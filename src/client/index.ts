/**
 * dsh-tavern browser half: registers the "酒馆" entry of the conversation
 * view slot, to the right of Chat (order 0) and Trajectory (order 10).
 * The chat area renders the active play DSH session directly and sends
 * through that session's conversation service; library management talks to
 * the host via the /tavern route. No cross-plugin value imports.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionBinding, SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
// Type-only: pulls the `slots` / `uiConversation` / `sessions` service
// declarations, the 'conversation.view' SlotMap row, and the standard Session
// props into the program. Every one of these imports erases at build time; the
// modules themselves are seeded by the web shell.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { createTavernStore } from './store.ts'
import { TavernView, type TavernSessionHandle, type TavernViewInjected } from './TavernView.tsx'

/** Required services: the slot registry, the session manager, conversation, and its view assembly. */
export const inject = ['slots', 'sessions', 'conversation', 'uiConversation']

declare module '@deepseek-ai/dsh-api-session-controller/client' {
  interface SessionReferenceSourceMap {
    /** A tavern view displaying (and sending into) an archived play session. */
    tavernView: unknown
  }
}

/**
 * Client plugin body: register the tavern view tab. The registration rides
 * the slot service's effect wrapper, so plugin unload removes the tab.
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  // Store identity follows this fiber (per the slot-system standard).
  const tavernStore = createTavernStore()
  const sessions = ctx.sessions

  /**
   * Live retain counts per play session.
   *
   * The tavern opens archived plays and sends into them without switching the
   * global current Session, so it has to own a Client reference: `binding()`
   * and `scope()` only borrow a generation someone else already retains and
   * return undefined for every other session. Borrowing is why opening an old
   * play used to leave the view permanently "未绑定".
   */
  const retained = new Map<SessionId, { reference: SessionReference; count: number }>()

  /** Drop one view's reference, tearing the session scope down with the last one. */
  const releasePlay = (id: SessionId): void => {
    const entry = retained.get(id)
    if (entry === undefined) return
    entry.count -= 1
    if (entry.count > 0) return
    retained.delete(id)
    entry.reference.release()
  }

  /** Build the view-facing handle for one live reference. */
  const handleFor = (reference: SessionReference): TavernSessionHandle => {
    // `binding` throws once the reference is released, so capture it while live.
    const binding: SessionBinding = reference.binding
    const conversation = binding.ctx.conversation
    const chat = ctx.uiConversation.binding(binding).target('chat')
    let released = false
    return {
      session: binding.session,
      conversation,
      chat,
      ready: reference.ready,
      release: () => {
        if (released) return
        released = true
        releasePlay(binding.sessionId)
      },
    }
  }

  /**
   * Retain one play session for a view and hand back its live sources.
   * @param id - durable session id of the play.
   * @returns the retained handle; `release()` must be called when the view stops showing it.
   */
  const retainPlay = (id: SessionId): TavernSessionHandle => {
    const existing = retained.get(id)
    if (existing !== undefined) {
      // Resolve the handle before counting: a binding that cannot be resolved
      // must not leave a count behind that only a release would clear.
      const handle = handleFor(existing.reference)
      existing.count += 1
      return handle
    }
    const reference = sessions.retain(id, { source: 'tavernView' })
    let handle: TavernSessionHandle
    try {
      handle = handleFor(reference)
    } catch (error) {
      reference.release()
      throw error
    }
    retained.set(id, { reference, count: 1 })
    return handle
  }

  // A retained session keeps its Client scope, history window and stream alive.
  // Views release theirs on unmount, but an unload that races React (or a
  // registration removed while a view is still mounted) must not leak one.
  ctx.effect(() => () => {
    for (const entry of retained.values()) entry.reference.release()
    retained.clear()
  }, 'dsh-tavern: play session references')

  // One stable injected face for every mount of the tab. A fresh object (or a
  // fresh function) per render would re-trigger the view's retain effect on
  // every commit, releasing and re-acquiring the reference in a loop.
  const injected: TavernViewInjected = {
    // The play is picked inside the view (its id lives in the store), not by
    // the tab row's session, so the view retains on demand.
    retainSession: (id) => retainPlay(id as SessionId),
  }

  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'tavern',
    order: 20,
    label: () => '酒馆',
    store: tavernStore,
    inject: (_sessionId: SessionId): TavernViewInjected => injected,
  }, TavernView))
}
