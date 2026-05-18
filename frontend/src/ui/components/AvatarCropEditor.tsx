import { useEffect, useRef, useState } from 'react'

const CROP_SIZE = 240

type TouchState = {
  touches: Touch[]
  initialDistance: number
  initialScale: number
  initialX: number
  initialY: number
}

type Props = {
  imageUrl: string
  onConfirm: (blob: Blob) => void
  onCancel: () => void
  isMobile?: boolean
}

function getDistance(t1: Touch, t2: Touch) {
  const dx = t2.clientX - t1.clientX
  const dy = t2.clientY - t1.clientY
  return Math.sqrt(dx * dx + dy * dy)
}

function getCenter(t1: Touch, t2: Touch) {
  return { x: (t1.clientX + t2.clientX) / 2, y: (t1.clientY + t2.clientY) / 2 }
}

function isPointInCircle(x: number, y: number, cx: number, cy: number, r: number) {
  const dx = x - cx
  const dy = y - cy
  return dx * dx + dy * dy <= r * r
}

export function AvatarCropEditor({ imageUrl, onConfirm, onCancel, isMobile = false }: Props) {
  const [crop, setCrop] = useState({ x: 0, y: 0, scale: 1 })
  const cropRef = useRef(crop)
  cropRef.current = crop
  const editorRef = useRef<HTMLDivElement>(null)
  const imageRef = useRef<HTMLImageElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const touchStateRef = useRef<TouchState | null>(null)
  const rafRef = useRef<number | null>(null)

  useEffect(() => {
    const editor = editorRef.current
    if (!editor) return

    const handleTouchStart = (e: TouchEvent) => {
      const rect = editor.getBoundingClientRect()
      if (!rect) return
      const centerX = rect.width / 2
      const centerY = rect.height / 2
      const radius = CROP_SIZE / 2
      const current = cropRef.current

      if (e.touches.length === 1) {
        const t = e.touches[0]
        const tx = t.clientX - rect.left
        const ty = t.clientY - rect.top
        if (!isPointInCircle(tx, ty, centerX, centerY, radius)) return
        touchStateRef.current = {
          touches: [t],
          initialDistance: 0,
          initialScale: current.scale,
          initialX: current.x,
          initialY: current.y,
        }
        e.preventDefault()
      } else if (e.touches.length === 2) {
        const [t1, t2] = [e.touches[0], e.touches[1]]
        const center = getCenter(t1, t2)
        const cx = center.x - rect.left
        const cy = center.y - rect.top
        if (!isPointInCircle(cx, cy, centerX, centerY, radius)) return
        touchStateRef.current = {
          touches: [t1, t2],
          initialDistance: getDistance(t1, t2),
          initialScale: current.scale,
          initialX: current.x,
          initialY: current.y,
        }
        e.preventDefault()
      }
    }

    const handleTouchMove = (e: TouchEvent) => {
      if (!touchStateRef.current) return
      e.preventDefault()
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current)
      rafRef.current = requestAnimationFrame(() => {
        if (!touchStateRef.current) return
        const rect = editor.getBoundingClientRect()
        if (!rect) return
        const centerX = rect.width / 2
        const centerY = rect.height / 2
        const n = e.touches.length
        const inN = touchStateRef.current.touches.length

        if (n === 1 && inN === 1) {
          const t = e.touches[0]
          const i0 = touchStateRef.current.touches[0]
          const dx = t.clientX - i0.clientX
          const dy = t.clientY - i0.clientY
          setCrop((prev) => {
            let newX = touchStateRef.current!.initialX + dx
            let newY = touchStateRef.current!.initialY + dy
            const img = imageRef.current
            if (img) {
              const scale = prev.scale
              const iw = img.naturalWidth * scale
              const ih = img.naturalHeight * scale
              const maxX = centerX + CROP_SIZE / 2
              const minX = centerX - CROP_SIZE / 2 - iw
              const maxY = centerY + CROP_SIZE / 2
              const minY = centerY - CROP_SIZE / 2 - ih
              newX = Math.max(minX, Math.min(maxX, newX))
              newY = Math.max(minY, Math.min(maxY, newY))
            }
            return { ...prev, x: newX, y: newY }
          })
        } else if (n === 2 && inN === 2) {
          const [t1, t2] = [e.touches[0], e.touches[1]]
          const dist = getDistance(t1, t2)
          const scaleChange = dist / touchStateRef.current.initialDistance
          const newScale = Math.max(0.1, Math.min(10, touchStateRef.current.initialScale * scaleChange))
          const img = imageRef.current
          if (img) {
            const iw = img.naturalWidth
            const ih = img.naturalHeight
            const initCx = touchStateRef.current.initialX + (iw * touchStateRef.current.initialScale) / 2
            const initCy = touchStateRef.current.initialY + (ih * touchStateRef.current.initialScale) / 2
            const vx = initCx - centerX
            const vy = initCy - centerY
            const ratio = newScale / touchStateRef.current.initialScale
            const newCx = centerX + vx * ratio
            const newCy = centerY + vy * ratio
            setCrop({
              x: newCx - (iw * newScale) / 2,
              y: newCy - (ih * newScale) / 2,
              scale: newScale,
            })
          }
        }
        rafRef.current = null
      })
    }

    const handleTouchEnd = () => {
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
      touchStateRef.current = null
    }

    editor.addEventListener('touchstart', handleTouchStart, { passive: false })
    editor.addEventListener('touchmove', handleTouchMove, { passive: false })
    editor.addEventListener('touchend', handleTouchEnd, { passive: true })
    editor.addEventListener('touchcancel', handleTouchEnd, { passive: true })
    return () => {
      editor.removeEventListener('touchstart', handleTouchStart)
      editor.removeEventListener('touchmove', handleTouchMove)
      editor.removeEventListener('touchend', handleTouchEnd)
      editor.removeEventListener('touchcancel', handleTouchEnd)
    }
  }, [imageUrl])

  const handleApply = async () => {
    const canvas = canvasRef.current
    const editor = editorRef.current
    if (!canvas || !editor || !imageUrl) return
    const img = await new Promise<HTMLImageElement>((resolve) => {
      const i = new Image()
      i.onload = () => resolve(i)
      i.src = imageUrl
    })
    const ctx = canvas.getContext('2d')!
    ctx.clearRect(0, 0, CROP_SIZE, CROP_SIZE)
    ctx.save()
    ctx.beginPath()
    ctx.arc(CROP_SIZE / 2, CROP_SIZE / 2, CROP_SIZE / 2, 0, Math.PI * 2)
    ctx.closePath()
    ctx.clip()
    const vw = editor.clientWidth ?? 320
    const vh = editor.clientHeight ?? 320
    const viewCenter = { x: vw / 2, y: vh / 2 }
    const viewRect = {
      x: viewCenter.x - CROP_SIZE / 2,
      y: viewCenter.y - CROP_SIZE / 2,
      w: CROP_SIZE,
      h: CROP_SIZE,
    }
    const srcX = (viewRect.x - crop.x) / crop.scale
    const srcY = (viewRect.y - crop.y) / crop.scale
    const srcW = viewRect.w / crop.scale
    const srcH = viewRect.h / crop.scale
    ctx.drawImage(img, srcX, srcY, srcW, srcH, 0, 0, CROP_SIZE, CROP_SIZE)
    ctx.restore()
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob((b) => resolve(b), 'image/png')
    )
    if (blob) onConfirm(blob)
  }

  return (
    <div
      style={{
        border: '1px solid var(--surface-border)',
        borderRadius: 16,
        padding: 16,
        marginTop: 12,
        background: 'var(--tab-surface, var(--surface-100))',
        boxShadow: '0 4px 12px rgba(0,0,0,0.1)',
      }}
    >
      <div style={{ fontSize: 14, color: 'var(--tab-text, var(--text-primary))', marginBottom: 12, fontWeight: 600 }}>
        Настройка аватара
      </div>
      <div
        ref={editorRef}
        onWheel={(e) => {
          e.preventDefault()
          const delta = -e.deltaY * 0.001
          const newScale = Math.max(0.1, Math.min(10, crop.scale * (1 + delta)))
          const rect = editorRef.current?.getBoundingClientRect()
          if (rect) {
            const x = e.clientX - rect.left
            const y = e.clientY - rect.top
            const scaleChange = newScale / crop.scale
            const newX = x - (x - crop.x) * scaleChange
            const newY = y - (y - crop.y) * scaleChange
            setCrop({ x: newX, y: newY, scale: newScale })
          }
        }}
        onPointerDown={(e) => {
          if (e.pointerType === 'touch') return
          const rect = editorRef.current?.getBoundingClientRect()
          if (!rect) return
          const centerX = rect.width / 2
          const centerY = rect.height / 2
          const radius = CROP_SIZE / 2
          const x = e.clientX - rect.left
          const y = e.clientY - rect.top
          if ((x - centerX) ** 2 + (y - centerY) ** 2 > radius ** 2) return
          try {
            (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
          } catch {}
          const startX = e.clientX
          const startY = e.clientY
          const start = { ...crop }
          const onMove = (ev: PointerEvent) => {
            ev.preventDefault()
            setCrop({
              ...start,
              x: start.x + (ev.clientX - startX),
              y: start.y + (ev.clientY - startY),
            })
          }
          const onUp = () => {
            window.removeEventListener('pointermove', onMove)
            window.removeEventListener('pointerup', onUp)
          }
          window.addEventListener('pointermove', onMove, { passive: false })
          window.addEventListener('pointerup', onUp, { passive: true })
        }}
        style={{
          position: 'relative',
          width: '100%',
          height: 320,
          background: 'var(--surface-200)',
          overflow: 'hidden',
          borderRadius: 12,
          touchAction: 'none',
          border: '1px solid var(--surface-border)',
          boxShadow: 'inset 0 2px 8px rgba(0,0,0,0.1)',
          cursor: 'move',
        }}
      >
        <img
          ref={imageRef}
          src={imageUrl}
          alt=""
          style={{
            position: 'absolute',
            left: crop.x,
            top: crop.y,
            transform: `scale(${crop.scale})`,
            transformOrigin: 'top left',
            willChange: 'transform',
            pointerEvents: 'none',
          }}
          draggable={false}
          onLoad={(e) => {
            const img = e.currentTarget
            const editor = editorRef.current
            if (!editor) return
            const editorWidth = editor.clientWidth
            const editorHeight = editor.clientHeight
            const centerX = editorWidth / 2
            const centerY = editorHeight / 2
            const scaleX = CROP_SIZE / img.naturalWidth
            const scaleY = CROP_SIZE / img.naturalHeight
            const initialScale = Math.max(scaleX, scaleY) * 1.2
            const initialX = centerX - (img.naturalWidth * initialScale) / 2
            const initialY = centerY - (img.naturalHeight * initialScale) / 2
            setCrop({ x: initialX, y: initialY, scale: initialScale })
          }}
        />
        <div
          style={{
            position: 'absolute',
            inset: 0,
            pointerEvents: 'none',
            borderRadius: '50%',
            boxShadow: '0 0 0 9999px rgba(0,0,0,0.65)',
            width: CROP_SIZE,
            height: CROP_SIZE,
            margin: 'auto',
            border: '2px solid rgba(255,255,255,0.3)',
            boxSizing: 'border-box',
          }}
        />
        <div
          style={{
            position: 'absolute',
            inset: 0,
            pointerEvents: 'none',
            borderRadius: '50%',
            width: CROP_SIZE,
            height: CROP_SIZE,
            margin: 'auto',
            background: `
              linear-gradient(to right, rgba(255,255,255,0.1) 1px, transparent 1px),
              linear-gradient(to bottom, rgba(255,255,255,0.1) 1px, transparent 1px)
            `,
            backgroundSize: '60px 60px',
            opacity: 0.5,
          }}
        />
      </div>
      <div style={{ marginTop: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
          <span style={{ fontSize: 13, color: 'var(--tab-text-muted, var(--text-muted))', fontWeight: 500 }}>
            Масштаб
          </span>
          <span style={{ fontSize: 12, color: 'var(--tab-text-muted, var(--text-muted))', background: 'var(--surface-200)', padding: '4px 8px', borderRadius: 6 }}>
            {Math.round(crop.scale * 100)}%
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button
            type="button"
            style={{ fontSize: 18, color: 'var(--tab-text-muted)', cursor: 'pointer', userSelect: 'none', background: 'none', border: 'none', padding: 4 }}
            onClick={() => setCrop((c) => ({ ...c, scale: Math.max(0.1, c.scale - 0.1) }))}
          >
            −
          </button>
          <input
            type="range"
            min={0.1}
            max={10}
            step={0.05}
            value={crop.scale}
            onChange={(e) => setCrop((c) => ({ ...c, scale: parseFloat(e.target.value) }))}
            style={{
              flex: 1,
              height: 6,
              background: 'var(--surface-200)',
              borderRadius: 3,
              outline: 'none',
              cursor: 'pointer',
            }}
          />
          <button
            type="button"
            style={{ fontSize: 18, color: 'var(--tab-text-muted)', cursor: 'pointer', userSelect: 'none', background: 'none', border: 'none', padding: 4 }}
            onClick={() => setCrop((c) => ({ ...c, scale: Math.min(10, c.scale + 0.1) }))}
          >
            +
          </button>
        </div>
        <div style={{ marginTop: 12, fontSize: 11, color: 'var(--tab-text-muted, var(--text-muted))', textAlign: 'center' }}>
          {isMobile ? 'Два пальца — масштаб, один — перемещение' : 'Перетащите для перемещения, колесико мыши — масштаб'}
        </div>
      </div>
      <canvas ref={canvasRef} width={CROP_SIZE} height={CROP_SIZE} style={{ display: 'none' }} />
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12 }}>
        <button type="button" className="btn btn-secondary" onClick={onCancel}>
          Отмена
        </button>
        <button type="button" className="btn btn-primary" onClick={handleApply}>
          Применить
        </button>
      </div>
    </div>
  )
}
