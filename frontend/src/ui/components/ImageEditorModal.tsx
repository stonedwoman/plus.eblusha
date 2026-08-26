import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, Crop as CropIcon, Eraser, Pencil, RotateCw, Undo2, X } from 'lucide-react'

/**
 * Редактор фото перед отправкой: обрезка + рисование.
 *
 * Две вещи, ради которых он переписан целиком:
 *  1. РАСКЛАДКА. Раньше размер сцены считался руками из window.innerHeight минус захардкоженные
 *     «toolbarHeight = 200 / headerHeight = 60». На мобильном вебе это не работает в принципе:
 *     панель выше константы, а высота окна пляшет вместе с адресной строкой — низ картинки
 *     уезжал под панель рисования. Теперь это обычная flex-колонка (шапка / сцена flex:1 /
 *     панель) на 100dvh: сцена сама получает ровно ту высоту, что осталась, а картинка
 *     вписывается в неё целиком. Никаких вычислений высот в JS.
 *  2. КООРДИНАТЫ. Мазки и рамка обрезки хранятся в ДОЛЯХ рабочего изображения (0..1), а не в
 *     пикселях экрана. Поэтому поворот экрана, смена размера окна, обрезка и поворот картинки
 *     больше не «уносят» рисунок — пересчитывать при ресайзе нечего.
 */

type Point = { x: number; y: number } // доли рабочего изображения, 0..1
type Stroke = { color: string; size: number; erase: boolean; points: Point[] }
/** Рамка обрезки в долях рабочего изображения. */
type CropRect = { x: number; y: number; w: number; h: number }

export type EditableImage = {
  id: string
  file: File
  previewUrl: string
  fileName?: string
  edited?: boolean
}

type Props = {
  open: boolean
  image: EditableImage | null
  onClose: () => void
  onApply: (payload: { file: File; previewUrl: string }) => void
}

const COLORS = ['#ff3b30', '#ff9f0a', '#ffd60a', '#34c759', '#0a84ff', '#bf5af2', '#ffffff', '#111111']
/** Толщина кисти в долях меньшей стороны картинки — не зависит от размера экрана. */
const SIZES = [0.006, 0.012, 0.024]
const ASPECTS: Array<{ label: string; value: number | null }> = [
  { label: 'Свободно', value: null },
  { label: '1:1', value: 1 },
  { label: '4:5', value: 4 / 5 },
  { label: '3:4', value: 3 / 4 },
  { label: '16:9', value: 16 / 9 },
]
const HANDLES = ['nw', 'ne', 'sw', 'se', 'n', 's', 'w', 'e'] as const
type Handle = (typeof HANDLES)[number]
const FULL_CROP: CropRect = { x: 0, y: 0, w: 1, h: 1 }
/** Минимальная сторона рамки, в долях. */
const MIN_CROP = 0.08

type WorkState = { canvas: HTMLCanvasElement; strokes: Stroke[] }
/** Шаг истории: вместе с картинкой запоминаем рамку и соотношение, иначе «Отменить» их теряет. */
type HistoryStep = { work: WorkState; crop: CropRect; aspect: number | null }

/**
 * Потолок рабочего разрешения. Телефонная камера даёт 12+ Мп; canvas такого размера — это
 * ~48 МБ на КАЖДЫЙ шаг истории, а Safari на iOS вообще отказывается растеризовать холсты
 * больше ~16.7 Мп и молча отдаёт пустой кадр. Мессенджеры и так ужимают отправляемое фото.
 */
const MAX_WORK_PIXELS = 12_000_000
const MAX_HISTORY = 6

export function ImageEditorModal({ open, image, onClose, onApply }: Props) {
  const [mode, setMode] = useState<'crop' | 'draw'>('crop')
  const [work, setWork] = useState<WorkState | null>(null)
  const [history, setHistory] = useState<HistoryStep[]>([])
  const [loadError, setLoadError] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [crop, setCrop] = useState<CropRect>(FULL_CROP)
  const [aspect, setAspect] = useState<number | null>(null)
  const [color, setColor] = useState(COLORS[0])
  const [sizeIdx, setSizeIdx] = useState(1)
  const [erase, setErase] = useState(false)
  const [busy, setBusy] = useState(false)
  const [sceneBox, setSceneBox] = useState({ w: 0, h: 0 })

  const sceneRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const drawingRef = useRef<{ pointerId: number; stroke: Stroke } | null>(null)
  /** Переиспользуемый холст-слой для мазков: создавать новый на каждый кадр — заметный мусор. */
  const layerRef = useRef<HTMLCanvasElement | null>(null)
  /** Размер исходника — чтобы понять, трогали ли фото вообще (см. isUntouched). */
  const naturalRef = useRef({ w: 0, h: 0 })
  const closedRef = useRef(false)
  const cropDragRef = useRef<
    { pointerId: number; kind: 'move' | Handle; start: { x: number; y: number }; initial: CropRect } | null
  >(null)

  // --- загрузка исходника в рабочий холст ---
  useEffect(() => {
    if (!open || !image) {
      setWork(null)
      setHistory([])
      setCrop(FULL_CROP)
      setAspect(null)
      setMode('crop')
      setErase(false)
      return
    }
    let cancelled = false
    setLoadError(false)
    setNotice(null)
    closedRef.current = false
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => {
      if (cancelled) return
      const iw = img.naturalWidth
      const ih = img.naturalHeight
      if (!iw || !ih) {
        setLoadError(true)
        return
      }
      // Ужимаем ДО работы, а не при экспорте: холст натурального размера кладёт вкладку на
      // телефоне, а Safari отдаёт пустой кадр на снимках больше ~16 Мп.
      const scale = Math.min(1, Math.sqrt(MAX_WORK_PIXELS / (iw * ih)))
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.round(iw * scale))
      canvas.height = Math.max(1, Math.round(ih * scale))
      const ctx = canvas.getContext('2d')
      if (!ctx) {
        setLoadError(true)
        return
      }
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
      naturalRef.current = { w: canvas.width, h: canvas.height }
      setWork({ canvas, strokes: [] })
      setCrop(FULL_CROP)
    }
    // Без onerror редактор навсегда оставался бы пустым чёрным экраном: HEIC с айфона,
    // битый файл, отозванный objectURL — всё это молча не вызывает onload.
    img.onerror = () => {
      if (!cancelled) setLoadError(true)
    }
    img.src = image.previewUrl
    return () => {
      cancelled = true
    }
  }, [open, image])

  // --- размер сцены: меряем DOM, ничего не вычисляя из window ---
  useLayoutEffect(() => {
    const el = sceneRef.current
    if (!el || !open) return
    const measure = () => {
      const rect = el.getBoundingClientRect()
      setSceneBox({ w: rect.width, h: rect.height })
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    // Страховка к ResizeObserver: он не везде срабатывает на смену вьюпорта (поворот
    // телефона, съезжающая адресная строка, эмуляция устройства). Без этих слушателей
    // картинка сохраняла старый размер и вылезала под панель — ровно та жалоба, ради
    // которой всё переписывалось.
    window.addEventListener('resize', measure)
    window.addEventListener('orientationchange', measure)
    const vv = (window as any).visualViewport as VisualViewport | undefined
    vv?.addEventListener('resize', measure)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', measure)
      window.removeEventListener('orientationchange', measure)
      vv?.removeEventListener('resize', measure)
    }
  }, [open, work])

  /** Прямоугольник картинки внутри сцены (contain) — единственный мост экран↔доли. */
  const fit = useMemo(() => {
    if (!work || !sceneBox.w || !sceneBox.h) return null
    const iw = work.canvas.width
    const ih = work.canvas.height
    // Поля по краям: ручки рамки висят на -14px от границы картинки, и без запаса их
    // срезал бы overflow:hidden сцены — на узком фото за них было не ухватиться.
    const pad = 18
    const availW = Math.max(40, sceneBox.w - pad * 2)
    const availH = Math.max(40, sceneBox.h - pad * 2)
    const scale = Math.min(availW / iw, availH / ih)
    const w = iw * scale
    const h = ih * scale
    return { x: (sceneBox.w - w) / 2, y: (sceneBox.h - h) / 2, w, h }
  }, [work, sceneBox])

  const toNorm = useCallback(
    (clientX: number, clientY: number): Point | null => {
      const el = sceneRef.current
      if (!el || !fit) return null
      const rect = el.getBoundingClientRect()
      return {
        x: (clientX - rect.left - fit.x) / fit.w,
        y: (clientY - rect.top - fit.y) / fit.h,
      }
    },
    [fit],
  )

  // --- отрисовка предпросмотра ---
  const redraw = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas || !work || !fit) return
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const w = Math.max(1, Math.round(fit.w))
    const h = Math.max(1, Math.round(fit.h))
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr
      canvas.height = h * dpr
    }
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)
    ctx.drawImage(work.canvas, 0, 0, w, h)
    // dpr передаём в слой мазков — иначе линии рисовались бы в CSS-пикселях и растягивались
    // на ретине, выглядя мыльными рядом с резким фото.
    paintStrokes(ctx, work.strokes, w, h, drawingRef.current?.stroke, dpr, layerRef)
  }, [work, fit])

  // Перерисовку схлопываем до кадра: события указателя приходят до 1000 раз в секунду, и
  // синхронная полная перерисовка фото на каждом из них ощущается как рывки при рисовании.
  const rafRef = useRef(0)
  const scheduleRedraw = useCallback(() => {
    if (rafRef.current) return
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0
      redraw()
    })
  }, [redraw])

  useEffect(() => {
    redraw()
  }, [redraw])

  useEffect(
    () => () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
    },
    [],
  )

  // --- рисование ---
  const brushSize = SIZES[sizeIdx]

  const onScenePointerDown = (e: React.PointerEvent) => {
    if (mode !== 'draw' || !fit) return
    // Второй палец (или случайное касание ладонью) не должен перехватывать уже идущий штрих:
    // раньше он молча обнулял начатую линию, и мазок пропадал целиком.
    if (drawingRef.current) return
    const p = toNorm(e.clientX, e.clientY)
    if (!p) return
    // Мимо картинки не рисуем: такой «невидимый» мазок всё равно попадал в стек отмены,
    // и «Отменить» потом срабатывало вхолостую.
    if (p.x < 0 || p.x > 1 || p.y < 0 || p.y > 1) return
    e.preventDefault()
    // setPointerCapture может бросить (указателя с таким id уже нет — например, жест перехватила
    // система). Без try исключение обрывало бы обработчик ДО начала штриха, и мазок терялся.
    try {
      ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
    } catch {
      // ignore
    }
    drawingRef.current = {
      pointerId: e.pointerId,
      stroke: { color, size: brushSize, erase, points: [p] },
    }
    scheduleRedraw()
  }

  const onScenePointerMove = (e: React.PointerEvent) => {
    const drawing = drawingRef.current
    if (!drawing || drawing.pointerId !== e.pointerId) return
    const p = toNorm(e.clientX, e.clientY)
    if (!p) return
    e.preventDefault()
    drawing.stroke.points.push(p)
    scheduleRedraw()
  }

  const endStroke = (e: React.PointerEvent) => {
    const drawing = drawingRef.current
    if (!drawing || drawing.pointerId !== e.pointerId) return
    drawingRef.current = null
    const stroke = drawing.stroke
    if (stroke.points.length && work) {
      setWork({ canvas: work.canvas, strokes: [...work.strokes, stroke] })
    } else {
      redraw()
    }
  }

  const undoStroke = () => {
    if (!work) return
    if (work.strokes.length) {
      setWork({ canvas: work.canvas, strokes: work.strokes.slice(0, -1) })
      return
    }
    // Мазков не осталось — откатываем предыдущую обрезку/поворот вместе с рамкой и
    // соотношением: без них после отмены поворота оставалось «перевёрнутое» 9:16,
    // которого нет ни в одном чипе.
    const prev = history[history.length - 1]
    if (!prev) return
    setHistory(history.slice(0, -1))
    setWork(prev.work)
    setCrop(prev.crop)
    setAspect(prev.aspect)
    aspectAppliedRef.current = { aspect: prev.aspect, work: prev.work }
  }

  const canUndo = !!work && (work.strokes.length > 0 || history.length > 0)

  // --- обрезка ---
  const applyAspect = useCallback(
    (rect: CropRect, ratio: number | null, iw: number, ih: number): CropRect => {
      if (!ratio) return rect
      // Соотношение задаётся в ПИКСЕЛЯХ картинки, поэтому переводим доли в пиксели и обратно.
      const cx = rect.x + rect.w / 2
      const cy = rect.y + rect.h / 2
      let wPx = rect.w * iw
      let hPx = rect.h * ih
      if (wPx / hPx > ratio) wPx = hPx * ratio
      else hPx = wPx / ratio
      // Ужимаем пропорционально, если сторона вышла за картинку: делить каждую сторону
      // по отдельности нельзя — пропорция бы поехала.
      const shrink = Math.min(1, iw / wPx, ih / hPx)
      wPx *= shrink
      hPx *= shrink
      const w = wPx / iw
      const h = hPx / ih
      const x = Math.min(Math.max(cx - w / 2, 0), 1 - w)
      const y = Math.min(Math.max(cy - h / 2, 0), 1 - h)
      return clampAspectRect({ x, y, w, h }, ratio, iw, ih)
    },
    [],
  )

  const onAspectPick = (ratio: number | null) => setAspect(ratio)

  // Подгоняем рамку под выбранное соотношение ЗДЕСЬ, а не в обработчике кнопки: иначе выбор,
  // сделанный до того, как картинка догрузилась (work ещё null), молча терялся — соотношение
  // подсвечено, а рамка осталась прежней.
  const aspectAppliedRef = useRef<{ aspect: number | null; work: WorkState | null }>({ aspect: null, work: null })
  useEffect(() => {
    if (!work) return
    const prev = aspectAppliedRef.current
    if (prev.aspect === aspect && prev.work === work) return
    aspectAppliedRef.current = { aspect, work }
    if (!aspect) return
    setCrop((c) => applyAspect(c, aspect, work.canvas.width, work.canvas.height))
  }, [aspect, work, applyAspect])

  const onCropPointerDown = (kind: 'move' | Handle) => (e: React.PointerEvent) => {
    if (mode !== 'crop') return
    e.preventDefault()
    e.stopPropagation()
    try {
      ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
    } catch {
      // ignore
    }
    cropDragRef.current = { pointerId: e.pointerId, kind, start: { x: e.clientX, y: e.clientY }, initial: crop }
  }

  const onCropPointerMove = (e: React.PointerEvent) => {
    const drag = cropDragRef.current
    if (!drag || drag.pointerId !== e.pointerId || !fit || !work) return
    e.preventDefault()
    const dx = (e.clientX - drag.start.x) / fit.w
    const dy = (e.clientY - drag.start.y) / fit.h
    const init = drag.initial
    let next: CropRect = { ...init }

    if (drag.kind === 'move') {
      next.x = clamp(init.x + dx, 0, 1 - init.w)
      next.y = clamp(init.y + dy, 0, 1 - init.h)
      cropDragRef.current = { ...drag }
      setCrop(next)
      return
    }

    const k = drag.kind
    let left = init.x
    let top = init.y
    let right = init.x + init.w
    let bottom = init.y + init.h
    if (k.includes('w')) left = clamp(init.x + dx, 0, right - MIN_CROP)
    if (k.includes('e')) right = clamp(init.x + init.w + dx, left + MIN_CROP, 1)
    if (k.includes('n')) top = clamp(init.y + dy, 0, bottom - MIN_CROP)
    if (k.includes('s')) bottom = clamp(init.y + init.h + dy, top + MIN_CROP, 1)
    next = { x: left, y: top, w: right - left, h: bottom - top }

    if (aspect) {
      // Держим пропорцию, отталкиваясь от «якорной» стороны, противоположной хвату.
      const iw = work.canvas.width
      const ih = work.canvas.height
      const anchorX = k.includes('w') ? right : left
      const anchorY = k.includes('n') ? bottom : top
      let wPx = next.w * iw
      let hPx = next.h * ih
      if (k === 'n' || k === 's') wPx = hPx * aspect
      else if (k === 'e' || k === 'w') hPx = wPx / aspect
      else if (wPx / hPx > aspect) wPx = hPx * aspect
      else hPx = wPx / aspect
      let w = wPx / iw
      let h = hPx / ih
      let x = k.includes('w') ? anchorX - w : anchorX
      let y = k.includes('n') ? anchorY - h : anchorY
      // Упираемся в края, не ломая пропорцию.
      if (x < 0) {
        w += x
        h = (w * iw) / aspect / ih
        x = 0
      }
      if (y < 0) {
        h += y
        w = ((h * ih) * aspect) / iw
        y = 0
      }
      if (x + w > 1) {
        w = 1 - x
        h = (w * iw) / aspect / ih
      }
      if (y + h > 1) {
        h = 1 - y
        w = ((h * ih) * aspect) / iw
      }
      next = clampAspectRect({ x, y, w, h }, aspect, iw, ih)
    }
    setCrop(next)
  }

  const onCropPointerUp = (e: React.PointerEvent) => {
    if (cropDragRef.current?.pointerId === e.pointerId) cropDragRef.current = null
  }

  /** Снимок состояния для «Отменить». Длину ограничиваем — иначе десяток полноразмерных
   *  холстов в памяти телефона заканчивается вылетом вкладки. */
  const pushHistory = () => {
    if (!work) return
    setHistory((h) => [...h, { work, crop, aspect }].slice(-MAX_HISTORY))
  }

  /** Вырезает выбранное и делает результат новым рабочим изображением. */
  const commitCrop = () => {
    if (!work) return
    const iw = work.canvas.width
    const ih = work.canvas.height
    const safe = sanitizeCrop(crop)
    const sx = Math.round(safe.x * iw)
    const sy = Math.round(safe.y * ih)
    const sw = Math.max(1, Math.min(Math.round(safe.w * iw), iw - sx))
    const sh = Math.max(1, Math.min(Math.round(safe.h * ih), ih - sy))
    if (sw === iw && sh === ih) return
    const canvas = document.createElement('canvas')
    canvas.width = sw
    canvas.height = sh
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.drawImage(work.canvas, sx, sy, sw, sh, 0, 0, sw, sh)
    // Мазки живут в долях, поэтому пересчитываем их в систему новой картинки.
    const strokes = work.strokes
      .map((s) => ({
        ...s,
        // Толщина задана долей меньшей стороны — при вырезке доля меняется.
        size: (s.size * Math.min(iw, ih)) / Math.min(sw, sh),
        points: s.points.map((p) => ({ x: (p.x * iw - sx) / sw, y: (p.y * ih - sy) / sh })),
      }))
      .filter((s) => s.points.some((p) => p.x > -0.2 && p.x < 1.2 && p.y > -0.2 && p.y < 1.2))
    pushHistory()
    setWork({ canvas, strokes })
    setCrop(FULL_CROP)
  }

  const rotate = () => {
    if (!work) return
    const iw = work.canvas.width
    const ih = work.canvas.height
    const canvas = document.createElement('canvas')
    canvas.width = ih
    canvas.height = iw
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.translate(ih, 0)
    ctx.rotate(Math.PI / 2)
    ctx.drawImage(work.canvas, 0, 0)
    const strokes = work.strokes.map((s) => ({
      ...s,
      points: s.points.map((p) => ({ x: 1 - p.y, y: p.x })),
    }))
    pushHistory()
    setWork({ canvas, strokes })
    setCrop((prev) => ({ x: 1 - prev.y - prev.h, y: prev.x, w: prev.h, h: prev.w }))
    // Соотношение переворачиваем вместе с картинкой, но только если перевёрнутое есть в
    // списке: иначе чип гаснет, а рамка живёт по значению, которого пользователь не выбирал.
    setAspect((a) => {
      if (!a) return a
      const inverted = 1 / a
      return ASPECTS.some((opt) => opt.value !== null && Math.abs(opt.value - inverted) < 0.001) ? inverted : null
    })
  }

  // --- сохранение ---
  /** Ничего не трогали — не пережимаем: каждый прогон toBlob портит JPEG заново. */
  const isUntouched = () =>
    !!work &&
    !history.length &&
    !work.strokes.length &&
    Math.abs(crop.x) < 0.001 &&
    Math.abs(crop.y) < 0.001 &&
    Math.abs(crop.w - 1) < 0.001 &&
    Math.abs(crop.h - 1) < 0.001 &&
    work.canvas.width === naturalRef.current.w &&
    work.canvas.height === naturalRef.current.h

  const apply = async () => {
    if (!work || !image || busy) return
    if (isUntouched()) {
      onClose()
      return
    }
    setBusy(true)
    try {
      const iw = work.canvas.width
      const ih = work.canvas.height
      const safe = sanitizeCrop(crop)
      const sx = Math.round(safe.x * iw)
      const sy = Math.round(safe.y * ih)
      const sw = Math.max(1, Math.min(Math.round(safe.w * iw), iw - sx))
      const sh = Math.max(1, Math.min(Math.round(safe.h * ih), ih - sy))
      const out = document.createElement('canvas')
      out.width = sw
      out.height = sh
      const ctx = out.getContext('2d')
      if (!ctx) throw new Error('canvas')
      ctx.drawImage(work.canvas, sx, sy, sw, sh, 0, 0, sw, sh)
      const strokes = work.strokes.map((s) => ({
        ...s,
        size: (s.size * Math.min(iw, ih)) / Math.min(sw, sh),
        points: s.points.map((p) => ({ x: (p.x * iw - sx) / sw, y: (p.y * ih - sy) / sh })),
      }))
      paintStrokes(ctx, strokes, sw, sh)

      // Форматы с прозрачностью сохраняем в PNG: jpeg залил бы прозрачные места чёрным.
      const src = `${image.file.type || ''} ${image.file.name || ''} ${image.fileName || ''}`.toLowerCase()
      const keepAlpha = /(png|webp|gif|svg)/.test(src)
      const type = keepAlpha ? 'image/png' : 'image/jpeg'
      const blob = await new Promise<Blob | null>((resolve) => out.toBlob(resolve, type, keepAlpha ? undefined : 0.92))
      if (!blob) throw new Error('blob')
      const baseName = (image.fileName || image.file.name || 'photo').replace(/\.[^.]+$/, '')
      const file = new File([blob], `${baseName}${keepAlpha ? '.png' : '.jpg'}`, { type })
      const url = URL.createObjectURL(blob)
      if (closedRef.current) {
        // Пока кодировали, редактор закрыли — результат никому не нужен, освобождаем ссылку.
        URL.revokeObjectURL(url)
        return
      }
      onApply({ file, previewUrl: url })
    } catch {
      // Молчаливый провал выглядел как «кнопка не работает»: говорим вслух.
      setNotice('Не удалось сохранить фото. Попробуйте ещё раз.')
      setBusy(false)
      return
    }
    setBusy(false)
  }

  const requestClose = useCallback(() => {
    if (busy) return // идёт кодирование — не бросаем работу на полпути
    closedRef.current = true
    onClose()
  }, [busy, onClose])

  // Аппаратная «Назад» на Android закрывает РЕДАКТОР, а не чат. Раньше это было только
  // обещано комментарием: обработчика popstate не существовало, и «назад» выкидывала из
  // переписки, теряя правки.
  useEffect(() => {
    if (!open) return
    const marker = { ebImageEditor: true }
    try {
      window.history.pushState(marker, '')
    } catch {
      // ignore
    }
    const onPop = () => {
      closedRef.current = true
      onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') requestClose()
    }
    window.addEventListener('popstate', onPop)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('popstate', onPop)
      window.removeEventListener('keydown', onKey)
      // Свою запись из истории убираем, только если она ещё наверху — иначе съели бы
      // чужой переход.
      try {
        if ((window.history.state as any)?.ebImageEditor) window.history.back()
      } catch {
        // ignore
      }
    }
  }, [open, onClose, requestClose])

  if (!open || !image) return null

  const cropStyle = fit
    ? {
        left: `${fit.x + crop.x * fit.w}px`,
        top: `${fit.y + crop.y * fit.h}px`,
        width: `${crop.w * fit.w}px`,
        height: `${crop.h * fit.h}px`,
      }
    : undefined

  return createPortal(
    <div style={S.root}>
      <div style={S.header}>
        <button type="button" onClick={requestClose} style={S.iconBtn} aria-label="Отмена">
          <X size={22} />
        </button>
        <div style={S.tabs}>
          <button
            type="button"
            onClick={() => setMode('crop')}
            style={{ ...S.tab, ...(mode === 'crop' ? S.tabActive : null) }}
          >
            <CropIcon size={16} /> Обрезка
          </button>
          <button
            type="button"
            onClick={() => {
              // Применяем рамку СРАЗУ: в режиме рисования её не видно, а «Готово» всё равно
              // резало по ней — люди рисовали по краям и получали обрезанное фото без
              // всякого предупреждения.
              commitCrop()
              setMode('draw')
            }}
            style={{ ...S.tab, ...(mode === 'draw' ? S.tabActive : null) }}
          >
            <Pencil size={16} /> Рисование
          </button>
        </div>
        <button type="button" onClick={apply} disabled={busy} style={{ ...S.iconBtn, ...S.doneBtn }} aria-label="Готово">
          <Check size={22} />
        </button>
      </div>

      {loadError && (
        <div style={S.errorBox}>
          <div style={{ fontWeight: 700, marginBottom: 6 }}>Не удалось открыть фото</div>
          <div style={{ color: '#9aa0a8', fontSize: 13, textAlign: 'center' }}>
            Браузер не смог его прочитать — например, формат HEIC с айфона. Отправьте файл как есть.
          </div>
          <button type="button" onClick={requestClose} style={{ ...S.actionBtn, marginTop: 14 }}>
            Закрыть
          </button>
        </div>
      )}
      {notice && !loadError && <div style={S.notice}>{notice}</div>}
      <div
        ref={sceneRef}
        style={{ ...S.scene, cursor: mode === 'draw' ? 'crosshair' : 'default', ...(loadError ? { display: 'none' } : null) }}
        onPointerDown={onScenePointerDown}
        onPointerMove={(e) => {
          onScenePointerMove(e)
          onCropPointerMove(e)
        }}
        onPointerUp={(e) => {
          endStroke(e)
          onCropPointerUp(e)
        }}
        onPointerCancel={(e) => {
          endStroke(e)
          onCropPointerUp(e)
        }}
      >
        {fit && (
          <canvas
            ref={canvasRef}
            style={{
              position: 'absolute',
              left: `${fit.x}px`,
              top: `${fit.y}px`,
              width: `${fit.w}px`,
              height: `${fit.h}px`,
              touchAction: 'none',
              borderRadius: 6,
            }}
          />
        )}

        {mode === 'crop' && fit && cropStyle && (
          <>
            {/* Затемнение снаружи рамки — четырьмя полосами, чтобы не ловить клики. */}
            <div style={{ ...S.shade, left: fit.x, top: fit.y, width: fit.w, height: crop.y * fit.h }} />
            <div
              style={{
                ...S.shade,
                left: fit.x,
                top: fit.y + (crop.y + crop.h) * fit.h,
                width: fit.w,
                height: (1 - crop.y - crop.h) * fit.h,
              }}
            />
            <div
              style={{
                ...S.shade,
                left: fit.x,
                top: fit.y + crop.y * fit.h,
                width: crop.x * fit.w,
                height: crop.h * fit.h,
              }}
            />
            <div
              style={{
                ...S.shade,
                left: fit.x + (crop.x + crop.w) * fit.w,
                top: fit.y + crop.y * fit.h,
                width: (1 - crop.x - crop.w) * fit.w,
                height: crop.h * fit.h,
              }}
            />
            <div style={{ ...S.cropBox, ...cropStyle }} onPointerDown={onCropPointerDown('move')}>
              <div style={S.gridV} />
              <div style={{ ...S.gridV, left: '66.66%' }} />
              <div style={S.gridH} />
              <div style={{ ...S.gridH, top: '66.66%' }} />
              {HANDLES.map((h) => (
                <div key={h} style={{ ...S.handle, ...handlePos(h) }} onPointerDown={onCropPointerDown(h)}>
                  <div style={{ ...S.handleDot, ...(h.length === 2 ? S.handleCorner : S.handleEdge) }} />
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      <div style={{ ...S.panel, ...(loadError ? { display: 'none' } : null) }}>
        {mode === 'crop' ? (
          <>
            <div style={S.row}>
              {ASPECTS.map((a) => (
                <button
                  key={a.label}
                  type="button"
                  onClick={() => onAspectPick(a.value)}
                  style={{ ...S.chip, ...(aspect === a.value ? S.chipActive : null) }}
                >
                  {a.label}
                </button>
              ))}
            </div>
            <div style={S.row}>
              <button type="button" onClick={rotate} style={S.actionBtn}>
                <RotateCw size={16} /> Повернуть
              </button>
              <button type="button" onClick={commitCrop} style={S.actionBtn}>
                <CropIcon size={16} /> Обрезать
              </button>
              <button type="button" onClick={undoStroke} disabled={!canUndo} style={S.actionBtn}>
                <Undo2 size={16} /> Отменить
              </button>
            </div>
          </>
        ) : (
          <>
            <div style={S.row}>
              {COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => {
                    setColor(c)
                    setErase(false)
                  }}
                  aria-label={`Цвет ${c}`}
                  style={{
                    ...S.swatch,
                    background: c,
                    outline: !erase && color === c ? '2px solid #fff' : '1px solid rgba(255,255,255,0.25)',
                    outlineOffset: 2,
                  }}
                />
              ))}
            </div>
            <div style={S.row}>
              {SIZES.map((s, i) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setSizeIdx(i)}
                  aria-label={`Толщина ${i + 1}`}
                  style={{ ...S.sizeBtn, ...(sizeIdx === i ? S.chipActive : null) }}
                >
                  <span style={{ width: 6 + i * 7, height: 6 + i * 7, borderRadius: '50%', background: '#fff' }} />
                </button>
              ))}
              <button
                type="button"
                onClick={() => setErase((v) => !v)}
                style={{ ...S.actionBtn, ...(erase ? S.chipActive : null) }}
              >
                <Eraser size={16} /> Ластик
              </button>
              <button type="button" onClick={undoStroke} disabled={!canUndo} style={S.actionBtn}>
                <Undo2 size={16} /> Отменить
              </button>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  )
}

function clamp(v: number, min: number, max: number) {
  return Math.min(Math.max(v, min), max)
}

/**
 * Приводит рамку к допустимому виду, НЕ ломая пропорцию: сначала растягивает её до
 * минимального размера (обе стороны сразу — иначе Math.max по каждой отдельно превращал
 * выбранное 1:1 в 16:9), потом ужимает, если не влезла, и только затем двигает внутрь картинки.
 * Раньше зажим стоял последним, поэтому рамка могла остаться за краем — и в отправленный
 * файл попадала чёрная (для PNG — прозрачная) полоса.
 */
function clampAspectRect(rect: CropRect, ratio: number, iw: number, ih: number): CropRect {
  let wPx = rect.w * iw
  let hPx = rect.h * ih
  const minW = MIN_CROP * iw
  const minH = MIN_CROP * ih
  const grow = Math.max(1, minW / wPx, minH / hPx)
  wPx *= grow
  hPx *= grow
  const shrink = Math.min(1, iw / wPx, ih / hPx)
  wPx *= shrink
  hPx *= shrink
  const w = Math.min(1, wPx / iw)
  const h = Math.min(1, hPx / ih)
  return {
    x: clamp(rect.x, 0, Math.max(0, 1 - w)),
    y: clamp(rect.y, 0, Math.max(0, 1 - h)),
    w,
    h,
  }
}

/** Страховка перед вырезкой: рамка обязана лежать внутри картинки. */
function sanitizeCrop(rect: CropRect): CropRect {
  const w = clamp(rect.w, 0.01, 1)
  const h = clamp(rect.h, 0.01, 1)
  return { x: clamp(rect.x, 0, 1 - w), y: clamp(rect.y, 0, 1 - h), w, h }
}

/**
 * Рисует мазки поверх картинки (координаты мазков — доли).
 *
 * Мазки собираются в ОТДЕЛЬНОМ слое и только потом накладываются. Иначе ластик
 * (`destination-out`) выедал бы дыру насквозь — вместе с самой фотографией, — а не стирал
 * бы только нарисованное.
 */
function paintStrokes(
  ctx: CanvasRenderingContext2D,
  strokes: Stroke[],
  w: number,
  h: number,
  extra?: Stroke | null,
  dpr = 1,
  layerRef?: { current: HTMLCanvasElement | null },
) {
  const list = extra ? [...strokes, extra] : strokes
  if (!list.length) return
  const base = Math.min(w, h)
  const lw = Math.max(1, Math.round(w * dpr))
  const lh = Math.max(1, Math.round(h * dpr))
  const layer = layerRef?.current ?? document.createElement('canvas')
  if (layerRef) layerRef.current = layer
  if (layer.width !== lw || layer.height !== lh) {
    layer.width = lw
    layer.height = lh
  }
  const lc = layer.getContext('2d')
  if (!lc) return
  lc.setTransform(1, 0, 0, 1, 0, 0)
  lc.clearRect(0, 0, lw, lh)
  // Слой держим в пикселях устройства: иначе линии рисовались бы в CSS-пикселях и на
  // ретине растягивались — рядом с резким фото это выглядело мылом.
  lc.setTransform(dpr, 0, 0, dpr, 0, 0)
  lc.lineCap = 'round'
  lc.lineJoin = 'round'
  for (const s of list) {
    if (!s.points.length) continue
    lc.globalCompositeOperation = s.erase ? 'destination-out' : 'source-over'
    lc.strokeStyle = s.color
    lc.lineWidth = Math.max(1, s.size * base)
    lc.beginPath()
    lc.moveTo(s.points[0].x * w, s.points[0].y * h)
    if (s.points.length === 1) {
      // Одиночный тап — точка, а не пустой путь.
      lc.lineTo(s.points[0].x * w + 0.01, s.points[0].y * h)
    } else {
      for (let i = 1; i < s.points.length; i++) lc.lineTo(s.points[i].x * w, s.points[i].y * h)
    }
    lc.stroke()
  }
  ctx.save()
  ctx.globalCompositeOperation = 'source-over'
  ctx.drawImage(layer, 0, 0, w, h)
  ctx.restore()
}

function handlePos(h: Handle): React.CSSProperties {
  const edge = -14
  switch (h) {
    case 'nw':
      return { left: edge, top: edge, cursor: 'nwse-resize' }
    case 'ne':
      return { right: edge, top: edge, cursor: 'nesw-resize' }
    case 'sw':
      return { left: edge, bottom: edge, cursor: 'nesw-resize' }
    case 'se':
      return { right: edge, bottom: edge, cursor: 'nwse-resize' }
    case 'n':
      return { left: '50%', top: edge, transform: 'translateX(-50%)', cursor: 'ns-resize' }
    case 's':
      return { left: '50%', bottom: edge, transform: 'translateX(-50%)', cursor: 'ns-resize' }
    case 'w':
      return { left: edge, top: '50%', transform: 'translateY(-50%)', cursor: 'ew-resize' }
    case 'e':
    default:
      return { right: edge, top: '50%', transform: 'translateY(-50%)', cursor: 'ew-resize' }
  }
}

const S: Record<string, React.CSSProperties> = {
  root: {
    position: 'fixed',
    inset: 0,
    zIndex: 4000,
    background: '#0b0d11',
    display: 'flex',
    flexDirection: 'column',
    // dvh, а не vh: на мобильном вебе адресная строка съезжает и vh «врёт» —
    // именно из-за этого низ картинки уходил под панель.
    height: '100dvh',
    maxHeight: '100dvh',
    overscrollBehavior: 'contain',
    touchAction: 'none',
    userSelect: 'none',
  },
  header: {
    flex: '0 0 auto',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    padding: '8px 10px',
    paddingTop: 'max(8px, env(safe-area-inset-top))',
  },
  tabs: { display: 'flex', gap: 6, background: 'rgba(255,255,255,0.06)', padding: 4, borderRadius: 12 },
  tab: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '7px 12px',
    borderRadius: 9,
    border: 'none',
    background: 'transparent',
    color: '#e8eaee',
    fontSize: 13,
    fontWeight: 700,
    cursor: 'pointer',
  },
  tabActive: { background: 'rgba(255,255,255,0.14)' },
  iconBtn: {
    width: 40,
    height: 40,
    borderRadius: 12,
    border: 'none',
    background: 'rgba(255,255,255,0.08)',
    color: '#fff',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
    flex: '0 0 auto',
  },
  doneBtn: { background: '#d97706' },
  // Сцена забирает ВСЁ оставшееся место; min-height: 0 обязателен, иначе flex-элемент
  // раздувается по содержимому и панель уезжает за экран.
  scene: { position: 'relative', flex: '1 1 auto', minHeight: 0, overflow: 'hidden', touchAction: 'none' },
  shade: { position: 'absolute', background: 'rgba(0,0,0,0.55)', pointerEvents: 'none' },
  cropBox: {
    position: 'absolute',
    boxSizing: 'border-box',
    border: '1.5px solid rgba(255,255,255,0.95)',
    boxShadow: '0 0 0 1px rgba(0,0,0,0.35)',
    cursor: 'move',
    touchAction: 'none',
  },
  gridV: {
    position: 'absolute',
    left: '33.33%',
    top: 0,
    bottom: 0,
    width: 1,
    background: 'rgba(255,255,255,0.35)',
    pointerEvents: 'none',
  },
  gridH: {
    position: 'absolute',
    top: '33.33%',
    left: 0,
    right: 0,
    height: 1,
    background: 'rgba(255,255,255,0.35)',
    pointerEvents: 'none',
  },
  // Зона захвата заметно больше видимой точки — иначе пальцем в неё не попасть.
  handle: {
    position: 'absolute',
    width: 28,
    height: 28,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    touchAction: 'none',
  },
  handleDot: { background: '#fff', boxShadow: '0 1px 3px rgba(0,0,0,0.5)' },
  handleCorner: { width: 14, height: 14, borderRadius: 4 },
  handleEdge: { width: 22, height: 5, borderRadius: 3 },
  panel: {
    // 0 1 auto + потолок высоты: в ландшафте на телефоне панель раньше забирала весь экран,
    // и сцена схлопывалась в ноль — фото просто исчезало.
    flex: '0 1 auto',
    maxHeight: '45dvh',
    overflowY: 'auto',
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    padding: '10px 12px',
    paddingBottom: 'max(12px, env(safe-area-inset-bottom))',
    background: '#12151b',
    borderTop: '1px solid rgba(255,255,255,0.08)',
  },
  row: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', justifyContent: 'center' },
  errorBox: {
    flex: '1 1 auto',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    color: '#e8eaee',
  },
  notice: {
    flex: '0 0 auto',
    margin: '0 12px',
    padding: '8px 12px',
    borderRadius: 10,
    background: 'rgba(248,113,113,0.15)',
    border: '1px solid rgba(248,113,113,0.35)',
    color: '#fca5a5',
    fontSize: 13,
    textAlign: 'center',
  },
  chip: {
    padding: '7px 12px',
    borderRadius: 10,
    border: '1px solid rgba(255,255,255,0.12)',
    background: 'rgba(255,255,255,0.05)',
    color: '#e8eaee',
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
  },
  chipActive: { background: 'rgba(217,119,6,0.9)', borderColor: 'transparent', color: '#fff' },
  actionBtn: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '9px 14px',
    borderRadius: 12,
    border: '1px solid rgba(255,255,255,0.12)',
    background: 'rgba(255,255,255,0.05)',
    color: '#e8eaee',
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
  },
  swatch: { width: 30, height: 30, borderRadius: '50%', border: 'none', cursor: 'pointer', padding: 0 },
  sizeBtn: {
    width: 40,
    height: 36,
    borderRadius: 10,
    border: '1px solid rgba(255,255,255,0.12)',
    background: 'rgba(255,255,255,0.05)',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
  },
}
