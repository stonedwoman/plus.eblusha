import { create } from 'zustand'
import { getDefaultStorageAdapter } from '../../core/storage'
import { clearNativeTokens, syncNativeTokens } from '../../core/auth/nativeSession'

export interface UserProfile {
  id: string
  username: string
  displayName?: string | null
  avatarUrl?: string | null
}

export interface SessionState {
  user: UserProfile
  accessToken: string
  refreshToken?: string | null
}

interface AppState {
  session: SessionState | null
  hydrated: boolean
  setSession: (session: SessionState | null) => void
  initFromStorage: () => void
}

const ACCESS_KEY = 'eb_access'
const USER_KEY = 'eb_user'
const REFRESH_KEY = 'eb_refresh'
const storage = getDefaultStorageAdapter()

export const useAppStore = create<AppState>((set) => ({
  session: null,
  hydrated: false,
  setSession: (session) => {
    if (session) {
      try {
        storage.setItem(ACCESS_KEY, session.accessToken)
        storage.setItem(USER_KEY, JSON.stringify(session.user))
        if (session.refreshToken) {
          storage.setItem(REFRESH_KEY, session.refreshToken)
        } else {
          storage.removeItem(REFRESH_KEY)
        }
      } catch {}
      syncNativeTokens(session.accessToken, session.refreshToken ?? undefined).catch((error) => {
        console.warn('[AppStore] ❌ Failed to update native socket token via store', error)
      })
    } else {
      try {
        storage.removeItem(ACCESS_KEY)
        storage.removeItem(USER_KEY)
        storage.removeItem(REFRESH_KEY)
      } catch {}
      clearNativeTokens().catch((error) => {
        console.warn('[AppStore] ❌ Failed to clear native socket tokens via store', error)
      })
    }
    set({ session })
  },
  initFromStorage: () => {
    try {
      const access = storage.getItem(ACCESS_KEY)
      const userStr = storage.getItem(USER_KEY)
      const refresh = storage.getItem(REFRESH_KEY)
      if (access && userStr) {
        const user = JSON.parse(userStr) as UserProfile
        set({
          session: {
            user,
            accessToken: access,
            refreshToken: refresh ?? undefined,
          },
          hydrated: true,
        })
        syncNativeTokens(access, refresh ?? undefined).catch((error) => {
          console.warn('[AppStore] ❌ Failed to update native socket token via hydration', error)
        })
      } else {
        set({ hydrated: true })
      }
    } catch {
      set({ hydrated: true })
    }
  },
}))


