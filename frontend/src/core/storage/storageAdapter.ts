export interface StorageAdapter {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

function createMemoryStorage(): StorageAdapter {
  const store = new Map<string, string>()
  return {
    getItem(key) {
      return store.has(key) ? store.get(key)! : null
    },
    setItem(key, value) {
      store.set(key, value)
    },
    removeItem(key) {
      store.delete(key)
    },
  }
}

export const memoryStorage = createMemoryStorage()
