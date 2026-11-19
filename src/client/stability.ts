/** Pure client stability primitives shared by the UI and offline regressions. */
export interface OperationAddress {
  playId: string | null
  sessionId?: string
}

export interface OperationState extends OperationAddress {
  boundSessionId?: string
  running: boolean
  busy: boolean
}

/** One guard for buttons, keyboard paths and the final conversation/API seat. */
export function operationBlockReason(state: OperationState, expected?: OperationAddress): string | undefined {
  if (state.playId === null || state.sessionId === undefined || state.boundSessionId !== state.sessionId) {
    return '请等待当前酒馆会话绑定完成'
  }
  if (expected !== undefined && (expected.playId !== state.playId || expected.sessionId !== state.sessionId)) {
    return '会话已切换，请在当前会话重试'
  }
  if (state.busy) return '上一项操作正在处理，请稍后再试'
  if (state.running) return '当前正在输出，请先停止或等待完成'
  return undefined
}

/** Acquire synchronously: two calls in the same render/tick cannot both enter. */
export function createOperationLock(): {
  readonly busy: boolean
  run: <T>(operation: () => Promise<T>) => Promise<T>
} {
  let busy = false
  return {
    get busy() { return busy },
    async run<T>(operation: () => Promise<T>): Promise<T> {
      if (busy) throw new Error('上一项操作正在处理，请稍后再试')
      busy = true
      try { return await operation() } finally { busy = false }
    },
  }
}

/** A committed mutation stays successful even if its follow-up snapshot fails. */
export async function commitThenRefresh<T>(
  commit: () => Promise<T>, publish: (result: T) => void,
  refresh: () => Promise<void>, onRefreshError: (error: unknown) => void,
): Promise<T> {
  const result = await commit()
  publish(result)
  try { await refresh() } catch (error) { onRefreshError(error) }
  return result
}

interface ReplyMessage {
  kind: 'user' | 'assistant'
  messageId?: string
  userMessageId?: string
  status?: string
}

/** A new user row removes the old reply's seat even before running arrives. */
export function replySeat(messages: readonly ReplyMessage[]): { assistantIndex: number; userMessageId?: string } {
  const assistantIndex = messages.length - 1
  if (assistantIndex < 0 || messages[assistantIndex]!.kind !== 'assistant') return { assistantIndex: -1 }
  const owner = messages[assistantIndex]!.userMessageId
  if (owner !== undefined) return { assistantIndex, userMessageId: owner }
  for (let index = assistantIndex - 1; index >= 0; index -= 1) {
    if (messages[index]!.kind === 'user') {
      return { assistantIndex, userMessageId: messages[index]!.messageId }
    }
  }
  return { assistantIndex }
}

interface AddressedSwipe {
  playId: string
  userMessageId?: string
  sessionId?: string
  updatedAt: string
}

/** Legacy summaries can omit sessionId, but still need the host-derived user id. */
export function matchingSwipe<T extends AddressedSwipe>(
  branches: readonly T[], address: OperationAddress, messages: readonly ReplyMessage[],
): T | undefined {
  const seat = replySeat(messages)
  if (address.playId === null || address.sessionId === undefined || seat.userMessageId === undefined) return undefined
  let found: T | undefined
  for (const branch of branches) {
    if (branch.playId !== address.playId || branch.userMessageId !== seat.userMessageId) continue
    if (branch.sessionId !== undefined && branch.sessionId !== address.sessionId) continue
    if (found === undefined || branch.updatedAt > found.updatedAt) found = branch
  }
  return found
}

export interface ComposerDraft {
  text: string
  revision: number
  error?: string
  /** Failed sends kept separately when a newer draft already exists. */
  failures: readonly string[]
}

export interface SendDraft {
  playId: string
  text: string
  content: string
  clearedRevision: number
}

const EMPTY_DRAFT: ComposerDraft = { text: '', revision: 0, failures: [] }

/** Owned by TavernView so switching plays or library panels preserves drafts. */
export function createComposerDrafts() {
  const drafts = new Map<string, ComposerDraft>()
  const editors = new Map<string, MessageEditor>()
  const listeners = new Set<() => void>()
  let version = 0
  const get = (playId: string | null): ComposerDraft => playId === null ? EMPTY_DRAFT : drafts.get(playId) ?? EMPTY_DRAFT
  const put = (playId: string, draft: ComposerDraft): void => {
    drafts.set(playId, draft)
    version += 1
    for (const listener of listeners) listener()
  }
  return {
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    getSnapshot: (): number => version,
    get,
    /** View row ids include speaker-run suffixes; durable step ids do not. */
    editor(playId: string, rowId: string): MessageEditor {
      const key = JSON.stringify([playId, rowId])
      let editor = editors.get(key)
      if (editor === undefined) {
        editor = createMessageEditor()
        editors.set(key, editor)
      }
      return editor
    },
    set(playId: string | null, text: string): void {
      if (playId === null) return
      const draft = get(playId)
      put(playId, { ...draft, text, revision: draft.revision + 1 })
    },
    begin(playId: string | null): SendDraft | undefined {
      if (playId === null) return undefined
      const draft = get(playId)
      const content = draft.text.trim()
      if (content === '') return undefined
      const clearedRevision = draft.revision + 1
      put(playId, { ...draft, text: '', error: undefined, revision: clearedRevision })
      return { playId, text: draft.text, content, clearedRevision }
    },
    fail(send: SendDraft, error: unknown): void {
      const draft = get(send.playId)
      const untouched = draft.text === '' && draft.revision === send.clearedRevision
      put(send.playId, {
        ...draft,
        text: untouched ? send.text : draft.text,
        revision: draft.revision + 1,
        error: errorText(error),
        failures: untouched ? draft.failures : [...draft.failures, send.text],
      })
    },
    recover(playId: string | null): void {
      if (playId === null) return
      const draft = get(playId)
      const first = draft.failures[0]
      if (first === undefined) return
      put(playId, {
        text: draft.text === '' ? first : `${draft.text}\n${first}`,
        revision: draft.revision + 1,
        failures: draft.failures.slice(1),
      })
    },
  }
}

export type ComposerDrafts = ReturnType<typeof createComposerDrafts>

export interface MessageEditorState {
  editing: boolean
  draft: string
  saving: boolean
  error?: string
}

/** Keep the editor and draft until the actual save promise succeeds. */
export function createMessageEditor() {
  let state: MessageEditorState = { editing: false, draft: '', saving: false }
  const listeners = new Set<() => void>()
  const publish = (next: MessageEditorState): void => {
    state = next
    for (const listener of listeners) listener()
  }
  return {
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    getSnapshot: (): MessageEditorState => state,
    open(text: string): void {
      if (!state.editing) publish({ editing: true, draft: text, saving: false })
    },
    change(draft: string): void {
      if (!state.saving) publish({ ...state, draft })
    },
    cancel(): void {
      if (!state.saving) publish({ ...state, editing: false, error: undefined })
    },
    async save(commit: (text: string) => Promise<void>): Promise<boolean> {
      if (!state.editing || state.saving || state.draft.trim() === '') return false
      const text = state.draft.trim()
      publish({ ...state, saving: true, error: undefined })
      try {
        await commit(text)
        publish({ ...state, editing: false, saving: false })
        return true
      } catch (error) {
        publish({ ...state, editing: true, saving: false, error: errorText(error) })
        return false
      }
    },
  }
}

export type MessageEditor = ReturnType<typeof createMessageEditor>

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export type PollScheduler = (task: () => void, delay: number) => () => void
const schedulePoll: PollScheduler = (task, delay) => {
  const timer = setTimeout(task, delay)
  return () => clearTimeout(timer)
}

/** Re-arm after failures too; disposal stops timers and late error publication. */
export function startRetryingPoll(
  load: () => Promise<void>, onError: (error: unknown) => void,
  schedule: PollScheduler = schedulePoll,
): () => void {
  let disposed = false
  let delay = 800
  let cancelTimer = (): void => {}
  const run = async (): Promise<void> => {
    try {
      await load()
      delay = 800
    } catch (error) {
      delay = Math.min(delay * 2, 5000)
      if (!disposed) onError(error)
    } finally {
      if (!disposed) cancelTimer = schedule(() => { void run() }, delay)
    }
  }
  cancelTimer = schedule(() => { void run() }, delay)
  return () => { disposed = true; cancelTimer() }
}
