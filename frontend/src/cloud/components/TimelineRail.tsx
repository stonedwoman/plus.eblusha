import { useEffect, useMemo, useRef, useState } from 'react'
import { formatDayLabel } from './Gallery'

/**
 * Вертикальная рельса-навигатор слева от плиток.
 *
 * Вся поездка одним взглядом: каждый день — горизонтальный штрих, длина ∝
 * количеству кадров, вертикальная протяжённость ∝ доле дня в альбоме (как в
 * Google Photos: рельса отражает объём, а не календарь, поэтому насыщенные дни
 * занимают на ней больше места, чем пустые месяцы между поездками). Клик или
 * перетаскивание — прыжок к дате; бегунок следует за прокруткой галереи.
 *
 * Данные приходят одним агрегатом /files/timeline по всему срезу, а не из
 * подгруженных страниц: рельса обязана показывать и то, до чего галерея ещё
 * не долистала.
 */
export type TimelineDay = { day: string; count: number }

const MONTH_SHORT = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек']

/** Полдень, а не полночь: парсинг YYYY-MM-DD без времени дал бы UTC-полночь и
 * съехавший на сутки ярлык в поясах западнее Гринвича. */
export function dayKeyToDate(day: string): Date {
  return new Date(`${day}T12:00:00`)
}

type Seg = TimelineDay & { y0: number; y1: number; w: number }

export function TimelineRail({
  days,
  activeDay,
  onJump,
}: {
  days: TimelineDay[]
  activeDay: string | null
  onJump: (day: string) => void
}) {
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const [h, setH] = useState(0)
  const [hover, setHover] = useState<{ y: number; seg: Seg } | null>(null)
  const dragging = useRef(false)

  useEffect(() => {
    const node = wrapRef.current
    if (!node) return
    const ro = new ResizeObserver(() => setH(node.clientHeight))
    ro.observe(node)
    setH(node.clientHeight)
    return () => ro.disconnect()
  }, [])

  const model = useMemo(() => {
    const total = days.reduce((n, d) => n + d.count, 0)
    if (total === 0) return null
    const max = Math.max(...days.map((d) => d.count))
    let cum = 0
    const segs: Seg[] = days.map((d) => {
      const y0 = cum / total
      cum += d.count
      // Корень, не линейно: день с 300 кадрами не должен визуально стирать
      // день с десятком — рельса про форму поездки, а не про соревнование.
      return { ...d, y0, y1: cum / total, w: 7 + Math.sqrt(d.count / max) * 17 }
    })
    return { segs, total }
  }, [days])

  /** Ярлыки месяцев: у первого дня каждого месяца, без наползания друг на друга. */
  const labels = useMemo(() => {
    if (!model || h < 80) return []
    const out: { day: string; y: number; text: string; year: boolean }[] = []
    let prevMonth = ''
    let prevYear = ''
    let lastY = -100
    for (const seg of model.segs) {
      const month = seg.day.slice(0, 7)
      if (month === prevMonth) continue
      prevMonth = month
      const y = seg.y0 * h
      if (y - lastY < 20) continue
      lastY = y
      const yearStr = seg.day.slice(0, 4)
      const newYear = yearStr !== prevYear
      prevYear = yearStr
      const m = Number(seg.day.slice(5, 7)) - 1
      out.push({ day: seg.day, y, text: newYear ? `${MONTH_SHORT[m]} ${yearStr.slice(2)}` : MONTH_SHORT[m]!, year: newYear })
    }
    return out
  }, [model, h])

  if (!model || days.length < 2) return null

  const dayAt = (frac: number): Seg => {
    const segs = model.segs
    const f = Math.min(0.9999, Math.max(0, frac))
    let lo = 0
    let hi = segs.length - 1
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (segs[mid]!.y1 <= f) lo = mid + 1
      else hi = mid
    }
    return segs[lo]!
  }

  const locate = (e: React.PointerEvent) => {
    const rect = wrapRef.current!.getBoundingClientRect()
    const y = Math.max(0, Math.min(rect.height, e.clientY - rect.top))
    return { y, seg: dayAt(y / rect.height) }
  }

  const active = activeDay ? model.segs.find((s) => s.day === activeDay) : null

  return (
    <div
      ref={wrapRef}
      className="cl-timenav"
      onPointerDown={(e) => {
        dragging.current = true
        e.currentTarget.setPointerCapture(e.pointerId)
        setHover(locate(e))
      }}
      onPointerMove={(e) => setHover(locate(e))}
      onPointerUp={(e) => {
        if (!dragging.current) return
        dragging.current = false
        e.currentTarget.releasePointerCapture(e.pointerId)
        onJump(locate(e).seg.day)
      }}
      onPointerLeave={() => {
        if (!dragging.current) setHover(null)
      }}
      role="slider"
      aria-label="Навигация по датам"
      aria-valuetext={activeDay ? formatDayLabel(dayKeyToDate(activeDay)) : undefined}
      tabIndex={-1}
    >
      {h > 0 ? (
        <svg width="64" height={h} className="cl-timenav-svg" aria-hidden>
          <line x1="57.5" x2="57.5" y1="2" y2={h - 2} className="cl-tn-track" />
          {model.segs.map((s) => (
            <rect
              key={s.day}
              x={57 - s.w}
              y={s.y0 * h}
              width={s.w}
              height={Math.max(1.5, (s.y1 - s.y0) * h - 0.6)}
              rx="1"
              className={`cl-tn-bar${s.day === activeDay ? ' is-active' : ''}${hover?.seg.day === s.day ? ' is-hover' : ''}`}
            />
          ))}
          {labels.map((l) => (
            <text key={l.day} x="1" y={l.y + 4} className={`cl-tn-label${l.year ? ' year' : ''}`}>
              {l.text}
            </text>
          ))}
          {active ? <circle cx="57.5" cy={((active.y0 + active.y1) / 2) * h} r="3.6" className="cl-tn-dot" /> : null}
        </svg>
      ) : null}

      {hover ? (
        <div className="cl-tn-bubble" style={{ top: hover.y }}>
          {formatDayLabel(dayKeyToDate(hover.seg.day))} · {hover.seg.count}
        </div>
      ) : null}
    </div>
  )
}
