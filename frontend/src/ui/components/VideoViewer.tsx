import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { X, Download } from 'lucide-react'

type Props = {
  open: boolean
  videoUrl: string
  fileName?: string
  onClose: () => void
}

export function VideoViewer({ open, videoUrl, fileName, onClose }: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    if (!open) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    setError(false)
    return () => {
      document.body.style.overflow = prev
    }
  }, [open])

  useEffect(() => {
    if (open && videoRef.current) {
      videoRef.current.play().catch(() => {})
    }
  }, [open, videoUrl])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') onClose()
  }

  if (!open) return null

  const content = (
    <div
      className="imglb-root"
      style={{ position: 'fixed', inset: 0, zIndex: 120, color: '#fff' }}
      onKeyDown={handleKeyDown}
      role="dialog"
      aria-modal="true"
      aria-label="Видео"
    >
      <div
        className="imglb-backdrop"
        style={{
          position: 'absolute',
          inset: 0,
          background: 'rgba(0,0,0,0.9)',
          backdropFilter: 'blur(8px)',
        }}
        onClick={onClose}
      />
      <div
        style={{
          position: 'absolute',
          top: 16,
          left: 16,
          right: 16,
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          zIndex: 10,
        }}
      >
        <div style={{ width: 40, height: 40 }} />
        <button
          className="imglb-btn"
          onClick={onClose}
          aria-label="Закрыть"
          style={{
            width: 40,
            height: 40,
            borderRadius: 999,
            border: '1px solid rgba(255,255,255,0.2)',
            background: 'rgba(0,0,0,0.3)',
            color: '#fff',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
          }}
        >
          <X size={22} />
        </button>
      </div>
      <div
        style={{
          position: 'absolute',
          inset: 56,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 24,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {error ? (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 16,
              color: 'rgba(255,255,255,0.9)',
              textAlign: 'center',
              maxWidth: 320,
            }}
          >
            <div style={{ fontSize: 15 }}>Не удалось воспроизвести видео</div>
            <a
              href={videoUrl}
              download={fileName || 'video.mp4'}
              className="btn btn-primary"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 8,
                padding: '10px 16px',
                borderRadius: 12,
                background: 'var(--brand)',
                color: '#fff',
                textDecoration: 'none',
                fontWeight: 600,
              }}
            >
              <Download size={18} />
              Скачать
            </a>
          </div>
        ) : (
          <video
            ref={videoRef}
            src={videoUrl}
            controls
            autoPlay
            playsInline
            preload="metadata"
            style={{
              maxWidth: '100%',
              maxHeight: '100%',
              objectFit: 'contain',
              borderRadius: 12,
              background: '#000',
            }}
            onError={() => setError(true)}
          />
        )}
      </div>
      {!error && (
        <div
          style={{
            position: 'absolute',
            bottom: 24,
            left: 24,
            right: 24,
            display: 'flex',
            justifyContent: 'center',
            zIndex: 10,
          }}
        >
          <a
            href={videoUrl}
            download={fileName || 'video.mp4'}
            className="btn"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
              padding: '10px 20px',
              borderRadius: 12,
              background: 'rgba(0,0,0,0.5)',
              border: '1px solid rgba(255,255,255,0.2)',
              color: '#fff',
              textDecoration: 'none',
              fontWeight: 500,
            }}
          >
            <Download size={18} />
            Скачать
          </a>
        </div>
      )}
    </div>
  )

  return createPortal(content, document.body)
}
