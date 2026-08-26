import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { cloudApi, formatBytes, formatDuration, toCloudError } from '../api'
import type { CloudComment, CloudFile } from '../types'
import { onCloudEvent } from '../realtime'
import { Avatar, toast } from './ui'
import { FacesPanel, type PanelFace } from './FacesPanel'

const EMOJI = ['👍', '❤️', '😂', '😮', '😢']

/**
 * Резерв по низу сцены (полоса превью, на узком экране — плюс планка корешка
 * и safe-area). Единственный источник правды — вычисленный --cl-gutter со
 * сцены: JS-двойник в пикселях неизбежно расходился бы с CSS при повороте
 * планшета и на устройствах с home-индикатором.
 */
const gutterOf = (stage: HTMLElement): number =>
  parseFloat(getComputedStyle(stage).getPropertyValue('--cl-gutter')) || 104
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
   * Видимый поворот кадра: НЕнормализованные градусы, привязанные к id кадра.
   * Ненормализованность — чтобы два щелчка крутили 0→90→180, а против часовой
   * шло через −90, а не длинной дорогой через 270. Привязка к id — чтобы откат
   * неудавшегося запроса не прилетал в СОСЕДНИЙ кадр, на который человек успел
   * перелистнуть, а свежий кадр не рисовался один фрейм с чужим углом: для
   * чужого id угол берётся из данных сервера прямо в рендере.
   */
  const [vis, setVis] = useState<{ id: string; deg: number } | null>(null)
  const baseDelta = file ? (((file.rotation - file.previewRotation) % 360) + 360) % 360 : 0
  const spin = vis && vis.id === file?.id ? vis.deg : baseDelta
  useEffect(() => {
    if (!file) return
    setVis((v) =>
      v && v.id === file.id && ((v.deg % 360) + 360) % 360 === baseDelta ? v : { id: file.id, deg: baseDelta }
    )
  }, [file?.id, baseDelta])

  /*
   * Лица кадра: бейдж на корешке (сколько неопознанных) и вкладка «Люди».
   * Кэш по id — листание не гоняет одни и те же запросы; после привязки
   * запись кэша сбрасывается и перечитывается.
   */
  const [fileFaces, setFileFaces] = useState<PanelFace[] | null>(null)
  const facesCache = useRef(new Map<string, PanelFace[]>())
  const loadFaces = useCallback(
    async (fid: string, force = false) => {
      if (!force && facesCache.current.has(fid)) {
        setFileFaces(facesCache.current.get(fid)!)
        return
      }
      try {
        const { data } = await cloudApi.get<{ faces: PanelFace[] }>('/faces/by-file', { params: { fileId: fid } })
        facesCache.current.set(fid, data.faces)
        setFileFaces((prev) => (file?.id === fid ? data.faces : prev))
      } catch {
        if (file?.id === fid) setFileFaces([])
      }
    },
    [file?.id]
  )
  useEffect(() => {
    if (!file) return
    setFileFaces(null)
    if (file.kind !== 'IMAGE') {
      setFileFaces([])
      return
    }
    void loadFaces(file.id)
  }, [file?.id, file?.kind, loadFaces])
  // Бейдж зовёт только на повторяющихся: прохожие не зажигают тревогу.
  const unknownFaces = fileFaces ? fileFaces.filter((f) => !f.person && f.recurring).length : 0

  const rotate = useCallback(
    async (dir: 'cw' | 'ccw') => {
      const target = file
      if (!target || (target.kind !== 'IMAGE' && target.kind !== 'VIDEO')) return
      const step = dir === 'cw' ? 90 : -90
      const targetBase = (((target.rotation - target.previewRotation) % 360) + 360) % 360
      // Оптимистично: кадр поворачивается сразу, ответ лишь подтверждает.
      setVis((v) => ({ id: target.id, deg: (v && v.id === target.id ? v.deg : targetBase) + step }))
      try {
        const { data } = await cloudApi.post<{ file: CloudFile }>(`/files/${target.id}/rotate`, { dir })
        onFileChanged?.(data.file)
        /*
         * Фолбэк на молчащий realtime: перепечка занимает секунды, и если
         * событие не дошло, кадр вечно жил бы растянутым из старого превью.
         * Несколько опросов — и DTO с перепечёнными превью доедет сам.
         */
        if (target.kind === 'IMAGE') {
          for (const ms of [1500, 3500, 7000]) {
            setTimeout(async () => {
              try {
                const { data: fresh } = await cloudApi.get<{ file: CloudFile }>(`/files/${target.id}`)
                if (fresh.file.previewRotation === fresh.file.rotation) onFileChanged?.(fresh.file)
              } catch {
                /* не критично — событие или следующий опрос */
              }
            }, ms)
          }
        }
      } catch (err) {
        // Откат строго своему кадру: человек мог уже перелистнуть.
        setVis((v) => (v && v.id === target.id ? { ...v, deg: v.deg - step } : v))
        toast.error(toCloudError(err).message)
      }
    },
    [file, onFileChanged]
  )
  /*
   * Панель закрыта по умолчанию: в зале герой — кадр, а не пустое обсуждение
   * на треть экрана. Открывается кнопкой или клавишей i; пока она открыта,
   * хром не прячется.
   */
  const [panel, setPanel] = useState<'info' | 'comments' | 'people' | null>(null)
  /*
   * Панель не исчезает, а УЕЗЖАЕТ. leaving держит её смонтированной (и грид
   * трёхколоночным) на время выездной анимации: ящик задвигается обратно под
   * корешок, и только потом сцена расширяется. Раньше закрытие было мгновенным
   * схлопыванием — единственная непроанимированная смена состояния вьюера.
   */
  const [leaving, setLeaving] = useState<'info' | 'comments' | 'people' | null>(null)
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const withPanel = Boolean(panel || leaving)
  /*
   * Плавное открытие/закрытие ящика для СЦЕНЫ. Грид-колонки не анимируются
   * принципиально (замерено: перевписывание снимка на каждом кадре — до
   * 117мс/кадр), поэтому FLIP: раскладка меняется мгновенно, а рельса
   * стартует из СТАРОЙ геометрии (сдвиг центра и отношение вписанных
   * масштабов, посчитанные из ширин руками) и доезжает трансформом по
   * композитору. Ленте и стрелке «вперёд» — тот же сдвиг без масштаба.
   */
  const prevStageW = useRef<number | null>(null)
  useLayoutEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    const w2 = stage.clientWidth
    const w1 = prevStageW.current
    prevStageW.current = w2
    if (w1 === null || w1 === w2) return
    const f = file
    const dx = (w1 - w2) / 2
    const H = stage.clientHeight - gutterRef.current
    let scale = 1
    if (f?.width && f?.height && H > 0) {
      const k1 = Math.min(w1 / f.width, H / f.height)
      const k2 = Math.min(w2 / f.width, H / f.height)
      if (k2 > 0) scale = k1 / k2
    }
    const opts = { duration: 340, easing: 'cubic-bezier(.22, .61, .36, 1)' }
    railRef.current?.animate(
      [{ transform: `translateX(${dx}px) scale(${scale})` }, { transform: 'none' }],
      opts
    )
    stage.querySelector('.cl-strip')?.animate(
      [{ transform: `translateX(${dx}px)` }, { transform: 'none' }],
      opts
    )
    stage.querySelector('.cl-viewer-nav.next')?.animate(
      [{ transform: `translate(${w1 - w2}px, -50%)` }, { transform: 'translate(0, -50%)' }],
      opts
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [withPanel])

  const togglePanel = useCallback((which: 'info' | 'comments' | 'people') => {
    setPanel((cur) => {
      if (cur === which) {
        setLeaving(which)
        if (leaveTimer.current) clearTimeout(leaveTimer.current)
        // Страховка: если animationend потеряется, панель всё равно уйдёт.
        leaveTimer.current = setTimeout(() => setLeaving(null), 420)
        return null
      }
      setLeaving(null)
      return which
    })
  }, [])
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
  const gutterRef = useRef(104)

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
    const maxY = Math.max(0, (fit.h * v.zoom - (stage.clientHeight - gutterRef.current)) / 2)
    v.x = clamp(v.x, -maxX, maxX)
    v.y = clamp(v.y, -maxY, maxY)
  }, [])

  /** Пересчитать размер вписанного снимка: нужен и для зажима, и для 100%. */
  const measureFit = useCallback(() => {
    const stage = stageRef.current
    if (!stage || !file) return
    // Гаттер перечитывается здесь: measureFit дёргается и наблюдателем размера,
    // и сменой кадра — ровно те моменты, когда медиазапрос мог переключиться.
    gutterRef.current = gutterOf(stage)
    const boxW = stage.clientWidth
    const boxH = stage.clientHeight - gutterRef.current
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
      } else if (key === 'r' || e.code === 'KeyR') {
        if (!readOnly) void rotate(e.shiftKey ? 'ccw' : 'cw')
      } else if (key === 'i' || e.code === 'KeyI') {
        togglePanel('info')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [go, requestClose, file, readOnly, wake, setZoom, rotate])

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

  /*
   * «Над снимком» — над САМИМ изображением с учётом зума и панорамы, а не над
   * контейнером во всю сцену. Общая точка правды для колеса, курсора и клика.
   */
  const isOverMedia = useCallback((clientX: number, clientY: number) => {
    const media = mediaRef.current
    const fit = fitRef.current
    if (!media || !(fit.w > 0)) return false
    /*
     * Прямоугольник медиа-контейнера УЖЕ включает пан и зум — applyView вешает
     * transform на него самого. Центр берём из rect как есть (прибавлять
     * view.x/y сверху значило бы учесть панораму дважды), а размер снимка —
     * вписанный × зум: сам кадр внутри контейнера отрисован contain-ом.
     */
    const r = media.getBoundingClientRect()
    const cx = r.left + r.width / 2
    const cy = r.top + r.height / 2
    const halfW = (fit.w * view.current.zoom) / 2
    const halfH = (fit.h * view.current.zoom) / 2
    return clientX >= cx - halfW && clientX <= cx + halfW && clientY >= cy - halfH && clientY <= cy + halfH
  }, [])

  // ── Колесо: внутри кадра масштаб, снаружи листание ──────────────────────
  const navAccum = useRef(0)
  const navAt = useRef(0)
  /** Когда колесо в последний раз было занято зумом — см. шлюз тишины ниже. */
  const wheelZoomAt = useRef(0)
  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      wake()
      const deltaPx =
        e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * window.innerHeight : e.deltaY

      lastMouse.current = { x: e.clientX, y: e.clientY }
      // Рядом с фото колесо всегда листает: вверх назад, вниз вперёд.
      const inside = isOverMedia(e.clientX, e.clientY)

      const now = performance.now()

      /*
       * Уменьшение на уже вписанном кадре отдаём листанию: иначе жест на
       * снимке, который и так помещается целиком, ощущается мёртвым.
       */
      const zoomable = inside && !(view.current.zoom <= 1.001 && deltaPx > 0)
      if (zoomable) {
        wheelZoomAt.current = now
        const factor = clamp(Math.exp(-deltaPx * 0.00075), 0.85, 1.18)
        const box = stage.getBoundingClientRect()
        setZoom(view.current.zoom * factor, {
          x: e.clientX - box.left - box.width / 2,
          y: e.clientY - box.top - (box.height - gutterRef.current) / 2,
        })
        return
      }

      /*
       * ШЛЮЗ ТИШИНЫ — развязка зума и листания на одном колесе.
       *
       * Отдаляешь снимок колесом вниз, зум доезжает до вписанного — и тот же
       * непрерывный жест тут же перелистывал на следующий кадр. Модификаторы
       * (Ctrl) неудобны, поэтому решает пауза: пока жест отдаления продолжается,
       * кадр у упора глотает колесо; каждый проглоченный тик продлевает
       * тишину — инерция трекпада тоже не пролистнёт. Отпустил колесо на
       * полсекунды — следующий скролл уже осознанное листание. Вне кадра шлюз
       * не действует: там колесо всегда листает.
       */
      if (inside && deltaPx > 0 && now - wheelZoomAt.current < 450) {
        wheelZoomAt.current = now
        return
      }

      /*
       * Накопитель с порогом и кулдауном: один жест трекпада не должен
       * пролистывать пять кадров. Резинки-«надвига» больше нет: она давала
       * ненужный мелкий сдвиг на первом щелчке колеса, а при недоборе порога
       * ещё и оставляла кадр смещённым — обратной анимации у неё не было.
       * Обратная связь теперь — сам проезд слотов.
       */
      if (Math.sign(deltaPx) !== Math.sign(navAccum.current)) navAccum.current = 0
      navAccum.current += deltaPx
      if (now - navAt.current < 260) return
      if (Math.abs(navAccum.current) < 90) return
      navAt.current = now
      const dir = navAccum.current > 0 ? 1 : -1
      navAccum.current = 0
      go(dir)
    }
    stage.addEventListener('wheel', onWheel, { passive: false })
    return () => stage.removeEventListener('wheel', onWheel)
  }, [go, setZoom, wake, isOverMedia])

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
  /* Над снимком курсор — лупа, вне — ‹›-листалка: жест колеса виден заранее. */
  const [overMedia, setOverMedia] = useState(false)
  const lastPointerType = useRef('mouse')
  const lastMouse = useRef<{ x: number; y: number } | null>(null)

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    lastPointerType.current = e.pointerType
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
    lastMouse.current = { x: e.clientX, y: e.clientY }
    const over = isOverMedia(e.clientX, e.clientY)
    setOverMedia((prev) => (prev === over ? prev : over))
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
        // Та же длительность и кривая, что у проезда слотов: возврат рельсы и
        // переезд кадра складываются в одно непрерывное движение.
        rail.style.transition = 'transform .3s var(--cl-ease)'
        rail.style.transform = ''
        setTimeout(() => {
          if (railRef.current) railRef.current.style.transition = ''
        }, 320)
      }
      if (backdropRef.current) backdropRef.current.style.opacity = ''
      return
    }
    if (rail) rail.style.transform = ''
    if (backdropRef.current) backdropRef.current.style.opacity = ''
  }

  /*
   * Курсор пересчитывается и БЕЗ движения мыши: пролистнул колесом с кадра
   * 16:9 на 9:16 — точка под неподвижным курсором могла выйти из снимка (или
   * войти в него), и лупа обязана смениться листалкой сама. Считаем дважды:
   * сразу (грубо) и после того, как доехали проезд слотов и FLIP панели —
   * прямоугольник медиа во время анимаций ещё в пути.
   */
  useEffect(() => {
    const refresh = () => {
      const m = lastMouse.current
      if (!m) return
      const over = isOverMedia(m.x, m.y)
      setOverMedia((prev) => (prev === over ? prev : over))
    }
    const raf = requestAnimationFrame(refresh)
    // Ступени: середина проезда, сразу после (300мс слоты + запас), контрольная.
    const timers = [140, 420, 800].map((ms) => setTimeout(refresh, ms))
    return () => {
      cancelAnimationFrame(raf)
      timers.forEach(clearTimeout)
    }
  }, [index, zoomPct, withPanel, file?.width, isOverMedia])

  /*
   * Клик над снимком — только ВЫХОД из зума (увеличение по клику убрано по
   * просьбе). Клик МИМО снимка — закрытие просмотра: тёмное поле и есть
   * «подложка» оверлея. Правая кнопка закрывает откуда угодно — но только
   * мышиная: длинное нажатие пальцем не должно вышвыривать из просмотра.
   */
  const onStageClick = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement | null
    if (target?.tagName === 'VIDEO' || target?.tagName === 'AUDIO') return
    if (target?.closest('button, a, video, audio, .cl-viewer-panel, .cl-strip, .cl-viewer-top')) return
    if (drag.current?.moved) return
    if (!file) return
    if (!isOverMedia(e.clientX, e.clientY)) {
      requestClose()
      return
    }
    if (file.kind === 'IMAGE' && view.current.zoom > 1.001) setZoom(1)
  }

  const onStageContextMenu = (e: React.MouseEvent) => {
    if (lastPointerType.current === 'touch') return
    e.preventDefault()
    requestClose()
  }

  if (!file) return null
  // eslint-disable-next-line @typescript-eslint/no-unused-vars

  const stripFrom = Math.max(0, Math.min(index - Math.floor(STRIP_WINDOW / 2), files.length - STRIP_WINDOW))
  const strip = files.slice(Math.max(0, stripFrom), Math.max(0, stripFrom) + STRIP_WINDOW)
  const slots = [-1, 0, 1]
    .map((d) => ({ d, f: files[index + d] }))
    .filter((s): s is { d: number; f: CloudFile } => Boolean(s.f))

  return (
    <div
      className={`cl-viewer${withPanel ? ' with-panel' : ''}${closing ? ' is-closing' : ''}${idle ? ' is-idle' : ''}`}
      onPointerMove={wake}
    >
      <div className="cl-vbackdrop" ref={backdropRef} aria-hidden />
      {/* Зарево от самого снимка: тёмный зал, свет идёт от кадра. Берём
          миниатюру — она уже в кэше, ею только что нарисована плитка. */}
      {file.urls.thumb ? (
        <div className="cl-vglow" style={{ backgroundImage: `url(${file.urls.thumb})` }} aria-hidden />
      ) : null}

      <div
        className={`cl-viewer-stage${overMedia ? ' is-over-media' : ''}${zoomPct > 101 ? ' is-zoomed' : ''}`}
        ref={stageRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onClick={onStageClick}
        onContextMenu={onStageContextMenu}
      >
        <div className="cl-viewer-top">
          <button className="cl-vbtn" onClick={requestClose} aria-label="Закрыть" title="Закрыть (Esc)">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
          <div className="cl-viewer-title" title={file.name}>{file.name}</div>
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
                  {/* key: свой экземпляр на каждый кадр. Иначе состояние слоёв
                      переезжает с предыдущего снимка, и его приходится гасить
                      эффектом — а тот успевает затереть готовность, выставленную
                      колбэк-рефом в том же коммите. */}
                  <CurrentMedia
                    key={f.id}
                    file={f}
                    videoRef={videoRef}
                    zoomPct={zoomPct}
                    spin={spin}
                    spinScale={(() => {
                      /*
                       * Довёрнутый CSS-ом кадр ВПИСЫВАЕТСЯ в новую коробку, а
                       * не просто крутится на месте: отношение вписанных
                       * масштабов k(новые размеры)/k(транспонированные) и
                       * увеличивает горизонтальный кадр, ставший вертикальным,
                       * до полной высоты. До перепечки картинка растянута из
                       * старого превью — резкость вернёт подмена битмапа.
                       */
                      if (!(((spin % 360) + 360) % 360 % 180)) return 1
                      const st = stageRef.current
                      if (!st || !f.width || !f.height) return 1
                      const W = st.clientWidth
                      const H = st.clientHeight - gutterRef.current
                      const kNew = Math.min(W / f.width, H / f.height)
                      const kOld = Math.min(W / f.height, H / f.width)
                      return kOld > 0 ? kNew / kOld : 1
                    })()}
                  />
                </div>
              ) : (
                /* Соседям — РОВНО одна картинка. Три слоя качества на каждом
                   слоте это до сотни мегабайт декодированных битмапов. */
                <div className="cl-shot-media">
                  {f.urls.preview || f.urls.thumb ? (
                    <img
                      className="cl-layer"
                      src={f.urls.preview ?? f.urls.thumb ?? ''}
                      alt=""
                      draggable={false}
                      style={
                        (f.rotation - f.bakedRotation) % 360
                          ? { transform: `rotate(${(((f.rotation - f.bakedRotation) % 360) + 360) % 360}deg)` }
                          : undefined
                      }
                    />
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
            {/*
              Координаты ячеек — ГЛОБАЛЬНЫЕ (по номеру кадра в альбоме), а не
              оконные. Окно из тринадцати миниатюр пересчитывается на каждом
              шаге, и в оконных координатах left каждой выжившей ячейки прыгал
              на клетку БЕЗ перехода, а транс рельсы в середине альбома вовсе
              не менялся — лента щёлкала. В глобальных координатах ячейка
              прибита к своему кадру навсегда, а едет сама рельса — её
              transition уже существовал и просто не имел шанса сработать.
            */}
            <div
              className="cl-strip-rail"
              style={{ transform: `translate3d(${-index * CELL}px, 0, 0)` }}
            >
              {strip.map((f, i) => (
                <button
                  key={f.id}
                  className={`cl-strip-cell${stripFrom + i === index ? ' is-active' : ''}`}
                  style={{ left: (stripFrom + i) * CELL }}
                  onClick={() => go(stripFrom + i - index)}
                  title={f.name}
                >
                  {f.urls.thumb ? (
                    <img
                      src={f.urls.thumb}
                      alt=""
                      loading="lazy"
                      draggable={false}
                      style={
                        (f.rotation - f.bakedRotation) % 360
                          ? { transform: `rotate(${(((f.rotation - f.bakedRotation) % 360) + 360) % 360}deg)` }
                          : undefined
                      }
                    />
                  ) : null}
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </div>

      {panel || leaving ? (
        <aside
          className={`cl-viewer-panel${leaving ? ' is-leaving' : ''}`}
          onAnimationEnd={(e) => {
            if (leaving && (e.animationName === 'clPanelOut' || e.animationName === 'clSheetDown')) setLeaving(null)
          }}
        >
          <div className="cl-panel-head">
            <b>{(panel ?? leaving) === 'info' ? 'Сведения' : (panel ?? leaving) === 'people' ? 'Люди' : 'Обсуждение'}</b>
            <button onClick={() => togglePanel(panel ?? 'info')} aria-label="Закрыть панель">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
          </div>
          <div className={`cl-panel-body${(panel ?? leaving) === 'comments' ? ' is-talk' : ''}`}>
            {(panel ?? leaving) === 'people' ? (
              <FacesPanel
                faces={fileFaces}
                canEdit={!readOnly}
                onChanged={() => {
                  // Привязка растекается по всей библиотеке — кэш лиц целиком
                  // устарел, а не только текущий кадр.
                  facesCache.current.clear()
                  if (file) void loadFaces(file.id, true)
                }}
              />
            ) : (panel ?? leaving) === 'info' ? (
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

      {/*
        Корешок. Правая колонка существует ВСЕГДА — это несущая поверхность
        для кнопок и постоянная граница сцены, а панель — ящик, выезжающий
        влево ИЗ-ПОД него (панель z:1, корешок z:2 — метафору даёт уже
        существующий въезд clPanelIn). Кнопки стоят на полотне, а не висят
        над фотографией; счётчик и зум дают корешку содержание карточки.
      */}
      <aside className="cl-vspine">
        {/* Вертикальный прогресс альбома на левом ребре — виден даже в покое,
            когда корешок утончается до нити. Значение через переменную:
            десктоп рисует scaleY, мобильная планка — scaleX. */}
        <i
          className="cl-vprogress"
          style={{ ['--p' as string]: (index + 1) / Math.max(1, files.length) }}
          aria-hidden
        />
        <div className="cl-vspine-in">
          <button
            className={`cl-sp-tab${panel === 'info' ? ' is-on' : ''}`}
            onClick={() => togglePanel('info')}
            title="Сведения о кадре (i)"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <circle cx="12" cy="12" r="9" />
              <path d="M12 11v5.5" />
              <circle cx="12" cy="7.7" r="1.1" fill="currentColor" stroke="none" />
            </svg>
            <span>Инфо</span>
          </button>

          {!readOnly ? (
            <button
              className={`cl-sp-tab${panel === 'comments' ? ' is-on' : ''}`}
              onClick={() => togglePanel('comments')}
              title="Обсуждение кадра"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round">
                <path d="M20 12.4c0 3.9-3.6 7-8 7a9 9 0 0 1-2.4-.3L5 21l1.1-3.4A6.7 6.7 0 0 1 4 12.4c0-3.9 3.6-7 8-7s8 3.1 8 7Z" />
              </svg>
              <span>Комменты</span>
              {file.commentCount ? <i className="cl-sp-dot">{file.commentCount}</i> : null}
            </button>
          ) : null}

          {file.kind === 'IMAGE' ? (
            <button
              className={`cl-sp-tab${panel === 'people' ? ' is-on' : ''}`}
              onClick={() => togglePanel('people')}
              title={unknownFaces > 0 ? `Люди на кадре · неопознанных: ${unknownFaces}` : 'Люди на кадре'}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <circle cx="12" cy="8.6" r="3.6" />
                <path d="M5.2 19.4c1.1-3 3.7-4.6 6.8-4.6s5.7 1.6 6.8 4.6" />
              </svg>
              <span>Люди</span>
              {/* Бейдж зовёт, только пока есть кого опознавать. */}
              {unknownFaces > 0 ? <i className="cl-sp-dot is-alert">{unknownFaces}</i> : null}
            </button>
          ) : null}

          {!readOnly && (file.kind === 'IMAGE' || file.kind === 'VIDEO') ? (
            <button
              className="cl-sp-tab is-act"
              onClick={(e) => void rotate(e.shiftKey ? 'ccw' : 'cw')}
              title="Повернуть по часовой (R) · с Shift — против"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M20.5 9A8.6 8.6 0 0 0 12 3.5 8.5 8.5 0 1 0 20.5 12" />
                <path d="M20.5 3.5V9H15" />
              </svg>
              <span>Повернуть</span>
            </button>
          ) : null}

          {file.urls.download ? (
            <a
              className="cl-sp-tab is-dl"
              href={file.urls.download}
              download={file.name}
              draggable
              /*
               * Перетаскивание прямо в папку: DownloadURL — единственный способ
               * отдать системе имя, тип и адрес файла так, чтобы отпускание над
               * рабочим столом сохранило именно файл, а не ярлык на страницу.
               * Рядом кладём обычный адрес: тем, кто DownloadURL не понимает,
               * достанется хотя бы ссылка.
               */
              onDragStart={(e) => {
                const url = new URL(file.urls.download as string, window.location.origin).href
                e.dataTransfer.setData('DownloadURL', `${file.mime}:${file.name}:${url}`)
                e.dataTransfer.setData('text/uri-list', url)
                e.dataTransfer.setData('text/plain', url)
                e.dataTransfer.effectAllowed = 'copy'
              }}
              title="Скачать · можно перетащить в папку"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 4v10m0 0 4-4m-4 4-4-4M5 19h14" />
              </svg>
              <span>Скачать</span>
            </a>
          ) : null}

          <div className="cl-vspine-meta">
            {zoomPct !== 100 ? <span className="cl-sp-zoom">{zoomPct}%</span> : null}
            <span className="cl-sp-fact">{new Date(file.takenAt).toLocaleDateString('ru-RU')}</span>
            {file.geoCity ? (
              <span className="cl-sp-fact is-city" title={file.geoCity}>
                {file.geoCity}
              </span>
            ) : null}
            <div className="cl-vspine-count">
              <b>{index + 1}</b>
              <i />
              <span>{files.length}</span>
            </div>
          </div>
        </div>
      </aside>
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
  spin,
  spinScale,
}: {
  file: CloudFile
  videoRef: React.MutableRefObject<HTMLVideoElement | null>
  zoomPct: number
  /** Видимый CSS-поворот: у фото — до перепечки превью, у видео — всегда. */
  spin: number
  spinScale: number
}) {
  const [previewOn, setPreviewOn] = useState(false)
  const [fullOn, setFullOn] = useState(false)
  /*
   * Показанное превью «заморожено» вместе со своей запечённостью. Когда после
   * поворота приезжает перепечка, сервер меняет URL и previewRotation
   * ОДНОВРЕМЕННО, но новый битмап ещё не скачан — если снять CSS-доворот сразу,
   * кадр на время загрузки «отворачивается» обратно. Поэтому старый URL и его
   * угол живут, пока новый не декодирован, а контейнер докручивает разницу
   * previewRotation − shown.baked: в момент подмены суммарный угол не меняется.
   */
  const [shown, setShown] = useState(() => ({
    url: file.urls.preview ?? file.urls.content,
    baked: file.previewRotation,
  }))
  useEffect(() => {
    const next = file.urls.preview ?? file.urls.content
    if (!next || next === shown.url) return
    let dead = false
    const nextBaked = file.previewRotation
    const im = new Image()
    im.src = next
    const apply = () => {
      if (!dead) setShown({ url: next, baked: nextBaked })
    }
    void im.decode().then(apply, apply)
    return () => {
      dead = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file.urls.preview, file.urls.content, file.previewRotation])

  /*
   * Готовность слоя проверяем ДВУМЯ путями: событием и полем complete.
   *
   * Одного onLoad мало. Пролистывая колёсиком, человек идёт по кадрам,
   * которые только что стояли в соседних слотах, — их превью уже в кэше и
   * успевает догрузиться раньше, чем React повесит обработчик. Событие
   * теряется, слой навсегда остаётся прозрачным, и сверху видна размытая
   * миниатюра: «все фото мутные». Колбэк-реф срабатывает после вставки узла в
   * документ, и complete у кэшированной картинки там уже true.
   */
  const settle = (on: () => void) => (el: HTMLImageElement | null) => {
    if (el?.complete && el.naturalWidth > 0) on()
  }

  if (file.kind === 'IMAGE') {
    /*
     * Слой полного разрешения — всегда НЕповёрнутый оригинал (оригиналы не
     * перепекаются никогда), поэтому у повёрнутого кадра его не монтируем:
     * иначе при зуме поверх правильного превью проявлялся бы кадр в старой
     * ориентации. Зум остаётся на превью 2048px — этого достаточно.
     */
    const wantFull =
      zoomPct > 160 && Boolean(file.urls.content) && ((file.rotation % 360) + 360) % 360 === 0
    const total = spin + file.previewRotation - shown.baked
    const turning = ((total % 360) + 360) % 360 !== 0
    return (
      <div
        className={`cl-shot-layers${turning ? ' is-turning' : ''}`}
        style={turning || total ? { transform: `rotate(${total}deg) scale(${turning ? spinScale : 1})` } : undefined}
      >
        {file.urls.thumb ? <img className="cl-layer is-lq" src={file.urls.thumb} alt="" draggable={false} /> : null}
        {shown.url ? (
          <img
            className={`cl-layer${previewOn ? ' is-on' : ''}`}
            src={shown.url}
            alt={file.name}
            ref={settle(() => setPreviewOn(true))}
            onLoad={() => setPreviewOn(true)}
            draggable={false}
          />
        ) : null}
        {wantFull ? (
          <img
            className={`cl-layer${fullOn ? ' is-on' : ''}`}
            src={file.urls.content ?? ''}
            alt=""
            ref={settle(() => setFullOn(true))}
            onLoad={() => setFullOn(true)}
            draggable={false}
          />
        ) : null}
      </div>
    )
  }

  if (file.kind === 'VIDEO') {
    if (!file.urls.playback) return <VideoUnavailable file={file} />
    return <Player key={file.id} file={file} videoRef={videoRef} turn={((spin % 360) + 360) % 360} />
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
function Player({
  file,
  videoRef,
  turn = 0,
}: {
  file: CloudFile
  videoRef: React.MutableRefObject<HTMLVideoElement | null>
  /** Поворот потока: видео не перекодируется, элемент доворачивается CSS-ом. */
  turn?: number
}) {
  const ref = useRef<HTMLVideoElement | null>(null)
  const barRef = useRef<HTMLDivElement | null>(null)
  const hostRef = useRef<HTMLDivElement | null>(null)
  const frameRef = useRef<HTMLDivElement | null>(null)
  const [box, setBox] = useState<{ w: number; h: number } | null>(null)

  /*
   * Плавный доворот: раскладка применяется мгновенно (коробка и размеры уже
   * конечные), а рамка стартует довёрнутой НАЗАД на шаг и раскручивается в
   * ноль — FLIP на композиторе, без прерываний и без анимации layout-свойств.
   * Раньше видео просто щёлкало в новую ориентацию.
   */
  const prevTurnRef = useRef<number | null>(null)
  useLayoutEffect(() => {
    const prev = prevTurnRef.current
    prevTurnRef.current = turn
    const el = frameRef.current
    if (prev === null || prev === turn || !el || !el.animate) return
    let delta = turn - prev
    // Кратчайшая дуга: 270 → 0 крутится через −90, а не через +270.
    if (delta > 180) delta -= 360
    if (delta < -180) delta += 360
    el.animate(
      [{ transform: `rotate(${-delta}deg)` }, { transform: 'rotate(0deg)' }],
      { duration: 380, easing: 'cubic-bezier(.22, .61, .36, 1)' }
    )
  }, [turn])
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
    <div
      ref={hostRef}
      className={`cl-player${playing ? '' : ' is-paused'}${turn % 180 !== 0 ? ' is-turned' : turn ? ' is-flipped' : ''}`}
    >
      <div ref={frameRef} className="cl-player-frame" style={box ? { width: box.w, height: box.h } : undefined}>
      <video
        ref={attach}
        src={file.urls.playback ?? undefined}
        poster={file.urls.poster ?? undefined}
        /*
         * Кадровая коробка уже посчитана из ДИСПЛЕЙНЫХ размеров (при нечётном
         * повороте они переставлены на сервере). Сам элемент при нечётном угле
         * рисуется в транспонированных КОНТЕЙНЕРНЫХ единицах рамки (100cqh на
         * 100cqw, см. CSS): пиксели из box ломались в полноэкранном режиме —
         * рамка растягивалась на монитор, а видео оставалось оконного размера.
         * Постер крутится вместе с элементом, двойного поворота нет.
         */
        style={turn ? ({ ['--cl-turn' as string]: `${turn}deg` } as React.CSSProperties) : undefined}
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
  const visible = comments.filter((c) => !c.deletedAt)

  const grow = (el: HTMLTextAreaElement | null) => {
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(150, el.scrollHeight)}px`
  }

  return (
    <div className="cl-talk">
      <div className="cl-talk-list">
        {loading ? (
          <div className="cl-talk-empty">
            <span className="cl-talk-wait" />
          </div>
        ) : visible.length === 0 ? (
          <div className="cl-talk-empty">
            <span className="cl-talk-mark">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round">
                <path d="M20 12.4c0 3.9-3.6 7-8 7a9 9 0 0 1-2.4-.3L5 21l1.1-3.4A6.7 6.7 0 0 1 4 12.4c0-3.9 3.6-7 8-7s8 3.1 8 7Z" />
              </svg>
            </span>
            <b>Пока тихо</b>
            <span>{canComment ? 'Напишите первым — остальные увидят сразу.' : 'Здесь появятся комментарии.'}</span>
          </div>
        ) : (
          visible.map((comment) => {
            const mine = Boolean(meId && comment.author?.id === meId)
            const parent = comment.parentCommentId ? byId.get(comment.parentCommentId) : null
            const name = comment.author?.displayName || comment.author?.username || 'Кто-то'
            return (
              <article className={`cl-talk-item${mine ? ' is-mine' : ''}`} key={comment.id}>
                <Avatar user={comment.author} />
                <div className="cl-talk-main">
                  <div className="cl-talk-head">
                    <b>{name}</b>
                    <time title={new Date(comment.createdAt).toLocaleString('ru-RU')}>{ago(comment.createdAt)}</time>
                    {comment.editedAt ? <i>изменено</i> : null}
                  </div>

                  <div className="cl-talk-bubble">
                    {parent ? (
                      <div className="cl-talk-quote">
                        <b>{parent.author?.displayName || parent.author?.username || 'Кто-то'}</b>
                        {parent.body?.slice(0, 90)}
                      </div>
                    ) : null}
                    {comment.videoTimestampMs !== null && onSeek ? (
                      <button className="cl-ts-chip" onClick={() => onSeek(comment.videoTimestampMs as number)}>
                        <svg viewBox="0 0 24 24" fill="currentColor">
                          <path d="M8 5.6v12.8c0 .9 1 1.4 1.7.9l9.3-6.4a1.1 1.1 0 0 0 0-1.8L9.7 4.7A1.1 1.1 0 0 0 8 5.6Z" />
                        </svg>
                        {formatDuration(comment.videoTimestampMs)}
                      </button>
                    ) : null}
                    {editing === comment.id ? (
                      <EditBox
                        initial={comment.body ?? ''}
                        onCancel={() => setEditing(null)}
                        onSave={(v) => void saveEdit(comment.id, v)}
                      />
                    ) : (
                      /* Текст рендерится как текстовый узел — никакого dangerouslySetInnerHTML. */
                      <p>{comment.body}</p>
                    )}
                  </div>

                  <div className="cl-talk-foot">
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
                      <span className="cl-talk-acts">
                        <button onClick={() => void toggleReaction(comment, '👍')} title="Отметить">
                          👍
                        </button>
                        <button onClick={() => setReplyTo(comment)}>Ответить</button>
                        {/*
                          Права ровно те же, что на сервере: править — только свой
                          текст, удалять — свой или любой, если ты владелец хуяпки.
                          Раньше кнопки висели у каждого комментария и приводили
                          к 403 «Можно править только свои комментарии» — интерфейс
                          обещал то, чего не мог.
                        */}
                        {mine ? <button onClick={() => setEditing(comment.id)}>Изменить</button> : null}
                        {mine || isOwner ? (
                          <button className="is-danger" onClick={() => void remove(comment.id)}>
                            Удалить
                          </button>
                        ) : null}
                      </span>
                    ) : null}
                  </div>
                </div>
              </article>
            )
          })
        )}
      </div>

      {canComment ? (
        <div className="cl-talk-compose">
          {replyTo ? (
            <div className="cl-talk-replyto">
              <span>
                <b>{replyTo.author?.displayName || replyTo.author?.username || 'Кто-то'}</b>
                {replyTo.body?.slice(0, 70)}
              </span>
              <button onClick={() => setReplyTo(null)} aria-label="Не отвечать">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
              </button>
            </div>
          ) : null}

          <div className="cl-talk-field">
            <textarea
              rows={1}
              placeholder="Написать комментарий…"
              value={text}
              ref={grow}
              onChange={(e) => {
                setText(e.target.value)
                grow(e.target)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void submit()
              }}
            />
            <button
              className="cl-talk-send"
              onClick={() => void submit()}
              disabled={!text.trim() || sending}
              aria-label="Отправить"
              title="Отправить (Ctrl+Enter)"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round">
                <path d="M4.5 12 20 4.6 15.6 20l-3.7-5.6L4.5 12Z" />
              </svg>
            </button>
          </div>

          {onSeek ? (
            <button
              type="button"
              className={`cl-talk-ts${withTimestamp ? ' is-on' : ''}`}
              onClick={() => setWithTimestamp((v) => !v)}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <circle cx="12" cy="12" r="8.5" />
                <path d="M12 7.6V12l3 1.8" />
              </svg>
              привязать к {formatDuration(currentTimeMs())}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

/**
 * «5 минут назад» вместо «24.08.2026, 22:24:29».
 *
 * В ленте обсуждения важна свежесть, а не протокольная точность: полная дата
 * читается дольше, чем сам комментарий. Точное время остаётся в подсказке.
 */
function ago(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  const min = Math.floor(ms / 60000)
  if (min < 1) return 'только что'
  if (min < 60) return `${min} мин назад`
  const hours = Math.floor(min / 60)
  if (hours < 24) return `${hours} ч назад`
  const days = Math.floor(hours / 24)
  if (days === 1) return 'вчера'
  if (days < 7) return `${days} дн назад`
  return new Date(iso).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' })
}

function EditBox({ initial, onSave, onCancel }: { initial: string; onSave: (v: string) => void; onCancel: () => void }) {
  const [value, setValue] = useState(initial)
  return (
    <div className="cl-talk-edit">
      <textarea
        value={value}
        autoFocus
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onCancel()
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && value.trim()) onSave(value.trim())
        }}
      />
      <div className="cl-talk-edit-acts">
        <button className="cl-talk-save" onClick={() => onSave(value.trim())} disabled={!value.trim()}>
          Сохранить
        </button>
        <button onClick={onCancel}>Отмена</button>
      </div>
    </div>
  )
}
