/**
 * Tavern UI store: cross-remount viewing state for the tavern view entry.
 * Business data (characters, lorebooks, presets, plays) lives on the host and
 * is fetched per mount; only navigation and selection survive here.
 */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-runtime/client'

/** Tavern panel tabs inside the view. */
export type TavernPanel = 'chat' | 'characters' | 'lorebooks' | 'presets' | 'import'

/** Draft settings for a new play. */
export interface DraftPlay {
  characterIds: string[]
  lorebookIds: string[]
  presetId?: string
  narratorEnabled: boolean
}

export interface TavernStoreState {
  /** Active panel. */
  panel: TavernPanel
  /** Current play id shown in the chat panel. */
  playId: string | null
  /** Selected character record id (characters panel). */
  selectedCharacterId: string | null
  /** Selected lorebook record id (lorebooks panel). */
  selectedLorebookId: string | null
  /** Selected preset record id (presets panel). */
  selectedPresetId: string | null
  /** New-play draft. */
  draft: DraftPlay
  /** Whether a generation request is in flight. */
  generating: boolean
  /** Last error message shown in the view. */
  error: string | null
  /** Reply mode for generation: first | all | mention. */
  replyMode: 'first' | 'all' | 'mention'
}

type TavernActions = {
  setPanel: (d: TavernStoreState, panel: TavernPanel) => void
  setPlayId: (d: TavernStoreState, playId: string | null) => void
  selectCharacter: (d: TavernStoreState, id: string | null) => void
  selectLorebook: (d: TavernStoreState, id: string | null) => void
  selectPreset: (d: TavernStoreState, id: string | null) => void
  setDraft: (d: TavernStoreState, draft: DraftPlay) => void
  toggleDraftCharacter: (d: TavernStoreState, id: string) => void
  setDraftLorebooks: (d: TavernStoreState, lorebookIds: string[]) => void
  setDraftPreset: (d: TavernStoreState, presetId: string | undefined) => void
  setDraftNarrator: (d: TavernStoreState, enabled: boolean) => void
  setGenerating: (d: TavernStoreState, generating: boolean) => void
  setError: (d: TavernStoreState, error: string | null) => void
  setReplyMode: (d: TavernStoreState, mode: 'first' | 'all' | 'mention') => void
}

/**
 * Declares the tavern viewing state and write surface.
 * @returns the store handle.
 */
export function createTavernStore(): EngineStoreHandle<TavernStoreState, TavernActions> {
  return defineStore({
    init: (): TavernStoreState => ({
      panel: 'chat',
      playId: null,
      selectedCharacterId: null,
      selectedLorebookId: null,
      selectedPresetId: null,
      draft: { characterIds: [], lorebookIds: [], narratorEnabled: false },
      generating: false,
      error: null,
      replyMode: 'first',
    }),
    actions: {
      setPanel: (d, panel) => { d.panel = panel },
      setPlayId: (d, playId) => { d.playId = playId },
      selectCharacter: (d, id) => { d.selectedCharacterId = id },
      selectLorebook: (d, id) => { d.selectedLorebookId = id },
      selectPreset: (d, id) => { d.selectedPresetId = id },
      setDraft: (d, draft) => { d.draft = draft },
      toggleDraftCharacter: (d, id) => {
        const has = d.draft.characterIds.includes(id)
        d.draft = {
          ...d.draft,
          characterIds: has
            ? d.draft.characterIds.filter(cid => cid !== id)
            : [...d.draft.characterIds, id],
        }
      },
      setDraftLorebooks: (d, lorebookIds) => { d.draft = { ...d.draft, lorebookIds } },
      setDraftPreset: (d, presetId) => { d.draft = { ...d.draft, presetId } },
      setDraftNarrator: (d, enabled) => { d.draft = { ...d.draft, narratorEnabled: enabled } },
      setGenerating: (d, generating) => { d.generating = generating },
      setError: (d, error) => { d.error = error },
      setReplyMode: (d, mode) => { d.replyMode = mode },
    },
  })
}
