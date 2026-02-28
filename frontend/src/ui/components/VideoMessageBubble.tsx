import { useEffect, useRef, useState } from 'react'
import { Video, Play, Maximize2, Loader2 } from 'lucide-react'
import { api } from '../../utils/api'
import { encodeKeyForUrl } from '../../utils/media'

const thumbInFlight = new Set<string>()

const ASPECT_MIN = 0.75
const ASPECT_MAX = 1.78

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

  const initialUrl = (() => {
    if (initialPosterUrl) return initialPosterUrl
    if (posterKey) return `/api/files/${encodeKeyForUrl(posterKey)}`
    return null
  })()
  const [posterUrl, setPosterUrl] = useState<string | null>(() => initialUrl)
  const [thumbLoading, setThumbLoading] = useState(!posterUrl && !!attachmentId && !thumbInFlight.has(attachmentId))
  const [thumbError, setThumbError] = useState(false)

  const rawRatio = typeof width === 'number' && typeof height === 'number' && width > 0 ? height / width : 9 / 16
  const ratio = Math.max(1 / ASPECT_MAX, Math.min(1 / ASPECT_MIN, rawRatio))
  const vw = typeof window !== 'undefined' ? window.innerWidth : 320
  const isMobile = vw <= 768
  const maxW = isMobile ? (vw - 48) : 420
  const maxH = 420

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
    if (isInlinePlaying && videoRef.current) {
      if (videoRef.current.paused) {
        videoRef.current.play().catch(() => {})
      } else {
        videoRef.current.pause()
      }
    } else {
      setIsInlinePlaying(true)
    }
  }

  const bubbleStyle: React.CSSProperties = {
    marginTop: 8,
    width: '100%',
    maxWidth: maxW,
    minHeight: 180,
    aspectRatio: `${1} / ${ratio}`,
    maxHeight: isMobile ? maxH : undefined,
    borderRadius: 14,
    overflow: 'hidden',
    position: 'relative',
    background: 'var(--surface-100)',
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

  if (decryptPending) {
    return (
      <div className="video-message-bubble" style={bubbleStyle} onClick={stopProp} onMouseDown={stopProp} role="presentation">
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
          Расшифровка видео...
        </div>
      </div>
    )
  }

  if (decryptError) {
    return (
      <div className="video-message-bubble" style={bubbleStyle} onClick={stopProp} onMouseDown={stopProp} role="presentation">
        <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, color: '#f87171', fontSize: 12, padding: 16 }}>
          <span>Не удалось расшифровать</span>
          {videoSrc && (
            <a href={videoSrc} download={fileName || 'video.mp4'} style={{ color: 'var(--brand)', textDecoration: 'underline' }} onClick={(e) => e.stopPropagation()}>Скачать</a>
          )}
        </div>
      </div>
    )
  }

  if (!videoSrc) {
    const statusText = uploadInProgress ? 'Загрузка…' : 'Видео недоступно'
    return (
      <div className="video-message-bubble" style={bubbleStyle} onClick={stopProp} onMouseDown={stopProp} role="presentation">
        <div
          style={{
            position: 'absolute',
            inset: 0,
            background: 'linear-gradient(180deg, #1a1d24 0%, #0f1115 100%)',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <div style={{ width: 56, height: 56, borderRadius: '50%', background: 'rgba(255,255,255,0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Play size={32} color="rgba(255,255,255,0.9)" fill="rgba(255,255,255,0.9)" style={{ marginLeft: 4 }} />
          </div>
          <div style={{ position: 'absolute', bottom: 12, left: 12, display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'rgba(255,255,255,0.6)' }}>
            {uploadInProgress && <Loader2 size={14} style={{ animation: 'spin 1s linear infinite', flexShrink: 0 }} />}
            <span>{statusText}</span>
          </div>
        </div>
      </div>
    )
  }

  if (isInlinePlaying) {
    return (
      <div
        className="video-message-bubble"
        style={bubbleStyle}
        onClick={(e) => { stopProp(e); handleBubbleClick() }}
        onMouseDown={stopProp}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleBubbleClick() } }}
      >
        <video
          ref={videoRef}
          src={videoSrc}
          controls
          playsInline
          preload="metadata"
          poster={posterUrl || undefined}
          style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block', background: '#000' }}
        />
        {btnFullscreen}
      </div>
    )
  }

  return (
    <div
      className="video-message-bubble"
      style={bubbleStyle}
      onClick={(e) => { stopProp(e); handleBubbleClick() }}
      onMouseDown={stopProp}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleBubbleClick() } }}
    >
      {posterUrl && !thumbError ? (
        <img
          src={posterUrl}
          alt=""
          style={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            display: 'block',
          }}
          loading="lazy"
          onError={() => setThumbError(true)}
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
      <div
        style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: posterUrl ? 'rgba(0,0,0,0.2)' : 'transparent',
          pointerEvents: 'none',
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
