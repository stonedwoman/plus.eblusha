import { type StorageAdapter, memoryStorage } from './storageAdapter'

function getLocalStorage(): Storage | null {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage
  } catch {
    return null
  }
}

export const localStorageAdapter: StorageAdapter = {
  getItem(key) {
    const storage = getLocalStorage()
    if (!storage) return memoryStorage.getItem(key)
    try {
      return storage.getItem(key)
    } catch {
      return memoryStorage.getItem(key)
    }
  },
  setItem(key, value) {
    const storage = getLocalStorage()
    if (!storage) {
      memoryStorage.setItem(key, value)
      return
    }
    try {
      storage.setItem(key, value)
    } catch {
      memoryStorage.setItem(key, value)
    }
  },
  removeItem(key) {
    const storage = getLocalStorage()
    if (!storage) {
      memoryStorage.removeItem(key)
      return
    }
    try {
      storage.removeItem(key)
    } catch {
      memoryStorage.removeItem(key)
    }
  },
}

export function getDefaultStorageAdapter(): StorageAdapter {
  return localStorageAdapter
}
