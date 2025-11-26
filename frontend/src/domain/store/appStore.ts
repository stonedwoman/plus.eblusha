import { create } from 'zustand'

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

export const useAppStore = create<AppState>((set) => ({
  session: null,
  hydrated: false,
  setSession: (session) => {
    try {
      if (session) {
        localStorage.setItem(ACCESS_KEY, session.accessToken)
        localStorage.setItem(USER_KEY, JSON.stringify(session.user))
        if (session.refreshToken) {
          localStorage.setItem(REFRESH_KEY, session.refreshToken)
        } else {
          localStorage.removeItem(REFRESH_KEY)
        }
      } else {
        localStorage.removeItem(ACCESS_KEY)
        localStorage.removeItem(USER_KEY)
        localStorage.removeItem(REFRESH_KEY)
      }
    } catch {}
    set({ session })
  },
  initFromStorage: () => {
    try {
      const access = localStorage.getItem(ACCESS_KEY)
      const userStr = localStorage.getItem(USER_KEY)
      const refresh = localStorage.getItem(REFRESH_KEY)
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
      } else {
        set({ hydrated: true })
      }
    } catch {
      set({ hydrated: true })
    }
  },
}))


