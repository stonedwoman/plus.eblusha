import { useEffect, useState } from 'react'
import { getYouTubeEmbedUrl } from '../chatsEmbeds'

export function YouTubePlayerEmbed({ videoId, openUrl, debug }: { videoId: string; openUrl: string; debug: boolean }) {
  const src = getYouTubeEmbedUrl(videoId)
  const [ready, setReady] = useState(false)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    setReady(false)
    setFailed(false)
  }, [videoId])

  useEffect(() => {
    if (!src) return
    const t = window.setTimeout(() => {
      if (!ready) setFailed(true)
    }, 9000)
    return () => window.clearTimeout(t)
  }, [src, ready])

  useEffect(() => {
    if (!src) return
    const handler = (ev: MessageEvent) => {
      const origin = (ev.origin || '').toLowerCase()
      if (!origin.includes('youtube') && !origin.includes('ytimg') && !origin.includes('youtube-nocookie')) return
      const data = ev.data
      // The player sometimes sends stringified JSON.
      const obj = (() => {
        if (!data) return null
        if (typeof data === 'string') {
          try { return JSON.parse(data) } catch { return null }
        }
        if (typeof data === 'object') return data
        return null
      })() as any
      const eventName = typeof obj?.event === 'string' ? obj.event : null
      if (!eventName) return
      if (debug) {
        // eslint-disable-next-line no-console
        console.log('[YOUTUBE_DEBUG] iframe:message', { origin, event: eventName })
      }
      if (eventName === 'onReady') setReady(true)
      if (eventName === 'onError') setFailed(true)
    }
    window.addEventListener('message', handler)
    return () => window.removeEventListener('message', handler)
  }, [src, debug])

  if (!src) {
    return (
      <div style={{ padding: 12 }}>
        <button className="btn btn-secondary" type="button" onClick={() => window.open(openUrl, '_blank', 'noopener,noreferrer')}>
          Открыть в браузере
        </button>
      </div>
    )
  }

  return (
    <div style={{ position: 'relative', width: '100%', aspectRatio: '16 / 9', borderRadius: 10, overflow: 'hidden', border: '1px solid rgba(255,255,255,0.08)', background: 'rgba(0,0,0,0.18)' }}>
      <iframe
        src={src}
        title="YouTube"
        allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
        allowFullScreen
        loading="lazy"
        style={{ width: '100%', height: '100%', border: 0, display: 'block' }}
      />
      {failed && (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 12, background: 'rgba(0,0,0,0.55)', color: '#fff', textAlign: 'center' }}>
          <div style={{ maxWidth: 420 }}>
            <div style={{ fontWeight: 800, marginBottom: 8 }}>Не удалось встроить YouTube</div>
            <div style={{ opacity: 0.9, fontSize: 13, lineHeight: 1.25, marginBottom: 12 }}>
              YouTube может требовать подтверждение/вход. Откройте видео в браузере.
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
              <button className="btn btn-primary" type="button" onClick={() => window.open(openUrl, '_blank', 'noopener,noreferrer')}>
                Открыть в браузере
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

