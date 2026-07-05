import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronLeft, ChevronRight, X } from 'lucide-react'
import { gridThumbUrl } from '../../utils/media'

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
  const activeThumbRef = useRef<HTMLButtonElement | null>(null)

  const [dimsByUrl, setDimsByUrl] = useState<Record<string, ImgDims>>({})
  // Пер-URL статусы загрузки: показываем главную картинку (opacity) только когда она РЕАЛЬНО
  // загружена+декодирована → нет кадра со «старыми пикселями» и скачка размера (главный источник морганий).
  const [loadedUrls, setLoadedUrls] = useState<Set<string>>(() => new Set())
  const [failedUrls, setFailedUrls] = useState<Set<string>>(() => new Set())
  // Инициализируем реальным размером окна (не {0,0}) → blur-подложка есть уже на первом кадре.
  const [viewport, setViewport] = useState<{ w: number; h: number }>(() => ({
    w: typeof window !== 'undefined' ? window.innerWidth : 0,
    h: typeof window !== 'undefined' ? window.innerHeight : 0,
  }))

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
  const pinchEndTsRef = useRef(-Infinity) // когда сняли второй палец с пинча — короткий кулдаун против ложного свайпа (−∞ = «давно», чтобы не блочить первый жест)
  const prevFocusRef = useRef<HTMLElement | null>(null) // куда вернуть фокус при закрытии

  const total = items.length
  const canNav = total > 1

  const safeIndex = total > 0 ? Math.min(Math.max(index, 0), total - 1) : 0
  const url = items[safeIndex] || ''
  const dims = url ? dimsByUrl[url] : undefined
  const isLoaded = !!url && loadedUrls.has(url)
  const isFailed = !!url && failedUrls.has(url)
  // Мгновенная размытая подложка (серверная миниатюра ~720px, обычно уже в кеше из ленты чата) —
  // видна пока грузится полноразмер; полное фото проявляется поверх (кроссфейд). blob/секрет → как есть.
  const placeholderSrc = url ? (gridThumbUrl(url) || url) : ''

  const thumbsHpx = useMemo(() => {
    if (total <= 1) return 24
    const isMobile = viewport.w <= 768
    if (isMobile) return 72
    // Desktop: at least 20% of viewport height (but not too tiny)
    return Math.max(140, Math.round(viewport.h * 0.2))
  }, [total, viewport.w, viewport.h])

  const fit = useMemo(() => {
    if (!dims || !viewport.w || !viewport.h) return { scale: 1, maxX: 0, maxY: 0 }
    // leave space for chrome (topbar + thumbs) and some padding
    const TOP = 56
    const BOTTOM = thumbsHpx
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
  }, [dims, viewport.w, viewport.h, zoom, thumbsHpx])

  // Область под картинку (без хрома) — не зависит от dims. В неё вписываем и blur-подложку
  // (background-size:contain), так что она занимает ТОТ ЖЕ прямоугольник, что и полное фото → без скачка.
  const usable = useMemo(() => {
    const TOP = 56
    const BOTTOM = thumbsHpx
    const PAD = 28
    return {
      w: Math.max(0, viewport.w - PAD * 2),
      h: Math.max(0, viewport.h - TOP - BOTTOM - PAD * 2),
    }
  }, [viewport.w, viewport.h, thumbsHpx])

  const goPrev = () => {
    if (!canNav) return
    onIndexChange((index - 1 + total) % total)
  }
  const goNext = () => {
    if (!canNav) return
    onIndexChange((index + 1) % total)
  }

  const resetView = () => {
    draggingRef.current = null // сбрасываем незавершённый pan/swipe, иначе он считал бы от старой базы/картинки
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

  // Модальный фокус: запоминаем активный элемент, переносим фокус в диалог, возвращаем при закрытии.
  useEffect(() => {
    if (!open) return
    prevFocusRef.current = (document.activeElement as HTMLElement) ?? null
    containerRef.current?.focus()
    return () => {
      // Возвращаем фокус, только если прежний элемент ещё в DOM (иначе focus() молча потерял бы его).
      const prev = prevFocusRef.current
      if (prev && prev.isConnected) prev.focus?.()
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

  // reset when changing image + подхватываем УЖЕ закешированную картинку: её onLoad мог не
  // сработать (элемент был complete до навешивания обработчика) → иначе opacity зависла бы на 0.
  useEffect(() => {
    if (!open) return
    resetView()
    const el = imgRef.current
    if (el && el.complete && el.naturalWidth > 0) {
      const w = el.naturalWidth
      const h = el.naturalHeight
      setDimsByUrl((p) => (p[url] ? p : { ...p, [url]: { w, h } }))
      setLoadedUrls((p) => (p.has(url) ? p : new Set(p).add(url)))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, url])

  // Предзагрузка соседних кадров (±1) — перелистывание становится мгновенным, окно возможного мигания сужается.
  useEffect(() => {
    if (!open || total <= 1) return
    for (const i of [(index + 1) % total, (index - 1 + total) % total]) {
      const u = items[i]
      if (u) { const im = new Image(); im.src = u }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, index, total, items])

  // Чистим кеши размеров/статусов при закрытии — не растут за сессию.
  useEffect(() => {
    if (open) return
    setDimsByUrl((p) => (Object.keys(p).length ? {} : p))
    setLoadedUrls((p) => (p.size ? new Set() : p))
    setFailedUrls((p) => (p.size ? new Set() : p))
  }, [open])

  // Активную миниатюру держим в зоне видимости ленты (при >13 фото она уезжает за край).
  useEffect(() => {
    if (!open) return
    activeThumbRef.current?.scrollIntoView({ block: 'nearest', inline: 'center' })
  }, [open, index])

  // keyboard
  useEffect(() => {
    if (!open) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      if (e.key === 'ArrowLeft') { e.preventDefault(); goPrev() }
      if (e.key === 'ArrowRight') { e.preventDefault(); goNext() }
      if (e.key === '+' || e.key === '=') setZoom((z) => clamp(z * 1.15, 1, 6))
      if (e.key === '-') setZoom((z) => clamp(z / 1.15, 1, 6))
      if (e.key === '0') resetView()
      // Фокус-трап: Tab не выпускает фокус за пределы диалога.
      if (e.key === 'Tab') {
        const root = containerRef.current
        if (!root) return
        const f = Array.from(
          root.querySelectorAll<HTMLElement>('button, [href], [tabindex]:not([tabindex="-1"])'),
        ).filter((el) => el.offsetParent !== null || el === root)
        if (f.length === 0) { e.preventDefault(); root.focus(); return }
        const first = f[0]
        const last = f[f.length - 1]
        const active = document.activeElement as HTMLElement | null
        if (e.shiftKey && (active === first || active === root || !root.contains(active))) {
          e.preventDefault(); last.focus()
        } else if (!e.shiftKey && active === last) {
          e.preventDefault(); first.focus()
        }
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, index, total, url, onClose])

  // clamp translation whenever zoom/viewport changes (layout-effect → до кадра, без промежуточного «дёрга»)
  useLayoutEffect(() => {
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

    // Zoom inside image.
    // exp(-delta * k): consistent for wheels/trackpads.
    // Tuned for ~5–10% per typical wheel notch (delta ~100px).
    const k = 0.00075
    const factorRaw = Math.exp(-deltaPx * k)
    // Clamp per-event zoom to avoid huge jumps on trackpad momentum bursts.
    const factor = clamp(factorRaw, 0.85, 1.18)
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
    // Хвост пинча: только что сняли палец с двупальцевого зума — не считаем это свайпом/тапом
    // (иначе снятие пинча случайно листало бы/закрывало). Короткий кулдаун.
    if (performance.now() - pinchEndTsRef.current < 350) return
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
    if (!open) return
    if (e.touches.length !== 2) {
      // Переход 2→<2 пальца = конец пинча → ставим кулдаун (onPointerUp его учтёт).
      if (lastTouchDistanceRef.current !== null) pinchEndTsRef.current = performance.now()
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
    <div
      className="imglb-root"
      ref={containerRef}
      onWheel={onWheel}
      role="dialog"
      aria-modal="true"
      aria-label="Просмотр изображения"
      tabIndex={-1}
      style={{ ['--imglb-thumbs-h' as any]: `${thumbsHpx}px` }}
    >
      <div className="imglb-backdrop" onClick={onClose} />

      <div className="imglb-topbar">
        <div className="imglb-spacer" aria-hidden="true" />
        <div className="imglb-title">
          {safeIndex + 1} / {total}
          {zoom > 1.01 && <span className="imglb-zoom">{Math.round(zoom * 100)}%</span>}
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
      >
        {canNav && (
          <button className="imglb-nav imglb-nav-left" onClick={goPrev} aria-label="Назад">
            <ChevronLeft size={24} />
          </button>
        )}

        <div className="imglb-media" onClick={(e) => e.stopPropagation()}>
          {/* Blur-up подложка: тот же прямоугольник, что и полное фото (usable + contain) → без скачка.
              Держим смонтированной и гасим по opacity при загрузке → кроссфейд в резкое фото (без «дырки»). */}
          {!isFailed && placeholderSrc && usable.w > 0 && (
            <div
              className="imglb-blurup"
              aria-hidden="true"
              style={{
                width: `${usable.w}px`,
                height: `${usable.h}px`,
                backgroundImage: `url("${placeholderSrc}")`,
                opacity: isLoaded ? 0 : 1,
              }}
            />
          )}
          {!isLoaded && !isFailed && <div className="imglb-spinner" aria-hidden="true" />}
          {isFailed && <div className="imglb-error" role="alert">Не удалось загрузить изображение</div>}
          <div className="imglb-pan" style={{ transform: `translate3d(${tx}px, ${ty}px, 0)` }}>
            <img
              key={url}
              ref={imgRef}
              className="imglb-img"
              src={url}
              alt={`Изображение ${safeIndex + 1} из ${total}`}
              draggable={false}
              style={{
                width: dims?.w ? `${dims.w}px` : undefined,
                height: dims?.h ? `${dims.h}px` : undefined,
                transform: `scale(${fit.scale})`,
                // Показываем только когда реально загружена+декодирована → без кадра «старых
                // пикселей»/скачка размера. Битую картинку держим скрытой (оверлей-ошибка вместо неё).
                opacity: isLoaded && !isFailed ? 1 : 0,
              }}
              onLoad={(e) => {
                const el = e.currentTarget
                const u = url
                setDimsByUrl((prev) => ({ ...prev, [u]: { w: el.naturalWidth || 1, h: el.naturalHeight || 1 } }))
                const mark = () => setLoadedUrls((p) => (p.has(u) ? p : new Set(p).add(u)))
                // decode перед показом → не показываем полу-декодированный кадр (статтер на больших фото)
                if (el.decode) el.decode().then(mark).catch(mark)
                else mark()
              }}
              onError={() => {
                const u = url
                setFailedUrls((p) => (p.has(u) ? p : new Set(p).add(u)))
                setLoadedUrls((p) => (p.has(u) ? p : new Set(p).add(u)))
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
                ref={i === index ? activeThumbRef : undefined}
                type="button"
                className={i === index ? 'imglb-thumb is-active' : 'imglb-thumb'}
                onClick={() => onIndexChange(i)}
                aria-label={`Открыть ${i + 1}`}
              >
                {/* Лёгкая серверная миниатюра (~720px), а не полноразмер — иначе лента грузила бы
                    до 13 полных фото разом и всё «моргало». blob/секрет → gridThumbUrl вернёт как есть. */}
                <img
                  src={gridThumbUrl(u) || u}
                  alt=""
                  draggable={false}
                  loading="lazy"
                  onError={(e) => { (e.currentTarget as HTMLImageElement).style.visibility = 'hidden' }}
                />
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )

  return createPortal(content, document.body)
}


