import { useEffect, useRef, useState } from 'react'
import { getYouTubeEmbedUrl } from '../chatsEmbeds'

let NEXT_WIDGET_ID = 1
function allocWidgetId(): number {
  const n = NEXT_WIDGET_ID
  NEXT_WIDGET_ID += 1
  return n
}

export function YouTubePlayerEmbed({ videoId, openUrl, debug }: { videoId: string; openUrl: string; debug: boolean }) {
  const srcBase = getYouTubeEmbedUrl(videoId)
  const widgetIdRef = useRef<number>(0)
  if (!widgetIdRef.current) widgetIdRef.current = allocWidgetId()
  const widgetId = widgetIdRef.current

  const src = (() => {
    if (!srcBase) return null
    try {
      const u = new URL(srcBase)
      u.searchParams.set('widgetid', String(widgetId))
      return u.toString()
    } catch {
      return srcBase
    }
  })()

  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  const [ready, setReady] = useState(false)
  const [failed, setFailed] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const [playerState, setPlayerState] = useState<number | null>(null)

  useEffect(() => {
    setReady(false)
    setFailed(false)
    setDismissed(false)
    setPlayerState(null)
  }, [videoId])

  useEffect(() => {
    if (!src) return
    // Tell the YouTube iframe that we are listening, so it starts emitting events back.
    // Some browsers/players may ignore the first message, so retry briefly.
    let stopped = false
    let tries = 0
    const postListening = () => {
      if (stopped) return
      tries += 1
      const win = iframeRef.current?.contentWindow
      if (win) {
        try {
          win.postMessage(JSON.stringify({ event: 'listening', id: widgetId, channel: 'widget' }), '*')
        } catch {}
      }
      if (tries >= 10) return
      window.setTimeout(postListening, 350)
    }
    // Kick off after a tick so iframeRef is set.
    window.setTimeout(postListening, 0)
    return () => { stopped = true }
  }, [src, widgetId])

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

      // If multiple YouTube iframes exist, ignore events for other widgets when possible.
      const msgId = obj?.id
      if (typeof msgId === 'number' && msgId !== widgetId) return
      if (typeof msgId === 'string' && msgId.trim() && msgId.trim() !== String(widgetId)) return

      if (debug) {
        // eslint-disable-next-line no-console
        console.log('[YOUTUBE_DEBUG] iframe:message', { origin, event: eventName })
      }

      const info = obj?.info
      const nextState = typeof info?.playerState === 'number' ? info.playerState : null
      if (nextState !== null) setPlayerState(nextState)

      // If we see a playing state, never show the failure overlay.
      if (nextState === 1) {
        setReady(true)
        setFailed(false)
        return
      }

      if (eventName === 'initialDelivery') {
        const vd = info?.videoData
        const isPlayable = typeof vd?.isPlayable === 'boolean' ? vd.isPlayable : null
        const errorCode = vd?.errorCode ?? null
        if (isPlayable === false || errorCode) {
          setFailed(true)
        }
        return
      }

      if (eventName === 'onReady') {
        setReady(true)
        return
      }
      if (eventName === 'onError') {
        setFailed(true)
      }
    }
    window.addEventListener('message', handler)
    return () => window.removeEventListener('message', handler)
  }, [src, debug, widgetId])

  if (!src) {
    return (
      <div style={{ padding: 12 }}>
        <button className="btn btn-secondary" type="button" onClick={() => window.open(openUrl, '_blank', 'noopener,noreferrer')}>
          Открыть в браузере
        </button>
      </div>
    )
  }

  const showOverlay = failed && !dismissed && playerState !== 1

  return (
    <div style={{ position: 'relative', width: '100%', aspectRatio: '16 / 9', borderRadius: 10, overflow: 'hidden', border: '1px solid rgba(255,255,255,0.08)', background: 'rgba(0,0,0,0.18)' }}>
      <iframe
        ref={(el) => { iframeRef.current = el }}
        src={src}
        title="YouTube"
        allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
        allowFullScreen
        loading="lazy"
        style={{ width: '100%', height: '100%', border: 0, display: 'block' }}
      />
      {showOverlay && (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 12, background: 'rgba(0,0,0,0.55)', color: '#fff', textAlign: 'center' }}>
          <button
            type="button"
            aria-label="Закрыть"
            onClick={() => setDismissed(true)}
            style={{
              position: 'absolute',
              top: 8,
              right: 8,
              width: 34,
              height: 34,
              borderRadius: 999,
              border: '1px solid rgba(255,255,255,0.18)',
              background: 'rgba(0,0,0,0.45)',
              color: '#fff',
              cursor: 'pointer',
              fontSize: 20,
              lineHeight: '34px',
              padding: 0,
            }}
          >
            ×
          </button>
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

