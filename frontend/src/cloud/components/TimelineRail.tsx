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
  /** Дни, свёрнутые в станцию: по ним считается доля пройденного пути. */
  days: string[]
}

/** Минимальный вертикальный шаг станции: узел + двухстрочная подпись + воздух. */
const STEP = 62
const PAD = 12
const NODE = 38

/**
 * Где сейчас читатель: день у верхней кромки и доля пройденного внутри его
 * группы. Дробная часть и делает полоску непрерывной — она отражает прокрутку,
 * а не прыгает от даты к дате.
 */
export type RailPosition = { day: string | null; fraction: number }

export function TimelineRail({
  days,
  position,
  onJump,
}: {
  days: TimelineDay[]
  position: RailPosition
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
  /*
   * База для ГРАНУЛЯРНОСТИ — высота рельсы при спрятанной шапке, то есть
   * clientHeight плюс текущий --cl-rail-off. Живой h дышит на высоту шапки при
   * каждом повороте прокрутки (621↔810), и если считать от него capacity,
   * альбом на 9–11 дней флипался бы день↔месяц на каждом развороте: ключи
   * станций меняются, узлы пересоздаются — мигание вместо переезда. Пиксельная
   * раскладка (шаг, ось) остаётся на живом h.
   */
  const [baseH, setBaseH] = useState(0)

  useEffect(() => {
    if (!node) return
    /*
     * Высота рельсы постоянна (см. .cl-timenav), поэтому наблюдатель срабатывает
     * только на настоящем изменении окна. Сравнение перед записью обязательно:
     * без него любое срабатывание тянуло за собой перерисовку всех станций.
     */
    const apply = () => {
      const next = node.clientHeight
      setH((prev) => (prev === next ? prev : next))
      setBaseH((prev) => (prev === next ? prev : next))
    }
    const ro = new ResizeObserver(apply)
    ro.observe(node)
    apply()
    return () => ro.disconnect()
  }, [node])

  const stations = useMemo<Station[]>(() => {
    if (days.length === 0) return []
    // −1 на хвост: под последней станцией остаётся отрезок такой же длины,
    // по которому полоска доходит до низа, пока листаешь последний период.
    const capacity = Math.max(3, Math.floor((baseH - PAD * 2) / STEP) - 1)
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
          days: [d.day],
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
          days: items.map((d) => d.day),
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
      days: items.map((d) => d.day),
    }))
  }, [days, baseH])

  if (stations.length < 2 || baseH < 200) {
    // Однодневный альбом навигации не требует; держим колонку, чтобы сетка
    // плиток не прыгала при переключении фильтров.
    return days.length > 0 ? <div ref={setNode} className="cl-timenav" aria-hidden /> : null
  }

  const n = stations.length
  /*
   * Станции растягиваются на ВСЮ высоту рельсы, но шкала делится на n частей,
   * а не на n−1: под последним узлом остаётся отрезок ровно в один шаг.
   *
   * Он не украшение. Узел отмечает НАЧАЛО периода, и без хвоста полоска
   * упиралась в край, едва начавшись последний день, — а в нём могут быть ещё
   * сотни кадров. Теперь она честно доползает до низа по мере их просмотра.
   */
  const step = (h - PAD * 2 - NODE) / n
  const y = (i: number) => PAD + i * step

  const activeIdx = position.day
    ? stations.findIndex((s) => s.days.includes(position.day as string))
    : -1
  const lineTop = PAD + NODE / 2
  // Линия идёт на шаг ДАЛЬШЕ последнего узла — это и есть хвост последнего дня.
  const lineBottom = y(n - 1) + NODE / 2 + step
  const axisLen = Math.max(1, lineBottom - lineTop)

  /*
   * Дробная позиция в шкале станций.
   *
   * Целая часть — станция, у верхней кромки которой читатель; дробная —
   * насколько он её прошёл. Когда станция свёрнута из нескольких дней, доля
   * складывается из номера дня внутри станции и прокрутки внутри самого дня,
   * поэтому полоска ползёт ровно и всегда приходит точно в узел следующей
   * станции, а не обгоняет его и не отстаёт.
   */
  const posIdx = (() => {
    if (activeIdx < 0) return -1
    const st = stations[activeIdx]!
    const k = st.days.indexOf(position.day as string)
    if (k < 0) return activeIdx
    return activeIdx + (k + Math.max(0, Math.min(1, position.fraction))) / st.days.length
  })()
  // Закрашенный отрезок рисуется полной длины и сжимается масштабом: рост идёт
  // на композиторе, без релэйаута на каждом кадре прокрутки.
  // Делим на n, а не на n−1: шкала включает хвост, поэтому доля станции i
  // приходится ровно на центр её узла, а конец альбома — на низ линии.
  const progress = posIdx < 0 ? 0 : Math.max(0, Math.min(1, posIdx / n))

  return (
    <nav ref={setNode} className="cl-timenav" aria-label="Таймлайн по датам">
      <div className="cl-tn-axis" style={{ top: lineTop, height: axisLen }} />
      {activeIdx >= 0 ? (
        <div className="cl-tn-axis done" style={{ top: lineTop, height: axisLen, transform: `scaleY(${progress})` }} />
      ) : null}

      {stations.map((s, i) => {
        const active = i === activeIdx
        const passed = activeIdx >= 0 && i < activeIdx
        return (
          <button
            key={s.key}
            className={`cl-tn-node${active ? ' is-active' : ''}${passed ? ' is-passed' : ''}`}
            style={{ transform: `translateY(${y(i)}px)` }}
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
