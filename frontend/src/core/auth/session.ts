import { AxiosError, AxiosHeaders, type AxiosInstance } from 'axios'
import { useAppStore, type SessionState } from '../../domain/store/appStore'
import { api, refreshClient } from '../api/httpClient'
import { getDefaultStorageAdapter } from '../storage'
import { getNativeStoredTokens, isAndroidNativeSessionRuntime } from './nativeSession'

let refreshPromise: Promise<SessionState | null> | null = null
let interceptorsInstalled = false
const storage = getDefaultStorageAdapter()

function isAuthEndpoint(url?: string) {
  if (!url) return false
  return /\/(auth\/(login|register|refresh|logout)|mobile\/session\/bootstrap)/.test(url)
}

function buildRefreshRequestBody() {
  const token = useAppStore.getState().session?.refreshToken
  if (token) {
    return { refreshToken: token }
  }
  return undefined
}

async function refreshTokens(): Promise<SessionState | null> {
  if (refreshPromise) {
    return refreshPromise
  }

  const currentSession = useAppStore.getState().session
  if (!currentSession) {
    return null
  }

  const payload = buildRefreshRequestBody()
  refreshPromise = refreshClient
    .post('/auth/refresh', payload)
    .then((response) => {
      const latestSession = useAppStore.getState().session
      if (!latestSession) return null
      const updatedSession: SessionState = {
        ...latestSession,
        accessToken: response.data.accessToken,
        refreshToken: response.data.refreshToken ?? latestSession.refreshToken,
      }
      useAppStore.getState().setSession(updatedSession)
      return updatedSession
    })
    .finally(() => {
      refreshPromise = null
    })

  return refreshPromise
}

function installAuthInterceptorForClient(client: AxiosInstance) {
  client.interceptors.response.use(
    (response) => response,
    async (error) => {
      const axiosError = error as AxiosError
      const originalRequest = axiosError.config as (typeof axiosError.config & { _retry?: boolean }) | undefined

      if (
        !axiosError.response ||
        axiosError.response.status !== 401 ||
        !originalRequest ||
        originalRequest._retry ||
        isAuthEndpoint(originalRequest.url)
      ) {
        throw error
      }

      originalRequest._retry = true

      try {
        const updatedSession = await refreshTokens()
        if (!updatedSession) {
          useAppStore.getState().setSession(null)
          throw error
        }
        if (!originalRequest.headers) {
          originalRequest.headers = new AxiosHeaders()
        }
        if (originalRequest.headers instanceof AxiosHeaders) {
          originalRequest.headers.set('Authorization', `Bearer ${updatedSession.accessToken}`)
        } else {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ;(originalRequest.headers as any).Authorization = `Bearer ${updatedSession.accessToken}`
        }
        return client(originalRequest)
      } catch (refreshError) {
        const refreshAxiosError = refreshError as AxiosError
        if (refreshAxiosError.response?.status === 401 || refreshAxiosError.response?.status === 403) {
          useAppStore.getState().setSession(null)
        }
        throw refreshError
      }
    },
  )
}

export function installSessionInterceptors(): void {
  if (interceptorsInstalled) return
  interceptorsInstalled = true
  installAuthInterceptorForClient(api)
}

export function forceRefreshSession() {
  return refreshTokens()
}

export function getAccessExpMs(token: string | undefined | null): number | null {
  if (!token) return null
  try {
    const [, payload] = token.split('.')
    const json = JSON.parse(atob(payload))
    if (typeof json?.exp === 'number') {
      return json.exp * 1000
    }
    return null
  } catch {
    return null
  }
}

function buildMobileBootstrapBody(refreshToken: string) {
  let deviceId: string | undefined
  try {
    const raw = storage.getItem('eb_device_info_v1')
    if (raw) {
      const parsed = JSON.parse(raw) as { deviceId?: string }
      const candidate = typeof parsed?.deviceId === 'string' ? parsed.deviceId.trim() : ''
      if (candidate) {
        deviceId = candidate
      }
    }
  } catch {}
  return {
    refreshToken,
    client: 'android-apk' as const,
    ...(deviceId ? { deviceId } : {}),
  }
}

async function tryBootstrapNativeSession(): Promise<boolean | null> {
  if (!isAndroidNativeSessionRuntime()) {
    return null
  }
  const nativeTokens = await getNativeStoredTokens()
  const refreshToken = nativeTokens?.refreshToken ?? useAppStore.getState().session?.refreshToken ?? null
  if (!refreshToken) {
    return null
  }

  try {
    const response = await refreshClient.post('/mobile/session/bootstrap', buildMobileBootstrapBody(refreshToken))
    if (response.data?.accessToken && response.data?.user) {
      useAppStore.getState().setSession({
        user: {
          id: response.data.user.id,
          username: response.data.user.username,
          displayName: response.data.user.displayName,
          avatarUrl: response.data.user.avatarUrl,
        },
        accessToken: response.data.accessToken,
        refreshToken: response.data.refreshToken ?? refreshToken,
      })
      return true
    }
    return null
  } catch (error) {
    const status = (error as { response?: { status?: number } })?.response?.status
    if (status === 401 || status === 403) {
      useAppStore.getState().setSession(null)
      return false
    }
    throw error
  }
}

export async function validateStoredSession(): Promise<boolean> {
  try {
    const bootstrapResult = await tryBootstrapNativeSession()
    if (bootstrapResult !== null) {
      return bootstrapResult
    }
  } catch {
    // Fall back to the normal web flow if native bootstrap is temporarily unavailable.
  }

  const session = useAppStore.getState().session

  if (!session) {
    try {
      const response = await api.post('/auth/refresh')
      if (response.data?.accessToken) {
        const userResponse = await api.get('/status/me')
        if (userResponse.data?.user) {
          useAppStore.getState().setSession({
            user: {
              id: userResponse.data.user.id,
              username: userResponse.data.user.username,
              displayName: userResponse.data.user.displayName,
              avatarUrl: userResponse.data.user.avatarUrl,
            },
            accessToken: response.data.accessToken,
            refreshToken: response.data.refreshToken ?? undefined,
          })
          return true
        }
      }
    } catch {
      return false
    }
    return false
  }

  try {
    const response = await api.get('/status/me')
    if (response.data?.user) {
      useAppStore.getState().setSession({
        ...session,
        user: {
          id: response.data.user.id,
          username: response.data.user.username,
          displayName: response.data.user.displayName,
          avatarUrl: response.data.user.avatarUrl,
        },
      })
      return true
    }
    return false
  } catch (error) {
    try {
      const refreshed = await forceRefreshSession()
      if (refreshed) {
        const userResponse = await api.get('/status/me')
        if (userResponse.data?.user) {
          useAppStore.getState().setSession({
            user: {
              id: userResponse.data.user.id,
              username: userResponse.data.user.username,
              displayName: userResponse.data.user.displayName,
              avatarUrl: userResponse.data.user.avatarUrl,
            },
            accessToken: refreshed.accessToken,
            refreshToken: refreshed.refreshToken ?? undefined,
          })
          return true
        }
      }
    } catch (refreshError) {
      const status = (refreshError as { response?: { status?: number } })?.response?.status
      if (status === 401 || status === 403) {
        useAppStore.getState().setSession(null)
      }
      return false
    }
    return false
  }
}
