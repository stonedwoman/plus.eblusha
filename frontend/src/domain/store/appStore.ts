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
  // refreshToken is now stored in httpOnly cookie, not in state
}

interface AppState {
  session: SessionState | null
  hydrated: boolean
  setSession: (session: SessionState | null) => void
  initFromStorage: () => void
}

const ACCESS_KEY = 'eb_access'
const USER_KEY = 'eb_user'

export const useAppStore = create<AppState>((set) => ({
  session: null,
  hydrated: false,
  setSession: (session) => {
    try {
      if (session) {
        // Persist access token and user data
        localStorage.setItem(ACCESS_KEY, session.accessToken)
        localStorage.setItem(USER_KEY, JSON.stringify(session.user))
      } else {
        localStorage.removeItem(ACCESS_KEY)
        localStorage.removeItem(USER_KEY)
      }
    } catch {}
    set({ session })
  },
  initFromStorage: () => {
    try {
      const access = localStorage.getItem(ACCESS_KEY)
      const userStr = localStorage.getItem(USER_KEY)
      if (access && userStr) {
        const user = JSON.parse(userStr) as UserProfile
        set({ session: { user, accessToken: access }, hydrated: true })
      } else {
        set({ hydrated: true })
      }
    } catch {
      set({ hydrated: true })
    }
  },
}))


