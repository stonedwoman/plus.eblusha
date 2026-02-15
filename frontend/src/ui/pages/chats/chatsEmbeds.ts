export type YouTubeOpenMode = 'embed' | 'external' | 'electron_session' | 'system_browser'

export function parseYouTubeVideoId(urlString: string): string | null {
  try {
    const u = new URL(urlString)
    const host = u.hostname.toLowerCase()
    if (host === 'youtu.be' || host.endsWith('.youtu.be')) {
      const id = u.pathname.replace(/^\//, '').split('/')[0] || null
      return id
    }
    if (host === 'youtube.com' || host.endsWith('.youtube.com')) {
      const v = u.searchParams.get('v')
      if (v) return v
      const parts = u.pathname.split('/').filter(Boolean)
      const head = parts[0] || ''
      const id = parts[1] || ''
      if (head === 'shorts' || head === 'embed' || head === 'v') return id || null
    }
    return null
  } catch {
    return null
  }
}

export function getYouTubeEmbedUrl(videoId: string): string | null {
  const id = (videoId || '').trim()
  if (!id) return null
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

