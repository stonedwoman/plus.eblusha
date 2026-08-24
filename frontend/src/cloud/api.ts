import axios, { type AxiosInstance } from 'axios'

/**
 * HTTP-клиент Cloud.
 *
 * Отличается от api мессенджера принципиально: здесь НЕ используется Bearer-токен
 * Еблуши. Аутентификация — своя HttpOnly-кука cloud_sid, поэтому withCredentials
 * обязателен, а все мутации подписываются заголовком X-Cloud-CSRF (SameSite=Lax
 * плюс кастомный заголовок, который кросс-сайтовая форма выставить не может).
 */
export const CLOUD_API_BASE = '/api/cloud'

let csrfToken: string | null = null

export function setCloudCsrf(token: string | null) {
  csrfToken = token
}

export function getCloudCsrf(): string | null {
  return csrfToken
}

export const cloudApi: AxiosInstance = axios.create({
  baseURL: CLOUD_API_BASE,
  withCredentials: true,
  timeout: 30_000,
})

cloudApi.interceptors.request.use((config) => {
  const method = (config.method ?? 'get').toUpperCase()
  if (method !== 'GET' && method !== 'HEAD' && csrfToken) {
    config.headers = config.headers ?? {}
    config.headers['X-Cloud-CSRF'] = csrfToken
  }
  return config
})

/**
 * Событие «сессия умерла». Ловит CloudLayout и заново проходит SSO.
 *
 * Раньше протухшая cloud_sid оставляла человека на живой с виду странице, где
 * каждый клик отвечал тостом «Нужно войти заново» — и ничего не предлагал.
 * Перехватчик один на приложение; шлём событие с антидребезгом, чтобы пачка
 * одновременно упавших запросов не устроила шторм повторных логинов.
 */
let lastAuthEventAt = 0
cloudApi.interceptors.response.use(
  (r) => r,
  (err) => {
    const status = axios.isAxiosError(err) ? err.response?.status : 0
    const url = axios.isAxiosError(err) ? (err.config?.url ?? '') : ''
    // /auth/* не трогаем: их 401 — часть нормального протокола входа.
    if (status === 401 && !url.startsWith('/auth') && Date.now() - lastAuthEventAt > 15_000) {
      lastAuthEventAt = Date.now()
      window.dispatchEvent(new CustomEvent('cloud:unauthorized'))
    }
    return Promise.reject(err)
  }
)

export type CloudApiError = {
  code: string
  message: string
  status: number
  requestId?: string
}

/** Разбор типизированной ошибки API: фронт различает 401/403/404/409/413/422/429/507. */
export function toCloudError(err: unknown): CloudApiError {
  if (axios.isAxiosError(err)) {
    const status = err.response?.status ?? 0
    const data = err.response?.data as { code?: string; message?: string; requestId?: string } | undefined
    if (data?.code) return { code: data.code, message: data.message ?? 'Ошибка', status, requestId: data.requestId }
    if (status === 0) return { code: 'NETWORK', message: 'Нет связи с сервером', status }
    return { code: `HTTP_${status}`, message: humanStatus(status), status }
  }
  return { code: 'UNKNOWN', message: 'Неизвестная ошибка', status: 0 }
}

function humanStatus(status: number): string {
  switch (status) {
    case 401:
      return 'Нужно войти заново'
    case 403:
      return 'Недостаточно прав'
    case 404:
      return 'Не найдено'
    case 409:
      return 'Конфликт состояния'
    case 413:
      return 'Файл слишком большой'
    case 422:
      return 'Некорректный запрос'
    case 429:
      return 'Слишком много запросов, подождите'
    case 507:
      return 'В хранилище не хватает места'
    default:
      return 'Ошибка сервера'
  }
}

/** Роль по-русски: enum из БД человеку показывать нельзя. */
export function roleLabel(role: string | null | undefined): string {
  switch (role) {
    case 'OWNER':
      return 'Владелец'
    case 'EDITOR':
      return 'Редактор'
    case 'VIEWER':
      return 'Зритель'
    default:
      return role ?? ''
  }
}

export function formatBytes(bytes: number, digits = 1): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1024) return `${bytes} Б`
  const units = ['КБ', 'МБ', 'ГБ', 'ТБ']
  let value = bytes / 1024
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i++
  }
  return `${value.toFixed(value >= 100 ? 0 : digits)} ${units[i]}`
}

export function formatDuration(ms: number | null | undefined): string {
  if (!ms || ms <= 0) return ''
  const total = Math.round(ms / 1000)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`
}

export function formatEta(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return ''
  if (seconds < 60) return `${Math.round(seconds)} сек`
  if (seconds < 3600) return `${Math.round(seconds / 60)} мин`
  const h = Math.floor(seconds / 3600)
  const m = Math.round((seconds % 3600) / 60)
  return `${h} ч ${m} мин`
}
