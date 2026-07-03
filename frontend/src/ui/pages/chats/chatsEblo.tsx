/**
 * Eblo — лёгкая ручная виртуализация («окно») списка сообщений чата.
 *
 * Зачем: список сообщений может быть очень длинным; рендерить все строки дорого.
 * «Eblo» держит в DOM только строки рядом с вьюпортом (плюс overscan), а
 * остальные заменяет плейсхолдерами известной высоты. Высоты реальных строк
 * измеряются через ResizeObserver (EbloMeasuredRow) и кэшируются, чтобы оценки
 * спейсеров были точными.
 *
 * Здесь — только константы, типы и измеряющий контейнер строки. Логика выбора
 * видимого диапазона (updateEblo) и прилипания к низу живёт в ChatsPage/хуках,
 * т.к. завязана на состояние компонента.
 */
import { useLayoutEffect, useRef, type ReactNode } from 'react'

/** Ниже этого числа строк виртуализация выключается — рендерим всё как есть. */
export const EBLO_MIN_ROWS = 120
/** Сколько последних строк держать смонтированными при первом показе / у низа. */
export const EBLO_INITIAL_ROWS = 72
/** Запас по пикселям над/под вьюпортом, чтобы прокрутка была без «дыр». */
export const EBLO_OVERSCAN_PX = 1800
/** Запас по количеству строк с каждого края видимого диапазона. */
export const EBLO_INDEX_OVERSCAN = 16
/** Оценка высоты обычной строки до реального измерения. */
export const EBLO_DEFAULT_ROW_HEIGHT = 92
/** Оценка высоты строки-пересылки (обычно выше обычной). */
export const EBLO_FORWARD_ROW_HEIGHT = 180
/** Оценка высоты системной строки (звонок, событие). */
export const EBLO_SYSTEM_ROW_HEIGHT = 48

/** Видимый диапазон строк [start, end] (индексы в плоском списке строк). */
export type EbloRange = { start: number; end: number }
/** Метаданные строки в плоском списке: её индекс и стабильный ключ. */
export type EbloRowMeta = { index: number; key: string }

/**
 * Обёртка вокруг одной строки списка, которая измеряет свою реальную высоту
 * (учитывая внешние margin первого потомка) и сообщает её наверх через
 * onHeightChange. Слушает ResizeObserver, поэтому ловит поздние изменения высоты
 * (догрузка картинок/превью/видео) — это и питает точные оценки спейсеров и
 * прилипание к низу.
 */
export function EbloMeasuredRow({
  rowKey,
  onHeightChange,
  children,
}: {
  rowKey: string
  onHeightChange: (rowKey: string, height: number) => void
  children: ReactNode
}) {
  const nodeRef = useRef<HTMLDivElement | null>(null)

  useLayoutEffect(() => {
    const node = nodeRef.current
    if (!node) return
    let raf = 0
    const measure = () => {
      if (raf) cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        raf = 0
        const child = node.firstElementChild instanceof HTMLElement ? node.firstElementChild : null
        const rect = child?.getBoundingClientRect() ?? node.getBoundingClientRect()
        const styles = child ? window.getComputedStyle(child) : null
        const marginTop = styles ? Number.parseFloat(styles.marginTop || '0') || 0 : 0
        const marginBottom = styles ? Number.parseFloat(styles.marginBottom || '0') || 0 : 0
        const height = Math.max(1, Math.ceil(rect.height + marginTop + marginBottom))
        onHeightChange(rowKey, height)
      })
    }

    measure()
    if (typeof ResizeObserver === 'undefined') {
      return () => {
        if (raf) cancelAnimationFrame(raf)
      }
    }

    const observer = new ResizeObserver(measure)
    observer.observe(node)
    const child = node.firstElementChild
    if (child instanceof HTMLElement) observer.observe(child)
    return () => {
      if (raf) cancelAnimationFrame(raf)
      observer.disconnect()
    }
  }, [onHeightChange, rowKey])

  return (
    <div className="eblo-row" data-eblo-row={rowKey} ref={nodeRef}>
      {children}
    </div>
  )
}
