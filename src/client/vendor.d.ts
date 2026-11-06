/**
 * Ambient declarations for the DSH browser platform modules that are seeded
 * into the web shell's module table instead of being installed packages.
 *
 * `@deepseek-ai/dsh-client-store` and `@deepseek-ai/dsh-client-ui-slots` can be
 * required at run time (the shell registers them in PLATFORM_MODULES), but
 * neither exists under node_modules as an npm package, so there is no .d.ts to
 * resolve an import against. This file declares only the surface the tavern
 * plugin touches.
 *
 * The declarations also carry the base names that shipped `@deepseek-ai/*`
 * declarations import from these two modules (`PropsRuntime`, `PropsStore`,
 * `ObservableSnapshot`, ...). Without them those imports collapse to `any`,
 * which would silently disable the checks on our own props and on the shapes
 * the framework hands back — the failure mode is a typecheck that passes while
 * the bundle is wrong.
 *
 * Keep this file a global script (no top-level import/export): the blocks below
 * are ambient module declarations, not augmentations of modules that exist.
 */

declare module '@deepseek-ai/dsh-client-store' {
  /** Read-only observable: the `useSyncExternalStore` contract. */
  export interface ObservableSnapshot<Value> {
    /** @returns the current value; identity stays stable between changes. */
    getSnapshot(): Value
    /** @param listener - called after the value changes. @returns the unsubscribe function. */
    subscribe(listener: () => void): () => void
  }

  /** Mutable snapshot store: the writer side plus the reader contract. */
  export interface SnapshotStore<State> extends ObservableSnapshot<State> {
    /** @param state - complete replacement state. @param notify - publish now (defaults to true). */
    set(state: State, notify?: boolean): void
    /** @param recipe - mutate a draft to produce the next state. */
    update(recipe: (draft: State) => void): void
    /** @param state - complete replacement state. @param notify - publish now (defaults to true). */
    setState(state: State, notify?: boolean): void
  }

  /** Selector hook over one observable state (the `useStore` seat). */
  export interface SnapshotSelectorHook<State> {
    <Selected>(selector: (state: State) => Selected, equal?: (left: Selected, right: Selected) => boolean): Selected
  }

  /** Selector hook whose state is absent outside an owning scope. */
  export interface MaybeSnapshotSelectorHook<State> {
    <Selected>(selector: (state: State | undefined) => Selected, equal?: (left: Selected, right: Selected) => boolean): Selected
  }

  /** Selector hook resolved per key for keyed seats. */
  export interface KeyedSnapshotSelectorHook<State, Key> {
    <Selected>(key: Key, selector: (state: State) => Selected, equal?: (left: Selected, right: Selected) => boolean): Selected
  }

  /**
   * Bound actions: the draft parameter of an authored action is supplied by the
   * store instance, so consumers only pass the remaining arguments.
   */
  export type BoundActions<Actions> = {
    [Name in keyof Actions]: Actions[Name] extends (draft: infer _Draft, ...args: infer Args) => infer Result
      ? (...args: Args) => Result
      : never
  }

  /** One store definition: the value `defineStore` returns. */
  export interface StoreDefinition<State, Actions> {
    /** The authored definition; the slot registry mints one instance per scope from it. */
    readonly spec: {
      readonly init: () => State
      readonly actions: Actions
      readonly persist?: string
    }
    /**
     * Mint one bound instance.
     * @param scope - durable scope key for a persisted definition.
     */
    create(scope?: string): {
      readonly actions: BoundActions<Actions>
      readonly getSnapshot: () => State
      readonly subscribe: (listener: () => void) => () => void
      readonly store: SnapshotStore<State>
      readonly clearPersisted: () => void
    }
  }

  /**
   * Declare a per-scope store.
   * @param spec - initial state and draft-mutating actions.
   * @returns the definition the slot system instantiates.
   */
  export function defineStore<State, Actions>(spec: {
    init: () => State
    actions: Actions
    persist?: string
  }): StoreDefinition<State, Actions>

  /**
   * The name shipped `@deepseek-ai/*` declarations use for {@link StoreDefinition}
   * (`createChatStore(): EngineStoreHandle<...>`). Kept so those declarations
   * resolve to the same shape instead of degrading to `any`.
   */
  export type EngineStoreHandle<State, Actions> = StoreDefinition<State, Actions>

  /**
   * Create a standalone snapshot store.
   * @param init - initial state.
   * @param options - optional localStorage persistence settings.
   */
  export function createSnapshotStore<State>(init: State, options?: {
    persist?: { name: string }
  }): SnapshotStore<State>

  /** Wake every listener; a throwing listener never hides the others. */
  export function notifySubscribers(listeners: Iterable<() => void>, reason?: string): void

  /** Shallow equality used by selector hooks for hand-built snapshots. */
  export function shallowEqual(left: unknown, right: unknown): boolean
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  import type { BoundActions, SnapshotSelectorHook, StoreDefinition } from '@deepseek-ai/dsh-client-store'
  import type { ComponentType } from 'react'
  import type { SessionId } from '@deepseek-ai/dsh-session/types'

  /**
   * The selector-hook types are re-exported here: shipped declarations import
   * them from this module (ui-session's `UseSessions`, for one), so declaring
   * them only in `@deepseek-ai/dsh-client-store` would leave those imports
   * unresolved and every selector callback implicitly `any`.
   */
  export type {
    BoundActions,
    KeyedSnapshotSelectorHook,
    MaybeSnapshotSelectorHook,
    SnapshotSelectorHook,
  } from '@deepseek-ai/dsh-client-store'

  /** Seat lifetime declared for one SlotMap key. */
  export type SlotScope = 'root' | 'session' | 'session-maybe'

  /** Merge-extensible registry of ordinary slots. */
  export interface SlotMap {}

  /** Merge-extensible registry of reusable component factories. */
  export interface SlotFactoryMap {}

  /** Merge-extensible map of scope names to the reference type a scope owns. */
  export interface SlotScopeTargetMap {}

  /** Props every entry receives from the shell, whatever its scope. */
  export interface GlobalStandardProps {}

  /** Identity and control state of the strict `session` scope. */
  export interface SessionStandardProps {}

  /** Same, absent while no Session is selected (`session-maybe` scope). */
  export interface SessionMaybeStandardProps {}

  /** Owner data handed to the occupant of one key, when the key declares any. */
  export type OwnerOf<Key extends keyof SlotMap & string> =
    SlotMap[Key] extends { owner: infer Owner } ? Owner : {}

  /** Standard props supplied by the scope a key is declared in. */
  type StandardPropsFor<Scope> =
    Scope extends 'session' ? GlobalStandardProps & SessionStandardProps
      : Scope extends 'session-maybe' ? GlobalStandardProps & SessionMaybeStandardProps
        : GlobalStandardProps

  /** Full props a registered component receives: owner data plus its scope's standard props. */
  export type PropsRuntime<Key extends keyof SlotMap & string> =
    OwnerOf<Key> & StandardPropsFor<SlotMap[Key] extends { scope: infer Scope } ? Scope : 'root'>

  /**
   * Store-backed entry props. The slot system instantiates the definition once
   * per scope and hands the occupant the bound selector hook and actions.
   * Keys registered without a `store` receive no such props (`unknown` is the
   * neutral element of the intersection).
   */
  export type PropsStore<Handle> = Handle extends StoreDefinition<infer State, infer Actions>
    ? {
      readonly useStore: SnapshotSelectorHook<State>
      readonly actions: BoundActions<Actions>
    }
    : unknown

  /** The injected face is spread into the occupant's props verbatim. */
  export type InjectFace<Injected> = Injected

  /** Child declarations a registering entry contributes to the composition tree. */
  export interface SlotChildSpec {
    readonly kind: 'single' | 'list' | 'keyed' | 'chain'
    readonly scope: SlotScope
    readonly inline?: boolean
    readonly props?: unknown
  }

  /** Everything one ordinary entry registration may declare. */
  export interface SlotEntrySpec<Key extends keyof SlotMap & string, Handle, Injected> {
    /** SlotMap key being filled. */
    readonly name: Key
    /** Stable identity of this entry inside the seat. */
    readonly id: string
    /** Ascending render order inside the seat. */
    readonly order?: number
    /** Localized label for seats that render a tab or row title. */
    readonly label?: () => string
    /** Store definition (`defineStore` result) instantiated once per scope. */
    readonly store?: Handle
    /** Locale namespace this entry's copy comes from. */
    readonly locale?: string
    /** Per-scope injected face: resolved for the scope the seat renders in. */
    readonly inject?: (sessionId: SessionId) => Injected
    /** Slots this entry declares for its own children. */
    readonly children?: Readonly<Record<string, SlotChildSpec>>
  }

  /**
   * Registration core behind `ctx.slots` (the renderer service exposes its
   * `register` verbatim). Only the member the tavern resolves through that
   * service is declared; the core also owns factory registration, the
   * declaration ledger and store-instance bookkeeping.
   */
  export declare class SlotCore {
    /**
     * Register one entry for a declared key.
     * @param spec - entry declaration checked against `SlotMap`.
     * @param component - occupant; it receives the key's runtime props, the
     *   store seat and the injected face. It is checked against the types the
     *   spec declares (`NoInfer`): otherwise a component could infer its own
     *   `store`/`inject` shape from its parameter and every mismatch would be
     *   accepted silently.
     * @returns the idempotent disposer.
     */
    register<Key extends keyof SlotMap & string, Handle, Injected>(
      spec: SlotEntrySpec<Key, Handle, Injected>,
      component: ComponentType<NoInfer<PropsRuntime<Key> & PropsStore<Handle> & InjectFace<Injected>>>,
    ): () => void
  }
}
