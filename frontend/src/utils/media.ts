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

export function convertToProxyUrl(url: string | null | undefined): string | null {
  if (!url) return null

  // Don't touch local blob/data URLs.
  if (url.startsWith('blob:') || url.startsWith('data:')) return url

  // Already relative (includes /api/files/* proxy case)
  if (url.startsWith('/')) return url

  // If we can't parse, return as-is.
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return url
  }

  // If it's already a proxy URL, normalize to same-origin relative path.
  if (parsed.pathname.startsWith('/api/files/')) {
    return `${parsed.pathname}${parsed.search || ''}${parsed.hash || ''}`
  }

  // Convert any absolute media URL (S3/public storage/etc) to our proxy endpoint.
  // This avoids CORS issues in waveform generation and mitigates blocked storage domains.
  const segments = parsed.pathname
    .split('/')
    .filter(Boolean)
    .map((s) => encodeURIComponent(decodeURIComponent(s)))
    .join('/')

  // If URL has no usable path, keep original.
  if (!segments) return url

  const suffix = `${parsed.search || ''}${parsed.hash || ''}`
  return `/api/files/${segments}${suffix}`
}


