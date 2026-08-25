import { useEffect, useMemo, useState } from 'react'

/**
 * Географическая рельса — зеркало таймлайна, только справа от плиток.
 *
 * Лента одна и та же: слева видно КОГДА, справа — ГДЕ. Станция здесь не место
 * вообще, а отрезок поездки: подряд идущие снимки одного места. Вернулись в
 * Тбилиси через неделю — это вторая станция, а не та же самая, иначе рельса
 * врала бы про маршрут.
 *
 * Глубже населённого пункта не спускаемся: у справочника мест нет городских
 * кварталов, сразу за ними идут улицы и здания.
 */
export type GeoSegment = {
  path: string
  country: string
  city: string | null
  district: string | null
  count: number
  fileId: string | null
}

/** Где читатель: номер отрезка и доля пройденного внутри него. */
export type GeoPosition = { run: number; fraction: number }

const NODE = 38
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
const STEP = 62
const PAD = 12

export function GeoRail({
  segments,
  withoutPlace,
  position,
  onJump,
}: {
  segments: GeoSegment[]
  /** Сколько снимков без геометки — их место в рельсе не показать. */
  withoutPlace: number
  position: GeoPosition
  onJump: (run: number) => void
}) {
  const [node, setNode] = useState<HTMLElement | null>(null)
  const [h, setH] = useState(0)
  const [baseH, setBaseH] = useState(0)

  useEffect(() => {
    if (!node) return
    const apply = () => {
      setH(node.clientHeight)
      const off = parseFloat(getComputedStyle(node).getPropertyValue('--cl-rail-off')) || 0
      setBaseH(node.clientHeight + off)
    }
    const ro = new ResizeObserver(apply)
    ro.observe(node)
    apply()
    return () => ro.disconnect()
  }, [node])

  /*
   * Когда отрезков больше, чем помещается, оставляем САМЫЕ ЗНАЧИМЫЕ по числу
   * снимков, сохраняя порядок поездки. Склеивать соседние отрезки нельзя:
   * подряд идут разные места, и слитая станция подписывалась именем первого,
   * а счётчик собирала со всех — рельса показывала «Окрокана · 153» там, где
   * человек проехал пять разных посёлков.
   */
  const stations = useMemo(() => {
    if (segments.length === 0) return []
    const withRun = segments.map((s, i) => ({ ...s, run: i }))
    const capacity = Math.max(3, Math.floor((baseH - PAD * 2) / STEP) - 1)

    /*
     * Показываем ЗНАЧИМЫЕ остановки, а не всё подряд.
     *
     * Слева рельса дат просторная: дней в поездке единицы. Справа же
     * проездом набегают десятки точек по три снимка, и рельса превращалась в
     * мелкую сыпь вместо маршрута. Отсекаем мелочь по доле от общего числа
     * снимков, но всегда оставляем хотя бы четыре самые крупные — иначе у
     * равномерной поездки рельса опустела бы совсем.
     */
    const total = withRun.reduce((n, s) => n + s.count, 0)
    const floor = Math.max(4, Math.round(total * 0.02))
    let majorRuns = new Set(withRun.filter((s) => s.count >= floor).map((s) => s.run))
    if (majorRuns.size < Math.min(4, withRun.length)) {
      majorRuns = new Set(
        [...withRun].sort((a, b) => b.count - a.count).slice(0, Math.min(4, withRun.length)).map((s) => s.run)
      )
    }
    if (majorRuns.size > capacity) {
      majorRuns = new Set(
        withRun.filter((s) => majorRuns.has(s.run)).sort((a, b) => b.count - a.count).slice(0, capacity).map((s) => s.run)
      )
    }
    // Мелкие остановки не выбрасываем: они остаются точками на оси — как
    // промежуточные станции на схеме метро. Иначе исчезал целый Ереван, и
    // выглядело так, будто география не догрузилась.
    return withRun.map((s) => ({ ...s, major: majorRuns.has(s.run) }))
  }, [segments, baseH])

  /*
   * Одну станцию тоже показываем. Порог в две отрезал целые альбомы: снимки
   * одного города давали единственный отрезок, и геолайн пропадал целиком —
   * выглядело так, будто места не определились вовсе.
   */
  if (stations.length < 1 || baseH < 200) {
    return <div ref={setNode} className="cl-timenav cl-geonav" aria-hidden />
  }

  // Активная станция — последняя, чей отрезок уже начался.
  let activeRun = -1
  let activeIndex = -1
  stations.forEach((st, i) => {
    if (st.run <= position.run) {
      activeRun = st.run
      activeIndex = i
    }
  })

  /*
   * Раскладка «фокус и контекст»: рельса расступается вокруг того места, где
   * читатель сейчас, и сжимает далёкое.
   *
   * Постоянная плотность не работает: на поездке в двадцать городов подписи
   * налезали друг на друга, а миниатюры сливались в кашу. Здесь вес станции
   * зависит от расстояния до текущей — соседи получают полный шаг, дальние
   * ужимаются. Сумма весов нормируется на высоту рельсы, поэтому узлы
   * физически не могут столкнуться, сколько бы мест ни было.
   *
   * Значимость остановки тоже учитываем: крупный город остаётся заметнее
   * проездом схваченного посёлка, даже когда до него далеко.
   */
  // Пока до первой геометки не дошли, фокус держим на первой станции: рельса
  // без акцента выглядит как ровная сыпь и не подсказывает, куда смотреть.
  const focusAt = activeIndex < 0 ? 0 : activeIndex
  const focusWeight = (i: number) => {
    const d = Math.abs(i - focusAt)
    const near = d === 0 ? 1.5 : d === 1 ? 1.15 : d === 2 ? 0.9 : d <= 4 ? 0.62 : 0.4
    return near * (stations[i]!.major ? 1.18 : 1)
  }
  const weights = stations.map((_, i) => focusWeight(i))
  const totalW = Math.max(1, weights.reduce((a, b) => a + b, 0))
  const step = (h - PAD * 2 - NODE) / totalW
  const lineTop = PAD + NODE / 2

  const startW = new Map<number, number>()
  let acc = 0
  const laid = stations.map((st, i) => {
    const start = acc
    acc += weights[i]!
    startW.set(st.run, start)
    /*
     * Размер узла выводится из ФАКТИЧЕСКИ доставшегося места, а не задаётся
     * заранее: где просторно — полноценный кружок с подписью, где тесно —
     * точка. Плотность подстраивается сама, и отдельного порога «мелкая или
     * крупная» больше не нужно.
     */
    const room = weights[i]! * step
    // Запас против соседа: узел никогда не занимает всё доставшееся место.
    const k = clamp(room / 52, 0.26, 1)
    return { ...st, i, k, room, top: PAD + start * step + (NODE * (1 - k)) / 2 }
  })
  const lineBottom = PAD + totalW * step + NODE / 2
  const axisLen = Math.max(1, lineBottom - lineTop)

  const activeStation = laid.find((s) => s.run === activeRun)
  const inside = activeStation ? Math.max(0, Math.min(1, position.fraction)) * weights[activeStation.i]! : 0
  const progress =
    activeRun < 0 ? 0 : Math.max(0, Math.min(1, ((startW.get(activeRun) ?? 0) + inside) / totalW))

  return (
    <nav ref={setNode} className="cl-timenav cl-geonav" aria-label="Места съёмки">
      <div className="cl-tn-axis" style={{ top: lineTop, height: axisLen }} />
      {activeRun >= 0 ? (
        <div className="cl-tn-axis done" style={{ top: lineTop, height: axisLen, transform: `scaleY(${progress})` }} />
      ) : null}

      {laid.map((s) => {
        const label = s.district ?? s.city ?? s.country
        const sub = s.district ? (s.city ?? s.country) : s.city ? s.country : ''
        // Подпись показываем, только когда узлу досталось место под неё —
        // иначе она наползла бы на соседнюю.
        const showCap = s.k >= 0.72 || s.run === activeRun
        return (
          <button
            key={`${s.run}-${s.path}`}
            className={`cl-tn-node${s.k < 0.72 ? ' is-minor' : ''}${s.run === activeRun ? ' is-active' : ''}${
              activeRun >= 0 && s.run < activeRun ? ' is-passed' : ''
            }`}
            style={{ transform: `translateY(${s.top}px)`, ['--k' as string]: s.k }}
            onClick={() => onJump(s.run)}
            title={[s.country, s.city, s.district].filter(Boolean).join(' · ') + ` · ${s.count}`}
          >
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
            <span className="cl-tn-cap" style={{ opacity: showCap ? 1 : 0 }}>
              <b>{label}</b>
              <i>{sub ? `${sub} · ${s.count}` : String(s.count)}</i>
            </span>
          </button>
        )
      })}

      {/* Прямо говорим, почему часть альбома в геолайне не представлена:
          у старых снимков GPS в EXIF попросту нет. */}
      {withoutPlace > 0 ? (
        <span className="cl-geonav-rest" style={{ top: PAD + totalW * step + NODE }}>
          {withoutPlace} без геометки
        </span>
      ) : null}
    </nav>
  )
}
