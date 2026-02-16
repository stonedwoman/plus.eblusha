export type YouTubeOpenMode = 'embed' | 'external' | 'electron_session' | 'system_browser'

const YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'gaming.youtube.com',
  'youtu.be',
])

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/

function sanitizeVideoId(candidate: string | null | undefined): string | null {
  if (!candidate) return null
  const id = (candidate.trim().split(/[?&#/]/)[0] || '')
  return VIDEO_ID_RE.test(id) ? id : null
}

function isYouTubeHost(hostname: string): boolean {
  const host = hostname.toLowerCase()
  if (YOUTUBE_HOSTS.has(host)) return true
  return host === 'youtube.com' || host.endsWith('.youtube.com') || host === 'youtu.be' || host.endsWith('.youtu.be')
}

function decodeMaybeTwice(value: string): string {
  let out = value
  for (let i = 0; i < 2; i++) {
    try {
      const decoded = decodeURIComponent(out)
      if (decoded === out) break
      out = decoded
    } catch {
      break
    }
  }
  return out
}

export function parseYouTubeVideoId(urlString: string): string | null {
  const extract = (value: string, depth: number): string | null => {
    if (depth > 3) return null
    const direct = sanitizeVideoId(value)
    if (direct) return direct

    let u: URL
    try {
      u = new URL(value)
    } catch {
      try {
        u = new URL(value, 'https://www.youtube.com')
      } catch {
        const rx = /(?:youtu\.be\/|youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|live\/|embed\/|v\/))([A-Za-z0-9_-]{11})/i.exec(value)
        return sanitizeVideoId(rx?.[1] || null)
      }
    }

    const host = u.hostname.toLowerCase()
    if (isYouTubeHost(host)) {
      if (host === 'youtu.be' || host.endsWith('.youtu.be')) {
        const id = sanitizeVideoId(u.pathname.split('/').filter(Boolean)[0] || null)
        if (id) return id
      }

      const v = sanitizeVideoId(u.searchParams.get('v'))
      if (v) return v
      const vi = sanitizeVideoId(u.searchParams.get('vi'))
      if (vi) return vi

      const parts = u.pathname.split('/').filter(Boolean)
      const head = (parts[0] || '').toLowerCase()
      const fromPath = sanitizeVideoId(parts[1] || null)
      if ((head === 'shorts' || head === 'live' || head === 'embed' || head === 'v') && fromPath) return fromPath
    }

    for (const key of ['url', 'u', 'q', 'target', 'dest', 'destination', 'redirect', 'redir', 'link', 'href']) {
      const raw = u.searchParams.get(key)
      if (!raw) continue
      const nested = extract(decodeMaybeTwice(raw), depth + 1)
      if (nested) return nested
    }
    return null
  }

  try {
    return extract(urlString, 0)
  } catch {
    return null
  }
}

export function getYouTubeEmbedUrl(videoId: string): string | null {
  const id = (videoId || '').trim()
  if (!VIDEO_ID_RE.test(id)) return null
  const embed = new URL(`https://www.youtube-nocookie.com/embed/${id}`)
  embed.searchParams.set('autoplay', '0')
  embed.searchParams.set('rel', '0')
  embed.searchParams.set('modestbranding', '1')
  embed.searchParams.set('playsinline', '1')
  embed.searchParams.set('enablejsapi', '1')
  const origin =
    typeof window !== 'undefined' &&
    typeof window.location?.origin === 'string' &&
    (window.location.origin.startsWith('http://') || window.location.origin.startsWith('https://'))
      ? window.location.origin
      : null
  if (origin) embed.searchParams.set('origin', origin)
  return embed.toString()
}

export function getSpotifyEmbed(urlString: string): { url: string; height: number } | null {
  try {
    const u = new URL(urlString)
    const host = u.hostname.toLowerCase()
    if (!host.includes('spotify.com') && host !== 'spoti.fi') return null
    if (host === 'spoti.fi') return null // short links require a HEAD/redirect; skip for now
    const parts = u.pathname.split('/').filter(Boolean)
    const type = parts[0]
    const id = parts[1]
    if (!type || !id) return null
    const allow = new Set(['track', 'album', 'playlist', 'episode', 'show', 'artist'])
    if (!allow.has(type)) return null
    const embedUrl = `https://open.spotify.com/embed/${type}/${id}`
    const height = type === 'track' ? 152 : 352
    return { url: embedUrl, height }
  } catch {
    return null
  }
}

export function getDefaultYouTubeOpenMode(): YouTubeOpenMode {
  // Mobile native wrappers should prefer system browser components.
  const isCapacitor =
    typeof window !== 'undefined' &&
    (window as any).Capacitor &&
    ((window as any).Capacitor.isNativePlatform?.() || (window as any).Capacitor.getPlatform?.() !== 'web')
  return isCapacitor ? 'system_browser' : 'embed'
}

export function getYouTubeOpenMode(): YouTubeOpenMode {
  try {
    const raw =
      (typeof localStorage !== 'undefined' ? localStorage.getItem('youtubeOpenMode') : null) ||
      null
    const v = (raw || '').trim()
    if (v === 'embed' || v === 'external' || v === 'electron_session' || v === 'system_browser') return v
  } catch {}
  return getDefaultYouTubeOpenMode()
}

export async function openUrlSystemBrowser(url: string) {
  // Best-effort: Capacitor Browser plugin if present; fallback to window.open.
  const w: any = typeof window !== 'undefined' ? window : null
  const cap = w?.Capacitor
  const browser = cap?.Plugins?.Browser
  if (browser?.open) {
    try {
      await browser.open({ url })
      return
    } catch {}
  }
  window.open(url, '_blank', 'noopener,noreferrer')
}

