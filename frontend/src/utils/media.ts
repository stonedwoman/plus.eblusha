import { baseURL as axiosApiBase } from '../core/api/httpClient'

export type MediaPermissionResult =
  | { ok: true }
  | { ok: false; error: DOMException | Error }

type MediaOptions = {
  audio?: boolean
  video?: boolean
}

export async function ensureMediaPermissions(options: MediaOptions = {}): Promise<MediaPermissionResult> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    return { ok: true }
  }

  const wantsAudio = options.audio !== false
  const wantsVideo = !!options.video

  if (!wantsAudio && !wantsVideo) {
    return { ok: true }
  }

  const constraints: MediaStreamConstraints = {
    audio: wantsAudio,
    video: wantsVideo,
  }

  let stream: MediaStream | null = null
  try {
    stream = await navigator.mediaDevices.getUserMedia(constraints)
    return { ok: true }
  } catch (error) {
    return { ok: false, error: (error as DOMException | Error) ?? new Error('Unknown media error') }
  } finally {
    if (stream) {
      stream.getTracks().forEach((track) => {
        try {
          track.stop()
        } catch {
          // ignore
        }
      })
    }
  }
}

/** Склеенное имя зашифрованного файла на сторедже: `<ms>-<uuid>.eblusha`. */
const EB_STORAGE_BLOB_SUFFIX = /\d{10,}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.eblusha$/i

/** Encode S3 object key for /api/files/ URL (matches backend encodeKeyForUrl). */
export function encodeKeyForUrl(key: string): string {
  return key.split('/').map((s) => encodeURIComponent(s)).join('/')
}

/** Проверить, что строка совпадает с именем блоба (без доп. сегментов пути в конце имени кроме .eblusha). */
function isEblStorageBlobFileName(segment: string): boolean {
  return EB_STORAGE_BLOB_SUFFIX.test(segment)
}

/** Из любого урла брать последний сегмент пути (для «…/uuid.eblusha» после битых относительных ссылок). */
function decodeLastPathSegmentHint(urlish: string): string {
  const pathOnly = urlish.split('?')[0]?.split('#')[0] ?? ''
  let last = pathOnly.split('/').filter(Boolean).pop() ?? ''
  try {
    last = decodeURIComponent(last)
  } catch {
    // keep last
  }
  return last
}

/**
 * Когда страница на одном origin, а Axios с абсолютным `VITE_API_URL` ходит на другой,
 * относительные `/api/files/...` резолвятся неверно → 404. Подставляем origin того же API.
 */
export function attachApiOriginToFilesProxy(relativeProxyPath: string): string {
  if (!relativeProxyPath.startsWith('/api/files')) return relativeProxyPath
  if (typeof window === 'undefined') return relativeProxyPath
  if (!/^https?:\/\//i.test(axiosApiBase)) return relativeProxyPath
  try {
    const pageOrigin = window.location.origin
    const apiRoot = new URL(axiosApiBase, pageOrigin)
    if (apiRoot.origin === pageOrigin) return relativeProxyPath
    return `${apiRoot.origin}${relativeProxyPath}`
  } catch {
    return relativeProxyPath
  }
}

export function convertToProxyUrl(url: string | null | undefined): string | null {
  if (!url) return null

  // Don't touch local blob/data URLs.
  if (url.startsWith('blob:') || url.startsWith('data:')) return url

  const raw = typeof url === 'string' ? url.trim() : String(url ?? '').trim()
  /** Совпадает с дефолтным STORAGE_PREFIX на бэкенде. Все ключи загрузки идут сюда. */
  const uploadsBucket = 'uploads'

  const finalize = (p: string): string =>
    /^https?:\/\//i.test(p) ? p : attachApiOriginToFilesProxy(p)

  const lastHint = decodeLastPathSegmentHint(raw)
  /** Любой URL, заканчивающийся на сторедж-блоб, ведём на канонический ключ uploads/ИМЯ (.eblusha может быть недекодирован в пути дважды). */
  if (lastHint && isEblStorageBlobFileName(lastHint)) {
    return finalize(`/api/files/${encodeKeyForUrl(`${uploadsBucket}/${lastHint}`)}`)
  }

  /** `uploads/…` без схемы и без ведущего `/` из старых биндов. */
  if (/^uploads\/.+/i.test(raw) && !raw.startsWith('/') && !/^[a-z][a-z0-9+.-]*:/i.test(raw)) {
    return finalize(`/api/files/${encodeKeyForUrl(raw)}`)
  }

  // Относительные пути — для /api/files подставить origin API при необходимости.
  if (raw.startsWith('/')) return finalize(raw)

  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return finalize(raw)
  }

  // If it's already a proxy URL, normalize to same-origin relative path.
  if (parsed.pathname.startsWith('/api/files/')) {
    return finalize(`${parsed.pathname}${parsed.search || ''}${parsed.hash || ''}`)
  }

  // Convert any absolute media URL (S3/public storage/etc) to our proxy endpoint.
  const segments = parsed.pathname
    .split('/')
    .filter(Boolean)
    .map((s) => encodeURIComponent(decodeURIComponent(s)))
    .join('/')

  if (!segments) return finalize(raw)

  const suffix = `${parsed.search || ''}${parsed.hash || ''}`
  return finalize(`/api/files/${segments}${suffix}`)
}

/** Extract S3 object key from /api/files/ URL. Returns null if URL format unknown. */
export function extractObjectKeyFromUrl(url: string | null | undefined): string | null {
  if (!url?.trim()) return null
  let pathname = url.trim()
  try {
    if (url.startsWith('http')) {
      const u = new URL(url)
      pathname = u.pathname
    }
  } catch {
    return null
  }
  const prefix = '/api/files/'
  if (pathname.startsWith(prefix)) {
    const rest = pathname.slice(prefix.length).replace(/^\//, '')
    return rest
      .split('/')
      .map((s) => decodeURIComponent(s))
      .join('/')
  }
  return null
}


