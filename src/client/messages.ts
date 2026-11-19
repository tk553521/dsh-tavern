/** Pure projection of the retained Chat snapshot; shared by UI and regressions. */
import type { ChatSnapshot } from '@deepseek-ai/dsh-client-ui-chat/client'

/** Lifecycle status of one projected reply row. */
export type ViewStatus = 'streaming' | 'done' | 'stopped' | 'truncated' | 'error'

/** One message row projected from the session snapshot for tavern display. */
export interface ViewMessage {
  id: string
  kind: 'user' | 'assistant'
  name?: string
  text: string
  /** Model thinking (reasoning) text, rendered as a collapsible block. */
  thinking?: string
  /** Generation status of the row (user rows are always 'done'). */
  status: ViewStatus
  /** Failure text when status is 'error'. */
  errorText?: string
  /** Durable message id: the edit/retry address (absent on streaming rows). */
  messageId?: string
  /** Owning user message, including hidden opening/empty user rows. */
  userMessageId?: string
  /**
   * Whole-step text behind `messageId`. A classic-mode step can render as
   * several speaker rows (and a single row has its `角色名：` prefix stripped),
   * so the editor must round-trip the stored step text instead of this row's
   * display text — otherwise saving an edit would drop the other speakers.
   * Only set on the row that carries `messageId`.
   */
  stepText?: string
}

/** Shape read from `assistant-step` chat nodes (mirrors AssistantChatData). */
interface ChatAssistantStepData {
  status?: 'running' | 'settled' | 'interrupted'
  turn?: number
  blocks?: readonly { kind: string; text?: string }[]
  finalNode?: { messageId?: string }
}

/** Extract text blocks from a content block list. */
function blocksToText(blocks: readonly { type: string; text?: string }[]): string {
  return blocks
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('')
}

/** Join one kind of assistant blocks (text / reasoning). */
function joinBlocks(blocks: readonly { kind: string; text?: string }[], kind: string): string {
  return blocks
    .filter(block => block.kind === kind && typeof block.text === 'string')
    .map(block => block.text)
    .join('')
}

/** One contiguous stretch of a reply spoken by the same character. */
interface SpeakerRun {
  /** Undefined for narration / an unrecognized prefix (rendered as 叙述者). */
  name?: string
  text: string
}

/** `角色名：台词` line prefix that the classic-mode prompt asks the model for. */
const SPEAKER_LINE_RE = /^\s*([^：:\n]{1,20})[：:]\s*([\s\S]*)$/

/** Split a classic-mode reply into consecutive speaker runs. */
function splitSpeakerRuns(text: string, characterNames: readonly string[]): SpeakerRun[] {
  const runs: { name?: string; lines: string[] }[] = []
  for (const line of text.split('\n')) {
    const match = SPEAKER_LINE_RE.exec(line)
    const speaker = match !== null && characterNames.includes(match[1]!.trim())
      ? match[1]!.trim()
      : undefined
    if (speaker !== undefined) runs.push({ name: speaker, lines: [match![2]!] })
    else if (runs.length === 0) runs.push({ lines: [line] })
    else runs[runs.length - 1]!.lines.push(line)
  }
  const out = runs
    .map(run => ({
      ...(run.name !== undefined ? { name: run.name } : {}),
      text: run.lines.join('\n').trim(),
    }))
    .filter(run => run.text !== '')
  // Bare labels still need one row for thinking, status and the retry seat.
  return out.length > 0 ? out : [{ text: text.trim() }]
}

/** Project user/assistant rows and retain their durable ownership separately from visibility. */
export function extractMessages(snapshot: ChatSnapshot, characterNames: readonly string[]): ViewMessage[] {
  const turnMarks = new Map<number, { truncated?: true; error?: string }>()
  for (const key of snapshot.order) {
    const node = snapshot.nodes.get(key)
    if (node === undefined) continue
    const data = node.data as { turn?: number; message?: string }
    if (node.kind === 'turn-max-tokens' && typeof data.turn === 'number') {
      turnMarks.set(data.turn, { ...turnMarks.get(data.turn), truncated: true })
    } else if (node.kind === 'turn-error' && typeof data.turn === 'number') {
      const error = typeof data.message === 'string' && data.message !== '' ? data.message : '生成失败'
      turnMarks.set(data.turn, { ...turnMarks.get(data.turn), error })
    }
  }

  const out: ViewMessage[] = []
  let userMessageId: string | undefined
  for (const key of snapshot.order) {
    const node = snapshot.nodes.get(key)
    if (node === undefined) continue
    if (node.kind === 'user' || node.kind === 'steering') {
      // Visibility is presentation only: even the hidden opening owns a reply.
      userMessageId = node.id
      const data = node.data as { content?: readonly { type: string; text?: string }[] }
      const text = blocksToText(data.content ?? []).trim()
      if (text !== '' && text !== '[开场] 扮演开始。') {
        out.push({ id: key, kind: 'user', text, status: 'done', messageId: node.id })
      }
    } else if (node.kind === 'assistant-step') {
      const data = node.data as ChatAssistantStepData
      const blocks = data.blocks ?? []
      const thinking = joinBlocks(blocks, 'reasoning').trim()
      const text = joinBlocks(blocks, 'text').trim()
      if (text === '' && thinking === '') continue
      let status: ViewStatus = data.status === 'running'
        ? 'streaming'
        : data.status === 'interrupted'
          ? 'stopped'
          : 'done'
      let errorText: string | undefined
      const mark = typeof data.turn === 'number' ? turnMarks.get(data.turn) : undefined
      if (status === 'done' && mark?.truncated === true) status = 'truncated'
      if (mark?.error !== undefined) {
        status = 'error'
        errorText = mark.error
      }
      const runs = splitSpeakerRuns(text, characterNames)
      runs.forEach((run, index) => {
        const isTail = index === runs.length - 1
        out.push({
          // Keep stable, distinct row ids as later speaker runs stream in.
          id: `${key}#${index}`,
          kind: 'assistant',
          ...(run.name !== undefined ? { name: run.name } : {}),
          ...(userMessageId !== undefined ? { userMessageId } : {}),
          text: run.text,
          ...(thinking !== '' && index === 0 ? { thinking } : {}),
          status: isTail ? status : 'done',
          ...(isTail && errorText !== undefined ? { errorText } : {}),
          // Only the tail owns the durable whole-step edit/retry address.
          ...(isTail && data.finalNode?.messageId !== undefined
            ? { messageId: data.finalNode.messageId, stepText: text }
            : {}),
        })
      })
    }
  }
  return out
}
