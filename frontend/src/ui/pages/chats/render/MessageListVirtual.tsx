import { useCallback, useEffect, useLayoutEffect, useRef, type ReactNode } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'

export type MsgRow = { mapIndex: number; key: string }

/**
 * Виртуализированный список сообщений на @tanstack/react-virtual (headless).
 * Держит в DOM только видимые строки; высоты меряются (measureElement).
 * Скролл-поведение: открытие у низа, прилипание к низу на новом хвосте, триггер
 * подгрузки старых у верха, трекинг «у низа». Якорение при вставке старых —
 * компенсируем сами (см. prepend-эффект).
 */
export function MessageListVirtual(props: {
  rows: MsgRow[]
  renderRow: (mapIndex: number) => ReactNode
  activeId: string | null
  /** наружу отдаём scroll-элемент (нужен LazyImage rootRef и пр.) */
  scrollElRef: { current: HTMLDivElement | null }
  nearBottomRef: { current: boolean }
  onReachTop: () => void
  setShowJump: (v: boolean) => void
  /** императивный API для кнопки «вниз» / клавиатуры iOS */
  apiRef: { current: { scrollToBottom: (smooth?: boolean) => void } | null }
}) {
  const { rows, renderRow, activeId, scrollElRef, nearBottomRef, onReachTop, setShowJump, apiRef } = props
  const parentRef = useRef<HTMLDivElement | null>(null)
  const rowsRef = useRef(rows)
  rowsRef.current = rows

  // Оценка высоты ПО ТИПУ строки (ближе к реальной → меньше дельта при домере → меньше
  // тряски). overscan большой: строки выше/ниже вьюпорта рендерятся и меряются ЗАРАНЕЕ
  // (за ~2 экрана), поэтому к моменту, когда домотаешь до них, высота уже известна и
  // скролл не дёргается. Это и есть «строить страницу вверх заранее».
  const estimateSize = useCallback(
    (i: number) => {
      const k = rowsRef.current[i]?.key || ''
      if (k.startsWith('system:')) return 48
      if (k.startsWith('bundle:') || k.startsWith('forward:')) return 200
      return 96
    },
    [],
  )
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize,
    getItemKey: (i) => rows[i]?.key ?? i,
    overscan: 160,
    paddingEnd: 12,
  })

  // Прижать к низу. Прямой scrollTop=scrollHeight надёжнее scrollToIndex при динамических
  // высотах (те меряются после отрисовки, и scrollToIndex промахивается). Добиваем по
  // кадрам: пока нижние строки домеряются, scrollHeight растёт — держим низ несколько кадров.
  const burstRafRef = useRef(0)
  const pinBottom = useCallback((smooth?: boolean) => {
    const el = parentRef.current
    if (!el) return
    if (smooth) { el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' }); nearBottomRef.current = true; return }
    if (burstRafRef.current) cancelAnimationFrame(burstRafRef.current)
    let frames = 0
    const step = () => {
      const e = parentRef.current
      if (!e) return
      e.scrollTop = e.scrollHeight
      nearBottomRef.current = true
      if (frames++ < 8) burstRafRef.current = requestAnimationFrame(step)
    }
    step()
  }, [nearBottomRef])
  const scrollToBottom = pinBottom

  // Отдаём наружу scroll-элемент и API (каждый рендер — дёшево).
  useEffect(() => {
    scrollElRef.current = parentRef.current
    apiRef.current = { scrollToBottom }
  })

  // Открытие беседы — сразу у низа (один раз на беседу).
  const positionedConvRef = useRef<string | null>(null)
  useLayoutEffect(() => {
    if (!activeId || rows.length === 0) return
    if (positionedConvRef.current === activeId) return
    positionedConvRef.current = activeId
    pinBottom()
  }, [activeId, rows.length, pinBottom])

  // Прилипание к низу, когда пришёл НОВЫЙ хвост и мы были у низа.
  const prevCountRef = useRef(0)
  const prevLastKeyRef = useRef<string | null>(null)
  useLayoutEffect(() => {
    const lastKey = rows[rows.length - 1]?.key ?? null
    const grewAtEnd = rows.length > prevCountRef.current && lastKey !== prevLastKeyRef.current
    prevCountRef.current = rows.length
    prevLastKeyRef.current = lastKey
    if (grewAtEnd && nearBottomRef.current) {
      pinBottom()
    }
  }, [rows, pinBottom, nearBottomRef])

  // Высоты меряются асинхронно (measureElement/ResizeObserver): общая высота растёт уже
  // после прокрутки. Пока мы у низа — ре-пиним на каждое изменение общей высоты, чтобы
  // низ не «отъезжал» (домер картинок/строк). При чтении истории (не у низа) не трогаем.
  // Направление прокрутки: если недавно мотали ВВЕРХ — НЕ пиним к низу. Иначе домер
  // высот строк при мотании вверх швыряет кадр к низу и тут же назад = мерзкое мигание.
  const lastScrollTopRef = useRef(0)
  const lastUpAtRef = useRef(0)
  const totalSize = virtualizer.getTotalSize()
  useLayoutEffect(() => {
    const el = parentRef.current
    if (!el) return
    if (!nearBottomRef.current) return
    if (typeof performance !== 'undefined' && performance.now() - lastUpAtRef.current < 400) return
    el.scrollTop = el.scrollHeight
  }, [totalSize, nearBottomRef])

  // Якорь для восстановления позиции при вставке старых сверху: верхний видимый ряд
  // (ключ) + его смещение от верха вьюпорта. Обновляем на скролле, пока читаем историю.
  const anchorRef = useRef<{ key: string; offsetFromTop: number } | null>(null)
  const prevLenRef = useRef(0)
  const prevFirstKeyRef = useRef<string | null>(null)
  useLayoutEffect(() => {
    const firstKey = rows[0]?.key ?? null
    const prepended = rows.length > prevLenRef.current && firstKey !== prevFirstKeyRef.current && !nearBottomRef.current
    prevLenRef.current = rows.length
    prevFirstKeyRef.current = firstKey
    if (prepended && anchorRef.current) {
      const a = anchorRef.current
      const idx = rows.findIndex((r) => r.key === a.key)
      const el = parentRef.current
      if (idx >= 0 && el) {
        const off = virtualizer.getOffsetForIndex(idx, 'start')
        const offset = Array.isArray(off) ? off[0] : (off as unknown as number)
        if (typeof offset === 'number' && Number.isFinite(offset)) el.scrollTop = offset - a.offsetFromTop
      }
    }
  }, [rows, virtualizer, nearBottomRef])

  const onScroll = useCallback(() => {
    const el = parentRef.current
    if (!el) return
    const st = el.scrollTop
    // Засекаем момент прокрутки ВВЕРХ — на 400мс это выключит авто-пин к низу.
    if (st < lastScrollTopRef.current - 1 && typeof performance !== 'undefined') lastUpAtRef.current = performance.now()
    lastScrollTopRef.current = st
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40
    nearBottomRef.current = nearBottom
    setShowJump(!nearBottom)
    // Пишем якорь (верхний видимый ряд) для восстановления после prepend.
    if (!nearBottom) {
      for (const vi of virtualizer.getVirtualItems()) {
        if (vi.start + vi.size > el.scrollTop) {
          const key = rows[vi.index]?.key
          if (key) anchorRef.current = { key, offsetFromTop: vi.start - el.scrollTop }
          break
        }
      }
    } else {
      anchorRef.current = null
    }
    if (el.scrollTop < 300) onReachTop()
  }, [nearBottomRef, setShowJump, onReachTop, virtualizer, rows])

  const items = virtualizer.getVirtualItems()
  return (
    <div
      ref={parentRef}
      onScroll={onScroll}
      className="messages-virtual"
      style={{ flex: 1, minHeight: 0, overflowY: 'auto', position: 'relative' }}
    >
      <div style={{ height: virtualizer.getTotalSize(), width: '100%', position: 'relative' }}>
        {items.map((vi) => (
          <div
            key={vi.key}
            data-index={vi.index}
            ref={virtualizer.measureElement}
            style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${vi.start}px)` }}
          >
            <div className="msg-row">{renderRow(rows[vi.index].mapIndex)}</div>
          </div>
        ))}
      </div>
    </div>
  )
}
