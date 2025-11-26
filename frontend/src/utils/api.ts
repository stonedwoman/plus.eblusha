import axios, { AxiosError, AxiosHeaders } from 'axios'
import { useAppStore, type SessionState } from '../domain/store/appStore'
import { isNativePlatform } from './platform'

// Определяем базовый URL для API: из переменной окружения, либо умный fallback
let baseURL: string | undefined = (import.meta as any).env?.VITE_API_URL
if (!baseURL) {
  try {
    const isLocalhost = location.hostname === 'localhost' || location.hostname === '127.0.0.1'
    const port = location.port
    // Если фронт запущен не на 5173 (прокси Vite может не работать), бьём напрямую на backend
    baseURL = isLocalhost && port && port !== '5173' ? 'http://localhost:4000/api' : '/api'
  } catch {
    baseURL = '/api'
  }
}

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

