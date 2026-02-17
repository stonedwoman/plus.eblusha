import axios, { AxiosError, AxiosHeaders } from 'axios'
import { useAppStore, type SessionState } from '../domain/store/appStore'
import { isNativePlatform } from './platform'

function isTruthyEnv(v: unknown): boolean {
  const s = String(v ?? '').trim().toLowerCase()
  return s === '1' || s === 'true' || s === 'yes'
}

// Определяем базовый URL для API: из переменной окружения, либо умный fallback.
//
// Важно: по умолчанию НЕ позволяем случайно использовать кросс-ориджин absolute URL в проде.
// Это защищает от ситуации, когда стейдж/плюс фронт внезапно стучится в ru.eblusha.org и ловит 502.
function computeApiBaseUrl(): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const env = (import.meta as any).env ?? {}
  let baseURL: string | undefined = typeof env?.VITE_API_URL === 'string' ? env.VITE_API_URL : undefined
  baseURL = baseURL ? baseURL.trim() : undefined

  const allowCrossOrigin = isTruthyEnv(env?.VITE_ALLOW_CROSS_ORIGIN_API)

  // If env URL is absolute and points to another origin, ignore it unless explicitly allowed
  if (baseURL && /^https?:\/\//i.test(baseURL)) {
    try {
      const targetOrigin = new URL(baseURL).origin
      const currentOrigin = typeof window !== 'undefined' ? window.location.origin : null
      const isLocalhost =
        typeof window !== 'undefined' &&
        (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')

      if (currentOrigin && targetOrigin !== currentOrigin && !allowCrossOrigin && !isLocalhost) {
        baseURL = undefined
      }
    } catch {
      baseURL = undefined
    }
  }

  if (baseURL) return baseURL

  try {
    const isLocalhost = location.hostname === 'localhost' || location.hostname === '127.0.0.1'
    const port = location.port
    // Если фронт запущен не на 5173 (прокси Vite может не работать), бьём напрямую на backend
    return isLocalhost && port && port !== '5173' ? 'http://localhost:4000/api' : '/api'
  } catch {
    return '/api'
  }
}

const baseURL = computeApiBaseUrl()

export const api = axios.create({
  baseURL,
  withCredentials: true,
})

const refreshClient = axios.create({
  baseURL,
  withCredentials: true,
})

const isNativeClient = isNativePlatform()
if (isNativeClient) {
  api.defaults.headers.common = api.defaults.headers.common || {}
  refreshClient.defaults.headers.common = refreshClient.defaults.headers.common || {}
  api.defaults.headers.common['X-Native-Client'] = '1'
  refreshClient.defaults.headers.common['X-Native-Client'] = '1'
}

let refreshPromise: Promise<SessionState | null> | null = null

function isAuthEndpoint(url?: string) {
  if (!url) return false
  return /\/auth\/(login|register|refresh|logout)/.test(url)
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

  // Refresh token is now in httpOnly cookie, so we don't need to send it in body
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
    .catch((error) => {
      throw error
    })
    .finally(() => {
      refreshPromise = null
    })

  return refreshPromise
}

api.interceptors.request.use((config) => {
  const token = useAppStore.getState().session?.accessToken
  if (token) {
    config.headers = config.headers ?? {}
    config.headers.Authorization = `Bearer ${token}`
  }
  // Best-effort deviceId propagation for multi-device E2EE flows.
  try {
    const raw = typeof window !== 'undefined' ? window.localStorage.getItem('eb_device_info_v1') : null
    if (raw) {
      const parsed = JSON.parse(raw) as any
      const did = typeof parsed?.deviceId === 'string' ? parsed.deviceId.trim() : ''
      if (did) {
        config.headers = config.headers ?? {}
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ;(config.headers as any)['X-Device-Id'] = did
      }
    }
  } catch {}

  // Avoid "minute-long hangs" when network/proxy is half-dead.
  // Set a sane default timeout for API calls, but DO NOT apply it to uploads/files streaming.
  try {
    const url = String(config.url ?? '')
    const hasExplicitTimeout = typeof (config as any).timeout === 'number'
    const isLongRunning =
      url.includes('/upload') || url.includes('/uploads') || url.includes('/files') || url.includes('/api/files')
    if (!hasExplicitTimeout && !isLongRunning) {
      ;(config as any).timeout = 15_000
    }
  } catch {}
  return config
})

api.interceptors.response.use(
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
      return api(originalRequest)
    } catch (refreshError) {
      const refreshAxiosError = refreshError as AxiosError
      if (refreshAxiosError.response?.status === 401 || refreshAxiosError.response?.status === 403) {
        useAppStore.getState().setSession(null)
      }
      throw refreshError
    }
  },
)

export function forceRefreshSession() {
  return refreshTokens()
}

