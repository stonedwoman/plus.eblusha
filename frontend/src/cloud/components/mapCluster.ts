import type { MapPoint } from './MapView'

/**
 * Группировка точек съёмки для карты.
 *
 * Вынесена из компонента в чистую функцию сознательно: карту нельзя прогнать в
 * headless-тесте вместе с Leaflet и тайлами, а вот арифметику группировки —
 * можно и нужно (mapCluster.test.ts). Именно здесь легче всего получить NaN в
 * координатах и «пустую карту» без единой ошибки в консоли.
 *
 * Сетка считается в ГРАДУСАХ на текущем масштабе. Для приватного альбома этого
 * достаточно: точки одной поездки лежат в пределах области, где искажение
 * долготы по широте несущественно.
 */
export type Cluster = { lat: number; lon: number; items: MapPoint[] }

/** Максимальный масштаб, на котором ещё группируем; выше — каждая точка сама по себе. */
export const MAX_CLUSTER_ZOOM = 18

/** Сторона ячейки группировки в пикселях экрана. Маркер — 46 px. */
export const CLUSTER_CELL_PX = 64

export function clusterize(points: MapPoint[], zoom: number): Cluster[] {
  // Невалидный масштаб (карта ещё не получила view) превратил бы шаг в NaN, а
  // ключи бакетов — в "NaN|NaN": все точки схлопнулись бы в одну группу с
  // произвольным центром. Подстраховываемся явно.
  const safeZoom = Number.isFinite(zoom) ? Math.max(0, Math.min(zoom, MAX_CLUSTER_ZOOM)) : 2
  /*
   * Шаг сетки задаём В ПИКСЕЛЯХ ЭКРАНА, а не в градусах.
   *
   * Тайл Leaflet — 256 px и покрывает 360/2^zoom градусов долготы, значит один
   * пиксель это 360/(256·2^zoom) градусов. Прежняя формула (360/2^zoom · 2)
   * давала ячейку в 512 px при маркере в 46 px: почти всё схлопывалось в одну
   * группу на любом масштабе, и карта выглядела как пара пинов вместо поездки.
   * CLUSTER_CELL_PX чуть больше маркера — соседние миниатюры не наезжают,
   * но и лишнего не слипается.
   */
  const step = (360 / (256 * Math.pow(2, safeZoom))) * CLUSTER_CELL_PX

  const buckets = new Map<string, Cluster>()
  for (const p of points) {
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lon)) continue
    const key = `${Math.round(p.lat / step)}|${Math.round(p.lon / step)}`
    const bucket = buckets.get(key)
    if (bucket) {
      bucket.items.push(p)
      // Скользящее среднее: центр группы, а не координаты первой попавшейся точки.
      bucket.lat += (p.lat - bucket.lat) / bucket.items.length
      bucket.lon += (p.lon - bucket.lon) / bucket.items.length
    } else {
      buckets.set(key, { lat: p.lat, lon: p.lon, items: [p] })
    }
  }
  return [...buckets.values()]
}
