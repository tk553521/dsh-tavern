/**
 * Browser-side tavern API client: plain fetch against the /tavern prefix
 * route with SSE streaming for generation.
 */

import type {
  CharacterRecord, Play, Preset, SwipeBranchSummary, TavernState, TavernStyle, TauriTavernImportReport, WorldBookRecord,
} from '../types.ts'

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      ...(init?.body !== undefined && typeof init.body === 'string' ? { 'content-type': 'application/json' } : {}),
      ...init?.headers,
    },
  })
  if (!response.ok) {
    let message = `请求失败：${response.status}`
    try {
      const body = await response.json() as { error?: string }
      if (body.error) message = body.error
    } catch {
      // Non-JSON error body; keep the status message.
    }
    throw new Error(message)
  }
  // DELETE and simple acks may legitimately answer with an empty body;
  // parse only when there is content so a void endpoint never throws here.
  if (response.status === 204) return undefined as T
  const text = await response.text()
  if (text === '') return undefined as T
  return JSON.parse(text) as T
}

/** Patch values for one preset. `null` clears an optional field. */
export interface PresetPatch {
  name?: string
  model?: string | null
  provider?: string | null
  systemPrompt?: string | null
  maxTokens?: number | null
  temperature?: number | null
  topP?: number | null
  topK?: number | null
  topA?: number | null
  typicalP?: number | null
  minP?: number | null
  repPen?: number | null
  repPenRange?: number | null
  repPenSlope?: number | null
  presencePenalty?: number | null
  frequencyPenalty?: number | null
  raw?: Record<string, unknown>
}

export interface TavernApi {
  state(): Promise<TavernState>
  createCharacter(input: { input?: string; card?: unknown; source?: string; avatar?: string }): Promise<CharacterRecord>
  updateCharacter(id: string, data: unknown, avatar?: string): Promise<CharacterRecord>
  deleteCharacter(id: string): Promise<void>
  exportCharacterUrl(id: string): string
  createLorebook(input: { book?: unknown; name?: string; input?: string }): Promise<WorldBookRecord>
  updateLorebook(id: string, book: unknown, name?: string): Promise<WorldBookRecord>
  deleteLorebook(id: string): Promise<void>
  exportLorebookUrl(id: string): string
  createPreset(input: { preset?: unknown; name?: string; raw?: unknown }): Promise<Preset>
  updatePreset(id: string, patch: PresetPatch): Promise<Preset>
  deletePreset(id: string): Promise<void>
  exportPresetUrl(id: string): string
  importTauriTavern(input: {
    path: string
    characters?: boolean
    lorebooks?: boolean
    presets?: boolean
  }): Promise<TauriTavernImportReport>
  createPlay(input: {
    title?: string
    characterIds: string[]
    lorebookIds?: string[]
    presetId?: string
    narratorEnabled?: boolean
    multiAgent?: boolean
    greetingIndex?: number
  }): Promise<Play>
  getPlay(id: string): Promise<Play>
  /** Create or resume the play's director DSH session. */
  activatePlay(id: string): Promise<Play>
  updatePlay(id: string, patch: Partial<Pick<Play, 'title' | 'lorebookIds' | 'presetId' | 'narratorEnabled' | 'multiAgent' | 'characterIds'>>): Promise<Play>
  deletePlay(id: string): Promise<void>
  /** Regenerate the last assistant reply as a new swipe variant. */
  retryReply(playId: string): Promise<{ play: Play; branch: SwipeBranchSummary }>
  /** Materialize another stored variant of one swipe branch (step ±1). */
  swipeReply(playId: string, key: string, step: 1 | -1): Promise<{ play: Play; branch: SwipeBranchSummary }>
  /** Edit one assistant reply in place (forks the session, no regeneration). */
  editAssistantMessage(playId: string, messageId: string, text: string): Promise<{ play: Play }>
  /** Edit one user message and regenerate the answer from it. */
  editUserMessageAndRetry(playId: string, messageId: string, text: string): Promise<{ play: Play }>
  setDefaultPreset(id: string | undefined): Promise<void>
  /** Persist the tavern view style preference. */
  setStyle(style: TavernStyle): Promise<void>
}

function api(): TavernApi {
  return {
    state: () => request<TavernState>('/tavern/state'),

    createCharacter: (input) => request<CharacterRecord>('/tavern/characters', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
    updateCharacter: (id, data, avatar) => request<CharacterRecord>(`/tavern/characters/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify({ data, avatar }),
    }),
    deleteCharacter: async (id) => {
      await request(`/tavern/characters/${encodeURIComponent(id)}`, { method: 'DELETE' })
    },
    exportCharacterUrl: (id) => `/tavern/characters/${encodeURIComponent(id)}/export`,

    createLorebook: (input) => request<WorldBookRecord>('/tavern/lorebooks', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
    updateLorebook: (id, book, name) => request<WorldBookRecord>(`/tavern/lorebooks/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify({ book, name }),
    }),
    deleteLorebook: async (id) => {
      await request(`/tavern/lorebooks/${encodeURIComponent(id)}`, { method: 'DELETE' })
    },
    exportLorebookUrl: (id) => `/tavern/lorebooks/${encodeURIComponent(id)}/export`,

    createPreset: (input) => request<Preset>('/tavern/presets', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
    updatePreset: (id, patch) => request<Preset>(`/tavern/presets/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify(patch),
    }),
    deletePreset: async (id) => {
      await request(`/tavern/presets/${encodeURIComponent(id)}`, { method: 'DELETE' })
    },
    exportPresetUrl: (id) => `/tavern/presets/${encodeURIComponent(id)}/export`,

    importTauriTavern: (input) => request<TauriTavernImportReport>('/tavern/import/tauritavern', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

    createPlay: (input) => request<Play>('/tavern/plays', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
    getPlay: (id) => request<Play>(`/tavern/plays/${encodeURIComponent(id)}`),
    activatePlay: (id) => request<Play>(`/tavern/plays/${encodeURIComponent(id)}/activate`, {
      method: 'POST',
      body: '{}',
    }),
    updatePlay: (id, patch) => request<Play>(`/tavern/plays/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify(patch),
    }),
    deletePlay: async (id) => {
      await request(`/tavern/plays/${encodeURIComponent(id)}`, { method: 'DELETE' })
    },
    retryReply: (playId) => request(`/tavern/plays/${encodeURIComponent(playId)}/messages/retry`, {
      method: 'POST',
      body: '{}',
    }),
    swipeReply: (playId, key, step) => request(`/tavern/plays/${encodeURIComponent(playId)}/messages/swipe`, {
      method: 'POST',
      body: JSON.stringify({ key, step }),
    }),
    editAssistantMessage: (playId, messageId, text) => request(
      `/tavern/plays/${encodeURIComponent(playId)}/messages/${encodeURIComponent(messageId)}`,
      { method: 'PUT', body: JSON.stringify({ text }) },
    ),
    editUserMessageAndRetry: (playId, messageId, text) => request(
      `/tavern/plays/${encodeURIComponent(playId)}/messages/${encodeURIComponent(messageId)}/retry`,
      { method: 'POST', body: JSON.stringify({ text }) },
    ),
    setDefaultPreset: async (defaultPresetId) => {
      await request('/tavern/settings', {
        method: 'PUT',
        body: JSON.stringify({ defaultPresetId: defaultPresetId ?? null }),
      })
    },
    setStyle: async (style) => {
      await request('/tavern/settings', {
        method: 'PUT',
        body: JSON.stringify({ style }),
      })
    },
  }
}

/** Shared singleton handle for the API (stateless). */
export const tavernApi: TavernApi = api()

/** Read a file as base64 data URL. */
export function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error('读取文件失败'))
    reader.readAsDataURL(file)
  })
}

/** Read a text file. */
export function fileToText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error('读取文件失败'))
    reader.readAsText(file)
  })
}
