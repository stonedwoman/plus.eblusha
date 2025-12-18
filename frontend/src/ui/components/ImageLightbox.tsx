import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronLeft, ChevronRight, X } from 'lucide-react'

type Props = {
  open: boolean
  items: string[]
  index: number
  onClose: () => void
  onIndexChange: (nextIndex: number) => void
}

type ImgDims = { w: number; h: number }

function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n))
}

export function ImageLightbox({ open, items, index, onClose, onIndexChange }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const imgRef = useRef<HTMLImageElement | null>(null)

  const [dimsByUrl, setDimsByUrl] = useState<Record<string, ImgDims>>({})
  const [viewport, setViewport] = useState<{ w: number; h: number }>({ w: 0, h: 0 })

  // zoom is relative to "fit"
  const [zoom, setZoom] = useState(1)
  const [tx, setTx] = useState(0)
  const [ty, setTy] = useState(0)

  const draggingRef = useRef<{
    active: boolean
    startX: number
    startY: number
    startTx: number
    startTy: number
    mode: 'pan' | 'swipe'
    startedInsideImg: boolean
  } | null>(null)
  const lastTouchDistanceRef = useRef<number | null>(null)
  const wheelNavAccumRef = useRef(0)
  const wheelNavLastTsRef = useRef(0)
  const lastTapRef = useRef<{ ts: number; x: number; y: number } | null>(null)

  const total = items.length
  const canNav = total > 1

  const url = items[index] || ''
  const dims = url ? dimsByUrl[url] : undefined

  const fit = useMemo(() => {
    if (!dims || !viewport.w || !viewport.h) return { scale: 1, maxX: 0, maxY: 0 }
    // leave space for chrome (topbar + thumbs) and some padding
    const TOP = 56
    const BOTTOM = total > 1 ? 82 : 24
    const PAD = 28
    const usableW = Math.max(0, viewport.w - PAD * 2)
    const usableH = Math.max(0, viewport.h - TOP - BOTTOM - PAD * 2)
    const fitScale = Math.min(usableW / dims.w, usableH / dims.h, 1)
    const actualScale = fitScale * zoom
    const scaledW = dims.w * actualScale
    const scaledH = dims.h * actualScale
    const maxX = Math.max(0, (scaledW - usableW) / 2)
    const maxY = Math.max(0, (scaledH - usableH) / 2)
    return { scale: actualScale, maxX, maxY }
  }, [dims, viewport.w, viewport.h, zoom, total])

  const goPrev = () => {
    if (!canNav) return
    onIndexChange((index - 1 + total) % total)
  }
  const goNext = () => {
    if (!canNav) return
    onIndexChange((index + 1) % total)
  }

  const resetView = () => {
    setZoom(1)
    setTx(0)
    setTy(0)
  }

  // lock scroll
  useEffect(() => {
    if (!open) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [open])

  // update viewport size
  useLayoutEffect(() => {
    if (!open) return
    const update = () => {
      const w = window.innerWidth
      const h = window.innerHeight
      setViewport({ w, h })
    }
    update()
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [open])

  // reset when changing image
  useEffect(() => {
    if (!open) return
    resetView()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, url])

  // keyboard
  useEffect(() => {
    if (!open) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      if (e.key === 'ArrowLeft') goPrev()
      if (e.key === 'ArrowRight') goNext()
      if (e.key === '+' || e.key === '=') setZoom((z) => clamp(z * 1.15, 1, 6))
      if (e.key === '-') setZoom((z) => clamp(z / 1.15, 1, 6))
      if (e.key === '0') resetView()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, index, total, url, onClose])

  // clamp translation whenever zoom/viewport changes
  useEffect(() => {
    if (!open) return
    setTx((x) => clamp(x, -fit.maxX, fit.maxX))
    setTy((y) => clamp(y, -fit.maxY, fit.maxY))
  }, [open, fit.maxX, fit.maxY])

  const onWheel: React.WheelEventHandler = (e) => {
    if (!open) return
    e.preventDefault()
    const rect = imgRef.current?.getBoundingClientRect() ?? null
    const insideImg =
      !!rect &&
      e.clientX >= rect.left &&
      e.clientX <= rect.right &&
      e.clientY >= rect.top &&
      e.clientY <= rect.bottom

    // Normalize delta to pixels for consistent feel across devices.
    const deltaPx =
      e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * viewport.h : e.deltaY

    // Wheel outside the image navigates images (Telegram-like).
    if (!insideImg) {
      if (!canNav) return
      const now = performance.now()
      const COOLDOWN_MS = 260
      const THRESHOLD_PX = 90

      // Accumulate small deltas (trackpads) and only trigger once per "tick".
      // Also apply a short cooldown so one scroll gesture doesn't flip multiple images.
      wheelNavAccumRef.current += deltaPx
      if (now - wheelNavLastTsRef.current < COOLDOWN_MS) return
      if (Math.abs(wheelNavAccumRef.current) < THRESHOLD_PX) return

      wheelNavLastTsRef.current = now
      const dir = wheelNavAccumRef.current > 0 ? 1 : -1
      wheelNavAccumRef.current = 0
      if (dir > 0) goNext()
      else goPrev()
      return
    }

    // Very smooth zoom step (much smaller than before).
    // exp(-delta * k): trackpads/wheels become consistent.
    const k = 0.00008 // ~4x faster than previous value
    const factor = Math.exp(-deltaPx * k)
    setZoom((z) => clamp(z * factor, 1, 6))
  }

  const onPointerDown: React.PointerEventHandler = (e) => {
    // only primary button
    if (e.button !== 0) return
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    const isPan = zoom > 1.01
    const rect = imgRef.current?.getBoundingClientRect() ?? null
    const startedInsideImg =
      !!rect &&
      e.clientX >= rect.left &&
      e.clientX <= rect.right &&
      e.clientY >= rect.top &&
      e.clientY <= rect.bottom
    draggingRef.current = {
      active: true,
      startX: e.clientX,
      startY: e.clientY,
      startTx: tx,
      startTy: ty,
      mode: isPan ? 'pan' : 'swipe',
      startedInsideImg,
    }
  }

  const onPointerMove: React.PointerEventHandler = (e) => {
    const d = draggingRef.current
    if (!d?.active) return
    const dx = e.clientX - d.startX
    const dy = e.clientY - d.startY
    if (d.mode === 'pan') {
      setTx(clamp(d.startTx + dx, -fit.maxX, fit.maxX))
      setTy(clamp(d.startTy + dy, -fit.maxY, fit.maxY))
      return
    }
    // swipe preview: do nothing until pointer up
  }

  const onPointerUp: React.PointerEventHandler = (e) => {
    const d = draggingRef.current
    draggingRef.current = null
    if (!d?.active) return
    const dx = e.clientX - d.startX
    const dy = e.clientY - d.startY

    // swipe navigation (when not zoomed)
    if (d.mode === 'swipe') {
      // vertical swipe closes
      if (Math.abs(dy) > 110 && Math.abs(dx) < 90) {
        onClose()
        return
      }
      if (Math.abs(dx) > 70 && Math.abs(dy) < 60) {
        if (dx < 0) goNext()
        else goPrev()
        return
      }
    }

    // Tap outside the image:
    // - if zoomed => first tap resets to fit
    // - if not zoomed => tap closes
    const TAP_PX = 8
    const isTap = Math.abs(dx) <= TAP_PX && Math.abs(dy) <= TAP_PX

    // Double tap on the image toggles zoom (mobile-friendly).
    // We use pointer events so it works for touch; desktop keeps onDoubleClick.
    if (isTap && d.startedInsideImg) {
      const now = performance.now()
      const prev = lastTapRef.current
      const DOUBLE_TAP_MS = 280
      const DOUBLE_TAP_PX = 18
      if (
        prev &&
        now - prev.ts <= DOUBLE_TAP_MS &&
        Math.abs(prev.x - e.clientX) <= DOUBLE_TAP_PX &&
        Math.abs(prev.y - e.clientY) <= DOUBLE_TAP_PX
      ) {
        // consume double-tap
        lastTapRef.current = null
        if (zoom <= 1.01) setZoom(2)
        else resetView()
        return
      }
      lastTapRef.current = { ts: now, x: e.clientX, y: e.clientY }
      return
    }

    if (isTap && !d.startedInsideImg) {
      if (zoom > 1.01) {
        resetView()
      } else {
        onClose()
      }
    }
  }

  // pinch to zoom (touch)
  const onTouchMove: React.TouchEventHandler = (e) => {
    if (e.touches.length !== 2) {
      lastTouchDistanceRef.current = null
      return
    }
    e.preventDefault()
    const t0 = e.touches[0]
    const t1 = e.touches[1]
    const dx = t0.clientX - t1.clientX
    const dy = t0.clientY - t1.clientY
    const dist = Math.sqrt(dx * dx + dy * dy)
    const prev = lastTouchDistanceRef.current
    lastTouchDistanceRef.current = dist
    if (!prev) return
    const factor = dist > prev ? 1.03 : 1 / 1.03
    setZoom((z) => clamp(z * factor, 1, 6))
  }

  const onDoubleClick: React.MouseEventHandler = () => {
    // Telegram-like: toggle fit <-> 2x
    if (zoom <= 1.01) setZoom(2)
    else resetView()
  }

  if (!open) return null

  const thumbs = (() => {
    // render a window around current to avoid loading too many images at once
    const max = 13
    if (total <= max) return items.map((u, i) => ({ u, i }))
    const half = Math.floor(max / 2)
    let start = index - half
    let end = index + half
    if (start < 0) {
      end += -start
      start = 0
    }
    if (end > total - 1) {
      const over = end - (total - 1)
      start = Math.max(0, start - over)
      end = total - 1
    }
    const out: Array<{ u: string; i: number }> = []
    for (let i = start; i <= end; i++) out.push({ u: items[i], i })
    return out
  })()

  const content = (
    <div className="imglb-root" ref={containerRef} onWheel={onWheel}>
      <div className="imglb-backdrop" onClick={onClose} />

      <div className="imglb-topbar">
        <div className="imglb-spacer" aria-hidden="true" />
        <div className="imglb-title">
          {index + 1} / {total}
        </div>
        <button className="imglb-btn" onClick={onClose} aria-label="Закрыть">
          <X size={18} />
        </button>
      </div>

      <div
        className="imglb-stage"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => {
          draggingRef.current = null
        }}
        onTouchMove={onTouchMove}
        onDoubleClick={onDoubleClick}
      >
        {canNav && (
          <button className="imglb-nav imglb-nav-left" onClick={goPrev} aria-label="Назад">
            <ChevronLeft size={24} />
          </button>
        )}

        <div className="imglb-media" onClick={(e) => e.stopPropagation()}>
          <div className="imglb-pan" style={{ transform: `translate3d(${tx}px, ${ty}px, 0)` }}>
            <img
              ref={imgRef}
              className="imglb-img"
              src={url}
              alt="preview"
              draggable={false}
              style={{
                width: dims?.w ? `${dims.w}px` : undefined,
                height: dims?.h ? `${dims.h}px` : undefined,
                transform: `scale(${fit.scale})`,
              }}
              onLoad={(e) => {
                const el = e.currentTarget
                const w = el.naturalWidth || 1
                const h = el.naturalHeight || 1
                setDimsByUrl((prev) => ({ ...prev, [url]: { w, h } }))
              }}
            />
          </div>
        </div>

        {canNav && (
          <button className="imglb-nav imglb-nav-right" onClick={goNext} aria-label="Вперёд">
            <ChevronRight size={24} />
          </button>
        )}
      </div>

      {total > 1 && (
        <div className="imglb-thumbs" onClick={(e) => e.stopPropagation()}>
          <div className="imglb-thumbs-inner">
            {thumbs.map(({ u, i }) => (
              <button
                key={`${u}-${i}`}
                type="button"
                className={i === index ? 'imglb-thumb is-active' : 'imglb-thumb'}
                onClick={() => onIndexChange(i)}
                aria-label={`Открыть ${i + 1}`}
              >
                <img src={u} alt="" draggable={false} />
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )

  return createPortal(content, document.body)
}


