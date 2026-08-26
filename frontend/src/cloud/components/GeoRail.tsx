import { useEffect, useMemo, useRef, useState } from 'react'

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
  compact,
}: {
  segments: GeoSegment[]
  /** Сколько снимков без геометки — их место в рельсе не показать. */
  withoutPlace: number
  position: GeoPosition
  onJump: (run: number) => void
  /**
   * Узкий тач-вариант: подписи/миниатюры прячет CSS (см. @media max-width:860px
   * в cloud.css), а здесь появляется протяжка пальцем — на 22px-полосе тыкать
   * по отдельным станциям бесполезно, значит листаем непрерывным драгом.
   */
  compact?: boolean
}) {
  const [node, setNode] = useState<HTMLElement | null>(null)
  const [h, setH] = useState(0)
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
   * useRef ДО раннего return ниже — тот же порядок хуков нужен на КАЖДОМ
   * рендере, а ранний return его иначе не соблюдал (React error #310), см.
   * идентичную правку и комментарий в TimelineRail.tsx.
   */
  const lastScrubRef = useRef<number | null>(null)

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
   * Позиции станций РАВНОМЕРНЫЕ, меняются только размер и акцент.
   *
   * Пробовал «рыбий глаз» — вес по расстоянию до текущей станции. Он
   * красиво расступается, но деформирует саму шкалу: когда фокус переходит
   * дальше, предыдущие станции сжимаются, и следующая уползает ВВЕРХ.
   * Полоска заливки при движении вперёд ехала назад — замерено: 0.26 на
   * Барселоне, 0.23 на Болонье. Для оси, по которой читают маршрут, это
   * недопустимо: положение обязано быть монотонным.
   *
   * Поэтому плотность выражается иначе: шаг делится поровну, а размер узла
   * выводится из доставшегося шага — мест мало, узлы крупные; мест много,
   * узлы ужимаются в точки. Акцент при проматывании даёт кольцо и подписи,
   * которые показываются только у текущей станции и её соседей.
   */
  const n = stations.length
  /*
   * Одно место — не маршрут.
   *
   * Ось со шкалой подразумевает движение между остановками; при единственном
   * месте она вырождалась в длинную линию в никуда с одиноким кружком наверху
   * и читалась как обломок вёрстки. Показываем просто отметку по центру
   * колонки: «всё это снято здесь» — и ничего больше.
   */
  const solo = n === 1
  const step = (h - PAD * 2 - NODE) / Math.max(1, n)
  const lineTop = PAD + NODE / 2
  const lineBottom = PAD + n * step + NODE / 2
  const axisLen = Math.max(1, lineBottom - lineTop)
  // Запас против соседа: узел не занимает весь доставшийся шаг.
  const baseK = clamp(step / 52, 0.26, 1)
  /*
   * Свободная рельса — подписаны ВСЕ станции: двухстрочная подпись занимает
   * ~30px, при шаге от 48px соседние даже не соприкасаются, и прятать их
   * незачем. Акцент «текущая + соседи» остаётся для тесной рельсы, где
   * подписи без прореживания легли бы друг на друга.
   */
  const roomy = step >= 48

  const laid = stations.map((st, i) => {
    // Рядом с текущей позволяем чуть крупнее, но строго в пределах шага.
    const d = activeIndex < 0 ? 9 : Math.abs(i - activeIndex)
    const boost = d === 0 ? 1.18 : d === 1 ? 1.08 : 1
    const k = solo ? 1 : clamp(baseK * boost, 0.26, clamp(step / 42, 0.26, 1))
    const top = solo ? Math.max(PAD, (h - NODE) / 2) : PAD + i * step + (NODE * (1 - k)) / 2
    return { ...st, i, k, top }
  })

  const activeStation = laid.find((s) => s.run === activeRun)
  const centerOf = (st: { top: number; k: number }) => st.top + (NODE * st.k) / 2
  let fillPx = 0
  if (activeStation) {
    const from = centerOf(activeStation)
    const next = laid[activeStation.i + 1]
    const to = next ? centerOf(next) : lineBottom
    fillPx = from - lineTop + (to - from) * Math.max(0, Math.min(1, position.fraction))
  }
  const progress = activeRun < 0 ? 0 : Math.max(0, Math.min(1, fillPx / axisLen))

  /*
   * Протяжка пальцем по узкой полосе: находим станцию, ближайшую к пальцу по
   * вертикали, и прыгаем к ней — повторно, только когда станция СМЕНИЛАСЬ, а
   * не на каждый пиксель движения (иначе десятки прыжков за один жест).
   */
  const scrubTo = (clientY: number) => {
    if (!node || laid.length === 0) return
    const y = clientY - node.getBoundingClientRect().top
    let best = laid[0]!
    let bestDist = Infinity
    for (const s of laid) {
      const d = Math.abs(centerOf(s) - y)
      if (d < bestDist) {
        bestDist = d
        best = s
      }
    }
    if (lastScrubRef.current === best.run) return
    lastScrubRef.current = best.run
    onJump(best.run)
  }
  const onScrubDown = (e: React.PointerEvent<HTMLElement>) => {
    if (!compact) return
    lastScrubRef.current = null
    e.currentTarget.setPointerCapture(e.pointerId)
    scrubTo(e.clientY)
  }
  const onScrubMove = (e: React.PointerEvent<HTMLElement>) => {
    if (!compact || e.buttons === 0) return
    scrubTo(e.clientY)
  }

  return (
    <nav
      ref={setNode}
      className="cl-timenav cl-geonav"
      aria-label="Места съёмки"
      onPointerDown={onScrubDown}
      onPointerMove={onScrubMove}
    >
      {!solo ? (
        <>
          <div className="cl-tn-axis" style={{ top: lineTop, height: axisLen }} />
          {activeRun >= 0 ? (
            <div className="cl-tn-axis done" style={{ top: lineTop, height: axisLen, transform: `scaleY(${progress})` }} />
          ) : null}
        </>
      ) : null}

      {laid.map((s) => {
        const label = s.district ?? s.city ?? s.country
        const sub = s.district ? (s.city ?? s.country) : s.city ? s.country : ''
        // Подпись показываем, только когда узлу досталось место под неё —
        // иначе она наползла бы на соседнюю.
        // Подписи — у текущей станции и её ближайших соседей: это и есть
        // акцент, который едет за прокруткой. Остальные читаются по наведению.
        const near = activeIndex < 0 ? s.i <= 1 : Math.abs(s.i - activeIndex) <= 1
        const showCap = solo || roomy || (near && s.k >= 0.5)
        return (
          <button
            key={`${s.run}-${s.path}`}
            className={`cl-tn-node${s.k < 0.6 ? ' is-minor' : ''}${showCap ? ' is-labeled' : ''}${
              s.run === activeRun ? ' is-active' : ''
            }${activeRun >= 0 && s.run < activeRun ? ' is-passed' : ''}`}
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
            <span className="cl-tn-cap">
              <b>{label}</b>
              <i>{sub ? `${sub} · ${s.count}` : String(s.count)}</i>
            </span>
          </button>
        )
      })}

      {/* Прямо говорим, почему часть альбома в геолайне не представлена:
          у старых снимков GPS в EXIF попросту нет. */}
      {withoutPlace > 0 ? (
        <span className="cl-geonav-rest" style={{ top: lineBottom + NODE / 2 }}>
          {withoutPlace} без геометки
        </span>
      ) : null}
    </nav>
  )
}
