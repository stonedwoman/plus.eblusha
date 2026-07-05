import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'

export type MsgRow = { mapIndex: number; key: string }

// ОКОННАЯ ВИРТУАЛИЗАЦИЯ. В DOM держим только ХВОСТ загруженного списка (окно):
//  - при открытии/у низа — последние BASE_WINDOW строк;
//  - при скролле вверх — расширяем окно из кэша по WINDOW_STEP (мгновенно, без сети);
//  - у низа — сжимаем обратно до BASE_WINDOW (старые строки выше вьюпорта — вне экрана).
// Двигаем ТОЛЬКО верхнюю (старую) границу и ТОЛЬКО вне экрана — в column-reverse это не
// двигает вьюпорт (низ якорится). Новейшие строки НИКОГДА не роняем (они между вьюпортом
// и якорем-низом → сдвинуло бы). Итог: тяжёлый проход (сбор deps + рендер + сверка мемо)
// = O(окно), а не O(весь чат) → нет подвисания при вставке страницы и ограничен DOM на годы.
const BASE_WINDOW = 150 // строк в DOM в покое (у низа)
const WINDOW_STEP = 60 // на сколько расширяем окно за один «дошёл до верха»

type MemoRowProps = { mapIndex: number; rowKey: string; deps: unknown[] | null; renderRow: (i: number) => ReactNode }
const MemoRow = memo(
  function MemoRow({ mapIndex, rowKey, renderRow }: MemoRowProps) {
    // Реальная высота (медиа зарезервировано через aspect-ratio) стабильна с первого кадра
    // → ничего не «распухает» поздно, скролл не дёргается. data-rowkey — якорь для reveal.
    return (
      <div className="msg-row" data-rowkey={rowKey} style={{ flex: '0 0 auto' }}>
        {renderRow(mapIndex)}
      </div>
    )
  },
  (a: MemoRowProps, b: MemoRowProps) => {
    if (a.deps === null || b.deps === null) return false // «сложная» строка — всегда рисуем
    const da = a.deps
    const db = b.deps
    if (da.length !== db.length) return false
    for (let i = 0; i < da.length; i++) if (!Object.is(da[i], db[i])) return false
    return true
  },
)

/**
 * Список сообщений: плоский рендер видимого ОКНА + column-reverse + построчная React.memo.
 * Высоты реальные (медиа зарезервировано aspect-ratio в ChatMessageRow) → скролл нативно
 * гладкий, ничего не распухает поздно. column-reverse якорит низ (вставка/сброс старых
 * сверху не двигает вьюпорт, iOS-прыжок при подгрузке решён нативно). overflow-anchor:none
 * (auto пере-корректировал при массовой догрузке превью). deps строятся ЛЕНИВО (buildDeps)
 * только для окна. Детект краёв — IntersectionObserver-сентинелы (без арифметики scrollTop).
 */
export function MessageListFlat(props: {
  rows: MsgRow[]
  renderRow: (mapIndex: number) => ReactNode
  buildDeps: (mapIndex: number) => unknown[] | null
  activeId: string | null
  /** наружу отдаём scroll-элемент (нужен LazyImage rootRef, visibleObserver и пр.) */
  scrollElRef: { current: HTMLDivElement | null }
  nearBottomRef: { current: boolean }
  onReachTop: () => void
  setShowJump: (v: boolean) => void
  /** императивный API: кнопка «вниз» + переход к цитате вне окна (раскрыть окно) */
  apiRef: { current: { scrollToBottom: (smooth?: boolean) => void; scrollToMessage?: (id: string) => void } | null }
}) {
  const { rows, renderRow, buildDeps, activeId, scrollElRef, nearBottomRef, onReachTop, setShowJump, apiRef } = props
  const parentRef = useRef<HTMLDivElement | null>(null)
  const bottomSentinelRef = useRef<HTMLDivElement | null>(null)
  const topSentinelRef = useRef<HTMLDivElement | null>(null)
  const topObsRef = useRef<IntersectionObserver | null>(null)

  // Верхняя граница окна = ключ самой СТАРОЙ рендеримой строки. null == «у низа» (последние
  // BASE_WINDOW). Низ окна — всегда конец списка (новейшие), поэтому новые сообщения окно
  // включает автоматически, а старые роняются только при сжатии у низа.
  const [oldestKey, setOldestKey] = useState<string | null>(null)

  const rowsRef = useRef(rows)
  rowsRef.current = rows
  const oldestKeyRef = useRef(oldestKey)
  oldestKeyRef.current = oldestKey
  const onReachTopRef = useRef(onReachTop)
  onReachTopRef.current = onReachTop
  const setShowJumpRef = useRef(setShowJump)
  setShowJumpRef.current = setShowJump
  const pendingRevealRef = useRef<string | null>(null)
  const [revealTick, setRevealTick] = useState(0)
  // true, пока верхний сентинел в зоне пересечения (близко к началу загруженного). Гейт для
  // сжатия окна: сжимаем только когда верх ВНЕ экрана — иначе роняемые строки могут быть видны.
  const topIntersectingRef = useRef(false)
  // Последний зафиксированный старт окна — безопасный откат, если ключ-граница (oldestKey)
  // исчезнет из rows (сообщение удалили / поглотил forward-бандл): без него startIndexFor
  // схлопнул бы окно до базы и швырнул вьюпорт вниз (C#1/C#2).
  const startIdxRef = useRef(0)

  // Индекс начала окна в полном списке. Ищем С КОНЦА (oldestKey у хвоста) → O(окно).
  const startIndexFor = (fr: MsgRow[], key: string | null): number => {
    if (key == null) return Math.max(0, fr.length - BASE_WINDOW)
    for (let i = fr.length - 1; i >= 0; i--) if (fr[i]?.key === key) return i
    // Ключ-граница исчез (удаление/бандл). НЕ схлопываем окно — это уронило бы строки,
    // которые сейчас читает пользователь, и швырнуло бы вьюпорт вниз. Держим НЕ МЕНЬШЕ строк,
    // чем в прошлом кадре (границу окно переустановит при следующем расширении/сжатии).
    return Math.min(startIdxRef.current, Math.max(0, fr.length - BASE_WINDOW))
  }
  const startIdx = startIndexFor(rows, oldestKey)
  const windowRows = startIdx > 0 ? rows.slice(startIdx) : rows
  // Фиксируем фактический старт окна для отката выше (startIndexFor при пропаже ключа).
  useLayoutEffect(() => {
    startIdxRef.current = startIdx
  })

  const scrollToBottom = useCallback((smooth?: boolean) => {
    const el = parentRef.current
    if (!el) return
    el.scrollTo({ top: 0, behavior: smooth ? 'smooth' : 'auto' })
    nearBottomRef.current = true
  }, [nearBottomRef])

  // Переход к цитируемому сообщению ВНЕ окна: раскрываем окно до него, затем скроллим.
  const scrollToMessage = useCallback((id: string) => {
    const fr = rowsRef.current
    const sid = String(id)
    // ключ строки вида '<prefix>:<id>' (msg:/system:/forward:/bundle:) → id после первого ':'
    let idx = -1
    for (let i = 0; i < fr.length; i++) {
      const k = fr[i]?.key
      if (k && k.slice(k.indexOf(':') + 1) === sid) { idx = i; break }
    }
    if (idx < 0) return // не в загруженном кэше — раскрыть нечего
    const curStart = startIndexFor(fr, oldestKeyRef.current)
    if (idx < curStart) {
      const nk = fr[Math.max(0, idx - 5)]?.key ?? null
      oldestKeyRef.current = nk
      setOldestKey(nk)
    }
    pendingRevealRef.current = fr[idx]?.key ?? null
    setRevealTick((t) => t + 1)
  }, [])

  // Отдаём наружу scroll-элемент и API; чистим при размонтировании.
  useEffect(() => {
    scrollElRef.current = parentRef.current
    apiRef.current = { scrollToBottom, scrollToMessage }
    return () => {
      scrollElRef.current = null
      apiRef.current = null
    }
  }, [scrollToBottom, scrollToMessage, scrollElRef, apiRef])

  // После раскрытия окна прокрутить к целевой строке (нода уже отрисована).
  useEffect(() => {
    const key = pendingRevealRef.current
    if (!key) return
    // ПОТРЕБЛЯЕМ сразу: иначе незакрытый reveal «выстрелил» бы на любой будущей смене oldestKey
    // (обычный скролл-расширение/сжатие) и швырнул бы вьюпорт к устаревшей цитате (P#1).
    pendingRevealRef.current = null
    const root = parentRef.current
    if (!root) return
    const sel = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(key) : key
    const go = () => {
      const el = root.querySelector(`[data-rowkey="${sel}"]`)
      if (el) {
        ;(el as HTMLElement).scrollIntoView({ behavior: 'smooth', block: 'center' })
        return true
      }
      return false
    }
    // Одна повторная попытка через кадр — строка могла ещё не смонтироваться.
    if (!go()) requestAnimationFrame(go)
  }, [revealTick, oldestKey])

  // Смена беседы: окно к базе, пиним к низу, гасим кнопку «вниз».
  useLayoutEffect(() => {
    const el = parentRef.current
    if (el) el.scrollTop = 0
    nearBottomRef.current = true
    oldestKeyRef.current = null
    setOldestKey(null)
    setShowJumpRef.current(false)
    pendingRevealRef.current = null // не тащим незакрытый reveal из прошлой беседы (P#3)
  }, [activeId, nearBottomRef])

  // Расширить окно вверх (из кэша) + догрузить с сервера, если окно у начала кэша.
  const expandWindow = useCallback(() => {
    const fr = rowsRef.current
    if (fr.length === 0) return
    const start = startIndexFor(fr, oldestKeyRef.current)
    if (start > 0) {
      const nk = fr[Math.max(0, start - WINDOW_STEP)]?.key ?? null
      oldestKeyRef.current = nk
      setOldestKey(nk)
    }
    // у начала кэша — просим сервер (self-gated по hasMore/olderLoadingRef), чтобы кэш
    // был впереди окна и следующее расширение шло мгновенно из него.
    if (start <= WINDOW_STEP) onReachTopRef.current()
  }, [])

  // Сентинелы: низ (у-низа / кнопка «вниз» / сжатие окна) и верх (расширение окна).
  useEffect(() => {
    const root = parentRef.current
    const bottom = bottomSentinelRef.current
    const top = topSentinelRef.current
    if (!root || !bottom || !top) return

    const bottomObs = new IntersectionObserver(
      (entries) => {
        const near = entries[entries.length - 1]?.isIntersecting ?? false
        nearBottomRef.current = near
        setShowJumpRef.current(!near)
        // У низа сжимаем окно до базового: лишние старые строки выше вьюпорта — вне экрана,
        // их удаление в column-reverse невидимо. НО только когда верхний сентинел ВНЕ экрана —
        // иначе (короткий хвост < вьюпорта, очень высокий экран) роняемые строки ещё видны → прыжок (P#2).
        if (near && oldestKeyRef.current !== null && !topIntersectingRef.current) {
          oldestKeyRef.current = null
          setOldestKey(null)
        }
      },
      { root, rootMargin: '0px 0px 40px 0px', threshold: 0 },
    )
    bottomObs.observe(bottom)

    const topObs = new IntersectionObserver(
      (entries) => {
        const hit = entries[entries.length - 1]?.isIntersecting ?? false
        topIntersectingRef.current = hit
        if (hit) expandWindow()
      },
      // 1400px — расширяем/грузим за ~2 экрана до верха, чтобы к моменту, когда домотаешь,
      // строки уже были в DOM → нет «стены» и подвисания у верха.
      { root, rootMargin: '1400px 0px 0px 0px', threshold: 0 },
    )
    topObs.observe(top)
    topObsRef.current = topObs

    return () => {
      bottomObs.disconnect()
      topObs.disconnect()
      topObsRef.current = null
    }
  }, [nearBottomRef, expandWindow])

  // Пере-вооружаем верхний сентинел после смены отрисованного окна (границы rows ИЛИ
  // oldestKey). IntersectionObserver шлёт колбэк только на СМЕНУ пересечения; после
  // расширения/prepend сентинел может остаться в зоне и не дать события → re-observe форсит
  // свежую доставку (цепочка конечна: упирается в начало кэша либо в выход из зоны).
  useEffect(() => {
    const obs = topObsRef.current
    const top = topSentinelRef.current
    if (!obs || !top) return
    obs.unobserve(top)
    obs.observe(top)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows.length, rows[0]?.key, rows[rows.length - 1]?.key, oldestKey])

  return (
    <div
      ref={parentRef}
      className="messages-virtual messages-flat"
      style={{
        flex: 1,
        minHeight: 0,
        overflowY: 'auto',
        // Жёстко запрещаем горизонтальную прокрутку/пан ленты сообщений.
        // overflow-y:auto без overflow-x повышает overflow-x до auto (CSS spec) —
        // любой ребёнок шире контейнера (code-блок, width:max-content шапки
        // форвардов/реплаев, inline-реакции, длинный неразрывный текст) делал
        // скроллер горизонтально прокручиваемым, и iOS позволял тянуть ленту
        // влево-вправо. overflowX:'hidden' обрезает ось (внутренний скролл
        // самих pre/таблиц/каруселей сохраняется — у них свой контейнер).
        // touchAction:'pan-y' — жест на самом скроллере только вертикальный.
        // overscrollBehaviorX:'contain' — ремень: не тянуть слайдер панелей.
        overflowX: 'hidden',
        touchAction: 'pan-y',
        overscrollBehaviorX: 'contain',
        display: 'flex',
        flexDirection: 'column-reverse',
        overflowAnchor: 'none',
      }}
    >
      {/* Порядок DOM в column-reverse: первый ребёнок = визуальный НИЗ.
          [нижний сентинел, новейшие → старейшие окна, верхний сентинел]. */}
      <div ref={bottomSentinelRef} style={{ height: 12, width: '100%', flex: '0 0 auto' }} aria-hidden />
      {windowRows.map((_row, i) => {
        const row = windowRows[windowRows.length - 1 - i] // обратный порядок
        return (
          <MemoRow
            key={row.key}
            rowKey={row.key}
            mapIndex={row.mapIndex}
            deps={buildDeps(row.mapIndex)}
            renderRow={renderRow}
          />
        )
      })}
      <div ref={topSentinelRef} style={{ height: 1, width: '100%', flex: '0 0 auto' }} aria-hidden />
    </div>
  )
}
