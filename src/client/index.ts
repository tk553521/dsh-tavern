/**
 * dsh-tavern browser half: registers the "酒馆" entry of the conversation
 * view slot, to the right of Chat (order 0) and Trajectory (order 10).
 * The chat area renders the active play DSH session directly and sends
 * through that session's conversation service; library management talks to
 * the host via the /tavern route. No cross-plugin value imports.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the 'conversation.view' SlotMap row and the slot service
// Context merge into the program.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type { IConversation } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ISessions } from '@deepseek-ai/dsh-client-runtime/client'
import { createTavernStore } from './store.ts'
import { TavernView, type OpenableSession, type TavernViewInjected } from './TavernView.tsx'

/** Required services: the slot registry, the session manager, and the conversation service. */
export const inject = ['slots', 'sessions', 'conversation']

/** Resolve the session-scoped conversation face, failing loud. */
function scopedConversation(sessions: ISessions, id: SessionId): IConversation {
  const scoped = sessions.scope(id)
  if (scoped === undefined) throw new Error(`dsh-tavern: session "${id}" resolved no scope`)
  const conversation = scoped.get('conversation')
  if (conversation === undefined) throw new Error('dsh-tavern: conversation service unavailable through the session scope')
  return conversation
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

  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'tavern',
    order: 20,
    label: () => '酒馆',
    store: tavernStore,
    inject: (_sessionId: SessionId): TavernViewInjected => {
      return {
        // The runtime hides `open()` behind SessionFace, but tavern needs it
        // to load an archived/non-current play session without switching the
        // global current session (which would kick the user to the workspace home).
        getSession: (id) => sessions.binding(id as SessionId)?.session as OpenableSession | undefined,
        getConversation: (id) => scopedConversation(sessions, id as SessionId),
      }
    },
  }, TavernView))
}
