import { useEffect, useMemo, useState } from 'react'

/**
 * Вертикальный таймлайн слева от плиток.
 *
 * Не гистограмма, а маршрут поездки: вертикальная ось со «станциями»-узлами,
 * у каждой — круглая миниатюра дня, дата и счётчик кадров. Линия до текущего
 * дня закрашена фирменным цветом — видно, где ты в альбоме. Клик по узлу —
 * прыжок к дате.
 *
 * Масштаб выбирает себя сам по высоте окна: пока дни помещаются — станции-дни;
 * дней больше, чем влезает, — станции-месяцы; совсем длинная история — годы.
 * Так рельса одинаково выглядит и у поездки на три дня, и у архива за десять
 * лет.
 */
export type TimelineDay = { day: string; count: number; fileId: string | null }

const MONTH_SHORT = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек']
const MONTH_FULL = [
  'январь', 'февраль', 'март', 'апрель', 'май', 'июнь',
  'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь',
]

/** Полдень, а не полночь: YYYY-MM-DD без времени парсился бы как UTC-полночь
 * и в поясах западнее Гринвича ярлык уезжал бы на сутки назад. */
export function dayKeyToDate(day: string): Date {
  return new Date(`${day}T12:00:00`)
}

/** Станция на оси: день, месяц или год — смотря сколько влезает. */
type Station = {
  key: string
  /** Крупная строка: «24 мар», «март», «2023». */
  label: string
  /** Мелкая строка: счётчик, год месяца. */
  sub: string
  count: number
  fileId: string | null
  /** Куда прыгать: первый день станции, где реально есть съёмка. */
  firstDay: string
}

/** Минимальный вертикальный шаг станции: узел + двухстрочная подпись + воздух. */
const STEP = 62
const PAD = 12
const NODE = 38

export function TimelineRail({
  days,
  activeDay,
  onJump,
}: {
  days: TimelineDay[]
  activeDay: string | null
  onJump: (day: string) => void
}) {
  /*
   * Колбэк-реф, а не useRef + эффект с пустыми deps: до прихода данных
   * компонент отдаёт null, эффект успевал отработать по несуществующему узлу,
   * и высота навсегда оставалась нулевой — рельса застревала в пустой
   * заглушке. Со state-рефом наблюдатель цепляется к тому элементу, который
   * реально в DOM, каким бы по счёту рендером он ни появился.
   */
  const [node, setNode] = useState<HTMLElement | null>(null)
  const [h, setH] = useState(0)

  useEffect(() => {
    if (!node) return
    const ro = new ResizeObserver(() => setH(node.clientHeight))
    ro.observe(node)
    setH(node.clientHeight)
    return () => ro.disconnect()
  }, [node])

  const stations = useMemo<Station[]>(() => {
    if (days.length === 0) return []
    const capacity = Math.max(3, Math.floor((h - PAD * 2) / STEP))
    const thisYear = String(new Date().getFullYear())

    if (days.length <= capacity) {
      return days.map((d) => {
        const [y, m, dd] = d.day.split('-')
        return {
          key: d.day,
          label: `${Number(dd)} ${MONTH_SHORT[Number(m) - 1]}`,
          sub: y === thisYear ? String(d.count) : `${y} · ${d.count}`,
          count: d.count,
          fileId: d.fileId,
          firstDay: d.day,
        }
      })
    }

    const byMonth = groupBy(days, (d) => d.day.slice(0, 7))
    if (byMonth.length <= capacity) {
      return byMonth.map(({ key, items }) => {
        const [y, m] = key.split('-')
        return {
          key,
          label: MONTH_FULL[Number(m) - 1]!,
          sub: y === thisYear ? String(sum(items)) : `${y} · ${sum(items)}`,
          count: sum(items),
          fileId: items[0]!.fileId,
          firstDay: items[0]!.day,
        }
      })
    }

    const byYear = groupBy(days, (d) => d.day.slice(0, 4))
    return byYear.map(({ key, items }) => ({
      key,
      label: key,
      sub: String(sum(items)),
      count: sum(items),
      fileId: items[0]!.fileId,
      firstDay: items[0]!.day,
    }))
  }, [days, h])

  if (stations.length < 2 || h < 200) {
    // Однодневный альбом навигации не требует; держим колонку, чтобы сетка
    // плиток не прыгала при переключении фильтров.
    return days.length > 0 ? <div ref={setNode} className="cl-timenav" aria-hidden /> : null
  }

  const n = stations.length
  // Станции растягиваются на ВСЮ высоту рельсы: ось живёт от шапки до низа
  // экрана, а не жмётся в верхнем углу. Так и выглядит осью маршрута, и в
  // каждый узел проще попасть.
  const step = (h - PAD * 2 - NODE) / Math.max(1, n - 1)
  const y = (i: number) => PAD + i * step

  const activeIdx = activeDay
    ? stations.findIndex((s) => activeDay === s.key || activeDay.startsWith(s.key))
    : -1
  const lineTop = PAD + NODE / 2
  const lineBottom = y(n - 1) + NODE / 2

  return (
    <nav ref={setNode} className="cl-timenav" aria-label="Таймлайн по датам">
      <div className="cl-tn-axis" style={{ top: lineTop, height: lineBottom - lineTop }} />
      {activeIdx >= 0 ? (
        <div className="cl-tn-axis done" style={{ top: lineTop, height: Math.max(0, y(activeIdx) + NODE / 2 - lineTop) }} />
      ) : null}

      {stations.map((s, i) => {
        const active = i === activeIdx
        const passed = activeIdx >= 0 && i < activeIdx
        return (
          <button
            key={s.key}
            className={`cl-tn-node${active ? ' is-active' : ''}${passed ? ' is-passed' : ''}`}
            style={{ top: y(i) }}
            onClick={() => onJump(s.firstDay)}
            title={`${s.label}${s.sub ? ` · ${s.sub}` : ''}`}
          >
            {/* Подпись слева от оси, узел — на самой оси. Пустой узел (нет
                миниатюры) стилем превращается в полый кружок на линии. */}
            <span className="cl-tn-cap">
              <b>{s.label}</b>
              <i>{s.sub}</i>
            </span>
            <span className="cl-tn-ava">
              {s.fileId ? (
                <img
                  src={`/api/cloud/files/${s.fileId}/thumb`}
                  alt=""
                  width={NODE}
                  height={NODE}
                  loading="lazy"
                  decoding="async"
                  draggable={false}
                  onError={(e) => e.currentTarget.remove()}
                />
              ) : null}
            </span>
          </button>
        )
      })}
    </nav>
  )
}

function groupBy(days: TimelineDay[], keyOf: (d: TimelineDay) => string): { key: string; items: TimelineDay[] }[] {
  const out: { key: string; items: TimelineDay[] }[] = []
  for (const d of days) {
    const key = keyOf(d)
    const last = out[out.length - 1]
    if (last && last.key === key) last.items.push(d)
    else out.push({ key, items: [d] })
  }
  return out
}

function sum(items: TimelineDay[]): number {
  return items.reduce((n, d) => n + d.count, 0)
}
