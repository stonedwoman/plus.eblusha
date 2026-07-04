import { useCallback, useEffect, useLayoutEffect, useRef, type ReactNode } from 'react'

export type MsgRow = { mapIndex: number; key: string }

/**
 * Плоский (невиртуализированный) список сообщений с нативным якорением у низа
 * через `flex-direction: column-reverse`.
 *
 * ПОЧЕМУ ТАК (после долгой борьбы с item-виртуализацией):
 *  - Реальные DOM-ноды с реальными высотами → нативно ГЛАДКИЙ скролл. Ноль
 *    transform/measureElement → ноль поштучной тряски (болезнь @tanstack/Eblo).
 *  - `column-reverse`: точка отсчёта скролла = НИЗ. Вставка старых сообщений
 *    сверху (loadOlderMessages дописывает в начало кэша) НЕ двигает вьюпорт —
 *    ни на десктопе, ни на iOS (где нет overflow-anchor и momentum перебивает
 *    ручной scrollTop). Новые сообщения у низа автоматически «прилипают».
 *    Короткие беседы естественно жмутся к низу (как Telegram).
 *  - Детект «у низа» / «у верха» — через IntersectionObserver по сентинелам,
 *    БЕЗ арифметики scrollTop (у column-reverse знак scrollTop разнится между
 *    браузерами — сентинелы к этому иммунны).
 *
 * DOM пока не ограничен (все загруженные строки в DOM). Ограничение размера
 * DOM для очень длинных чатов — отдельная фаза (сброс самой старой страницы
 * из кэша у низа), строится ПОВЕРХ этой гладкой базы.
 */
export function MessageListFlat(props: {
  rows: MsgRow[]
  renderRow: (mapIndex: number) => ReactNode
  activeId: string | null
  /** наружу отдаём scroll-элемент (нужен LazyImage rootRef, visibleObserver и пр.) */
  scrollElRef: { current: HTMLDivElement | null }
  nearBottomRef: { current: boolean }
  onReachTop: () => void
  setShowJump: (v: boolean) => void
  /** императивный API для кнопки «вниз» / клавиатуры iOS */
  apiRef: { current: { scrollToBottom: (smooth?: boolean) => void } | null }
}) {
  const { rows, renderRow, activeId, scrollElRef, nearBottomRef, onReachTop, setShowJump, apiRef } = props
  const parentRef = useRef<HTMLDivElement | null>(null)
  const bottomSentinelRef = useRef<HTMLDivElement | null>(null)
  const topSentinelRef = useRef<HTMLDivElement | null>(null)
  const topObsRef = useRef<IntersectionObserver | null>(null)

  // Свежие колбэки в рефах: IntersectionObserver подписываем ОДИН раз, а
  // onReachTop/setShowJump пересоздаются каждый рендер (MessagesPane —
  // render-функция без useCallback-стабилизации снаружи).
  const onReachTopRef = useRef(onReachTop)
  onReachTopRef.current = onReachTop
  const setShowJumpRef = useRef(setShowJump)
  setShowJumpRef.current = setShowJump

  // Прокрутка к низу = scrollTop 0 (в column-reverse ноль == визуальный низ).
  const scrollToBottom = useCallback((smooth?: boolean) => {
    const el = parentRef.current
    if (!el) return
    el.scrollTo({ top: 0, behavior: smooth ? 'smooth' : 'auto' })
    nearBottomRef.current = true
  }, [nearBottomRef])

  // Отдаём наружу scroll-элемент и API. Чистим при размонтировании, иначе
  // messagesRef остался бы указывать на отсоединённую ноду (напр. беседа без
  // кэша → rows пусты → MessagesPane вернёт null → мы размонтируемся), и внешние
  // эффекты мерили бы 0/clientWidth у мёртвого элемента.
  useEffect(() => {
    scrollElRef.current = parentRef.current
    apiRef.current = { scrollToBottom }
    return () => {
      scrollElRef.current = null
      apiRef.current = null
    }
  }, [scrollToBottom, scrollElRef, apiRef])

  // Смена беседы: инстанс скролл-контейнера переиспользуется, поэтому scrollTop
  // мог «протухнуть» от прошлой беседы. Пиним к низу (scrollTop 0 в column-reverse)
  // и сразу гасим кнопку «вниз» — иначе стейл-true из прошлой (промотанной) беседы
  // мигал бы кадр-другой, пока не сработает async-колбэк IntersectionObserver.
  useLayoutEffect(() => {
    const el = parentRef.current
    if (el) el.scrollTop = 0
    nearBottomRef.current = true
    setShowJumpRef.current(false)
  }, [activeId, nearBottomRef])

  // Детект у-низа (кнопка «вниз» + авто-пин новых) и у-верха (подгрузка старых)
  // через сентинелы. Подписываемся один раз при монтировании.
  useEffect(() => {
    const root = parentRef.current
    const bottom = bottomSentinelRef.current
    const top = topSentinelRef.current
    if (!root || !bottom || !top) return

    // Нижний сентинел: «у низа», если он в пределах 40px от края → nearBottom.
    const bottomObs = new IntersectionObserver(
      (entries) => {
        const near = entries[entries.length - 1]?.isIntersecting ?? false
        nearBottomRef.current = near
        setShowJumpRef.current(!near)
      },
      { root, rootMargin: '0px 0px 40px 0px', threshold: 0 },
    )
    bottomObs.observe(bottom)

    // Верхний сентинел: подгружаем старые за ~600px до верха (страница ≫ экрана,
    // так что сентинел выходит из зоны после вставки и триггерит снова при
    // дальнейшем скролле вверх).
    const topObs = new IntersectionObserver(
      (entries) => {
        if (entries[entries.length - 1]?.isIntersecting) onReachTopRef.current()
      },
      { root, rootMargin: '600px 0px 0px 0px', threshold: 0 },
    )
    topObs.observe(top)
    topObsRef.current = topObs

    return () => {
      bottomObs.disconnect()
      topObs.disconnect()
      topObsRef.current = null
    }
  }, [nearBottomRef])

  // Пере-вооружаем верхний сентинел после смены rows. IntersectionObserver шлёт
  // колбэк только на СМЕНУ пересечения; после prepend старых сверху сентинел может
  // остаться в зоне (страница короче зоны / частичная последняя страница) и не дать
  // нового события → пагинация «залипнет». unobserve+observe форсит свежую доставку:
  // если всё ещё у верха и есть ещё старые — подгрузит следующую (loadOlderMessages
  // сам гейтит по hasMore/olderLoadingRef, так что цикл конечен).
  useEffect(() => {
    const obs = topObsRef.current
    const top = topSentinelRef.current
    if (!obs || !top) return
    obs.unobserve(top)
    obs.observe(top)
  }, [rows])

  return (
    <div
      ref={parentRef}
      className="messages-virtual messages-flat"
      style={{
        flex: 1,
        minHeight: 0,
        overflowY: 'auto',
        display: 'flex',
        flexDirection: 'column-reverse',
        // «Overflow anchor» нам не нужен — column-reverse якорит нативно; но и не
        // мешает. WebKit его игнорирует.
        overflowAnchor: 'none',
      }}
    >
      {/* Порядок DOM в column-reverse: первый ребёнок = визуальный НИЗ.
          [нижний сентинел, новейшие → старейшие, верхний сентинел]
          Визуально сверху вниз: верхний сентинел, старое … новое, нижний сентинел. */}
      {/* Нижний сентинел = визуальный низ (между новейшим сообщением и композером).
          Высота 12px даёт «воздух», чтобы последний бабл не липнул к полю ввода
          (старый список резервировал ~24px через paddingEnd+Footer). */}
      <div ref={bottomSentinelRef} style={{ height: 12, width: '100%', flex: '0 0 auto' }} aria-hidden />
      {rows.map((_row, i) => {
        const row = rows[rows.length - 1 - i] // рендерим в обратном порядке
        return (
          <div className="msg-row" key={row.key} style={{ flex: '0 0 auto' }}>
            {renderRow(row.mapIndex)}
          </div>
        )
      })}
      <div ref={topSentinelRef} style={{ height: 1, width: '100%', flex: '0 0 auto' }} aria-hidden />
    </div>
  )
}
