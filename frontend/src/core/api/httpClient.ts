import axios from 'axios'
import { useAppStore } from '../../domain/store/appStore'
import { isNativePlatform } from '../../utils/platform'
import { getDefaultStorageAdapter } from '../storage'

function isTruthyEnv(value: unknown): boolean {
  const normalized = String(value ?? '').trim().toLowerCase()
  return normalized === '1' || normalized === 'true' || normalized === 'yes'
}

export function computeApiBaseUrl(): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const env = (import.meta as any).env ?? {}
  let baseURL: string | undefined = typeof env?.VITE_API_URL === 'string' ? env.VITE_API_URL : undefined
  baseURL = baseURL ? baseURL.trim() : undefined

  const allowCrossOrigin = isTruthyEnv(env?.VITE_ALLOW_CROSS_ORIGIN_API)

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
    return isLocalhost && port && port !== '5173' ? 'http://localhost:4000/api' : '/api'
  } catch {
    return '/api'
  }
}

export const baseURL = computeApiBaseUrl()
export const DEFAULT_API_TIMEOUT_MS = 15_000
export const api = axios.create({
  baseURL,
  withCredentials: true,
})
export const refreshClient = axios.create({
  baseURL,
  withCredentials: true,
})

api.defaults.timeout = DEFAULT_API_TIMEOUT_MS
refreshClient.defaults.timeout = DEFAULT_API_TIMEOUT_MS

const isNativeClient = isNativePlatform()
if (isNativeClient) {
  api.defaults.headers.common = api.defaults.headers.common || {}
  refreshClient.defaults.headers.common = refreshClient.defaults.headers.common || {}
  api.defaults.headers.common['X-Native-Client'] = '1'
  refreshClient.defaults.headers.common['X-Native-Client'] = '1'
}

const storage = getDefaultStorageAdapter()

api.interceptors.request.use((config) => {
  const token = useAppStore.getState().session?.accessToken
  if (token) {
    config.headers = config.headers ?? {}
    config.headers.Authorization = `Bearer ${token}`
  }

  try {
    const raw = storage.getItem('eb_device_info_v1')
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

  try {
    const url = String(config.url ?? '')
    const hasExplicitTimeout = typeof (config as any).timeout === 'number'
    const isLongRunning =
      url.includes('/upload') || url.includes('/uploads') || url.includes('/files') || url.includes('/api/files')
    if (!hasExplicitTimeout && isLongRunning) {
      ;(config as any).timeout = 0
    } else if (!hasExplicitTimeout && !isLongRunning) {
      ;(config as any).timeout = DEFAULT_API_TIMEOUT_MS
    }
  } catch {}

  return config
})

export function getUploadUrl(): string {
  const base = baseURL.replace(/\/$/, '')
  return `${base}/upload`
}
