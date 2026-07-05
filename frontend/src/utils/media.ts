import { baseURL as axiosApiBase } from '../core/api/httpClient'

export type MediaPermissionResult =
  | { ok: true; videoUnavailable?: boolean }
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

  // A capture device can be momentarily "busy" (NotReadableError / TrackStartError / AbortError) when
  // a previous getUserMedia hasn't released it yet — e.g. this very permission pre-check on a prior
  // attempt, or a call that just ended. For video that window is wider (the camera frees slower than
  // the mic). Retry transient busy errors with a short backoff so a single press succeeds on its own.
  // Permission denials / missing devices are NOT transient and fail immediately.
  const TRANSIENT_ERRORS = new Set(['NotReadableError', 'TrackStartError', 'AbortError'])
  const MAX_ATTEMPTS = 3

  const probe = async (constraints: MediaStreamConstraints): Promise<MediaPermissionResult> => {
    let lastError: DOMException | Error = new Error('Unknown media error')
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      let stream: MediaStream | null = null
      try {
        stream = await navigator.mediaDevices.getUserMedia(constraints)
        return { ok: true }
      } catch (error) {
        lastError = (error as DOMException | Error) ?? new Error('Unknown media error')
        const name = (lastError as { name?: string })?.name ?? ''
        if (!TRANSIENT_ERRORS.has(name) || attempt === MAX_ATTEMPTS) {
          return { ok: false, error: lastError }
        }
        // Device busy — wait for it to free up, then retry (250ms, then 500ms).
        await new Promise((resolve) => setTimeout(resolve, 250 * attempt))
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
    return { ok: false, error: lastError }
  }

  const primary = await probe({ audio: wantsAudio, video: wantsVideo })
  if (primary.ok) return { ok: true }

  // Video call whose combined audio+video capture failed: the camera may be
  // denied/busy/absent while the microphone is perfectly fine. Do NOT block the whole
  // call over a camera problem — fall back to an audio-only probe. If audio works, the
  // call proceeds audio-only (video stays best-effort and is published opportunistically).
  if (wantsVideo && wantsAudio) {
    const audioOnly = await probe({ audio: true, video: false })
    if (audioOnly.ok) return { ok: true, videoUnavailable: true }
  }

  return primary
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

/**
 * URL для превью-плитки в сетке сообщений: добавляет ?thumb=1 к прокси-URL картинки —
 * сервер отдаёт уменьшенную копию (~720px), а если её нет (старое фото / секретный чат /
 * генерация не удалась) — полный размер (безопасный фолбэк). Для blob:/data:/не-прокси
 * (секретные чаты расшифровывают в blob) — как есть. Лайтбокс всегда открывает оригинал.
 */
export function gridThumbUrl(url: string | null | undefined): string | null {
  if (!url) return url ?? null
  if (!url.includes('/api/files/')) return url
  return url + (url.includes('?') ? '&' : '?') + 'thumb=1'
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


