import { useEffect, useMemo, useState } from 'react'

/**
 * Вертикальная рельса мест — сестра таймлайна, только шкала не время, а
 * география: страна → город → район.
 *
 * Как и у дат, это обзорная мини-карта: станции распределены по всей высоте,
 * заливка ползёт за прокруткой, клик прыгает к группе. Отличие одно —
 * страна показывается заголовком-разделителем, а не станцией: она объединяет
 * города, и отдельный узел под неё сбивал бы счёт.
 *
 * Глубже района не спускаемся сознательно: у справочника мест нет городских
 * кварталов, сразу за ними начинаются улицы и здания.
 */
export type PlaceGroup = {
  path: string
  country: string
  city: string | null
  district: string | null
  count: number
  fileId: string | null
}

export type PlacePosition = { path: string | null; fraction: number }

const NODE = 38
const STEP = 62
const PAD = 12

type Station = PlaceGroup & { firstOfCountry: boolean }

export function PlaceRail({
  places,
  position,
  onJump,
}: {
  places: PlaceGroup[]
  position: PlacePosition
  onJump: (path: string) => void
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
   * Когда мест больше, чем помещается, сворачиваем районы в города, а если и
   * этого мало — города в страны. Тот же приём, что у дат: рельса одинаково
   * читается и у поездки в три города, и у архива по десяти странам.
   */
  const stations = useMemo<Station[]>(() => {
    if (places.length === 0) return []
    const capacity = Math.max(3, Math.floor((baseH - PAD * 2) / STEP) - 1)

    const mark = (list: PlaceGroup[]): Station[] =>
      list.map((p, i) => ({ ...p, firstOfCountry: i === 0 || list[i - 1]!.country !== p.country }))

    if (places.length <= capacity) return mark(places)

    const byCity = collapse(places, (p) => `${p.country}${p.city ?? ''}`, (items) => ({
      ...items[0]!,
      district: null,
      count: items.reduce((n, x) => n + x.count, 0),
    }))
    if (byCity.length <= capacity) return mark(byCity)

    const byCountry = collapse(places, (p) => p.country, (items) => ({
      ...items[0]!,
      city: null,
      district: null,
      count: items.reduce((n, x) => n + x.count, 0),
    }))
    return mark(byCountry)
  }, [places, baseH])

  if (stations.length < 2 || baseH < 200) {
    return places.length > 0 ? <div ref={setNode} className="cl-timenav" aria-hidden /> : null
  }

  const n = stations.length
  const step = (h - PAD * 2 - NODE) / n
  const y = (i: number) => PAD + i * step
  const lineTop = PAD + NODE / 2
  const lineBottom = y(n - 1) + NODE / 2 + step
  const axisLen = Math.max(1, lineBottom - lineTop)

  // Активная станция — та, чей путь начинает текущую группу (после свёртки
  // путь станции короче пути группы, поэтому сравнение по префиксу).
  const activeIdx = position.path
    ? stations.findIndex((s) => (position.path as string).startsWith(keyOf(s)))
    : -1
  const posIdx = activeIdx < 0 ? -1 : activeIdx + Math.max(0, Math.min(1, position.fraction))
  const progress = posIdx < 0 ? 0 : Math.max(0, Math.min(1, posIdx / n))

  return (
    <nav ref={setNode} className="cl-timenav" aria-label="Места съёмки">
      <div className="cl-tn-axis" style={{ top: lineTop, height: axisLen }} />
      {activeIdx >= 0 ? (
        <div className="cl-tn-axis done" style={{ top: lineTop, height: axisLen, transform: `scaleY(${progress})` }} />
      ) : null}

      {stations.map((s, i) => {
        const label = s.district ?? s.city ?? s.country
        const sub = s.district ? (s.city ?? '') : s.city ? s.country : String(s.count)
        return (
          <button
            key={keyOf(s)}
            className={`cl-tn-node${i === activeIdx ? ' is-active' : ''}${activeIdx >= 0 && i < activeIdx ? ' is-passed' : ''}`}
            style={{ transform: `translateY(${y(i)}px)` }}
            onClick={() => onJump(s.path)}
            title={[s.country, s.city, s.district].filter(Boolean).join(' · ') + ` · ${s.count}`}
          >
            <span className="cl-tn-cap">
              <b>{label}</b>
              <i>{sub ? `${sub} · ${s.count}` : String(s.count)}</i>
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

/** Ключ станции: путь до того уровня, до которого её свернули. */
function keyOf(s: PlaceGroup): string {
  if (s.district) return s.path
  if (s.city) return `${s.country}${s.city}`
  return s.country
}

function collapse(
  list: PlaceGroup[],
  keyFn: (p: PlaceGroup) => string,
  merge: (items: PlaceGroup[]) => PlaceGroup
): PlaceGroup[] {
  const out: { key: string; items: PlaceGroup[] }[] = []
  for (const p of list) {
    const key = keyFn(p)
    const last = out[out.length - 1]
    if (last && last.key === key) last.items.push(p)
    else out.push({ key, items: [p] })
  }
  return out.map((g) => merge(g.items))
}
