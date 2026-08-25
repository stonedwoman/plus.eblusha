import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { cloudApi, formatBytes, formatDuration, toCloudError } from '../api'
import type { CloudComment, CloudFile } from '../types'
import { onCloudEvent } from '../realtime'
import { Avatar, toast } from './ui'

const EMOJI = ['👍', '❤️', '😂', '😮', '😢']

/** Место под полосу превью резервируется раз и навсегда — см. --cl-gutter. */
const GUTTER = 104
/** Ширина ячейки полосы превью вместе с зазором. */
const CELL = 72
/** Сколько миниатюр держим в полосе: окно вокруг текущей, а не весь альбом. */
const STRIP_WINDOW = 13
/** Простой мыши, после которого хром уходит и остаётся только снимок. */
const IDLE_MS = 2600
/** Порог протяжки вниз для закрытия. */
const DISMISS_PX = 130
/** Порог протяжки вбок для перехода к соседнему кадру. */
const SWIPE_PX = 70

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
const reducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches

/**
 * Просмотрщик файла — тёмный зал, где свет идёт от самого снимка.
 *
 * Кадр не «открывается», а вырастает из плитки, по которой кликнули, и
 * возвращается в неё при закрытии. Соседние кадры стоят рядом на рельсе,
 * поэтому переход — это сдвиг, а не мигание чёрным. Через пару секунд покоя
 * хром растворяется и остаётся только снимок.
 *
 * Устройство, важное для кадров в секунду:
 *  - зум и панорама живут в ref и пишутся ПРЯМО в style. Через React каждый
 *    щелчок колеса перерисовывал бы весь просмотрщик вместе с панелью
 *    комментариев;
 *  - рельса декларативна: три слота, каждый на своём translate3d, никаких
 *    автоматов по transitionend;
 *  - место под полосу превью выделено статически, лента лишь проявляется —
 *    иначе её появление двигало бы кадр;
 *  - соседние слоты держат РОВНО одну картинку. Три слоя качества на каждом
 *    из трёх слотов — это до сотни мегабайт декодированных битмапов;
 *  - никакого backdrop-filter: над едущей рельсой он заставлял бы браузер
 *    копировать и размывать подложку каждый кадр.
 *
 * Комментарий к таймкоду — не украшение: клик по «03:42» перематывает плеер
 * ровно туда, и обсуждать длинное видео становится возможно.
 */
export function Viewer({
  files,
  index,
  onClose,
  onIndexChange,
  onFileChanged,
  readOnly,
  spaceId,
  canComment,
  hasMore,
  onNeedMore,
  meId,
  isOwner,
}: {
  files: CloudFile[]
  index: number
  onClose: () => void
  onIndexChange: (index: number) => void
  onFileChanged?: (file: CloudFile) => void
  readOnly?: boolean
  spaceId?: string
  canComment?: boolean
  /** Есть ли ещё непрогруженные файлы дальше по списку. */
  hasMore?: boolean
  /** Догрузить следующую страницу — вызывается на последнем кадре. */
  onNeedMore?: () => void
  /** Кто смотрит: от этого зависят «Изменить» и «Удалить» у комментариев. */
  meId?: string
  /** Владелец хуяпки модерирует чужие комментарии — но не правит их. */
  isOwner?: boolean
}) {
  const file = files[index]
  /*
   * Панель закрыта по умолчанию: в зале герой — кадр, а не пустое обсуждение
   * на треть экрана. Открывается кнопкой или клавишей i; пока она открыта,
   * хром не прячется.
   */
  const [panel, setPanel] = useState<'info' | 'comments' | null>(null)
  const [closing, setClosing] = useState(false)
  const [idle, setIdle] = useState(false)
  /** Показываемый процент масштаба: обновляется редко, поэтому в состоянии. */
  const [zoomPct, setZoomPct] = useState(100)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const stageRef = useRef<HTMLDivElement | null>(null)
  const railRef = useRef<HTMLDivElement | null>(null)
  const mediaRef = useRef<HTMLDivElement | null>(null)
  const backdropRef = useRef<HTMLDivElement | null>(null)

  /*
   * Зум и смещение — в ref, не в состоянии: колесо шлёт до тридцати событий в
   * секунду, и каждое перерисовывало бы просмотрщик целиком вместе с панелью
   * обсуждения. В React уходит только округлённый процент, и то с порогом.
   */
  const view = useRef({ zoom: 1, x: 0, y: 0 })
  /** Размер вписанного снимка — считаем сами, чтобы не мерить DOM в жесте. */
  const fitRef = useRef({ w: 0, h: 0 })

  const applyView = useCallback(() => {
    const el = mediaRef.current
    if (!el) return
    const v = view.current
    el.style.transform = `translate3d(${v.x}px, ${v.y}px, 0) scale(${v.zoom})`
  }, [])

  /** Границы панорамы считаются из размера ВПИСАННОГО снимка, а не бокса. */
  const clampOffset = useCallback(() => {
    const v = view.current
    const stage = stageRef.current
    const fit = fitRef.current
    if (!stage || !fit.w) {
      if (v.zoom <= 1) {
        v.x = 0
        v.y = 0
      }
      return
    }
    const maxX = Math.max(0, (fit.w * v.zoom - stage.clientWidth) / 2)
    const maxY = Math.max(0, (fit.h * v.zoom - (stage.clientHeight - GUTTER)) / 2)
    v.x = clamp(v.x, -maxX, maxX)
    v.y = clamp(v.y, -maxY, maxY)
  }, [])

  /** Пересчитать размер вписанного снимка: нужен и для зажима, и для 100%. */
  const measureFit = useCallback(() => {
    const stage = stageRef.current
    if (!stage || !file) return
    const boxW = stage.clientWidth
    const boxH = stage.clientHeight - GUTTER
    const w = file.width || 0
    const h = file.height || 0
    if (!w || !h || boxW <= 0 || boxH <= 0) {
      fitRef.current = { w: boxW, h: boxH }
      return
    }
    const k = Math.min(boxW / w, boxH / h)
    fitRef.current = { w: w * k, h: h * k }
  }, [file])

  const setZoom = useCallback(
    (next: number, anchor?: { x: number; y: number }) => {
      const v = view.current
      const from = v.zoom
      const to = clamp(next, 1, 8)
      if (Math.abs(to - from) < 0.0005) return
      if (anchor) {
        /*
         * Точка под курсором остаётся на месте: без этого зум всегда шёл к
         * центру, и лицо в углу кадра уезжало ровно тогда, когда его и хотели
         * рассмотреть.
         */
        v.x = anchor.x - (anchor.x - v.x) * (to / from)
        v.y = anchor.y - (anchor.y - v.y) * (to / from)
      }
      v.zoom = to
      if (to <= 1.001) {
        v.x = 0
        v.y = 0
      }
      clampOffset()
      applyView()
      const fit = fitRef.current
      const natural = file?.width || 0
      const pct = natural && fit.w ? Math.round((fit.w * to * 100) / natural) : Math.round(to * 100)
      setZoomPct((prev) => (Math.abs(prev - pct) >= 1 ? pct : prev))
    },
    [applyView, clampOffset, file]
  )

  // ── Хром: уходит в простое, возвращается на любое движение ──────────────
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const wake = useCallback(() => {
    setIdle((v) => (v ? false : v))
    if (idleTimer.current) clearTimeout(idleTimer.current)
    // Пока открыто обсуждение, прятать хром нельзя: человек читает и печатает.
    if (panel === 'comments') return
    idleTimer.current = setTimeout(() => setIdle(true), IDLE_MS)
  }, [panel])

  useEffect(() => {
    wake()
    return () => {
      if (idleTimer.current) clearTimeout(idleTimer.current)
    }
  }, [wake, index])

  // ── Полёт из плитки и обратно ───────────────────────────────────────────
  const openedFrom = useRef<DOMRect | null>(null)
  useLayoutEffect(() => {
    if (reducedMotion()) return
    const tile = document.querySelector<HTMLElement>(`[data-file-id="${CSS.escape(files[index]?.id ?? '')}"]`)
    const media = mediaRef.current
    if (!tile || !media) return
    const from = tile.getBoundingClientRect()
    openedFrom.current = from
    const to = media.getBoundingClientRect()
    if (!to.width || !to.height) return
    /*
     * FLIP: кадр уже стоит на своём конечном месте, мы лишь на один кадр
     * возвращаем его в геометрию плитки и снимаем — браузер интерполирует
     * трансформом, без единого релэйаута.
     */
    const sx = from.width / to.width
    const sy = from.height / to.height
    const dx = from.left + from.width / 2 - (to.left + to.width / 2)
    const dy = from.top + from.height / 2 - (to.top + to.height / 2)
    media.style.transition = 'none'
    media.style.transform = `translate3d(${dx}px, ${dy}px, 0) scale(${Math.min(sx, sy)})`
    requestAnimationFrame(() => {
      media.style.transition = 'transform .34s var(--cl-ease)'
      applyView()
      setTimeout(() => {
        if (mediaRef.current) mediaRef.current.style.transition = ''
      }, 360)
    })
    // Только при первом открытии: смена кадра едет рельсой, а не полётом.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const requestClose = useCallback(() => {
    if (closeTimer.current) return
    setClosing(true)
    const media = mediaRef.current
    const tile = document.querySelector<HTMLElement>(`[data-file-id="${CSS.escape(files[index]?.id ?? '')}"]`)
    if (media && tile && !reducedMotion()) {
      const to = media.getBoundingClientRect()
      const from = tile.getBoundingClientRect()
      if (to.width && to.height && from.width) {
        const sx = from.width / to.width
        const sy = from.height / to.height
        const dx = from.left + from.width / 2 - (to.left + to.width / 2)
        const dy = from.top + from.height / 2 - (to.top + to.height / 2)
        media.style.transition = 'transform .28s var(--cl-ease-io)'
        media.style.transform = `translate3d(${dx}px, ${dy}px, 0) scale(${Math.min(sx, sy)})`
      }
    }
    closeTimer.current = setTimeout(onClose, 240)
  }, [files, index, onClose])
  useEffect(() => () => { if (closeTimer.current) clearTimeout(closeTimer.current) }, [])

  // ── Переходы между кадрами ──────────────────────────────────────────────
  const go = useCallback(
    (delta: number) => {
      const next = index + delta
      if (next >= 0 && next < files.length) {
        view.current = { zoom: 1, x: 0, y: 0 }
        setZoomPct(100)
        onIndexChange(next)
        // Подтягиваем следующую страницу заранее, за пару кадров до конца:
        // иначе на последнем снимке стрелка «вперёд» упиралась в пустоту.
        if (hasMore && next >= files.length - 3) onNeedMore?.()
        return
      }
      if (delta > 0 && hasMore) onNeedMore?.()
    },
    [index, files.length, onIndexChange, hasMore, onNeedMore]
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      const tag = target?.tagName
      const typing = tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable === true || e.isComposing

      // Escape закрывает всегда — даже из поля комментария.
      if (e.key === 'Escape') {
        requestClose()
        return
      }
      if (typing) return
      if (e.ctrlKey || e.metaKey || e.altKey) return
      wake()

      const mediaFocused = tag === 'VIDEO' || tag === 'AUDIO'
      const key = e.key.toLowerCase()

      if (key === 'arrowleft') {
        if (!mediaFocused) go(-1)
      } else if (key === 'arrowright') {
        if (!mediaFocused) go(1)
      } else if (e.key === ' ') {
        if (mediaFocused || !videoRef.current) return
        e.preventDefault()
        if (videoRef.current.paused) void videoRef.current.play()
        else videoRef.current.pause()
      } else if (e.key === '+' || e.key === '=') {
        setZoom(view.current.zoom * 1.25)
      } else if (e.key === '-') {
        setZoom(view.current.zoom / 1.25)
      } else if (e.key === '0') {
        setZoom(1)
      } else if (key === 'i' || e.code === 'KeyI') {
        setPanel((p) => (p === 'info' ? null : 'info'))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [go, requestClose, file, readOnly, wake, setZoom])

  // Соседей подгружаем заранее: без этого фейд успевал отыграть на пустом
  // месте, и снимок появлялся скачком уже после него.
  useEffect(() => {
    for (const neighbour of [files[index - 1], files[index + 1]]) {
      const src = neighbour?.urls.preview ?? neighbour?.urls.thumb
      if (src) new Image().src = src
    }
  }, [files, index])

  // Пересчёт вписанного размера при смене кадра и размера окна.
  useEffect(() => {
    measureFit()
    const stage = stageRef.current
    if (!stage) return
    const ro = new ResizeObserver(() => {
      measureFit()
      clampOffset()
      applyView()
    })
    ro.observe(stage)
    return () => ro.disconnect()
  }, [measureFit, clampOffset, applyView])

  useEffect(() => {
    view.current = { zoom: 1, x: 0, y: 0 }
    setZoomPct(100)
    measureFit()
    applyView()
  }, [index, measureFit, applyView])

  const react = useCallback(
    async (target: CloudFile, emoji: string) => {
      try {
        const { data } = await cloudApi.post<{ reactions: Record<string, number>; myReactions: string[] }>('/reactions', {
          targetType: 'FILE',
          targetId: target.id,
          emoji,
        })
        onFileChanged?.({ ...target, reactions: data.reactions, myReactions: data.myReactions })
      } catch (err) {
        toast.error(toCloudError(err).message)
      }
    },
    [onFileChanged]
  )

  const seekTo = useCallback((ms: number) => {
    if (!videoRef.current) return
    videoRef.current.currentTime = ms / 1000
    void videoRef.current.play()
  }, [])

  // ── Колесо: внутри кадра масштаб, снаружи листание ──────────────────────
  const navAccum = useRef(0)
  const navAt = useRef(0)
  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      wake()
      const deltaPx =
        e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * window.innerHeight : e.deltaY

      const media = mediaRef.current
      const r = media?.getBoundingClientRect()
      const inside =
        !!r && e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom

      /*
       * Уменьшение на уже вписанном кадре отдаём листанию: иначе жест на
       * снимке, который и так помещается целиком, ощущается мёртвым.
       */
      const zoomable = inside && !(view.current.zoom <= 1.001 && deltaPx > 0)
      if (zoomable) {
        const factor = clamp(Math.exp(-deltaPx * 0.00075), 0.85, 1.18)
        const box = stage.getBoundingClientRect()
        setZoom(view.current.zoom * factor, {
          x: e.clientX - box.left - box.width / 2,
          y: e.clientY - box.top - (box.height - GUTTER) / 2,
        })
        return
      }

      // Накопитель с порогом и кулдауном: один жест трекпада не должен
      // пролистывать пять кадров.
      const now = performance.now()
      if (Math.sign(deltaPx) !== Math.sign(navAccum.current)) navAccum.current = 0
      navAccum.current += deltaPx
      // Пока порог не набран — рельса чуть подаётся, как резинка.
      railRef.current?.style.setProperty('--nudge', `${clamp(-navAccum.current * 0.16, -22, 22)}px`)
      if (now - navAt.current < 260) return
      if (Math.abs(navAccum.current) < 90) return
      navAt.current = now
      const dir = navAccum.current > 0 ? 1 : -1
      navAccum.current = 0
      railRef.current?.style.setProperty('--nudge', '0px')
      go(dir)
    }
    stage.addEventListener('wheel', onWheel, { passive: false })
    return () => stage.removeEventListener('wheel', onWheel)
  }, [go, setZoom, wake])

  // ── Указатель: панорама при зуме, протяжка вниз/вбок при обычном ────────
  const drag = useRef<{
    x: number
    y: number
    ox: number
    oy: number
    moved: boolean
    mode: 'pan' | 'dismiss' | null
  } | null>(null)
  const [dragging, setDragging] = useState(false)

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return
    const target = e.target as HTMLElement | null
    /*
     * Видео и аудио не трогаем совсем. Их органы управления живут в теневом
     * дереве, поэтому по closest() не отличаются от самого элемента — сцена
     * забирала указатель себе, и нажать «играть» было невозможно.
     */
    if (target?.tagName === 'VIDEO' || target?.tagName === 'AUDIO') return
    if (target?.closest('button, a, input, textarea, video, audio, .cl-viewer-panel, .cl-strip')) return
    drag.current = {
      x: e.clientX,
      y: e.clientY,
      ox: view.current.x,
      oy: view.current.y,
      moved: false,
      mode: view.current.zoom > 1.001 ? 'pan' : 'dismiss',
    }
    setDragging(true)
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    wake()
    const d = drag.current
    if (!d) return
    const dx = e.clientX - d.x
    const dy = e.clientY - d.y
    if (Math.abs(dx) + Math.abs(dy) > 4) d.moved = true
    if (d.mode === 'pan') {
      view.current.x = d.ox + dx
      view.current.y = d.oy + dy
      clampOffset()
      applyView()
      return
    }
    // Обычный масштаб: вниз — закрытие, вбок — переход.
    const rail = railRef.current
    if (Math.abs(dy) > Math.abs(dx)) {
      const k = clamp(dy / 1200, -0.25, 0.25)
      if (rail) rail.style.transform = `translate3d(0, ${dy}px, 0) scale(${1 - Math.abs(k)})`
      if (backdropRef.current) backdropRef.current.style.opacity = String(clamp(1 - Math.abs(dy) / 420, 0.2, 1))
    } else if (rail) {
      rail.style.transform = `translate3d(${dx}px, 0, 0)`
    }
  }

  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    setDragging(false)
    if (!d) return
    drag.current = null
    e.currentTarget.releasePointerCapture(e.pointerId)
    const dx = e.clientX - d.x
    const dy = e.clientY - d.y
    const rail = railRef.current
    if (d.mode === 'dismiss' && d.moved) {
      if (Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > DISMISS_PX) {
        requestClose()
        return
      }
      if (Math.abs(dx) > SWIPE_PX) go(dx < 0 ? 1 : -1)
      if (rail) {
        rail.style.transition = 'transform .22s var(--cl-ease)'
        rail.style.transform = ''
        setTimeout(() => {
          if (railRef.current) railRef.current.style.transition = ''
        }, 240)
      }
      if (backdropRef.current) backdropRef.current.style.opacity = ''
      return
    }
    if (rail) rail.style.transform = ''
    if (backdropRef.current) backdropRef.current.style.opacity = ''
  }

  const onStageClick = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement | null
    if (target?.tagName === 'VIDEO' || target?.tagName === 'AUDIO') return
    if (target?.closest('button, a, video, audio, .cl-viewer-panel, .cl-strip')) return
    if (drag.current?.moved) return
    if (!file || file.kind !== 'IMAGE') return
    const stage = stageRef.current
    if (!stage) return
    const box = stage.getBoundingClientRect()
    const anchor = {
      x: e.clientX - box.left - box.width / 2,
      y: e.clientY - box.top - (box.height - GUTTER) / 2,
    }
    if (view.current.zoom > 1.001) {
      setZoom(1)
      return
    }
    // Двойной уровень — честные сто процентов оригинала, а не число из воздуха.
    const fit = fitRef.current
    const natural = file.width || 0
    const target100 = natural && fit.w ? clamp(natural / fit.w, 1.4, 8) : 2.6
    setZoom(target100, anchor)
  }

  if (!file) return null

  const stripFrom = Math.max(0, Math.min(index - Math.floor(STRIP_WINDOW / 2), files.length - STRIP_WINDOW))
  const strip = files.slice(Math.max(0, stripFrom), Math.max(0, stripFrom) + STRIP_WINDOW)
  const slots = [-1, 0, 1]
    .map((d) => ({ d, f: files[index + d] }))
    .filter((s): s is { d: number; f: CloudFile } => Boolean(s.f))

  return (
    <div
      className={`cl-viewer${panel ? ' with-panel' : ''}${closing ? ' is-closing' : ''}${idle ? ' is-idle' : ''}`}
      onPointerMove={wake}
    >
      <div className="cl-vbackdrop" ref={backdropRef} aria-hidden />
      {/* Зарево от самого снимка: тёмный зал, свет идёт от кадра. Берём
          миниатюру — она уже в кэше, ею только что нарисована плитка. */}
      {file.urls.thumb ? (
        <div className="cl-vglow" style={{ backgroundImage: `url(${file.urls.thumb})` }} aria-hidden />
      ) : null}

      <div
        className="cl-viewer-stage"
        ref={stageRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onClick={onStageClick}
      >
        <div className="cl-viewer-top">
          <button className="cl-vbtn" onClick={requestClose} aria-label="Закрыть" title="Закрыть (Esc)">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
          <div className="cl-viewer-title" title={file.name}>{file.name}</div>
          <span className="cl-viewer-count">
            {index + 1} <em>/</em> {files.length}
          </span>
          {zoomPct !== 100 ? <span className="cl-zoom-pill">{zoomPct}%</span> : null}
          <div className="cl-spacer" />
          {file.urls.download ? (
            <a className="cl-vbtn" href={file.urls.download} download aria-label="Скачать" title="Скачать">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 4v10m0 0 4-4m-4 4-4-4M5 19h14" />
              </svg>
            </a>
          ) : null}
          <button
            className={`cl-vbtn${panel === 'info' ? ' is-on' : ''}`}
            onClick={() => setPanel(panel === 'info' ? null : 'info')}
            aria-label="Сведения"
            title="Сведения (i)"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <circle cx="12" cy="12" r="9" />
              <path d="M12 11v5.5" />
              <circle cx="12" cy="7.7" r="1.1" fill="currentColor" stroke="none" />
            </svg>
          </button>
          {!readOnly ? (
            <button
              className={`cl-vbtn${panel === 'comments' ? ' is-on' : ''}`}
              onClick={() => setPanel(panel === 'comments' ? null : 'comments')}
              aria-label="Обсуждение"
              title="Обсуждение"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round">
                <path d="M20 12.4c0 3.9-3.6 7-8 7a9 9 0 0 1-2.4-.3L5 21l1.1-3.4A6.7 6.7 0 0 1 4 12.4c0-3.9 3.6-7 8-7s8 3.1 8 7Z" />
              </svg>
              {file.commentCount ? <i className="cl-vbtn-dot">{file.commentCount}</i> : null}
            </button>
          ) : null}
        </div>

        {index > 0 ? (
          <button className="cl-viewer-nav prev" onClick={() => go(-1)} aria-label="Предыдущий">
            ‹
          </button>
        ) : null}
        {index < files.length - 1 || hasMore ? (
          <button className="cl-viewer-nav next" onClick={() => go(1)} aria-label="Следующий">
            ›
          </button>
        ) : null}

        {/* Рельса из трёх слотов: старый кадр не исчезает, а уезжает. */}
        <div className={`cl-rail${dragging ? ' is-live' : ''}`} ref={railRef}>
          {slots.map(({ d, f }) => (
            <div className="cl-shot" key={f.id} style={{ transform: `translate3d(${d * 100}%, 0, 0)` }}>
              {d === 0 ? (
                <div className="cl-shot-media" ref={mediaRef}>
                  <CurrentMedia file={f} videoRef={videoRef} zoomPct={zoomPct} />
                </div>
              ) : (
                /* Соседям — РОВНО одна картинка. Три слоя качества на каждом
                   слоте это до сотни мегабайт декодированных битмапов. */
                <div className="cl-shot-media">
                  {f.urls.preview || f.urls.thumb ? (
                    <img className="cl-layer" src={f.urls.preview ?? f.urls.thumb ?? ''} alt="" draggable={false} />
                  ) : null}
                </div>
              )}
            </div>
          ))}
        </div>

        {/* Полоса превью. Место под неё зарезервировано --cl-gutter, поэтому
            её появление и скрытие не двигают кадр ни на пиксель. */}
        {files.length > 1 ? (
          <div className="cl-strip" aria-label="Кадры">
            <div
              className="cl-strip-rail"
              style={{ transform: `translate3d(${-(index - stripFrom) * CELL}px, 0, 0)` }}
            >
              {strip.map((f, i) => (
                <button
                  key={f.id}
                  className={`cl-strip-cell${stripFrom + i === index ? ' is-active' : ''}`}
                  style={{ left: i * CELL }}
                  onClick={() => go(stripFrom + i - index)}
                  title={f.name}
                >
                  {f.urls.thumb ? <img src={f.urls.thumb} alt="" loading="lazy" draggable={false} /> : null}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {/* Плёночная риска: видна даже когда весь хром ушёл. */}
        <div className="cl-vprogress" style={{ transform: `scaleX(${(index + 1) / Math.max(1, files.length)})` }} aria-hidden />
      </div>

      {panel ? (
        <aside className="cl-viewer-panel">
          <div className="cl-panel-tabs">
            {/* Сегментированный переключатель: бегунок ездит под активной
                вкладкой, поэтому переход читается как движение, а не как
                перекраска текста. */}
            <div className={`cl-panel-seg${readOnly ? ' solo' : ''}`}>
              {!readOnly ? (
                <span className="cl-panel-thumb" style={panel === 'comments' ? { transform: 'translateX(100%)' } : undefined} />
              ) : null}
              <button className={panel === 'info' ? 'is-active' : ''} onClick={() => setPanel('info')}>
                Сведения
              </button>
              {!readOnly ? (
                <button className={panel === 'comments' ? 'is-active' : ''} onClick={() => setPanel('comments')}>
                  Обсуждение{file.commentCount ? <b>{file.commentCount}</b> : null}
                </button>
              ) : null}
            </div>
          </div>
          <div className="cl-panel-body">
            {panel === 'info' ? (
              <MetadataPanel file={file} onReact={!readOnly ? (emoji) => void react(file, emoji) : undefined} />
            ) : (
              <CommentsPanel
                key={file.id}
                file={file}
                spaceId={spaceId ?? file.spaceId}
                onSeek={file.kind === 'VIDEO' ? seekTo : undefined}
                currentTimeMs={() => Math.round((videoRef.current?.currentTime ?? 0) * 1000)}
                canComment={canComment !== false}
                {...(meId ? { meId } : {})}
                isOwner={isOwner === true}
                onCountChange={(count) => onFileChanged?.({ ...file, commentCount: count })}
              />
            )}
          </div>
        </aside>
      ) : null}
    </div>
  )
}

/**
 * Текущий кадр: послойное качество.
 *
 * Миниатюра лежит в кэше — ею только что нарисована плитка, поэтому кадр виден
 * СРАЗУ, а не после белой паузы. Поверх проявляется превью, и только при
 * заметном увеличении подтягивается оригинал: тянуть его всегда значит гонять
 * десятки мегабайт ради экрана, где разницы не видно.
 */
function CurrentMedia({
  file,
  videoRef,
  zoomPct,
}: {
  file: CloudFile
  videoRef: React.MutableRefObject<HTMLVideoElement | null>
  zoomPct: number
}) {
  const [previewOn, setPreviewOn] = useState(false)
  const [fullOn, setFullOn] = useState(false)

  useEffect(() => {
    setPreviewOn(false)
    setFullOn(false)
  }, [file.id])

  if (file.kind === 'IMAGE') {
    const preview = file.urls.preview ?? file.urls.content
    const wantFull = zoomPct > 160 && Boolean(file.urls.content)
    return (
      <div className="cl-shot-layers">
        {file.urls.thumb ? <img className="cl-layer is-lq" src={file.urls.thumb} alt="" draggable={false} /> : null}
        {preview ? (
          <img
            className={`cl-layer${previewOn ? ' is-on' : ''}`}
            src={preview}
            alt={file.name}
            onLoad={() => setPreviewOn(true)}
            draggable={false}
          />
        ) : null}
        {wantFull ? (
          <img
            className={`cl-layer${fullOn ? ' is-on' : ''}`}
            src={file.urls.content ?? ''}
            alt=""
            onLoad={() => setFullOn(true)}
            draggable={false}
          />
        ) : null}
      </div>
    )
  }

  if (file.kind === 'VIDEO') {
    if (!file.urls.playback) return <VideoUnavailable file={file} />
    return <Player key={file.id} file={file} videoRef={videoRef} />
  }

  if (file.kind === 'AUDIO' && file.urls.content) {
    return (
      <div className="cl-shot-generic">
        <div style={{ fontSize: 56, marginBottom: 14 }}>🎵</div>
        <div style={{ marginBottom: 14 }}>{file.name}</div>
        <audio src={file.urls.content} controls style={{ width: 'min(520px, 80vw)' }} />
      </div>
    )
  }

  return (
    <div className="cl-shot-generic">
      <div style={{ fontSize: 46 }}>📄</div>
      <h3>{file.name}</h3>
      <p>
        {formatBytes(file.size)} · {file.mime}
      </p>
      {file.urls.download ? (
        <div style={{ marginTop: 16 }}>
          <a className="cl-btn primary" href={file.urls.download} download>
            Скачать оригинал
          </a>
        </div>
      ) : null}
    </div>
  )
}

const fmt = (sec: number): string => {
  if (!Number.isFinite(sec) || sec < 0) return '0:00'
  const s = Math.floor(sec % 60)
  const m = Math.floor(sec / 60) % 60
  const h = Math.floor(sec / 3600)
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`
}

/**
 * Свой проигрыватель.
 *
 * Штатные органы управления браузера выглядят чужеродно и вдобавок живут в
 * теневом дереве: их нельзя ни оформить, ни надёжно отличить от самого
 * элемента в обработчиках сцены — из-за этого сцена забирала указатель себе, и
 * нажать «играть» было невозможно. Здесь всё своё: те же токены темы, что и у
 * остального интерфейса, и обычные кнопки, мимо которых сцена проходит.
 *
 * Запуск автоматический. Со звуком браузер разрешает не всегда, поэтому при
 * отказе повторяем беззвучно и честно показываем, что звук выключен, — вместо
 * молчаливого кадра, который выглядит как поломка.
 */
function Player({ file, videoRef }: { file: CloudFile; videoRef: React.MutableRefObject<HTMLVideoElement | null> }) {
  const ref = useRef<HTMLVideoElement | null>(null)
  const barRef = useRef<HTMLDivElement | null>(null)
  const hostRef = useRef<HTMLDivElement | null>(null)
  const [box, setBox] = useState<{ w: number; h: number } | null>(null)
  const [playing, setPlaying] = useState(false)
  const [muted, setMuted] = useState(false)
  const [time, setTime] = useState(0)
  const [dur, setDur] = useState(0)
  const [buffered, setBuffered] = useState(0)
  const [scrubbing, setScrubbing] = useState(false)

  /*
   * Коробка кадра — ровно вписанный ролик, посчитанный по месту.
   *
   * Одним aspect-ratio не обойтись: max-width и max-height вместе с ним не
   * ужимают элемент по обеим осям сразу, и вертикальный ролик 2160×3840
   * разъезжался на 2844 пикселя высоты. А знать точный кадр нужно: по нему
   * выставлена полоса управления — иначе она висит через всю сцену, отдельно
   * от изображения.
   *
   * Меряем САМУ сцену, растянутую по inset: 0. Замер контейнера, чей размер
   * зависит от содержимого, сходился к нулю — кадр ужимал контейнер, тот
   * ужимал следующий замер, и от ролика оставалось 43×77.
   */
  const w = file.width
  const h = file.height
  useEffect(() => {
    const host = hostRef.current
    if (!host || !w || !h) return
    const fit = () => {
      /*
       * clientWidth/Height, а НЕ getBoundingClientRect: прямоугольник считается
       * вместе с трансформами, а сцена въезжает от плитки — замер попадал в
       * середину анимации открытия и давал кадр 43×77. Наблюдатель размеров
       * при этом молчит: коробка вёрстки не менялась, менялся только сдвиг.
       */
      const rw = host.clientWidth
      const rh = host.clientHeight
      if (rw < 1 || rh < 1) return
      const scale = Math.min(rw / w, rh / h)
      const next = { w: Math.round(w * scale), h: Math.round(h * scale) }
      setBox((prev) => (prev && prev.w === next.w && prev.h === next.h ? prev : next))
    }
    const ro = new ResizeObserver(fit)
    ro.observe(host)
    fit()
    return () => ro.disconnect()
  }, [w, h])

  const attach = useCallback(
    (el: HTMLVideoElement | null) => {
      ref.current = el
      videoRef.current = el
    },
    [videoRef]
  )

  useEffect(() => {
    const el = ref.current
    if (!el) return
    let cancelled = false
    void (async () => {
      try {
        await el.play()
      } catch {
        if (cancelled) return
        el.muted = true
        setMuted(true)
        try {
          await el.play()
        } catch {
          // Совсем не пустили — остаётся крупная кнопка по центру кадра.
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [file.id])

  const seekAt = (clientX: number) => {
    const el = ref.current
    const bar = barRef.current
    if (!el || !bar || !dur) return
    const r = bar.getBoundingClientRect()
    const at = clamp((clientX - r.left) / Math.max(1, r.width), 0, 1) * dur
    el.currentTime = at
    setTime(at)
  }

  const pct = dur > 0 ? (time / dur) * 100 : 0
  const bufPct = dur > 0 ? (buffered / dur) * 100 : 0
  const toggle = () => {
    const el = ref.current
    if (!el) return
    if (el.paused) void el.play()
    else el.pause()
  }

  return (
    <div ref={hostRef} className={`cl-player${playing ? '' : ' is-paused'}`}>
      <div className="cl-player-frame" style={box ? { width: box.w, height: box.h } : undefined}>
      <video
        ref={attach}
        src={file.urls.playback ?? undefined}
        poster={file.urls.poster ?? undefined}
        playsInline
        preload="auto"
        onClick={toggle}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onTimeUpdate={(e) => {
          if (!scrubbing) setTime(e.currentTarget.currentTime)
        }}
        onDurationChange={(e) => setDur(e.currentTarget.duration || 0)}
        onLoadedMetadata={(e) => setDur(e.currentTarget.duration || 0)}
        onProgress={(e) => {
          const b = e.currentTarget.buffered
          if (b.length) setBuffered(b.end(b.length - 1))
        }}
        onVolumeChange={(e) => setMuted(e.currentTarget.muted)}
      />

      {/* Пока не играет, главное действие — крупная кнопка по центру. */}
      {!playing ? (
        <button className="cl-player-big" onClick={toggle} aria-label="Воспроизвести">
          <svg viewBox="0 0 24 24" fill="currentColor">
            <path d="M8 5.6v12.8c0 .9 1 1.4 1.7.9l9.3-6.4a1.1 1.1 0 0 0 0-1.8L9.7 4.7A1.1 1.1 0 0 0 8 5.6Z" />
          </svg>
        </button>
      ) : null}

      <div className="cl-player-bar" onPointerDown={(e) => e.stopPropagation()}>
        <button className="cl-player-btn" onClick={toggle} aria-label={playing ? 'Пауза' : 'Воспроизвести'}>
          {playing ? (
            <svg viewBox="0 0 24 24" fill="currentColor">
              <rect x="6.5" y="5" width="4" height="14" rx="1.3" />
              <rect x="13.5" y="5" width="4" height="14" rx="1.3" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" fill="currentColor">
              <path d="M8 5.6v12.8c0 .9 1 1.4 1.7.9l9.3-6.4a1.1 1.1 0 0 0 0-1.8L9.7 4.7A1.1 1.1 0 0 0 8 5.6Z" />
            </svg>
          )}
        </button>

        <span className="cl-player-time">{fmt(time)}</span>

        <div
          className={`cl-player-track${scrubbing ? ' is-live' : ''}`}
          ref={barRef}
          role="slider"
          aria-label="Перемотка"
          aria-valuenow={Math.round(pct)}
          onPointerDown={(e) => {
            setScrubbing(true)
            e.currentTarget.setPointerCapture(e.pointerId)
            seekAt(e.clientX)
          }}
          onPointerMove={(e) => {
            if (scrubbing) seekAt(e.clientX)
          }}
          onPointerUp={(e) => {
            setScrubbing(false)
            e.currentTarget.releasePointerCapture(e.pointerId)
          }}
        >
          <i className="cl-player-buf" style={{ transform: `scaleX(${bufPct / 100})` }} />
          <i className="cl-player-fill" style={{ transform: `scaleX(${pct / 100})` }} />
          <i className="cl-player-knob" style={{ left: `${pct}%` }} />
        </div>

        <span className="cl-player-time">{fmt(dur)}</span>

        <button
          className={`cl-player-btn${muted ? ' is-off' : ''}`}
          onClick={() => {
            const el = ref.current
            if (!el) return
            el.muted = !el.muted
            setMuted(el.muted)
          }}
          aria-label={muted ? 'Включить звук' : 'Выключить звук'}
        >
          {muted ? (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M11 5 6.5 9H3v6h3.5L11 19V5Z" />
              <path d="m16 10 4 4m0-4-4 4" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M11 5 6.5 9H3v6h3.5L11 19V5Z" />
              <path d="M15.5 9.2a4 4 0 0 1 0 5.6M18.2 6.6a7.7 7.7 0 0 1 0 10.8" />
            </svg>
          )}
        </button>

        <button
          className="cl-player-btn"
          onClick={() => {
            const el = ref.current?.parentElement
            if (!el) return
            if (document.fullscreenElement) void document.exitFullscreen()
            else void el.requestFullscreen?.()
          }}
          aria-label="На весь экран"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 9V5.5A1.5 1.5 0 0 1 5.5 4H9M15 4h3.5A1.5 1.5 0 0 1 20 5.5V9M20 15v3.5a1.5 1.5 0 0 1-1.5 1.5H15M9 20H5.5A1.5 1.5 0 0 1 4 18.5V15" />
          </svg>
        </button>
      </div>

      {muted && playing ? (
        <button
          className="cl-player-unmute"
          onClick={() => {
            const el = ref.current
            if (!el) return
            el.muted = false
            setMuted(false)
          }}
        >
          Звук выключен — включить
        </button>
      ) : null}
      </div>
    </div>
  )
}

function VideoUnavailable({ file }: { file: CloudFile }) {
  const [retrying, setRetrying] = useState(false)
  const [sent, setSent] = useState(false)
  const failed = file.status === 'FAILED' || Boolean(file.processingError)

  const retry = async () => {
    setRetrying(true)
    try {
      await cloudApi.post(`/files/${file.id}/reprocess`)
      setSent(true)
      toast.success('Отправили на повторную обработку')
    } catch (err) {
      toast.error(toCloudError(err).message)
    } finally {
      setRetrying(false)
    }
  }

  return (
    <div className="cl-empty">
      <div style={{ fontSize: 46 }}>{failed ? '⚠' : '⏳'}</div>
      <h3>{failed ? 'Не удалось подготовить видео' : 'Видео готовится'}</h3>
      <p>
        {failed
          ? 'Сервер не смог собрать web-версию этого файла. Оригинал цел и доступен для скачивания.'
          : 'Формат не воспроизводится браузером напрямую, поэтому сервер делает web-версию. Оригинал уже сохранён и доступен для скачивания.'}
      </p>
      {failed && file.processingError ? (
        <p className="cl-muted cl-mono" style={{ fontSize: 12.5 }}>
          {file.processingError}
        </p>
      ) : null}
      <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginTop: 16, flexWrap: 'wrap' }}>
        {failed ? (
          <button className="cl-btn primary" onClick={() => void retry()} disabled={retrying || sent}>
            {sent ? 'В очереди' : retrying ? 'Отправляем…' : 'Попробовать ещё раз'}
          </button>
        ) : null}
        {file.urls.download ? (
          <a className="cl-btn" href={file.urls.download} download>
            Скачать оригинал
          </a>
        ) : null}
      </div>
    </div>
  )
}

/**
 * Сведения о кадре.
 *
 * Не таблица «поле — значение» на четырнадцать строк: в ней всё весит
 * одинаково, и глаз не находит главного. Сверху — то, ради чего панель вообще
 * открывают: ГДЕ и КОГДА снято. Ниже — параметры съёмки крупными плитками, как
 * их показывает сама камера. Технические подробности убраны в разделы, чтобы не
 * забивать собой смысл.
 */
function MetadataPanel({ file, onReact }: { file: CloudFile; onReact?: (emoji: string) => void }) {
  const [copied, setCopied] = useState<string | null>(null)
  const copy = (key: string, value: string) => {
    void navigator.clipboard?.writeText(value)
    setCopied(key)
    window.setTimeout(() => setCopied((c) => (c === key ? null : c)), 1200)
  }

  const place = [file.geoCountry, file.geoCity, file.geoDistrict].filter(Boolean) as string[]
  const taken = new Date(file.takenAt)
  const source =
    file.takenAtSource === 'exif' ? 'EXIF' : file.takenAtSource === 'client' ? 'файл' : 'загрузка'

  const extra = (file.metadata ?? {}) as Record<string, unknown>
  const lens = typeof extra.lensModel === 'string' ? extra.lensModel : null
  const camera = [file.cameraMake, file.cameraModel].filter(Boolean).join(' ')
  const shutter =
    typeof extra.exposureTime === 'number'
      ? extra.exposureTime >= 1
        ? `${extra.exposureTime}″`
        : `1/${Math.round(1 / extra.exposureTime)}`
      : null
  // Плитки съёмки: три главных параметра кадра. Показываем, только если
  // камера их записала — пустые ячейки хуже отсутствующего блока.
  const shots = [
    typeof extra.fNumber === 'number' ? { v: `f/${extra.fNumber}`, t: 'диафрагма' } : null,
    shutter ? { v: shutter, t: 'выдержка' } : null,
    typeof extra.iso === 'number' ? { v: String(extra.iso), t: 'ISO' } : null,
  ].filter(Boolean) as { v: string; t: string }[]

  const fileRows: [string, string | null, string?][] = [
    ['Имя', file.name, 'name'],
    ['Размер', formatBytes(file.size), 'size'],
    ['Тип', file.mime],
    ['Разрешение', file.width && file.height ? `${file.width} × ${file.height}` : null],
    ['Длительность', file.durationMs ? formatDuration(file.durationMs) : null],
  ]
  const techRows: [string, string | null, string?][] = [
    ['Загрузил', file.uploader?.displayName || file.uploader?.username || null],
    ['Загружено', new Date(file.createdAt).toLocaleString('ru-RU')],
    ['Кодек', [file.videoCodec, file.audioCodec].filter(Boolean).join(' / ') || null],
    ['Битрейт', file.bitrate ? `${Math.round(file.bitrate / 1000)} кбит/с` : null],
    ['Воспроизведение', file.playbackSource ? (file.playbackSource === 'original' ? 'оригинал' : 'web-версия') : null],
    [
      'Координаты',
      file.latitude != null && file.longitude != null
        ? `${file.latitude.toFixed(5)}, ${file.longitude.toFixed(5)}`
        : null,
      'gps',
    ],
  ]

  const section = (title: string, rows: [string, string | null, string?][]) => {
    const shown = rows.filter(([, value]) => value)
    if (shown.length === 0) return null
    return (
      <section className="cl-mi-sect">
        <h4>{title}</h4>
        <dl>
          {shown.map(([label, value, key]) => (
            <div
              className={`cl-mi-row${key ? ' can-copy' : ''}${copied === key ? ' is-copied' : ''}`}
              key={label}
              {...(key ? { onClick: () => copy(key, value as string), title: 'Скопировать' } : {})}
            >
              <dt>{label}</dt>
              <dd>{copied === key ? 'скопировано' : value}</dd>
            </div>
          ))}
        </dl>
      </section>
    )
  }

  return (
    <div className="cl-mi">
      {onReact ? (
        <div className="cl-reactions">
          {EMOJI.map((emoji) => (
            <button
              key={emoji}
              className={`cl-reaction${file.myReactions.includes(emoji) ? ' mine' : ''}`}
              onClick={() => onReact(emoji)}
            >
              {emoji} {file.reactions[emoji] ?? ''}
            </button>
          ))}
        </div>
      ) : null}

      {file.status === 'FAILED' ? (
        <div className="cl-toast error">Обработка не удалась: {file.processingError ?? 'неизвестная ошибка'}</div>
      ) : null}

      <div className="cl-mi-hero">
        {place.length > 0 ? (
          <div className="cl-mi-place">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 21s7-5.7 7-11a7 7 0 1 0-14 0c0 5.3 7 11 7 11Z" />
              <circle cx="12" cy="10" r="2.6" />
            </svg>
            <span>
              {place.map((part, i) => (
                <span key={part} className={i === 0 ? 'top' : ''}>
                  {i > 0 ? <em>·</em> : null}
                  {part}
                </span>
              ))}
            </span>
          </div>
        ) : null}
        <div className="cl-mi-when">
          <b>{taken.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' })}</b>
          <span>{taken.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}</span>
          <i className="cl-mi-badge">{source}</i>
        </div>
      </div>

      {shots.length > 0 || camera ? (
        <div className="cl-mi-cam">
          {shots.length > 0 ? (
            <div className="cl-mi-shots">
              {shots.map((s) => (
                <div className="cl-mi-shot" key={s.t}>
                  <b>{s.v}</b>
                  <i>{s.t}</i>
                </div>
              ))}
            </div>
          ) : null}
          {camera ? (
            <div className="cl-mi-lens">
              <b>{camera}</b>
              {lens ? <span>{lens}</span> : null}
            </div>
          ) : null}
        </div>
      ) : null}

      {section('Файл', fileRows)}
      {section('Подробности', techRows)}
    </div>
  )
}


function CommentsPanel({
  file,
  spaceId,
  onSeek,
  currentTimeMs,
  canComment,
  meId,
  isOwner,
  onCountChange,
}: {
  file: CloudFile
  spaceId: string
  onSeek?: (ms: number) => void
  currentTimeMs: () => number
  canComment: boolean
  meId?: string
  isOwner: boolean
  onCountChange?: (count: number) => void
}) {
  const [comments, setComments] = useState<CloudComment[]>([])
  const [text, setText] = useState('')
  const [withTimestamp, setWithTimestamp] = useState(Boolean(onSeek))
  const [replyTo, setReplyTo] = useState<CloudComment | null>(null)
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<string | null>(null)
  const [sending, setSending] = useState(false)

  const load = useCallback(async () => {
    try {
      const { data } = await cloudApi.get<{ comments: CloudComment[] }>('/comments', {
        params: { spaceId, fileId: file.id },
      })
      setComments(data.comments)
      onCountChange?.(data.comments.filter((c) => !c.deletedAt).length)
    } catch (err) {
      toast.error(toCloudError(err).message)
    } finally {
      setLoading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spaceId, file.id])

  useEffect(() => {
    setLoading(true)
    void load()
  }, [load])

  useEffect(() => {
    const offs = [
      onCloudEvent('cloud.comment.created', (p) => {
        const payload = p as { comment: CloudComment }
        if (payload.comment.fileId === file.id) {
          setComments((prev) => (prev.some((c) => c.id === payload.comment.id) ? prev : [...prev, payload.comment]))
        }
      }),
      onCloudEvent('cloud.comment.updated', (p) => {
        const payload = p as { comment: CloudComment }
        setComments((prev) => prev.map((c) => (c.id === payload.comment.id ? payload.comment : c)))
      }),
      onCloudEvent('cloud.comment.deleted', (p) => {
        const payload = p as { commentId: string }
        setComments((prev) => prev.filter((c) => c.id !== payload.commentId))
      }),
      onCloudEvent('cloud.reaction.changed', (p) => {
        const payload = p as { targetType: string; targetId: string; reactions: Record<string, number> }
        if (payload.targetType !== 'COMMENT') return
        setComments((prev) => prev.map((c) => (c.id === payload.targetId ? { ...c, reactions: payload.reactions } : c)))
      }),
    ]
    return () => offs.forEach((off) => off())
  }, [file.id])

  const submit = async () => {
    const body = text.trim()
    // Ctrl+Enter и клик по «Отправить» наперегонки давали два одинаковых
    // комментария — сервер-то оба принимает честно.
    if (!body || sending) return
    setSending(true)
    try {
      await cloudApi.post('/comments', {
        spaceId,
        fileId: file.id,
        parentCommentId: replyTo?.id ?? null,
        body,
        videoTimestampMs: withTimestamp && onSeek ? currentTimeMs() : null,
      })
      setText('')
      setReplyTo(null)
      await load()
    } catch (err) {
      toast.error(toCloudError(err).message)
    } finally {
      setSending(false)
    }
  }

  const saveEdit = async (id: string, body: string) => {
    try {
      await cloudApi.patch(`/comments/${id}`, { body })
      setEditing(null)
      await load()
    } catch (err) {
      toast.error(toCloudError(err).message)
    }
  }

  const remove = async (id: string) => {
    try {
      await cloudApi.delete(`/comments/${id}`)
      setComments((prev) => prev.filter((c) => c.id !== id))
    } catch (err) {
      toast.error(toCloudError(err).message)
    }
  }

  const toggleReaction = async (comment: CloudComment, emoji: string) => {
    try {
      const { data } = await cloudApi.post<{ reactions: Record<string, number>; myReactions: string[] }>('/reactions', {
        targetType: 'COMMENT',
        targetId: comment.id,
        emoji,
      })
      setComments((prev) =>
        prev.map((c) => (c.id === comment.id ? { ...c, reactions: data.reactions, myReactions: data.myReactions } : c))
      )
    } catch (err) {
      toast.error(toCloudError(err).message)
    }
  }

  const byId = new Map(comments.map((c) => [c.id, c]))

  return (
    <>
      {loading ? (
        <div className="cl-muted">Загружаем обсуждение…</div>
      ) : comments.length === 0 ? (
        <div className="cl-muted" style={{ fontSize: 13.5, padding: '10px 0' }}>
          Пока никто ничего не написал.
        </div>
      ) : (
        comments
          .filter((c) => !c.deletedAt)
          .map((comment) => (
            <div className="cl-comment" key={comment.id}>
              <Avatar user={comment.author} />
              <div className="cl-comment-main">
                <div className="cl-comment-head">
                  <span className="cl-comment-author">
                    {comment.author?.displayName || comment.author?.username || 'Кто-то'}
                  </span>
                  {comment.videoTimestampMs !== null && onSeek ? (
                    <button className="cl-ts-chip" onClick={() => onSeek(comment.videoTimestampMs as number)}>
                      ▶ {formatDuration(comment.videoTimestampMs)}
                    </button>
                  ) : null}
                  <span className="cl-muted">{new Date(comment.createdAt).toLocaleString('ru-RU')}</span>
                  {comment.editedAt ? <span className="cl-muted">(изменено)</span> : null}
                </div>

                {comment.parentCommentId && byId.get(comment.parentCommentId) ? (
                  <div className="cl-reply-quote">
                    {byId.get(comment.parentCommentId)?.author?.displayName ??
                      byId.get(comment.parentCommentId)?.author?.username}
                    : {byId.get(comment.parentCommentId)?.body?.slice(0, 80)}
                  </div>
                ) : null}

                {editing === comment.id ? (
                  <EditBox initial={comment.body ?? ''} onCancel={() => setEditing(null)} onSave={(v) => void saveEdit(comment.id, v)} />
                ) : (
                  /* Текст рендерится как текстовый узел — никакого dangerouslySetInnerHTML. */
                  <div className="cl-comment-body">{comment.body}</div>
                )}

                <div className="cl-reactions">
                  {EMOJI.map((emoji) =>
                    comment.reactions[emoji] || comment.myReactions.includes(emoji) ? (
                      <button
                        key={emoji}
                        className={`cl-reaction${comment.myReactions.includes(emoji) ? ' mine' : ''}`}
                        onClick={() => void toggleReaction(comment, emoji)}
                      >
                        {emoji} {comment.reactions[emoji] ?? 0}
                      </button>
                    ) : null
                  )}
                  {canComment ? (
                    <>
                      <button className="cl-btn ghost sm" onClick={() => void toggleReaction(comment, '👍')}>
                        + 👍
                      </button>
                      <button className="cl-btn ghost sm" onClick={() => setReplyTo(comment)}>
                        Ответить
                      </button>
                      {/*
                        Права ровно те же, что на сервере: править — только свой
                        текст, удалять — свой или любой, если ты владелец хуяпки.
                        Раньше кнопки висели у каждого комментария и приводили
                        к 403 «Можно править только свои комментарии» — интерфейс
                        обещал то, чего не мог.
                      */}
                      {meId && comment.author?.id === meId ? (
                        <button className="cl-btn ghost sm" onClick={() => setEditing(comment.id)}>
                          Изменить
                        </button>
                      ) : null}
                      {meId && (comment.author?.id === meId || isOwner) ? (
                        <button className="cl-btn ghost sm" onClick={() => void remove(comment.id)}>
                          Удалить
                        </button>
                      ) : null}
                    </>
                  ) : null}
                </div>
              </div>
            </div>
          ))
      )}

      {canComment ? (
        <div style={{ marginTop: 14, position: 'sticky', bottom: 0, background: 'var(--surface-100)', paddingTop: 8 }}>
          {replyTo ? (
            <div className="cl-reply-quote" style={{ marginBottom: 6 }}>
              Ответ: {replyTo.author?.displayName ?? replyTo.author?.username} · {replyTo.body?.slice(0, 60)}
              <button className="cl-btn ghost sm" onClick={() => setReplyTo(null)}>
                ✕
              </button>
            </div>
          ) : null}
          <textarea
            className="cl-textarea"
            placeholder="Написать комментарий…"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void submit()
            }}
            style={{ minHeight: 62 }}
          />
          <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginTop: 8 }}>
            {onSeek ? (
              <label className="cl-check-row" style={{ padding: 0, fontSize: 13 }}>
                <input type="checkbox" checked={withTimestamp} onChange={(e) => setWithTimestamp(e.target.checked)} />
                привязать к {formatDuration(currentTimeMs())}
              </label>
            ) : null}
            <div className="cl-spacer" />
            <button className="cl-btn primary sm" onClick={() => void submit()} disabled={!text.trim() || sending}>
              {sending ? 'Отправляем…' : 'Отправить'}
            </button>
          </div>
        </div>
      ) : null}
    </>
  )
}

function EditBox({ initial, onSave, onCancel }: { initial: string; onSave: (v: string) => void; onCancel: () => void }) {
  const [value, setValue] = useState(initial)
  return (
    <div style={{ marginTop: 5 }}>
      <textarea className="cl-textarea" value={value} onChange={(e) => setValue(e.target.value)} style={{ minHeight: 56 }} />
      <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
        <button className="cl-btn primary sm" onClick={() => onSave(value.trim())} disabled={!value.trim()}>
          Сохранить
        </button>
        <button className="cl-btn ghost sm" onClick={onCancel}>
          Отмена
        </button>
      </div>
    </div>
  )
}
