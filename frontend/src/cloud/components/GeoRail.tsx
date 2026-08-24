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
const STEP = 62
const PAD = 12

export function GeoRail({
  segments,
  position,
  onJump,
}: {
  segments: GeoSegment[]
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

  if (stations.length < 2 || baseH < 200) {
    return segments.length > 0 ? <div ref={setNode} className="cl-timenav cl-geonav" aria-hidden /> : null
  }

  /*
   * Раскладка по ВЕСАМ, а не по числу снимков.
   *
   * Пропорционально числу кадров Тбилиси занимал три четверти оси, и все
   * армянские остановки слипались в кучу с наезжающими подписями. Крупная
   * станция получает полный шаг, мелкая точка — треть: порядок поездки
   * сохраняется, подписи не сталкиваются, а мелочь читается как
   * промежуточные станции на схеме.
   */
  const MINOR_W = 0.34
  const weights = stations.map((st) => (st.major ? 1 : MINOR_W))
  const totalW = Math.max(1, weights.reduce((a, b) => a + b, 0))
  const step = (h - PAD * 2 - NODE) / totalW
  const lineTop = PAD + NODE / 2

  const startW = new Map<number, number>()
  let acc = 0
  stations.forEach((st, i) => {
    startW.set(st.run, acc)
    acc += weights[i]!
  })
  const yOf = (run: number) => PAD + (startW.get(run) ?? 0) * step
  const lineBottom = PAD + totalW * step + NODE / 2
  const axisLen = Math.max(1, lineBottom - lineTop)

  // Активная станция — последняя, чей отрезок уже начался.
  let activeRun = -1
  let activeIndex = -1
  stations.forEach((st, i) => {
    if (st.run <= position.run) {
      activeRun = st.run
      activeIndex = i
    }
  })
  const inside = activeIndex >= 0 ? Math.max(0, Math.min(1, position.fraction)) * weights[activeIndex]! : 0
  const progress =
    activeRun < 0 ? 0 : Math.max(0, Math.min(1, ((startW.get(activeRun) ?? 0) + inside) / totalW))

  return (
    <nav ref={setNode} className="cl-timenav cl-geonav" aria-label="Места съёмки">
      <div className="cl-tn-axis" style={{ top: lineTop, height: axisLen }} />
      {activeRun >= 0 ? (
        <div className="cl-tn-axis done" style={{ top: lineTop, height: axisLen, transform: `scaleY(${progress})` }} />
      ) : null}

      {stations.map((s) => {
        const label = s.district ?? s.city ?? s.country
        const sub = s.district ? (s.city ?? s.country) : s.city ? s.country : ''
        return (
          <button
            key={`${s.run}-${s.path}`}
            className={`cl-tn-node${s.major ? '' : ' is-minor'}${s.run === activeRun ? ' is-active' : ''}${
              activeRun >= 0 && s.run < activeRun ? ' is-passed' : ''
            }`}
            style={{ transform: `translateY(${yOf(s.run)}px)` }}
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
            <span className="cl-tn-cap">
              <b>{label}</b>
              <i>{sub ? `${sub} · ${s.count}` : String(s.count)}</i>
            </span>
          </button>
        )
      })}
    </nav>
  )
}
