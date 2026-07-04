import { useCallback, useEffect, useLayoutEffect, useRef, type ReactNode } from 'react'

export type MsgRow = { mapIndex: number; key: string }

// Оценка высоты по типу строки — для contain-intrinsic-size (content-visibility).
// С ключевым словом auto реальная высота ЗАПОМИНАЕТСЯ после первого рендера, так что
// оценка важна только для ещё ни разу не показанных строк (минимизирует поправку при
// первом заезде в них).
function estRowHeight(key: string): number {
  if (key.startsWith('system:')) return 48
  if (key.startsWith('bundle:') || key.startsWith('forward:')) return 200
  return 96
}

/**
 * Список сообщений: плоский рендер + column-reverse + content-visibility.
 *
 * Гладкость (ноль тряски):
 *  - Строки — реальные ноды с реальными высотами → нативно гладкий скролл, ноль
 *    transform/measureElement (болезнь item-виртуализации Eblo/@tanstack).
 *  - `column-reverse`: точка отсчёта скролла = НИЗ. Вставка старых сверху не двигает
 *    вьюпорт ни на десктопе, ни на iOS (нет overflow-anchor + momentum перебивает
 *    ручной scrollTop). Новые у низа прилипают, короткие беседы жмутся к низу.
 *
 * Лёгкость огромных чатов (виртуализация РЕНДЕРА, не удаление нод):
 *  - `content-visibility: auto` на каждой строке: браузер ПРОПУСКАЕТ layout/paint для
 *    строк вне экрана, используя оценку `contain-intrinsic-size` как заглушку размера.
 *    Т.е. тысяча сообщений в DOM, а стоит (по рендеру) как ~видимые. Ноды при этом
 *    ОСТАЮТСЯ в DOM → переход к цитируемому сообщению, поиск, отметки о прочтении и
 *    прочая навигация по нодам продолжают работать (в отличие от «выкидывания» строк).
 *  - Почему это не возвращает тряску: в column-reverse якорь — НИЗ, а ошибки оценки
 *    высоты живут ВЫШЕ вьюпорта (у ещё не показанных старых строк) и на закреплённый
 *    низ не влияют; недавно показанные строки помнят реальную высоту (auto).
 *
 * Детект краёв — через IntersectionObserver-сентинелы (без арифметики scrollTop, у
 * column-reverse его знак разнится между браузерами).
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
  // onReachTop/setShowJump пересоздаются каждый рендер (MessagesPane — render-функция).
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

  // Отдаём наружу scroll-элемент и API; чистим при размонтировании, чтобы messagesRef
  // не указывал на отсоединённую ноду.
  useEffect(() => {
    scrollElRef.current = parentRef.current
    apiRef.current = { scrollToBottom }
    return () => {
      scrollElRef.current = null
      apiRef.current = null
    }
  }, [scrollToBottom, scrollElRef, apiRef])

  // Смена беседы: пиним к низу (scrollTop 0) и гасим кнопку «вниз».
  useLayoutEffect(() => {
    const el = parentRef.current
    if (el) el.scrollTop = 0
    nearBottomRef.current = true
    setShowJumpRef.current(false)
  }, [activeId, nearBottomRef])

  // Сентинелы: низ (у-низа/кнопка «вниз») и верх (подгрузка старых).
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
      },
      { root, rootMargin: '0px 0px 40px 0px', threshold: 0 },
    )
    bottomObs.observe(bottom)

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

  // Пере-вооружаем верхний сентинел после смены rows. IntersectionObserver шлёт колбэк
  // только на СМЕНУ пересечения; после prepend старых сверху сентинел может остаться в
  // зоне и не дать события → пагинация «залипнет». unobserve+observe форсит свежую
  // доставку (loadOlderMessages сам гейтит по hasMore/olderLoadingRef, цикл конечен).
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
        overflowAnchor: 'none',
      }}
    >
      {/* Порядок DOM в column-reverse: первый ребёнок = визуальный НИЗ.
          [нижний сентинел, новейшие → старейшие, верхний сентинел]. */}
      {/* Нижний сентинел = визуальный низ; 12px «воздуха» под новейшим баблом. */}
      <div ref={bottomSentinelRef} style={{ height: 12, width: '100%', flex: '0 0 auto' }} aria-hidden />
      {rows.map((_row, i) => {
        const row = rows[rows.length - 1 - i] // рендерим в обратном порядке
        return (
          <div
            className="msg-row"
            key={row.key}
            style={{
              flex: '0 0 auto',
              // Вне экрана браузер пропускает layout/paint → огромный чат остаётся
              // лёгким. Реальная высота запоминается (auto) → без «прыжка» при возврате.
              contentVisibility: 'auto',
              containIntrinsicSize: `auto ${estRowHeight(row.key)}px`,
            }}
          >
            {renderRow(row.mapIndex)}
          </div>
        )
      })}
      <div ref={topSentinelRef} style={{ height: 1, width: '100%', flex: '0 0 auto' }} aria-hidden />
    </div>
  )
}
