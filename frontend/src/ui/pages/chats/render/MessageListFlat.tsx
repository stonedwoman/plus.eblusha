import { memo, useCallback, useEffect, useLayoutEffect, useRef, type ReactNode } from 'react'

export type MsgRow = { mapIndex: number; key: string; deps?: unknown[] | null }

/**
 * Одна строка списка, обёрнутая в React.memo. Пропускает перерисовку, если её `deps`
 * (массив всего, что влияет на визуал строки, собран в MessagesPane) поэлементно не
 * изменились — тогда renderRow(mapIndex) НЕ вызывается и тяжёлое поддерево не
 * пересобирается. deps===null → «сложная» строка (пересылка/бандл): всегда рисуем.
 *
 * mapIndex/renderRow/rowKey намеренно НЕ сравниваем: при сдвиге индексов (подгрузка
 * старых сверху) вывод той же строки идентичен; при реальном изменении сработают deps,
 * и на ре-рендере компонент получит свежие mapIndex/renderRow (последние пропсы).
 */
type MemoRowProps = { mapIndex: number; deps: unknown[] | null; renderRow: (i: number) => ReactNode }
const MemoRow = memo(
  function MemoRow({ mapIndex, renderRow }: MemoRowProps) {
    // Реальная высота (медиа зарезервировано через aspect-ratio) стабильна с первого
    // кадра → ничего не «распухает» поздно, скролл не дёргается. content-visibility НЕ
    // используем: он держит оценку высоты и пересчитывает реальную у края экрана = рывок.
    return (
      <div className="msg-row" style={{ flex: '0 0 auto' }}>
        {renderRow(mapIndex)}
      </div>
    )
  },
  (a: MemoRowProps, b: MemoRowProps) => {
    if (a.deps === null || b.deps === null) return false // всегда перерисовываем
    const da = a.deps
    const db = b.deps
    if (da.length !== db.length) return false
    for (let i = 0; i < da.length; i++) if (!Object.is(da[i], db[i])) return false
    return true
  },
)

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
 * Стабильные высоты (ноль позднего «распухания»):
 *  - content-visibility НЕ используем: он держит грубую оценку высоты для строк вне
 *    экрана и пересчитывает реальную у КРАЯ вьюпорта → бабл с фото резко растёт и
 *    толкает ленту (та самая тряска). Вместо этого рисуем реальные высоты сразу; место
 *    под медиа зарезервировано через aspect-ratio (ChatMessageRow), так что и загрузка
 *    картинок раскладку не двигает.
 *  - `overflow-anchor: auto` — при любом изменении высоты выше вьюпорта браузер держит
 *    видимое на месте, рост уходит вверх.
 *  - Стоимость перерисовки больших чатов снимает построчная React.memo (см. MemoRow),
 *    а не пропуск рендера; ограничение числа нод (если понадобится) — отдельная фаза.
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
    // Зависим от ГРАНИЦ списка (длина + ключи краёв), а не от ссылки rows (она теперь
    // новая каждый рендер) — иначе пере-вооружали бы наблюдатель на каждый рендер.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows.length, rows[0]?.key, rows[rows.length - 1]?.key])

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
        // overflow-anchor: none. Высоты медиа зарезервированы (aspect-ratio) → ничего не
        // «растёт» при загрузке, компенсировать нечего. А браузерный якорь `auto` в
        // column-reverse ПЕРЕ-корректирует при массовой одновременной догрузке превью
        // (много мелких settle разом) и сам даёт рывок — поэтому none (как в Phase 1).
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
          <MemoRow
            key={row.key}
            mapIndex={row.mapIndex}
            deps={row.deps ?? null}
            renderRow={renderRow}
          />
        )
      })}
      <div ref={topSentinelRef} style={{ height: 1, width: '100%', flex: '0 0 auto' }} aria-hidden />
    </div>
  )
}
