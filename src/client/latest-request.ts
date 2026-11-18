/** Latest-started snapshot request wins, even when responses arrive out of order. */
export function createLatestRequest<T>(load: () => Promise<T>, publish: (value: T) => void): {
  run: () => Promise<void>
  invalidate: () => void
} {
  let generation = 0
  return {
    async run(): Promise<void> {
      const mine = ++generation
      try {
        const value = await load()
        if (mine === generation) publish(value)
      } catch (error: unknown) {
        // Errors belonging to obsolete snapshots must not overwrite current UI.
        if (mine === generation) throw error
      }
    },
    invalidate(): void { generation += 1 },
  }
}
