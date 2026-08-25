import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useOutletContext, useParams, useSearchParams } from 'react-router-dom'
import { cloudApi, formatBytes, formatEta, roleLabel, toCloudError } from '../api'
import type { CloudActivity, CloudFile, CloudFolder, CloudSpace, PresenceEntry } from '../types'
import { joinSpaceRoom, onCloudEvent } from '../realtime'
import {
  enqueueFiles,
  parseUploadRefs,
  pauseAll,
  resumeAll,
  useSpaceUploads,
  useSpaceUploadsBusy,
  useUploadStore,
  useUploadSummary,
} from '../uploads/manager'
import { UploadTile } from '../components/UploadTile'
import { TimelineView, Tiles } from '../components/Gallery'
import { GeoRail, type GeoPosition, type GeoSegment } from '../components/GeoRail'
import { useDragSelect, type PaintMode } from '../components/dragSelect'
import { Viewer } from '../components/Viewer'
import { MapView } from '../components/MapView'
import { TimelineRail, type RailPosition, type TimelineDay } from '../components/TimelineRail'
import { ShareDialog } from '../components/ShareDialog'
import { Avatar, Empty, Modal, SkeletonTiles, useInfiniteSentinel, useHideOnScrollDown, toast } from '../components/ui'
import type { CloudContext } from './CloudLayout'

type View = 'timeline' | 'files' | 'map' | 'activity'

/** Столько id уходит в один запрос: совпадает с лимитом валидации на сервере. */
const BATCH = 1000

/** Главный экран Space: галерея, файлы, карта, активность — и всё это realtime. */
export default function SpacePage() {
  const { spaceId = '' } = useParams()
  const { me } = useOutletContext<CloudContext>()
  const [params, setParams] = useSearchParams()
  const view = (params.get('view') as View) || 'timeline'
  const folderId = params.get('folder')

  const [space, setSpace] = useState<CloudSpace | null>(null)
  const [presence, setPresence] = useState<PresenceEntry[]>([])
  const [files, setFiles] = useState<CloudFile[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  /** Зеркало курсора для async-цикла прыжка по рельсе. */
  const cursorRef = useRef<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [selection, setSelection] = useState<Set<string>>(new Set())
  /*
   * Просмотрщик держится за ID файла, а не за индекс.
   *
   * Индекс — производная от массива: приход cloud.file.created вставлял файл в
   * середину (порядок takenAt asc), и открытый кадр молча подменялся соседним;
   * удаление сдвигало всё на единицу; фоновое обновление списка вообще
   * закрывало просмотрщик. По id этого не происходит.
   */
  const [viewerFileId, setViewerFileId] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const [shareOpen, setShareOpen] = useState(false)
  const [kindFilter, setKindFilter] = useState<'' | 'IMAGE' | 'VIDEO' | 'DOCUMENT'>('')
  const [onlyFavorites, setOnlyFavorites] = useState(false)
  // Прячем шапку только при движении вниз — см. useHideOnScrollDown.
  const headHidden = useHideOnScrollDown()
  /** Отрезки поездки для правой рельсы: где человек был, в порядке ленты. */
  const [segments, setSegments] = useState<GeoSegment[]>([])
  const [withoutPlace, setWithoutPlace] = useState(0)
  const [geoPos, setGeoPos] = useState<GeoPosition>({ run: -1, fraction: 0 })

  /** Счётчики по дням для рельсы: весь срез, не только загруженные страницы. */
  const [dayCounts, setDayCounts] = useState<TimelineDay[]>([])
  /** Где читатель: день у верхней кромки и доля пройденного внутри его
   *  группы — дробь делает заливку рельсы непрерывной. */
  const [railPos, setRailPos] = useState<RailPosition>({ day: null, fraction: 0 })
  /*
   * Обмер шапки. Меряем ДВА узла: всю шапку и «полосу» — нижний ряд, который
   * единственный остаётся на экране в свёрнутом виде. Разница даёт ход
   * складывания, а видимая высота идёт в --cl-rail-off, от которого зависят
   * липкая дата и рельса таймлайна.
   *
   * Сравнение перед setState обязательно: наблюдатель висит на липкой шапке, а
   * перерисовывается страница с сотнями плиток — без него протяжка края окна
   * гнала бы полный рендер на каждое срабатывание.
   */
  const [metrics, setMetrics] = useState({ h: 0, band: 0 })
  const headRef = useRef<HTMLDivElement | null>(null)
  const bandRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const el = headRef.current
    const band = bandRef.current
    if (!el || !band) return
    const measure = () => {
      const next = { h: el.offsetHeight, band: band.offsetTop }
      setMetrics((prev) => (prev.h === next.h && prev.band === next.band ? prev : next))
    }
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    ro.observe(band)
    measure()
    return () => ro.disconnect()
  }, [space !== null])

  /** На сколько шапка уезжает вверх, оставляя полосу под верхней панелью. */
  const headShift = Math.max(0, metrics.band - 8)
  /** Сколько шапки реально видно — ровно это и есть отступ для даты и рельсы. */
  const visibleHeadH = headHidden ? Math.max(0, metrics.h - headShift) : metrics.h
  const visibleHeadRef = useRef(0)
  visibleHeadRef.current = visibleHeadH
  const metricsRef = useRef(metrics)
  metricsRef.current = metrics
  const shiftRef = useRef(0)
  shiftRef.current = headShift
  const anchorRef = useRef<string | null>(null)
  const fileInput = useRef<HTMLInputElement | null>(null)
  const dirInput = useRef<HTMLInputElement | null>(null)

  // Только id и дата: список стабилен, пока не изменился состав очереди, поэтому
  // тик прогресса не перерисовывает страницу целиком.
  const uploadRefs = useSpaceUploads(spaceId)
  const uploads = useMemo(() => parseUploadRefs(uploadRefs), [uploadRefs])

  const viewerIndex = useMemo(
    () => (viewerFileId ? files.findIndex((f) => f.id === viewerFileId) : -1),
    [viewerFileId, files]
  )

  /*
   * Срез — единственное описание того, «что сейчас на экране»: вкладка, папка,
   * фильтр вида, поиск, избранное. Из него собирается и запрос списка, и запрос
   * «Выбрать все», и предикат для realtime. Пока эти три места жили порознь,
   * пришедший по сокету файл попадал в галерею мимо действующего фильтра.
   */
  const slice = useMemo(
    () => ({
      spaceId,
      view: onlyFavorites ? ('favorites' as const) : view === 'files' ? ('files' as const) : ('timeline' as const),
      ...(view === 'files' && !onlyFavorites ? { folderId: folderId ?? 'root' } : {}),
      ...(kindFilter ? { kind: kindFilter } : {}),
    }),
    [spaceId, view, folderId, kindFilter, onlyFavorites]
  )
  const sliceKey = useMemo(() => JSON.stringify(slice), [slice])

  /*
   * Ссылки, читаемые из колбэков и обработчиков сокета. Присваиваем прямо в
   * теле: к моменту, когда прилетит ответ или событие, здесь уже лежит то, что
   * человек видит, а не то, что было на момент создания замыкания.
   */
  const sliceKeyRef = useRef(sliceKey)
  sliceKeyRef.current = sliceKey
  const sliceRef = useRef({ view, folderId, kindFilter, onlyFavorites })
  sliceRef.current = { view, folderId, kindFilter, onlyFavorites }
  const filesRef = useRef(files)
  filesRef.current = files
  /** Порядковый номер запроса списка: применяем только самый свежий. */
  const reqSeq = useRef(0)

  /*
   * Рельса живёт только в таймлайне И только на широком экране. На узком она
   * спрятана CSS-ом, но конвейер иначе молотил бы вхолостую: трекер позиции
   * мерил секции на каждом кадре скролла, агрегат /files/timeline грузился —
   * всё ради элемента, который на телефоне невозможно увидеть.
   */
  const [railWide, setRailWide] = useState(() => window.matchMedia('(min-width: 861px)').matches)
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 861px)')
    const on = () => setRailWide(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  const showRail = railWide && view === 'timeline'
  const canEdit = space?.role === 'OWNER' || space?.role === 'EDITOR'
  const isOwner = space?.role === 'OWNER'

  // ── Загрузка данных ──────────────────────────────────────────────────────
  const loadSpace = useCallback(async () => {
    try {
      const { data } = await cloudApi.get<{ space: CloudSpace; presence: PresenceEntry[] }>(`/spaces/${spaceId}`)
      setSpace(data.space)
      setPresence(data.presence)
    } catch (err) {
      toast.error(toCloudError(err).message)
    }
  }, [spaceId])

  /**
   * mode:
   *   replace — первая страница, список пересобирается (смена фильтров);
   *   append  — следующая страница по курсору;
   *   merge   — фоновое обновление: подмешиваем свежие файлы, НЕ трогая
   *             курсор, скролл и уже загруженные страницы. Прежний код звал
   *             replace каждые 10 секунд во время заливки: список схлопывался
   *             до первой страницы, скролл прыгал, а открытый просмотрщик
   *             закрывался.
   */
  const loadFiles = useCallback(
    async (
      nextCursor: string | null,
      mode: 'replace' | 'append' | 'merge' = nextCursor ? 'append' : 'replace'
    ): Promise<{ files: CloudFile[]; nextCursor: string | null } | null> => {
      // merge подмешивает, а не заменяет, и seq не проверяет — потому не должен
      // его и сжигать: тик фонового merge иначе обрывал летящий append
      // (страницу прыжка по рельсе или сентинела) как «устаревший».
      const seq = mode === 'merge' ? reqSeq.current : ++reqSeq.current
      try {
        const { data } = await cloudApi.get<{ files: CloudFile[]; nextCursor: string | null }>('/files', {
          params: { ...slice, limit: 80, ...(nextCursor ? { cursor: nextCursor } : {}) },
        })
        /*
         * Ответ мог опоздать. Два случая, и оба на экране выглядели одинаково
         * скверно: человек переключил фильтр, пока летел ответ по прошлому
         * (в галерее оказывались чужие файлы), либо два быстрых набора в поиске
         * вернулись не в том порядке (список показывал предыдущий запрос).
         */
        if (sliceKeyRef.current !== sliceKey) return null
        if (mode !== 'merge' && seq !== reqSeq.current) return null
        // Дедуп по id обязателен: файл мог уже прилететь realtime-событием, и
        // тогда страница пагинации привозит его второй раз. Именно из-за этого
        // «Выбрать все» насчитывало больше файлов, чем есть в хуяпке.
        setFiles((prev) => {
          if (mode === 'replace') return data.files
          if (mode === 'append') {
            const seen = new Set(prev.map((f) => f.id))
            return [...prev, ...data.files.filter((f) => !seen.has(f.id))]
          }
          // merge: обновляем известные, новые вставляем на своё место в хронологии
          const byId = new Map(prev.map((f) => [f.id, f]))
          let next = prev
          for (const incoming of data.files) {
            if (byId.has(incoming.id)) {
              next = next.map((f) => (f.id === incoming.id ? { ...f, ...incoming } : f))
            } else {
              next = insertByTakenAt(next, incoming)
            }
          }
          return next
        })
        // Курсор при merge не трогаем: иначе подгрузка следующих страниц
        // сбрасывалась бы на первую при каждом фоновом обновлении.
        if (mode !== 'merge') {
          setCursor(data.nextCursor)
          cursorRef.current = data.nextCursor
        }
        return { files: data.files, nextCursor: data.nextCursor }
      } catch (err) {
        if (sliceKeyRef.current !== sliceKey) return null
        toast.error(toCloudError(err).message)
        return null
      } finally {
        // Скелет снимает только актуальный запрос: иначе устаревший ответ гасил
        // загрузку нового среза и на миг показывал «ничего не найдено».
        if (sliceKeyRef.current === sliceKey && (mode === 'merge' || seq === reqSeq.current)) setLoading(false)
      }
    },
    [slice, sliceKey]
  )

  useEffect(() => {
    void loadSpace()
  }, [loadSpace])

  /*
   * Один сброс на все смены среза. Выделение, сделанное в одной папке или под
   * одним фильтром, переживало переход в другую — и «Удалить» отправляло в
   * корзину файлы, которых человек уже не видел на экране.
   */
  useEffect(() => {
    setSelection(new Set())
    setViewerFileId(null)
    anchorRef.current = null
    // Курсор — тоже часть среза. Пока он сбрасывался только ответом replace,
    // клик по рельсе в окне перезагрузки запускал догрузку с курсором СТАРОГО
    // среза и приклеивал к списку страницу чужого фильтра из середины альбома.
    setCursor(null)
    cursorRef.current = null
  }, [sliceKey])

  useEffect(() => {
    setRailPos({ day: null, fraction: 0 })
  }, [spaceId])

  useEffect(() => {
    if (view === 'map' || view === 'activity') return
    setLoading(true)
    const t = setTimeout(() => void loadFiles(null), 0)
    return () => clearTimeout(t)
  }, [loadFiles, view])

  /** Агрегат для рельсы. Не критичен: не построился — рельса просто не рисуется. */
  const loadDayCounts = useCallback(async () => {
    if (view !== 'timeline' || !railWide) return
    try {
      const { data } = await cloudApi.get<{ days: TimelineDay[] }>('/files/timeline', {
        params: {
          spaceId,
          view: onlyFavorites ? 'favorites' : 'timeline',
          ...(kindFilter ? { kind: kindFilter } : {}),
          tz: -new Date().getTimezoneOffset(),
        },
      })
      setDayCounts(data.days)
    } catch {
      setDayCounts([])
    }
  }, [spaceId, view, kindFilter, onlyFavorites, railWide])

  useEffect(() => {
    const t = setTimeout(() => void loadDayCounts(), 0)
    return () => clearTimeout(t)
  }, [loadDayCounts])

  const loadSegments = useCallback(async () => {
    if (view !== 'timeline' || !railWide) return
    try {
      const { data } = await cloudApi.get<{ places: GeoSegment[]; withoutPlace: number }>('/files/places', {
        params: { spaceId, view: onlyFavorites ? 'favorites' : 'places', ...(kindFilter ? { kind: kindFilter } : {}) },
      })
      setSegments(data.places)
      setWithoutPlace(data.withoutPlace)
    } catch {
      setSegments([])
      setWithoutPlace(0)
    }
  }, [spaceId, view, kindFilter, onlyFavorites, railWide])

  useEffect(() => {
    void loadSegments()
  }, [loadSegments])

  /*
   * Бегунок правой рельсы: какой отрезок поездки сейчас под линией отсчёта.
   *
   * Плитка под точкой берётся через elementFromPoint — это одно обращение на
   * кадр вместо обхода сотен плиток. Номер отрезка плитки проставляет
   * раскладка ленты (data-run), нумерация совпадает с серверной, потому что
   * порядок один и тот же.
   */
  useEffect(() => {
    if (view !== 'timeline' || !railWide) return
    const root = document.querySelector<HTMLElement>('.cl-root')
    if (!root) return
    let raf = 0
    const measure = () => {
      raf = 0
      const main = document.querySelector<HTMLElement>('.cl-tl-main')
      if (!main) return
      const box = main.getBoundingClientRect()
      /*
       * Точку щупаем ниже видимой шапки и берём ВЕСЬ стек элементов под ней:
       * поверх плиток лежат липкие слои (заголовок дня, шапка), и одиночный
       * elementFromPoint возвращал именно их, а не снимок.
       */
      /*
       * Щупаем СЕТКУ точек, а не одну.
       *
       * Одна точка регулярно попадала в промежуток: по вертикали — между
       * рядами, по горизонтали — в зазор между колонками. На ширине 1440
       * центр колонки приходился ровно между снимками, и трекер выходил
       * впустую на КАЖДОМ кадре — фокус не двигался вообще, сколько ни
       * прокручивай. Зазор всего восемь пикселей, поэтому трёх позиций по
       * ширине заведомо достаточно; обычно срабатывает первая же проба.
       */
      /*
       * Низ списка проверяем ПЕРВЫМ делом, до всякого щупа: там прокручивать
       * больше нечего, и рельса обязана дойти до конца независимо от того,
       * попал щуп в плитку или нет. Раньше проверка стояла после щупа, и на
       * последних днях с одним снимком геолайн замирал на предыдущем месте.
       */
      if (root.scrollTop >= root.scrollHeight - root.clientHeight - 2) {
        const tiles = main.querySelectorAll<HTMLElement>('[data-run]')
        const lastRun = Number(tiles[tiles.length - 1]?.dataset.run)
        if (Number.isFinite(lastRun)) {
          setGeoPos((prev) => (prev.run === lastRun && prev.fraction === 1 ? prev : { run: lastRun, fraction: 1 }))
          return
        }
      }

      const probeY = 60 + visibleHeadRef.current + 30
      let tile: HTMLElement | null = null
      /*
       * Крайняя левая позиция обязательна: в день с одним-двумя снимками
       * плитки жмутся к левому краю, а пробы по центру и правее уходили в
       * пустоту — трекер не находил ничего и фокус застревал.
       */
      outer: for (const dy of [0, 46, 96, 150]) {
        for (const fx of [0.06, 0.5, 0.28, 0.72]) {
          const stack = document.elementsFromPoint(box.left + box.width * fx, probeY + dy) as HTMLElement[]
          for (const el of stack) {
            const hit = el.closest<HTMLElement>('[data-run]')
            if (hit) {
              tile = hit
              break outer
            }
          }
        }
      }
      const run = tile ? Number(tile.dataset.run) : NaN
      if (!Number.isFinite(run)) return
      // Доля пройденного внутри отрезка — по его крайним плиткам в разметке.
      const same = main.querySelectorAll<HTMLElement>(`[data-run="${run}"]`)
      let fraction = 0
      if (same.length > 0) {
        const top = same[0]!.getBoundingClientRect().top
        const bottom = same[same.length - 1]!.getBoundingClientRect().bottom
        fraction = Math.max(0, Math.min(1, (probeY - top) / Math.max(1, bottom - top)))
      }
      setGeoPos((prev) =>
        prev.run === run && Math.abs(prev.fraction - fraction) < 0.004 ? prev : { run, fraction }
      )
    }
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(measure)
    }
    root.addEventListener('scroll', onScroll, { passive: true })
    measure()
    return () => {
      root.removeEventListener('scroll', onScroll)
      if (raf) cancelAnimationFrame(raf)
    }
  }, [view, railWide, files])

  /**
   * Прыжок к отрезку поездки: первая его плитка встаёт под панель.
   *
   * Место может быть дальше загруженного — тогда тянем страницы, как это
   * делает прыжок по дате. Без этого клик по дальней станции молча не делал
   * ничего: половина кликов «срабатывала», половина нет, и разница была
   * ровно в том, докрутил ли человек до неё раньше.
   */
  const jumpToRun = useCallback(
    async (run: number) => {
      const root = document.querySelector<HTMLElement>('.cl-root')
      if (!root) return
      const startKey = sliceKeyRef.current
      const expired = () => !aliveRef.current || sliceKeyRef.current !== startKey
      const find = () => document.querySelector<HTMLElement>(`.cl-tl-main [data-run="${run}"][data-geo="1"]`)
      const go = () => {
        const tile = find()
        if (!tile) return false
        const base = tile.getBoundingClientRect().top - root.getBoundingClientRect().top + root.scrollTop
        const goingUp = base - HEADER_OFFSET < root.scrollTop
        const land = goingUp ? metricsRef.current.h : Math.max(0, metricsRef.current.h - shiftRef.current)
        // Подсветка — по приезде, см. jumpToDay.
        // Без добавочного сдвига: цель должна вставать ровно туда же, куда её
        // ставит прыжок по дате, иначе она уезжает ниже линии отсчёта и
        // бегунок показывает предыдущее место.
        smoothScrollTo(root, base - HEADER_OFFSET - land, (finished) => {
          if (finished && !expired()) {
            flashGroup(`.cl-tl-main [data-run="${CSS.escape(String(run))}"][data-geo="1"]`)
          }
        })
        return true
      }
      if (go()) return
      if (!cursorRef.current || jumpingRef.current) return
      jumpingRef.current = true
      try {
        let c: string | null = cursorRef.current
        for (let i = 0; c && i < 200; i++) {
          const batch = await loadFiles(c, 'append')
          if (!batch || expired()) return
          c = batch.nextCursor
          // Ждём кадр СЛЕДУЮЩЕГО отрезка: остановка на первом же кадре нужного
          // означала бы, что остаток предыдущего места ещё не приехал.
          if (find()) break
        }
        requestAnimationFrame(() => {
          if (!expired()) go()
        })
      } finally {
        jumpingRef.current = false
      }
    },
    [loadFiles]
  )

  /*
   * Бегунок рельсы. Ищем последнюю группу дня, чей верх уже ушёл под липкую
   * панель, и заодно считаем, насколько эта группа пройдена: без дробной части
   * полоска дёргалась бы скачками от даты к дате, а не отражала прокрутку.
   * Один rAF на кадр, слушатель пассивный — на плавность скролла не влияет.
   */
  useEffect(() => {
    if (view !== 'timeline' || !railWide) return
    const root = document.querySelector<HTMLElement>('.cl-root')
    if (!root) return
    let raf = 0
    const measure = () => {
      raf = 0
      const sections = Array.from(document.querySelectorAll<HTMLElement>('.cl-tl-main section[data-day]'))
      if (sections.length === 0) return
      let current: string | null = null
      let fraction = 0
      for (const el of sections) {
        const r = el.getBoundingClientRect()
        if (r.top > RAIL_ANCHOR) break
        current = el.dataset.day ?? null
        fraction = Math.max(0, Math.min(1, (RAIL_ANCHOR - r.top) / Math.max(1, r.height)))
      }
      /*
       * На самом дне списка текущий день — ПОСЛЕДНИЙ, а не тот, что попал под
       * линию отсчёта. Когда хвост альбома короче экрана, наверху оставались
       * мартовские снимки, и рельса замирала на них, пока внизу был уже август.
       */
      if (root.scrollTop >= root.scrollHeight - root.clientHeight - 2) {
        const last = sections[sections.length - 1]?.dataset.day ?? null
        setRailPos((prev) => (prev.day === last && prev.fraction === 1 ? prev : { day: last, fraction: 1 }))
        return
      }
      const day = current ?? sections[0]?.dataset.day ?? null
      setRailPos((prev) =>
        prev.day === day && Math.abs(prev.fraction - fraction) < 0.002 ? prev : { day, fraction }
      )
    }
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(measure)
    }
    root.addEventListener('scroll', onScroll, { passive: true })
    measure()
    return () => {
      root.removeEventListener('scroll', onScroll)
      if (raf) cancelAnimationFrame(raf)
    }
  }, [view, railWide, files])

  /**
   * Прыжок по рельсе: просто довозим страницу до нужного дня.
   *
   * День уже в списке — плавный скролл к его группе. Ещё не догружен — тянем
   * страницы пагинации, пока группа не появится, и едем к ней. Никаких
   * якорей «показывать с даты»: список всегда остаётся непрерывным, и над ним
   * не висит служебный чип, который нужно было отдельно понимать и сбрасывать.
   */
  const jumpingRef = useRef(false)
  const aliveRef = useRef(true)
  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  const jumpToDay = useCallback(
    async (day: string) => {
      /*
       * Вспышку зажигаем ПОСЛЕ приезда, а не по нажатию: прокрутка занимает до
       * секунды, и подсветка успевала отгореть по дороге — человек приезжал на
       * место уже к погасшему свету. Прерванную прокрутку не подсвечиваем
       * вовсе: если её остановили колесом, смотрят уже другое.
       */
      let flashed = false
      const flash = (finished: boolean) => {
        if (!finished || flashed) return
        flashed = true
        flashGroup(`.cl-tl-main section[data-day="${CSS.escape(day)}"] .cl-tile`)
      }
      const root = document.querySelector<HTMLElement>('.cl-root')
      // Срез на момент клика: любая его смена (фильтр, поиск, другая хуяпка)
      // делает и цикл догрузки, и посадку недействительными.
      const startKey = sliceKeyRef.current
      const expired = () =>
        !aliveRef.current || sliceKeyRef.current !== startKey || sliceRef.current.view !== 'timeline'
      const scrollToSection = (exactOnly: boolean, onDone?: (finished: boolean) => void) => {
        if (!root) return false
        const sections = Array.from(document.querySelectorAll<HTMLElement>('.cl-tl-main section[data-day]'))
        const target =
          sections.find((el) => el.dataset.day === day) ??
          // Ближайший следующий день съёмки — если в самом дне не снимали.
          (exactOnly ? undefined : sections.find((el) => (el.dataset.day ?? '') > day))
        if (!target) return false
        const base = target.getBoundingClientRect().top - root.getBoundingClientRect().top + root.scrollTop
        /*
         * Прыжок вверх закончится с ПОКАЗАННОЙ шапкой (движение вверх её
         * возвращает), и дата-прешапка встанет под ней — значит, и секцию надо
         * сажать ниже на её высоту. Вниз — шапка спрячется, хватает 62px.
         */
        /*
         * Шапка больше не исчезает целиком — свёрнутая оставляет полосу.
         * Поэтому вычитаем ВИДИМУЮ высоту того состояния, в котором прыжок
         * закончится: вверх — развёрнутая (движение вверх её раскрывает),
         * вниз — свёрнутая полоса.
         */
        const goingUp = base - HEADER_OFFSET < root.scrollTop
        const land = goingUp ? metricsRef.current.h : Math.max(0, metricsRef.current.h - shiftRef.current)
        const top = base - HEADER_OFFSET - land
        smoothScrollTo(root, top, onDone)
        return true
      }

      // Точная группа уже на месте — едем сразу. Приблизительную (следующий
      // день) принимаем только когда догружать больше нечего.
      if (scrollToSection(Boolean(cursorRef.current), flash)) return
      if (!cursorRef.current || jumpingRef.current) return

      jumpingRef.current = true
      try {
        let c: string | null = cursorRef.current
        // Грузим, пока не увидим день ПОЗЖЕ целевого (или конец альбома).
        // Остановка на первом же файле нужного дня коварна: последующая
        // догрузка вставляла остаток предыдущего дня ВЫШЕ цели, всё уезжало
        // вниз, и человек оказывался не на том дне, куда кликал.
        // Потолок — страховка от бесконечного цикла, не рабочий предел.
        for (let i = 0; c && i < 200; i++) {
          const batch = await loadFiles(c, 'append')
          // Смена среза, уход со страницы или в другую вкладку посреди цикла —
          // выходим: иначе догрузка молотила бы страницы на мёртвом экране.
          if (!batch || expired()) return
          c = batch.nextCursor
          if (batch.files.some((f) => dayKeyOf(new Date(f.takenAt)) > day)) break
        }
        // Секции рендерятся после коммита — целимся на следующий кадр. Посадку
        // проверяем ТОЛЬКО после естественного завершения анимации: пока она
        // едет, дрейф заведомо велик, а если человек перехватил скролл колесом,
        // возвращать его к цели против его же жеста нельзя.
        requestAnimationFrame(() => {
          if (expired()) return
          scrollToSection(false, (finished) => {
            flash(finished)
            if (!finished || expired() || !root) return
            const target = Array.from(
              document.querySelectorAll<HTMLElement>('.cl-tl-main section[data-day]')
            ).find((el) => (el.dataset.day ?? '') >= day)
            if (!target) return
            // Ожидаемая посадка — по фактически видимой высоте шапки.
            const expected = HEADER_OFFSET + visibleHeadRef.current
            const drift = Math.abs(target.getBoundingClientRect().top - expected)
            if (drift > 30) scrollToSection(false)
          })
        })
      } finally {
        jumpingRef.current = false
      }
    },
    [loadFiles]
  )

  // Счётчики «842 фото · 37 видео» пересчитываются пачкой, а не на каждый файл.
  const statsTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const scheduleStatsRefresh = useCallback(() => {
    if (statsTimer.current) return
    statsTimer.current = setTimeout(() => {
      statsTimer.current = null
      void loadSpace()
      void loadDayCounts()
    }, 4000)
  }, [loadSpace, loadDayCounts])
  useEffect(() => () => { if (statsTimer.current) clearTimeout(statsTimer.current) }, [])

  /*
   * Пока идёт заливка — периодически перечитываем список, и ещё раз сразу после
   * того, как очередь опустела.
   *
   * Realtime остаётся быстрым путём, но единственным быть не должен: одно
   * пропущенное событие оставляло пользователя с пустой галереей при том, что
   * файлы уже лежали на сервере — 464 файла в базе против «в хуяпке пока нет
   * файлов» на экране.
   */
  // Именно BUSY, а не «есть плитки»: пауза, ошибка и «нужен файл» ждут человека,
  // и держать из-за них десятисекундный опрос списка незачем.
  const uploadingNow = useSpaceUploadsBusy(spaceId)
  useEffect(() => {
    if (!uploadingNow || view === 'activity' || view === 'map') return
    const t = setInterval(() => {
      // Только при видимой вкладке: в фоне обновлять нечего и некому смотреть.
      if (document.visibilityState !== 'visible') return
      void loadFiles(null, 'merge')
      void loadSpace()
    }, 10_000)
    return () => clearInterval(t)
  }, [uploadingNow, view, loadFiles, loadSpace])

  const wasUploading = useRef(false)
  useEffect(() => {
    if (wasUploading.current && !uploadingNow) {
      void loadFiles(null, 'merge')
      void loadSpace()
      void loadDayCounts()
    }
    wasUploading.current = uploadingNow
  }, [uploadingNow, loadFiles, loadSpace, loadDayCounts])

  const sentinel = useInfiniteSentinel(() => {
    if (cursor && !loading) void loadFiles(cursor)
  }, Boolean(cursor))

  // ── Realtime ─────────────────────────────────────────────────────────────
  useEffect(() => {
    joinSpaceRoom(spaceId)
    const offs = [
      onCloudEvent('cloud.file.created', (p) => {
        const payload = p as { spaceId: string; file: CloudFile }
        if (payload.spaceId !== spaceId) return
        // Вставляем НА СВОЁ МЕСТО по времени съёмки, а не в начало списка:
        // таймлайн группирует по дням в порядке массива, и файл 2023 года,
        // приклеенный сверху, создавал вторую группу той же даты и выглядел
        // как «ничего не появилось».
        // Файл, не подходящий под текущий фильтр, в галерее не место: при
        // включённом «Видео» или поиске по имени свежая загрузка иначе
        // проваливалась в список мимо среза и путала счётчик выделения.
        if (!matchesSlice(payload.file, sliceRef.current)) return
        setFiles((prev) => (prev.some((f) => f.id === payload.file.id) ? prev : insertByTakenAt(prev, payload.file)))
        // НЕ дёргаем loadSpace() на каждый файл: при заливке пачки в 400+ штук
        // это 400 запросов с агрегацией по БД — именно они и подвешивали и
        // браузер, и сервер. Счётчики в шапке обновляем пачкой, с задержкой.
        scheduleStatsRefresh()
      }),
      onCloudEvent('cloud.file.ready', (p) => {
        const payload = p as { spaceId: string; file: CloudFile }
        if (payload.spaceId !== spaceId) return
        setFiles((prev) => prev.map((f) => (f.id === payload.file.id ? { ...f, ...payload.file } : f)))
      }),
      onCloudEvent('cloud.file.updated', (p) => {
        const payload = p as { file: CloudFile }
        setFiles((prev) => prev.map((f) => (f.id === payload.file.id ? { ...f, ...payload.file } : f)))
      }),
      onCloudEvent('cloud.file.deleted', (p) => {
        const payload = p as { spaceId: string; fileIds: string[] }
        if (payload.spaceId !== spaceId) return
        setFiles((prev) => prev.filter((f) => !payload.fileIds.includes(f.id)))
      }),
      onCloudEvent('cloud.presence.changed', (p) => {
        const payload = p as { spaceId: string; users: PresenceEntry[] }
        if (payload.spaceId === spaceId) setPresence(payload.users)
      }),
      onCloudEvent('cloud.member.joined', () => void loadSpace()),
      onCloudEvent('cloud.member.left', () => void loadSpace()),
    ]
    return () => {
      offs.forEach((off) => off())
      joinSpaceRoom(null)
    }
  }, [spaceId, loadSpace])

  // ── Drag & drop / вставка из буфера ──────────────────────────────────────
  useEffect(() => {
    if (!canEdit) return
    let depth = 0
    const onDragEnter = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes('Files')) return
      depth++
      setDragging(true)
    }
    const onDragOver = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes('Files')) e.preventDefault()
    }
    const onDragLeave = () => {
      depth = Math.max(0, depth - 1)
      if (depth === 0) setDragging(false)
    }
    const onDrop = async (e: DragEvent) => {
      e.preventDefault()
      depth = 0
      setDragging(false)
      const dropped = await collectFiles(e.dataTransfer)
      if (dropped.length) void enqueueFiles(dropped, { spaceId, spaceName: space?.name, folderId })
    }
    const onPaste = (e: ClipboardEvent) => {
      const items = Array.from(e.clipboardData?.files ?? [])
      if (items.length) void enqueueFiles(items, { spaceId, spaceName: space?.name, folderId })
    }
    window.addEventListener('dragenter', onDragEnter)
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('dragleave', onDragLeave)
    window.addEventListener('drop', onDrop)
    window.addEventListener('paste', onPaste)
    return () => {
      window.removeEventListener('dragenter', onDragEnter)
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('dragleave', onDragLeave)
      window.removeEventListener('drop', onDrop)
      window.removeEventListener('paste', onPaste)
    }
  }, [canEdit, spaceId, folderId, space?.name])

  const setView = (next: View) => {
    const p = new URLSearchParams(params)
    p.set('view', next)
    if (next !== 'files') p.delete('folder')
    setParams(p, { replace: true })
  }

  const onlineIds = useMemo(() => new Set(presence.map((p) => p.userId)), [presence])

  /**
   * Отметить файл; с Shift — весь диапазон от прошлой отметки.
   *
   * Колбэк обязан быть стабильным: плитка мемоизирована, и новая функция на
   * каждый рендер обесценивала memo — при 400+ файлах перерисовывалась вся
   * сетка. Поэтому список читаем через filesRef, а не из замыкания.
   */
  const toggleSelect = useCallback((id: string, shift = false) => {
    setSelection((prev) => {
      const next = new Set(prev)
      const anchor = anchorRef.current
      if (shift && anchor && anchor !== id) {
        const list = filesRef.current
        const from = list.findIndex((f) => f.id === anchor)
        const to = list.findIndex((f) => f.id === id)
        if (from >= 0 && to >= 0) {
          for (let i = Math.min(from, to); i <= Math.max(from, to); i++) next.add(list[i]!.id)
          return next
        }
      }
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
    anchorRef.current = id
  }, [])

  const openFile = useCallback((file: CloudFile) => setViewerFileId(file.id), [])

  /** Красим плитку под курсором при протяжке. Идемпотентно: одна и та же
   *  плитка приходит десятками событий подряд, и лишний setState тут не нужен. */
  const paintSelect = useCallback((id: string, mode: PaintMode) => {
    setSelection((prev) => {
      if (mode === 'add' ? prev.has(id) : !prev.has(id)) return prev
      const next = new Set(prev)
      if (mode === 'add') next.add(id)
      else next.delete(id)
      return next
    })
    /*
     * Якорь Shift-диапазона тут НЕ трогаем. Рамка красит все плитки кэша
     * подряд в порядке разметки, и якорь съезжал на последнюю подгруженную
     * плитку альбома: Shift+клик после рамки выделял пол-ленты. Якорь —
     * понятие клика, поэтому живёт только в toggleSelect.
     */
  }, [])
  useDragSelect({ enabled: selection.size > 0, onPaint: paintSelect })

  /**
   * «Выбрать все» — именно все файлы среза, а не подгруженная страница.
   *
   * Раньше кнопка звалась «Выбрать все», а брала только то, что успело
   * подгрузиться: на трёх тысячах файлов человек выбирал 80 и нажимал
   * «Удалить», будучи уверенным, что убрал всё.
   */
  const [selectingAll, setSelectingAll] = useState(false)
  const selectAllInSlice = async () => {
    setSelectingAll(true)
    try {
      const { data } = await cloudApi.get<{ ids: string[]; truncated: boolean }>('/files/ids', { params: slice })
      setSelection(new Set(data.ids))
      anchorRef.current = null
      if (data.truncated) toast.info(`Выбраны первые ${data.ids.length} файлов`)
    } catch (err) {
      toast.error(toCloudError(err).message)
    } finally {
      setSelectingAll(false)
    }
  }

  const deleteSelected = async () => {
    const ids = Array.from(selection)
    try {
      // Пачками: запрос на тысячи id упирался в лимит валидации, и удаление
      // молча не срабатывало («Нужен список ids»).
      for (let i = 0; i < ids.length; i += BATCH) {
        await cloudApi.post('/files/delete', { ids: ids.slice(i, i + BATCH) })
      }
      setFiles((prev) => prev.filter((f) => !selection.has(f.id)))
      setSelection(new Set())
      toast.success(ids.length > 1 ? `В корзину: ${ids.length}` : 'Перенесено в корзину')
      void loadSpace()
    } catch (err) {
      toast.error(toCloudError(err).message)
    }
  }

  /*
   * Архив по выделению собирается через талон.
   *
   * Скачивание — навигация (нужен Content-Disposition), то есть GET, а список
   * из тысяч id в строке запроса упирался в лимит nginx: «Скачать ZIP» на
   * большом выделении просто не работал, и вместо выбранного отдавалась вся
   * хуяпка целиком — совсем не то, что человек просил.
   */
  const [zipping, setZipping] = useState(false)
  const downloadSelected = async () => {
    const ids = Array.from(selection)
    setZipping(true)
    try {
      const { data } = await cloudApi.post<{ token: string; count: number }>('/files/zip/prepare', {
        spaceId,
        ids: ids.slice(0, 5000),
      })
      if (data.count < ids.length) toast.info(`В архив уйдут ${data.count} файлов из ${ids.length}`)
      window.location.href = `/api/cloud/files/zip?token=${encodeURIComponent(data.token)}`
    } catch (err) {
      toast.error(toCloudError(err).message)
    } finally {
      setZipping(false)
    }
  }

  if (!space) {
    return (
      <div className="cl-page">
        <div className="cl-skeleton" style={{ height: 96, marginBottom: 18 }} />
        <SkeletonTiles />
      </div>
    )
  }

  return (
    <div className={`cl-page${showRail ? ' with-rail' : ''}`}>
      {/*
        Рельса — САМОСТОЯТЕЛЬНАЯ колонка страницы, рядом с шапкой, а не под ней.
        Пока она жила внутри ветки таймлайна, липкая шапка (z-index 30) была её
        соседом сверху и на всю ширину: при прокрутке вверх шапка возвращалась
        и накрывала верхние станции — таймлайн выглядел обрезанным.
      */}
      <div
        className={`cl-tl-layout${showRail ? ' with-rail' : ''}`}
        style={{ ['--cl-rail-off' as string]: `${visibleHeadH}px` }}
      >
        {showRail ? <TimelineRail days={dayCounts} position={railPos} onJump={jumpToDay} /> : null}
        <div className="cl-tl-main">
      {/*
        Шапка и фильтры — единый липкий блок, который прячется при прокрутке
        вниз и возвращается при малейшем движении вверх. Так и контент не
        зажат, и «Выбрать всё», поиск и фильтры всегда в одном движении, а не
        через прокрутку в самый верх.
      */}
      {/*
        Шапка-полоса. При прокрутке вниз она не исчезает, а СКЛАДЫВАЕТСЯ: верхний
        «отворот» (титул, описание, цифры) уезжает под верхнюю панель, а нижняя
        полоса с вкладками, фильтрами и действиями остаётся на экране. Раньше
        шапка пряталась целиком, и чтобы сменить фильтр, приходилось мотать в
        самый верх альбома.
      */}
      <div
        ref={headRef}
        className={`cl-space-head cl-ed${headHidden ? ' is-compact' : ''}`}
        style={{ ['--cl-head-shift' as string]: `${headShift}px` }}
      >
        <div className="cl-head-fold">
          <div className="cl-ed-eyebrow">
            <span className="cl-ed-kicker">Хуяпка</span>
            <i className="cl-ed-rule" />
            <span className="cl-ed-issue">
              {space.members.length} {plural(space.members.length, 'участник', 'участника', 'участников')}
            </span>
          </div>

          <div className="cl-ed-grid">
            <div className="cl-ed-lede">
              <h1 className="cl-h1 cl-ed-title">{space.name}</h1>
              {space.description ? <p className="cl-ed-dek">{space.description}</p> : null}
            </div>

            {/*
              Цифры — главный графический элемент полосы. key по значению
              перезапускает набегание: счётчик оживает при заливке сам собой.
            */}
            {space.stats ? (
              <div className="cl-ed-figs">
                <Figure label="Фото" value={space.stats.photos} />
                {space.stats.videos > 0 ? <Figure label="Видео" value={space.stats.videos} /> : null}
                {space.stats.others > 0 ? <Figure label="Файлы" value={space.stats.others} /> : null}
                <Figure label="Объём" accent value={formatBytes(space.stats.bytes)} />
              </div>
            ) : null}
          </div>

          {/*
            Слот постоянной высоты: полоска заливки приходит НА МЕСТО подписи, а
            не добавляется рядом. Иначе старт загрузки менял высоту шапки, и
            дата с рельсой уезжали анимацией ровно в тот момент, когда процессор
            занят хешированием и отправкой.
          */}
          <div className="cl-ed-slot">{uploads.length > 0 ? <SpaceUploadBar /> : <SpaceByline space={space} onlineIds={onlineIds} />}</div>
        </div>

        {/* ── Полоса: живёт в обоих состояниях ────────────────────────────── */}
        <div ref={bandRef} className="cl-head-band">
          <div className="cl-band-who">
            <div className="cl-ava-stack">
              {space.members.slice(0, 4).map((m, i) => (
                <span className="cl-ed-ava" key={m.id} style={{ ['--i' as string]: i }}>
                  <Avatar user={m} online={onlineIds.has(m.id)} />
                </span>
              ))}
            </div>
            <span className="cl-band-title">{space.name}</span>
          </div>

          {/*
            Сегмент без единого замера: колонки равной ширины, пилюля шириной в
            одну колонку и сдвигом на индекс. Никаких offsetLeft, а значит и
            промаха на первом кадре, пока не доехал шрифт.
          */}
          <div
            className="cl-seg"
            style={{ ['--seg-n' as string]: 4, ['--seg-i' as string]: ['timeline', 'files', 'map', 'activity'].indexOf(view) }}
          >
            <i className="cl-seg-pill" aria-hidden />
            {(['timeline', 'files', 'map', 'activity'] as View[]).map((v) => (
              <button key={v} className={`cl-seg-btn${view === v ? ' is-active' : ''}`} onClick={() => setView(v)}>
                {v === 'timeline' ? 'Таймлайн' : v === 'files' ? 'Файлы' : v === 'map' ? 'Карта' : 'Активность'}
              </button>
            ))}
          </div>

          <div className="cl-spacer" />

          {view !== 'activity' && view !== 'map' ? (
            <div className="cl-chips cl-ed-filters">
              {([['', 'Все'], ['IMAGE', 'Фото'], ['VIDEO', 'Видео'], ['DOCUMENT', 'Документы']] as const).map(([value, label]) => (
                <button
                  key={label}
                  className={`cl-chip${kindFilter === value ? ' is-active' : ''}`}
                  onClick={() => setKindFilter(value as typeof kindFilter)}
                >
                  {label}
                </button>
              ))}
              <button className={`cl-chip${onlyFavorites ? ' is-active' : ''}`} onClick={() => setOnlyFavorites((v) => !v)}>
                ★ Избранное
              </button>
            </div>
          ) : null}

          {/*
            Действия переехали в полосу и потому доступны в обоих состояниях —
            это и есть место, освободившееся от поиска. Второстепенные стали
            иконками с подписью для скринридера.
          */}
          <div className="cl-band-acts">
            {canEdit ? (
              <>
                <button className="cl-btn primary sm cl-act-main" onClick={() => fileInput.current?.click()}>
                  <span aria-hidden>↑</span> Загрузить
                </button>
                <button className="cl-btn sm icon" onClick={() => dirInput.current?.click()} title="Загрузить папку целиком" aria-label="Загрузить папку">
                  ⊞
                </button>
              </>
            ) : null}
            {isOwner ? (
              <button className="cl-btn sm icon" onClick={() => setShareOpen(true)} title="Поделиться" aria-label="Поделиться">
                ↗
              </button>
            ) : null}
            <a
              className="cl-btn sm icon"
              href={`/api/cloud/files/zip?spaceId=${encodeURIComponent(spaceId)}&all=1`}
              title="Скачать всё"
              aria-label="Скачать всё"
            >
              ↓
            </a>
          </div>
        </div>
      </div>

      {/* ── Содержимое ──────────────────────────────────────────────────── */}
      {view === 'activity' ? (
        <ActivityView spaceId={spaceId} />
      ) : view === 'map' ? (
        <MapView
          spaceId={spaceId}
          tileUrl={me.map.tileUrl}
          attribution={me.map.attribution}
          onOpen={(fileId) => {
            // Файл может быть вне загруженной страницы — тогда подтянем его
            // отдельно и вставим в хронологию, не ломая порядок.
            if (files.some((f) => f.id === fileId)) setViewerFileId(fileId)
            else void openSingle(fileId, setFiles, setViewerFileId)
          }}
        />
      ) : view === 'files' ? (
        /*
         * «Файлы» — ВЫШЕ проверок загрузки и пустоты.
         *
         * Раньше пустая папка отдавала общий экран «В хуяпке пока нет файлов»
         * вместо файлового браузера: хлебные крошки и кнопка «+ Папка»
         * исчезали, и из пустой папки нельзя было ни создать вложенную, ни
         * вернуться в корень иначе как правкой адреса.
         */
        <FilesBrowser
          spaceId={spaceId}
          folderId={folderId}
          files={files}
          uploads={uploads}
          selection={selection}
          canEdit={canEdit}
          loading={loading}
          onNavigate={(id) => {
            const p = new URLSearchParams(params)
            p.set('view', 'files')
            if (id) p.set('folder', id)
            else p.delete('folder')
            setParams(p, { replace: true })
          }}
          onOpen={openFile}
          onToggleSelect={toggleSelect}
        />
      ) : loading ? (
        <SkeletonTiles />
      ) : files.length === 0 && uploads.length === 0 ? (
        <Empty
          icon="📷"
          title={kindFilter || onlyFavorites ? 'Ничего не найдено' : 'В хуяпке пока нет файлов'}
          text={
            kindFilter || onlyFavorites
              ? 'Попробуйте изменить фильтры.'
              : canEdit
                ? 'Перетащите сюда фотографии и видео или нажмите «Загрузить». Порядок в таймлайне строится по времени съёмки, а не по времени загрузки.'
                : 'Владелец ещё ничего не загрузил.'
          }
          action={
            canEdit ? (
              <button className="cl-btn primary" onClick={() => fileInput.current?.click()}>
                Загрузить файлы
              </button>
            ) : null
          }
        />
      ) : (
        <>
          <TimelineView
            files={files}
            uploads={uploads}
            selection={selection}
            selectMode={selection.size > 0}
            onOpen={openFile}
            onToggleSelect={toggleSelect}
          />
        </>
      )}

      {/* Один наблюдатель на все режимы: раньше он жил внутри ветки таймлайна,
          и в «Файлах» подгрузка не работала вовсе. */}
      {view !== 'activity' && view !== 'map' ? <div ref={sentinel} /> : null}
      {cursor && !loading ? (
        <div style={{ textAlign: 'center', marginTop: 18 }}>
          <button className="cl-btn" onClick={() => void loadFiles(cursor, 'append')}>
            Показать ещё
          </button>
        </div>
      ) : null}
        </div>
        {/* Правая колонка — зеркало левой: слева видно КОГДА, справа ГДЕ. */}
        {showRail ? <GeoRail segments={segments} withoutPlace={withoutPlace} position={geoPos} onJump={jumpToRun} /> : null}
      </div>

      {/* ── Панель выбора ───────────────────────────────────────────────── */}
      {selection.size > 0 ? (
        <div className="cl-selbar">
          <span>Выбрано: {selection.size}</span>
          <button className="cl-btn sm" onClick={() => setSelection(new Set(files.map((f) => f.id)))}>
            Всё на экране
          </button>
          {cursor ? (
            <button className="cl-btn sm" onClick={() => void selectAllInSlice()} disabled={selectingAll}>
              {selectingAll ? 'Выбираем…' : 'Выбрать все'}
            </button>
          ) : null}
          <button className="cl-btn sm" onClick={() => void downloadSelected()} disabled={zipping}>
            {zipping ? 'Собираем…' : 'Скачать ZIP'}
          </button>
          {isOwner ? (
            <button className="cl-btn sm" onClick={() => setShareOpen(true)}>
              Поделиться
            </button>
          ) : null}
          {canEdit ? (
            <button className="cl-btn danger sm" onClick={() => void deleteSelected()}>
              Удалить
            </button>
          ) : null}
          <button className="cl-btn ghost sm" onClick={() => setSelection(new Set())}>
            Снять
          </button>
        </div>
      ) : null}

      {dragging ? (
        <div className="cl-drop-overlay">
          <div>Хуяк — и в «{space.name}»</div>
        </div>
      ) : null}

      {viewerIndex >= 0 && files[viewerIndex] ? (
        <Viewer
          files={files}
          index={viewerIndex}
          spaceId={spaceId}
          hasMore={Boolean(cursor)}
          onNeedMore={() => {
            if (cursor && !loading) void loadFiles(cursor)
          }}
          canComment={space.role === 'OWNER' || space.role === 'EDITOR' || space.viewerCanComment}
          meId={me.user.id}
          isOwner={isOwner}
          onIndexChange={(next) => setViewerFileId(files[next]?.id ?? null)}
          onClose={() => setViewerFileId(null)}
          onFileChanged={(file) => setFiles((prev) => prev.map((f) => (f.id === file.id ? { ...f, ...file } : f)))}
        />
      ) : null}

      {shareOpen ? (
        <ShareDialog
          spaceId={spaceId}
          preselectedFileIds={selection.size > 0 ? Array.from(selection) : undefined}
          onClose={() => setShareOpen(false)}
        />
      ) : null}

      <input
        ref={fileInput}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          const picked = Array.from(e.target.files ?? [])
          e.target.value = ''
          if (picked.length) void enqueueFiles(picked, { spaceId, spaceName: space.name, folderId })
        }}
      />
      <input
        ref={dirInput}
        type="file"
        multiple
        hidden
        // @ts-expect-error нестандартный атрибут выбора каталога, поддержан всеми актуальными браузерами
        webkitdirectory=""
        onChange={(e) => {
          const picked = Array.from(e.target.files ?? [])
          e.target.value = ''
          if (picked.length) void enqueueFiles(picked, { spaceId, spaceName: space.name, folderId })
        }}
      />
    </div>
  )
}

/**
 * Подходит ли пришедший по сокету файл под то, что сейчас на экране.
 *
 * Избранное здесь всегда мимо: только что загруженный файл не может быть
 * отмечен звёздочкой, и подмешивать его в этот срез неправильно.
 */
function matchesSlice(
  file: CloudFile,
  s: { view: View; folderId: string | null; kindFilter: string; onlyFavorites: boolean }
): boolean {
  if (s.onlyFavorites) return false
  if (s.kindFilter && file.kind !== s.kindFilter) return false
  if (s.view === 'files' && (file.folderId ?? null) !== (s.folderId ?? null)) return false
  return true
}

/**
 * Подсветить разом все плитки подгруппы — вспышка с плавным угасанием.
 *
 * Правило вставляем ОДНОЙ строкой в служебный <style>, а не вешаем класс на
 * каждую плитку: в группе бывают сотни снимков, и перебор с перезапуском
 * анимации на каждом означал бы сотни принудительных пересчётов раскладки
 * ровно в момент прыжка. Здесь же — одна запись в CSSOM.
 */
const FLASH_MS = 1500
let flashTimer: ReturnType<typeof setTimeout> | null = null

function flashGroup(selector: string): void {
  let tag = document.getElementById('cl-flash') as HTMLStyleElement | null
  if (!tag) {
    tag = document.createElement('style')
    tag.id = 'cl-flash'
    document.head.appendChild(tag)
  }
  // Пустой шаг нужен, чтобы повторный клик по той же станции проиграл вспышку
  // заново: без смены правила анимация не перезапускается.
  tag.textContent = ''
  /*
   * Два правила разом: всё остальное гаснет, подгруппа остаётся в свету и
   * получает мягкое свечение наружу. Соседние плитки стоят вплотную, их ореолы
   * сливаются — и подсвеченной читается вся ОБЛАСТЬ, а не каждый снимок по
   * отдельности. Обводки внутри плитки для этого не хватало.
   */
  const rule =
    `.cl-tl-main .cl-tile { animation: clDim ${FLASH_MS}ms var(--cl-ease) both; }\n` +
    `${selector} { animation: clLit ${FLASH_MS}ms var(--cl-ease) both; }`
  requestAnimationFrame(() => {
    if (tag) tag.textContent = rule
  })
  if (flashTimer) clearTimeout(flashTimer)
  flashTimer = setTimeout(() => {
    if (tag) tag.textContent = ''
    flashTimer = null
  }, FLASH_MS + 120)
}

/** Куда сажаем цель прыжка: сразу под липкой панелью, с дыханием в пару px. */
const HEADER_OFFSET = 62

/** Линия отсчёта «где читатель»: сразу под верхней панелью. */
const RAIL_ANCHOR = 78

/**
 * Плавный скролл с явным easing.
 *
 * Не scrollIntoView({behavior:'smooth'}): его длительность и кривая зашиты в
 * браузер, на длинных дистанциях он дёргает почти мгновенно, на коротких —
 * тянет. Здесь easeInOutCubic и длительность от расстояния, а колесо или палец
 * пользователя мгновенно отменяют анимацию — управление всегда у человека.
 */
let cancelActiveScroll: (() => void) | null = null

/**
 * onDone(finished): true — анимация доехала сама; false — её перехватил
 * человек (колесо/палец) либо вытеснил новый прыжок. Проверка посадки после
 * прыжка опирается ровно на это: поправлять прицел можно только после
 * естественного финиша, отменённый жест пользователя священен.
 */
function smoothScrollTo(scroller: HTMLElement, targetTop: number, onDone?: (finished: boolean) => void) {
  // Два быстрых тапа по рельсе — две rAF-петли, дерущиеся за scrollTop с
  // видимым дрожанием. Новая анимация всегда сперва хоронит предыдущую.
  cancelActiveScroll?.()

  const from = scroller.scrollTop
  const to = Math.max(0, Math.min(targetTop, scroller.scrollHeight - scroller.clientHeight))
  const dist = to - from
  if (Math.abs(dist) < 2) {
    onDone?.(true)
    return
  }

  // Кому движение мешает физически — прыгаем сразу: CSS-блок
  // prefers-reduced-motion глушит переходы, но не rAF-петлю.
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    scroller.scrollTop = to
    onDone?.(true)
    return
  }

  const duration = Math.min(950, Math.max(420, Math.abs(dist) * 0.35))
  const start = performance.now()
  let raf = 0
  let settled = false
  const settle = (finished: boolean) => {
    if (settled) return
    settled = true
    cancelAnimationFrame(raf)
    scroller.removeEventListener('wheel', onUser)
    scroller.removeEventListener('touchstart', onUser)
    if (cancelActiveScroll === abort) cancelActiveScroll = null
    onDone?.(finished)
  }
  const onUser = () => settle(false)
  const abort = () => settle(false)
  cancelActiveScroll = abort
  scroller.addEventListener('wheel', onUser, { passive: true, once: true })
  scroller.addEventListener('touchstart', onUser, { passive: true, once: true })

  const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)
  const tick = (now: number) => {
    const t = Math.min(1, (now - start) / duration)
    scroller.scrollTop = from + dist * ease(t)
    if (t < 1) raf = requestAnimationFrame(tick)
    else settle(true)
  }
  raf = requestAnimationFrame(tick)
}

/** Русское склонение по числу: 1 участник, 2 участника, 5 участников. */
function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10
  const m100 = n % 100
  if (m10 === 1 && m100 !== 11) return one
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few
  return many
}

/**
 * Цифра-фигура: крупное число и капслок-подпись под ним.
 *
 * key по значению — не украшение: при заливке счётчик меняется, и React
 * пересоздаёт узел, из-за чего заново проигрывается набегание. Цифра оживает
 * ровно тогда, когда за ней что-то стоит.
 */
function Figure({ label, value, accent }: { label: string; value: number | string; accent?: boolean }) {
  const text = typeof value === 'number' ? String(value) : value
  return (
    <div className={`cl-ed-fig${accent ? ' is-accent' : ''}`}>
      <b key={text}>{text}</b>
      <span>{label}</span>
    </div>
  )
}

/** Строка авторства: кто в хуяпке. Живёт в слоте вместе с полоской заливки. */
function SpaceByline({ space, onlineIds }: { space: CloudSpace; onlineIds: Set<string> }) {
  return (
    <div className="cl-ed-by">
      <span className="cl-ed-by-names">
        {space.members.map((m) => m.displayName || m.username).join(' · ')}
      </span>
      {onlineIds.size > 0 ? <span className="cl-ed-by-online">{onlineIds.size} в сети</span> : null}
    </div>
  )
}

/** Локальный день YYYY-MM-DD — тем же календарём, что группы галереи. */
function dayKeyOf(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** Вставка с сохранением хронологии таймлайна (takenAt asc, затем id asc). */
function insertByTakenAt(list: CloudFile[], file: CloudFile): CloudFile[] {
  const at = new Date(file.takenAt).getTime()
  const idx = list.findIndex((f) => {
    const t = new Date(f.takenAt).getTime()
    return t > at || (t === at && f.id > file.id)
  })
  if (idx === -1) return [...list, file]
  return [...list.slice(0, idx), file, ...list.slice(idx)]
}

/**
 * Полоска загрузки в шапке хуяпки. Заменила плавающее окно в углу: сами файлы
 * видно плитками в галерее, здесь остаётся общий итог и пауза.
 */
function SpaceUploadBar() {
  const summary = useUploadSummary()
  const paused = useUploadStore((s) => s.paused)
  if (summary.active === 0 && summary.failed === 0) return null

  const percent = summary.totalBytes > 0 ? (summary.bytes / summary.totalBytes) * 100 : 0
  const eta = summary.speed > 1024 ? Math.max(0, summary.totalBytes - summary.bytes) / summary.speed : 0

  return (
    <div className="cl-upbar">
      <div className="cl-progress" style={{ flex: 1 }}>
        {/* Сдвиг, а не ширина: полоса не трогает layout — см. .cl-progress > i. */}
        <i style={{ transform: `translateX(${percent - 100}%)` }} />
      </div>
      <span className="cl-mono cl-muted" style={{ fontSize: 12.5, whiteSpace: 'nowrap' }}>
        {summary.done} из {summary.total}
        {summary.speed > 0 ? ` · ${formatBytes(summary.speed)}/с` : ''}
        {eta > 0 ? ` · ~${formatEta(eta)}` : ''}
        {summary.failed > 0 ? ` · ошибок ${summary.failed}` : ''}
      </span>
      <button className="cl-btn ghost sm" onClick={() => (paused ? resumeAll() : pauseAll())}>
        {paused ? 'Продолжить' : 'Пауза'}
      </button>
    </div>
  )
}

/**
 * Открыть файл, которого ещё нет в загруженной странице (клик по точке на карте).
 *
 * Раньше файл приклеивался в начало списка и открывался как индекс 0 — из-за
 * этого он вставал не на своё место в хронологии, а листание стрелками уводило
 * в соседей по случайному соседству, а не по времени съёмки.
 */
async function openSingle(
  fileId: string,
  setFiles: React.Dispatch<React.SetStateAction<CloudFile[]>>,
  setViewerFileId: (id: string | null) => void
) {
  try {
    const { data } = await cloudApi.get<{ file: CloudFile }>(`/files/${fileId}`)
    setFiles((prev) => insertByTakenAt(prev.filter((f) => f.id !== fileId), data.file))
    setViewerFileId(fileId)
  } catch {
    toast.error('Не удалось открыть файл')
  }
}

/** Рекурсивный обход перетащенных каталогов (там, где браузер это умеет). */
async function collectFiles(dt: DataTransfer | null): Promise<File[]> {
  if (!dt) return []
  const entries: FileSystemEntry[] = []
  for (const item of Array.from(dt.items ?? [])) {
    const entry = (item as DataTransferItem & { webkitGetAsEntry?: () => FileSystemEntry | null }).webkitGetAsEntry?.()
    if (entry) entries.push(entry)
  }
  if (entries.length === 0) return Array.from(dt.files ?? [])

  const out: File[] = []
  const walk = async (entry: FileSystemEntry, depth: number): Promise<void> => {
    if (depth > 12 || out.length > 2000) return
    if (entry.isFile) {
      const file = await new Promise<File | null>((resolve) =>
        (entry as FileSystemFileEntry).file(resolve, () => resolve(null))
      )
      if (file) out.push(file)
      return
    }
    if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader()
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((resolve) => reader.readEntries(resolve, () => resolve([])))
        if (batch.length === 0) break
        for (const child of batch) await walk(child, depth + 1)
      }
    }
  }
  for (const entry of entries) await walk(entry, 0)
  return out
}

// ── Файловый браузер с папками ───────────────────────────────────────────────

function FilesBrowser({
  spaceId,
  folderId,
  files,
  uploads,
  selection,
  canEdit,
  loading,
  onNavigate,
  onOpen,
  onToggleSelect,
}: {
  spaceId: string
  folderId: string | null
  files: CloudFile[]
  uploads: { id: string; at: number }[]
  selection: Set<string>
  canEdit: boolean
  loading: boolean
  onNavigate: (folderId: string | null) => void
  onOpen: (file: CloudFile) => void
  onToggleSelect: (id: string, shift: boolean) => void
}) {
  const [folders, setFolders] = useState<CloudFolder[]>([])
  const [breadcrumbs, setBreadcrumbs] = useState<{ id: string; name: string }[]>([])
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [savingFolder, setSavingFolder] = useState(false)

  const load = useCallback(async () => {
    try {
      const [foldersRes, crumbsRes] = await Promise.all([
        cloudApi.get<{ folders: CloudFolder[] }>('/folders', { params: { spaceId, parentId: folderId ?? 'root' } }),
        folderId
          ? cloudApi.get<{ breadcrumbs: { id: string; name: string }[] }>(`/folders/${folderId}/breadcrumbs`)
          : Promise.resolve({ data: { breadcrumbs: [] } }),
      ])
      setFolders(foldersRes.data.folders)
      setBreadcrumbs(crumbsRes.data.breadcrumbs)
    } catch (err) {
      toast.error(toCloudError(err).message)
    }
  }, [spaceId, folderId])

  useEffect(() => {
    void load()
  }, [load])

  const createFolder = async () => {
    // Дребезг: Enter в поле и клик по кнопке (или два быстрых Enter) создавали
    // папку дважды — сервер отвечал конфликтом имени на вторую.
    if (!newName.trim() || savingFolder) return
    setSavingFolder(true)
    try {
      await cloudApi.post('/folders', { spaceId, parentId: folderId, name: newName.trim() })
      setNewName('')
      setCreating(false)
      await load()
    } catch (err) {
      toast.error(toCloudError(err).message)
    } finally {
      setSavingFolder(false)
    }
  }

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
        <div className="cl-breadcrumbs">
          <button onClick={() => onNavigate(null)}>Корень</button>
          {breadcrumbs.map((crumb) => (
            <span key={crumb.id}>
              <span className="cl-muted">/</span>
              <button onClick={() => onNavigate(crumb.id)}>{crumb.name}</button>
            </span>
          ))}
        </div>
        <div className="cl-spacer" />
        {canEdit ? (
          <button className="cl-btn sm" onClick={() => setCreating(true)}>
            + Папка
          </button>
        ) : null}
      </div>

      {folders.length > 0 ? (
        <div className="cl-list" style={{ marginBottom: 16 }}>
          {folders.map((folder) => (
            <div className="cl-row" key={folder.id} onClick={() => onNavigate(folder.id)}>
              <div className="cl-row-thumb">📁</div>
              <div>
                <div className="cl-row-name">{folder.name}</div>
                <div className="cl-row-sub">
                  {folder.fileCount} файлов{folder.childCount ? `, ${folder.childCount} папок` : ''}
                </div>
              </div>
              <div className="cl-row-hide" />
              <div className="cl-row-hide" />
              <div />
            </div>
          ))}
        </div>
      ) : null}

      <div className="cl-tiles dense">
        {uploads.slice(0, 60).map((u) => (
          <UploadTile key={u.id} id={u.id} withPreview={false} />
        ))}
      </div>
      {loading ? (
        <SkeletonTiles />
      ) : files.length === 0 && uploads.length === 0 && folders.length === 0 ? (
        <Empty
          icon="📂"
          title="Папка пуста"
          text={canEdit ? 'Перетащите сюда файлы или создайте вложенную папку.' : 'Здесь пока ничего нет.'}
        />
      ) : (
        <Tiles
          files={files}
          selection={selection}
          selectMode={selection.size > 0}
          onOpen={onOpen}
          onToggleSelect={onToggleSelect}
          dense
        />
      )}

      {creating ? (
        <Modal
          title="Новая папка"
          onClose={() => setCreating(false)}
          footer={
            <>
              <button className="cl-btn ghost" onClick={() => setCreating(false)}>
                Отмена
              </button>
              <button className="cl-btn primary" onClick={() => void createFolder()} disabled={!newName.trim() || savingFolder}>
                {savingFolder ? 'Создаём…' : 'Создать'}
              </button>
            </>
          }
        >
          <input
            className="cl-input"
            autoFocus
            placeholder="Название папки"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void createFolder()}
          />
        </Modal>
      ) : null}
    </>
  )
}

// ── Лента активности ─────────────────────────────────────────────────────────

const ACTIVITY_TEXT: Record<string, (payload: Record<string, unknown>) => string> = {
  SPACE_CREATED: () => 'создал хуяпку',
  SPACE_UPDATED: () => 'изменил настройки хуяпки',
  MEMBER_ADDED: (p) => `добавил участника${p.name ? ` ${p.name}` : ''}`,
  MEMBER_REMOVED: (p) => (p.self ? 'вышел из хуяпки' : 'исключил участника'),
  MEMBER_ROLE_CHANGED: (p) => `изменил роль на «${roleLabel(String(p.role ?? ''))}»`,
  FILES_UPLOADED: (p) => `загрузил ${p.count ?? 1} файл(ов)`,
  FILES_DELETED: (p) => `удалил ${p.count ?? 1} файл(ов)`,
  FILES_RESTORED: (p) => `восстановил ${p.count ?? 1} файл(ов)`,
  FILES_SAVED: (p) => `сохранил к себе ${p.count ?? 1} файл(ов)`,
  FOLDER_CREATED: (p) => `создал папку «${p.name}»`,
  FOLDER_RENAMED: (p) => `переименовал папку в «${p.to}»`,
  FOLDER_DELETED: (p) => `удалил папку «${p.name}»`,
  COMMENT_CREATED: (p) => `оставил комментарий${p.preview ? `: «${String(p.preview).slice(0, 60)}»` : ''}`,
  SHARE_CREATED: () => 'создал публичную ссылку',
  SHARE_REVOKED: () => 'отозвал публичную ссылку',
}

function ActivityView({ spaceId }: { spaceId: string }) {
  const [events, setEvents] = useState<CloudActivity[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    cloudApi
      .get<{ events: CloudActivity[] }>('/activity', { params: { spaceId, limit: 100 } })
      .then(({ data }) => setEvents(data.events))
      .catch((err) => toast.error(toCloudError(err).message))
      .finally(() => setLoading(false))
  }, [spaceId])

  useEffect(() => {
    return onCloudEvent('cloud.activity.created', (p) => {
      const payload = p as { spaceId: string; event: CloudActivity }
      if (payload.spaceId !== spaceId) return
      setEvents((prev) => [payload.event, ...prev.filter((e) => e.id !== payload.event.id)])
    })
  }, [spaceId])

  if (loading) return <div className="cl-skeleton" style={{ height: 200 }} />
  if (events.length === 0) return <Empty title="Активности пока нет" text="Здесь появятся загрузки, комментарии и изменения состава." />

  return (
    <div className="cl-list" style={{ padding: '4px 16px' }}>
      {events.map((event) => (
        <div className="cl-activity-item" key={event.id}>
          <Avatar user={event.actor} />
          <div style={{ minWidth: 0, flex: 1 }}>
            <div>
              <strong>{event.actor?.displayName || event.actor?.username || 'Кто-то'}</strong>{' '}
              {(ACTIVITY_TEXT[event.type] ?? (() => event.type))((event.payload ?? {}) as Record<string, unknown>)}
            </div>
            <div className="cl-muted" style={{ fontSize: 12 }}>
              {new Date(event.createdAt).toLocaleString('ru-RU')}
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}
