import { create } from 'zustand'
import { Capacitor } from '@capacitor/core'

type NativeSocketPlugin = {
  updateToken: (options: { token: string; refreshToken?: string | null }) => Promise<{ success: boolean }>
}

let nativeSocketPromise: Promise<NativeSocketPlugin | null> | null = null

const getNativeSocket = async (): Promise<NativeSocketPlugin | null> => {
  if (typeof window === 'undefined') return null
  if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== 'android') return null
  if (!nativeSocketPromise) {
    nativeSocketPromise = import('../../capacitor/plugins/native-socket-plugin')
      .then((module) => module.NativeSocket || module.default || null)
      .catch((error) => {
        console.warn('[AppStore] Failed to load NativeSocket plugin', error)
        return null
      })
  }
  return nativeSocketPromise
}

const notifyNativeSocket = async (token: string, refreshToken?: string | null) => {
  const plugin = await getNativeSocket()
  if (!plugin || typeof plugin.updateToken !== 'function') return
  try {
    await plugin.updateToken({ token, refreshToken })
    console.log('[AppStore] ✅ Native socket token updated via store')
  } catch (error) {
    console.warn('[AppStore] ❌ Failed to update native socket token via store', error)
  }
}

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
        notifyNativeSocket(session.accessToken, session.refreshToken ?? undefined).catch(() => {})
      } else {
        localStorage.removeItem(ACCESS_KEY)
        localStorage.removeItem(USER_KEY)
        localStorage.removeItem(REFRESH_KEY)
        notifyNativeSocket('', undefined).catch(() => {})
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
        notifyNativeSocket(access, refresh ?? undefined).catch(() => {})
      } else {
        set({ hydrated: true })
        notifyNativeSocket('', undefined).catch(() => {})
      }
    } catch {
      set({ hydrated: true })
      notifyNativeSocket('').catch(() => {})
    }
  },
}))


