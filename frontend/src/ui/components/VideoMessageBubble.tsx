import { useEffect, useRef, useState } from 'react'
import { Video, Play, Maximize2, Loader2 } from 'lucide-react'
import { api } from '../../utils/api'
import { encodeKeyForUrl } from '../../utils/media'

const thumbInFlight = new Set<string>()

// Cache aspect ratio (w/h) learned from thumbnail for attachments that lack metadata.
const aspectByAttachmentId = new Map<string, number>()

function safeAspect(w: unknown, h: unknown): number | null {
  const ww = typeof w === 'number' ? w : Number(w)
  const hh = typeof h === 'number' ? h : Number(h)
  if (!Number.isFinite(ww) || !Number.isFinite(hh) || ww <= 0 || hh <= 0) return null
  return ww / hh
}

type Props = {
  attachmentId: string
  objectKey?: string | null
  videoSrc: string | null
  posterKey?: string | null
  initialPosterUrl?: string | null
  width?: number
  height?: number
  duration?: number
  sizeText?: string
  fileName?: string
  decryptPending?: boolean
  decryptError?: boolean
  uploadInProgress?: boolean
  onOpenFullscreenViewer: (url: string, fileName?: string) => void
}

export function VideoMessageBubble({
  attachmentId,
  objectKey,
  videoSrc,
  posterKey,
  initialPosterUrl,
  width,
  height,
  duration,
  sizeText,
  fileName,
  decryptPending,
  decryptError,
  uploadInProgress = false,
  onOpenFullscreenViewer,
}: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const [isInlinePlaying, setIsInlinePlaying] = useState(false)
  const [videoReady, setVideoReady] = useState(false)
  const [pendingStart, setPendingStart] = useState(false)

  const initialUrl = (() => {
    if (initialPosterUrl) return initialPosterUrl
    if (posterKey) return `/api/files/${encodeKeyForUrl(posterKey)}`
    return null
  })()
  const [posterUrl, setPosterUrl] = useState<string | null>(() => initialUrl)
  const [thumbLoading, setThumbLoading] = useState(!posterUrl && !!attachmentId && !thumbInFlight.has(attachmentId))
  const [thumbError, setThumbError] = useState(false)

  const aspectFromMeta = safeAspect(width, height)
  const aspectFromCache = attachmentId ? aspectByAttachmentId.get(attachmentId) ?? null : null
  const [aspect, setAspect] = useState<number | null>(() => aspectFromMeta ?? aspectFromCache)
  const [aspectSource, setAspectSource] = useState<'meta' | 'thumb' | 'cache' | 'unknown'>(() => {
    if (aspectFromMeta) return 'meta'
    if (aspectFromCache) return 'cache'
    return 'unknown'
  })
  const showVideo = isInlinePlaying
  const showLoadingOverlay =
    !!videoSrc &&
    !decryptPending &&
    !decryptError &&
    (pendingStart || (isInlinePlaying && !videoReady))

  useEffect(() => {
    if (isInlinePlaying) return
    if (!attachmentId) return
    if (!aspectFromMeta) return
    aspectByAttachmentId.set(attachmentId, aspectFromMeta)
    setAspect(aspectFromMeta)
    setAspectSource('meta')
  }, [attachmentId, aspectFromMeta, isInlinePlaying])

  useEffect(() => {
    if (posterUrl || !attachmentId || thumbInFlight.has(attachmentId) || decryptPending) return
    if (!objectKey) {
      // eslint-disable-next-line no-console
      console.warn('[VideoMessageBubble] No objectKey, backend will fallback to url', { attachmentId })
    }

    thumbInFlight.add(attachmentId)
    setThumbLoading(true)
    setThumbError(false)

    const body = objectKey ? { objectKey } : {}
    api
      .post<{ posterKey?: string }>(`/attachments/${attachmentId}/thumbnail`, body)
      .then((r) => {
        const data = r.data as Record<string, unknown>
        const pk = (data?.posterKey ?? data?.poster_file_key) as string | undefined
        if (pk && typeof pk === 'string') {
          setPosterUrl(`/api/files/${encodeKeyForUrl(pk)}`)
        }
        const a = safeAspect((data as any)?.width, (data as any)?.height)
        if (!isInlinePlaying && a && attachmentId && !aspectFromMeta) {
          aspectByAttachmentId.set(attachmentId, a)
          setAspect(a)
          setAspectSource('thumb')
        }
      })
      .catch((err: any) => {
        // eslint-disable-next-line no-console
        console.warn('[VideoMessageBubble] Thumbnail request failed:', err?.response?.status ?? err?.message, { attachmentId })
        setThumbError(true)
      })
      .finally(() => {
        thumbInFlight.delete(attachmentId)
        setThumbLoading(false)
      })
  }, [attachmentId, objectKey, posterUrl, decryptPending])

  useEffect(() => {
    if (!posterUrl && initialPosterUrl) setPosterUrl(initialPosterUrl)
  }, [initialPosterUrl])

  useEffect(() => {
    if (!posterUrl && posterKey) setPosterUrl(`/api/files/${encodeKeyForUrl(posterKey)}`)
  }, [posterKey])

  useEffect(() => {
    if (isInlinePlaying && videoRef.current && videoSrc) {
      setVideoReady(false)
      videoRef.current.play().catch(() => {})
    }
  }, [isInlinePlaying, videoSrc])

  const handleFullscreen = () => {
    if (isInlinePlaying && videoRef.current) {
      const el = videoRef.current
      if (el.requestFullscreen) {
        el.requestFullscreen().catch(() => {
          if (videoSrc) onOpenFullscreenViewer(videoSrc, fileName)
        })
      } else if (videoSrc) {
        onOpenFullscreenViewer(videoSrc, fileName)
      }
    } else if (videoSrc) {
      onOpenFullscreenViewer(videoSrc, fileName)
    }
  }

  const stopProp = (e: React.MouseEvent) => {
    e.stopPropagation()
  }

  const handleBubbleClick = () => {
    if (!videoSrc || uploadInProgress) return
    if (pendingStart) return
    if (isInlinePlaying && !videoReady) return
    if (isInlinePlaying && videoRef.current) {
      if (videoRef.current.paused) {
        videoRef.current.play().catch(() => {})
      } else {
        videoRef.current.pause()
      }
    } else {
      setPendingStart(true)
      setIsInlinePlaying(true)
      setPendingStart(false)
    }
  }

  const bubbleStyle: React.CSSProperties = {
    marginTop: 8,
    width: '100%',
    maxWidth: 480,
    aspectRatio: aspect ? `${aspect}` : '1 / 1',
    borderRadius: 14,
    overflow: 'hidden',
    position: 'relative',
    background: '#000',
    border: '1px solid var(--surface-border)',
    cursor: videoSrc && !uploadInProgress ? 'pointer' : 'default',
  }

  const btnFullscreen = (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation()
        handleFullscreen()
      }}
      onMouseDown={stopProp}
      aria-label="Полный экран"
      style={{
        position: 'absolute',
        top: 8,
        right: 8,
        zIndex: 5,
        width: 32,
        height: 32,
        borderRadius: 8,
        background: 'rgba(0,0,0,0.5)',
        border: '1px solid rgba(255,255,255,0.2)',
        color: '#fff',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: 'pointer',
      }}
    >
      <Maximize2 size={16} />
    </button>
  )

  return (
    <div
      className="video-message-bubble"
      style={bubbleStyle}
      onClick={isInlinePlaying ? undefined : (e) => { stopProp(e); handleBubbleClick() }}
      onMouseDown={isInlinePlaying ? undefined : stopProp}
      role={isInlinePlaying ? undefined : 'button'}
      tabIndex={isInlinePlaying ? undefined : 0}
      onKeyDown={isInlinePlaying ? undefined : (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleBubbleClick() } }}
    >
      {/* Video layer (crossfades in) */}
      <video
        ref={videoRef}
        src={videoSrc || undefined}
        controls={isInlinePlaying}
        playsInline
        preload={isInlinePlaying ? 'metadata' : 'none'}
        poster={posterUrl || undefined}
        onCanPlay={() => setVideoReady(true)}
        style={{
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
          objectFit: 'contain',
          display: 'block',
          background: '#000',
          opacity: isInlinePlaying ? 1 : 0,
          transition: 'opacity 180ms ease',
          pointerEvents: isInlinePlaying ? 'auto' : 'none',
        }}
      />

      {/* Preview layer (crossfades out) */}
      {posterUrl && !thumbError ? (
        <img
          src={posterUrl}
          alt=""
          style={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            objectFit: 'contain',
            display: 'block',
            background: '#000',
            opacity: isInlinePlaying ? 0 : 1,
            transition: 'opacity 180ms ease',
          }}
          loading="lazy"
          onError={() => setThumbError(true)}
          onLoad={(e) => {
            if (isInlinePlaying || aspectSource === 'meta') return
            const img = e.currentTarget
            const nw = img.naturalWidth
            const nh = img.naturalHeight
            if (nw > 0 && nh > 0) {
              const nextAspect = nw / nh
              if (attachmentId && !aspectFromMeta) aspectByAttachmentId.set(attachmentId, nextAspect)
              setAspect(nextAspect)
              setAspectSource('thumb')
            }
          }}
        />
      ) : (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            background: 'linear-gradient(180deg, #1a1d24 0%, #0f1115 100%)',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            opacity: isInlinePlaying ? 0 : 1,
            transition: 'opacity 180ms ease',
          }}
        >
          <div style={{ width: 56, height: 56, borderRadius: '50%', background: 'rgba(255,255,255,0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Play size={32} color="rgba(255,255,255,0.9)" fill="rgba(255,255,255,0.9)" style={{ marginLeft: 4 }} />
          </div>
          {thumbLoading && !thumbError && (
            <div style={{ position: 'absolute', bottom: 12, left: 12, display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'rgba(255,255,255,0.6)' }}>
              <Loader2 size={14} style={{ animation: 'spin 1s linear infinite', flexShrink: 0 }} />
              <span>Генерирую превью…</span>
            </div>
          )}
          {thumbError && <span style={{ position: 'absolute', bottom: 12, left: 12, fontSize: 11, color: 'rgba(255,255,255,0.6)' }}>без превью</span>}
        </div>
      )}

      {/* Status overlays */}
      {decryptPending && (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontSize: 13, background: 'rgba(0,0,0,0.15)', pointerEvents: 'none' }}>
          Расшифровка видео...
        </div>
      )}
      {decryptError && (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, color: '#f87171', fontSize: 12, padding: 16, background: 'rgba(0,0,0,0.15)' }}>
          <span>Не удалось расшифровать</span>
          {videoSrc && (
            <a href={videoSrc} download={fileName || 'video.mp4'} style={{ color: 'var(--brand)', textDecoration: 'underline', pointerEvents: 'auto' }} onClick={(e) => e.stopPropagation()}>Скачать</a>
          )}
        </div>
      )}
      {!videoSrc && (
        <div style={{ position: 'absolute', bottom: 12, left: 12, display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'rgba(255,255,255,0.6)' }}>
          {uploadInProgress && <Loader2 size={14} style={{ animation: 'spin 1s linear infinite', flexShrink: 0 }} />}
          <span>{uploadInProgress ? 'Загрузка…' : 'Видео недоступно'}</span>
        </div>
      )}
      {pendingStart && !isInlinePlaying && !showLoadingOverlay && (
        <div style={{ position: 'absolute', bottom: 12, left: 12, display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'rgba(255,255,255,0.6)' }}>
          <Loader2 size={14} style={{ animation: 'spin 1s linear infinite', flexShrink: 0 }} />
          <span>Загружаю…</span>
        </div>
      )}

      {showLoadingOverlay && (
        <div
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          role="presentation"
          style={{
            position: 'absolute',
            inset: 0,
            zIndex: 6,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 16,
            background: 'linear-gradient(180deg, rgba(5,7,10,0.40) 0%, rgba(5,7,10,0.58) 100%)',
            backdropFilter: 'blur(6px)',
            WebkitBackdropFilter: 'blur(6px)',
            pointerEvents: 'none',
            opacity: isInlinePlaying || pendingStart ? 1 : 0,
            transition: 'opacity 180ms ease',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              padding: '12px 14px',
              borderRadius: 999,
              background: 'rgba(0,0,0,0.55)',
              border: '1px solid rgba(255,255,255,0.14)',
              boxShadow: '0 12px 30px rgba(0,0,0,0.35)',
              color: 'rgba(255,255,255,0.92)',
              maxWidth: '100%',
            }}
          >
            <div
              style={{
                width: 36,
                height: 36,
                borderRadius: 999,
                background: 'rgba(255,255,255,0.10)',
                border: '1px solid rgba(255,255,255,0.16)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Loader2 size={18} style={{ animation: 'spin 0.9s linear infinite' }} />
            </div>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 650, letterSpacing: 0.2, whiteSpace: 'nowrap' }}>
                Загружаю видео…
              </div>
              <div style={{ marginTop: 2, fontSize: 11, color: 'rgba(255,255,255,0.66)', whiteSpace: 'nowrap' }}>
                Подготовка к воспроизведению
              </div>
            </div>
          </div>
        </div>
      )}

      <div
        style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: posterUrl ? 'rgba(0,0,0,0.2)' : 'transparent',
          pointerEvents: 'none',
          opacity: isInlinePlaying ? 0 : 1,
          transition: 'opacity 180ms ease',
        }}
      >
        <div
          style={{
            width: 56,
            height: 56,
            borderRadius: '50%',
            background: 'rgba(255,255,255,0.9)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
          }}
        >
          <Play size={28} color="#0b1220" fill="#0b1220" style={{ marginLeft: 4 }} />
        </div>
      </div>
      {btnFullscreen}
      <div
        style={{
          position: 'absolute',
          bottom: 8,
          left: 8,
          right: 8,
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-end',
          color: '#fff',
          fontSize: 12,
          textShadow: '0 1px 2px rgba(0,0,0,0.8)',
          pointerEvents: 'none',
        }}
      >
        <span>
          {duration != null ? `${Math.floor(duration / 60)}:${String(duration % 60).padStart(2, '0')}` : ''}
          {duration != null && sizeText ? ' · ' : ''}
          {sizeText}
        </span>
      </div>
    </div>
  )
}
