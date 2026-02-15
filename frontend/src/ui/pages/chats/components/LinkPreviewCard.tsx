import { useState, type CSSProperties } from 'react'
import { Play } from 'lucide-react'
import { decodeUrlForDisplay } from '../chatsTextRender'
import { getSpotifyEmbed, getYouTubeEmbedUrl, getYouTubeOpenMode, openUrlSystemBrowser, parseYouTubeVideoId } from '../chatsEmbeds'
import { YouTubePlayerEmbed } from './YouTubePlayerEmbed'

export function LinkPreviewCard({ preview }: { preview: any }) {
  // Full preview when metadata exists, but still show a minimal card (domain + url) when it doesn't.
  if (!preview || typeof preview !== 'object') return null
  const url = typeof preview.url === 'string' ? preview.url : null
  const title = typeof preview.title === 'string' ? preview.title : null
  const description = typeof preview.description === 'string' ? preview.description : null
  const imageUrl = typeof preview.imageUrl === 'string' ? preview.imageUrl : null
  const imageWidth = typeof preview.imageWidth === 'number' && preview.imageWidth > 0 ? preview.imageWidth : null
  const imageHeight = typeof preview.imageHeight === 'number' && preview.imageHeight > 0 ? preview.imageHeight : null
  const siteName = typeof preview.siteName === 'string' ? preview.siteName : null
  const isLoading = (preview as any).__loading === true
  const blockedReason = typeof (preview as any).blockedReason === 'string' ? (preview as any).blockedReason : null
  if (!url) return null

  const YOUTUBE_DEBUG =
    typeof window !== 'undefined' &&
    (
      (window as any).__YOUTUBE_DEBUG === true ||
      (typeof localStorage !== 'undefined' && localStorage.getItem('YOUTUBE_DEBUG') === '1') ||
      (typeof location !== 'undefined' && location.search.includes('YOUTUBE_DEBUG=1'))
    )

  const [showEmbed, setShowEmbed] = useState(false)
  const [measured, setMeasured] = useState<{ w: number; h: number } | null>(null)

  const siteLabel = siteName || (() => {
    try { return new URL(url).hostname } catch { return null }
  })()
  const fallbackTitle = (() => {
    try {
      const u = new URL(url)
      const host = u.hostname
      const pathRaw = (u.pathname && u.pathname !== '/' ? u.pathname : '')
      const path = pathRaw ? decodeUrlForDisplay(pathRaw) : ''
      return (host + path).slice(0, 160)
    } catch {
      return url.slice(0, 160)
    }
  })()
  const finalTitle = title || fallbackTitle
  const hasImage = !!imageUrl
  const aspectRatio =
    imageWidth && imageHeight
      ? `${imageWidth} / ${imageHeight}`
      : (measured?.w && measured?.h)
        ? `${measured.w} / ${measured.h}`
        : (hasImage ? '16 / 9' : undefined)
  const isMediaProvider = (() => {
    const label = (siteLabel || '').toLowerCase()
    if (label.includes('youtube') || label.includes('spotify')) return true
    try {
      const host = new URL(url).hostname.toLowerCase()
      return host.includes('youtube.com') || host === 'youtu.be' || host.includes('spotify.com') || host === 'spoti.fi'
    } catch {
      return false
    }
  })()
  // Never crop: show the whole image, let the container grow by aspect ratio.
  const imageFit: CSSProperties['objectFit'] = 'contain'

  const spotifyEmbed = getSpotifyEmbed(url)
  const youTubeId = url ? parseYouTubeVideoId(url) : null
  const youTubeMode = getYouTubeOpenMode()
  const embed =
    spotifyEmbed
      ? ({ kind: 'spotify' as const, url: spotifyEmbed.url, height: spotifyEmbed.height })
      : null

  const loading = isLoading && !blockedReason

  const effectiveW = imageWidth ?? measured?.w ?? null
  const maxCardW = (() => {
    const vw = typeof window !== 'undefined' ? window.innerWidth : 1280
    // Keep within bubble's max-width (92% viewport) and existing 720px cap.
    return Math.min(720, Math.floor(vw * 0.92) - 24)
  })()
  const targetW =
    effectiveW ??
    (youTubeId ? 560 : embed?.kind === 'spotify' ? 520 : null)
  const cardW = typeof targetW === 'number' && targetW > 0 ? Math.min(maxCardW, targetW) : null

  return (
    <div
      role="link"
      tabIndex={0}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={() => {
        if (YOUTUBE_DEBUG) {
          // eslint-disable-next-line no-console
          console.log('[YOUTUBE_DEBUG] ui:open', { url })
        }
        window.open(url, '_blank', 'noopener,noreferrer')
      }}
      style={{
        display: cardW ? 'inline-block' : 'block',
        width: cardW ? cardW : undefined,
        maxWidth: '100%',
        marginTop: 8,
        borderRadius: 12,
        overflow: 'hidden',
        border: '1px solid var(--surface-border)',
        background: 'rgba(0,0,0,0.10)',
        boxShadow: '0 6px 18px rgba(0,0,0,0.25)',
        position: 'relative',
        textDecoration: 'none',
        color: 'inherit',
        cursor: 'pointer',
      }}
    >
      <div style={{ padding: hasImage ? '12px 12px 10px 12px' : '12px 12px 12px 12px' }}>
        {siteLabel && (
          <div
            style={{
              fontSize: 12,
              fontWeight: 700,
              color: 'var(--brand)',
              marginBottom: 6,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {siteLabel}
          </div>
        )}
        <div style={{ fontSize: 14, fontWeight: 800, marginBottom: description ? 6 : 0, lineHeight: 1.25 }}>
          {finalTitle}
        </div>
        {!!description && (
          <div
            style={{
              fontSize: 13,
              opacity: 0.9,
              lineHeight: 1.25,
              display: '-webkit-box',
              WebkitLineClamp: hasImage ? 2 : 3,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
            }}
          >
            {description}
          </div>
        )}
        {!description && loading && (
          <div
            style={{
              marginTop: 6,
              height: 30,
              borderRadius: 8,
              background:
                'linear-gradient(90deg, rgba(255,255,255,0.06) 25%, rgba(255,255,255,0.12) 37%, rgba(255,255,255,0.06) 63%)',
              backgroundSize: '400% 100%',
              animation: 'eb-shimmer 1.2s ease-in-out infinite',
            }}
          />
        )}
      </div>
      {showEmbed && (youTubeId || embed) && (
        <div style={{ padding: '0 12px 12px 12px' }} onMouseDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
          {youTubeId ? (
            <YouTubePlayerEmbed videoId={youTubeId} openUrl={url} debug={YOUTUBE_DEBUG} />
          ) : (
            (() => {
              const sEmbed = embed as { kind: 'spotify'; url: string; height: number } | null
              if (!sEmbed) return null
              return (
                <div
                  style={{
                    width: '100%',
                    height: sEmbed.height,
                    borderRadius: 10,
                    overflow: 'hidden',
                    background: 'rgba(0,0,0,0.18)',
                    border: '1px solid rgba(255,255,255,0.08)',
                  }}
                >
                  <iframe
                    src={sEmbed.url}
                    title={finalTitle}
                    allow="encrypted-media"
                    loading="lazy"
                    style={{ width: '100%', height: '100%', border: 0, display: 'block' }}
                  />
                </div>
              )
            })()
          )}
        </div>
      )}
      {!showEmbed && (imageUrl || loading) && (
        <div style={{ padding: '0 12px 12px 12px' }}>
          <div
            style={{
              width: '100%',
              ...(embed?.kind === 'spotify'
                ? { height: embed.height }
                : (youTubeId ? { aspectRatio: '16 / 9' } : (aspectRatio ? { aspectRatio } : {}))),
              borderRadius: 10,
              overflow: 'hidden',
              background: isMediaProvider ? 'rgba(0,0,0,0.35)' : 'rgba(0,0,0,0.18)',
              border: '1px solid rgba(255,255,255,0.08)',
              position: 'relative',
            }}
          >
            {imageUrl ? (
              <img
                src={imageUrl}
                alt=""
                style={{ width: '100%', height: '100%', maxWidth: 'none', maxHeight: 'none', display: 'block', objectFit: imageFit, objectPosition: 'center' }}
                loading="lazy"
                referrerPolicy="no-referrer"
                onLoad={(e) => {
                  const img = e.currentTarget
                  const w = img.naturalWidth
                  const h = img.naturalHeight
                  if (w > 0 && h > 0 && !measured) setMeasured({ w, h })
                }}
                onError={(e) => {
                  const el = e.currentTarget
                  el.style.display = 'none'
                }}
              />
            ) : (
              <div
                style={{
                  position: 'absolute',
                  inset: 0,
                  background:
                    'linear-gradient(90deg, rgba(255,255,255,0.06) 25%, rgba(255,255,255,0.12) 37%, rgba(255,255,255,0.06) 63%)',
                  backgroundSize: '400% 100%',
                  animation: 'eb-shimmer 1.2s ease-in-out infinite',
                }}
              />
            )}
            {(youTubeId || embed) && (
              <button
                type="button"
                onMouseDown={(e) => e.stopPropagation()}
                onClick={async (e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  if (youTubeId) {
                    if (YOUTUBE_DEBUG) {
                      // eslint-disable-next-line no-console
                      console.log('[YOUTUBE_DEBUG] ui:youtube:play', { url, videoId: youTubeId, mode: youTubeMode })
                    }
                    if (youTubeMode === 'external') {
                      window.open(url, '_blank', 'noopener,noreferrer')
                      return
                    }
                    if (youTubeMode === 'system_browser') {
                      await openUrlSystemBrowser(url)
                      return
                    }
                    if (youTubeMode === 'electron_session') {
                      const embedUrl = getYouTubeEmbedUrl(youTubeId)
                      const w: any = window as any
                      if (embedUrl && typeof w?.__openYouTubeWindow === 'function') {
                        try { w.__openYouTubeWindow(embedUrl) } catch {}
                        return
                      }
                      window.open(url, '_blank', 'noopener,noreferrer')
                      return
                    }
                    // embed (default)
                    setShowEmbed(true)
                    return
                  }
                  if (embed) {
                    if (YOUTUBE_DEBUG) {
                      // eslint-disable-next-line no-console
                      console.log('[YOUTUBE_DEBUG] ui:embed:show', { url, embedUrl: embed.url })
                    }
                    setShowEmbed(true)
                  }
                }}
                style={{
                  position: 'absolute',
                  inset: 0,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  border: 'none',
                  background: 'linear-gradient(180deg, rgba(0,0,0,0.05), rgba(0,0,0,0.25))',
                  color: '#fff',
                  cursor: 'pointer',
                }}
                aria-label="Play"
              >
                <span
                  style={{
                    width: 56,
                    height: 56,
                    borderRadius: 999,
                    background: 'rgba(0,0,0,0.55)',
                    border: '1px solid rgba(255,255,255,0.18)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    backdropFilter: 'blur(6px)',
                  }}
                >
                  <Play size={24} />
                </span>
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

