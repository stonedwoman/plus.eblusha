import { useEffect, useRef } from 'react'
import { cloudApi } from '../api'

/**
 * Карта точек съёмки по EXIF GPS.
 *
 * Leaflet подгружается лениво — он не нужен никому, кто не открыл вкладку
 * «Карта». Провайдер тайлов берётся из конфигурации сервера (CLOUD_MAP_TILE_URL),
 * так что при желании его можно заменить на собственный, не трогая код.
 */
export type MapPoint = {
  id: string
  lat: number
  lon: number
  takenAt: string
  kind: string
  name: string
  thumb: string
}

/**
 * Группировка точек по сетке текущего масштаба.
 *
 * Без неё пятьсот снимков одной поездки превращаются в кучу налезающих друг на
 * друга миниатюр: разобрать что-либо невозможно, а браузер тянет пятьсот
 * превью разом. Отдельная библиотека кластеризации ради этого не нужна —
 * достаточно округлить координаты до шага, зависящего от зума.
 */
function clusterize(points: MapPoint[], zoom: number): { lat: number; lon: number; items: MapPoint[] }[] {
  // На каждом уровне приближения ячейка вдвое мельче; на максимуме кластеров нет.
  const step = 360 / Math.pow(2, Math.min(zoom, 18)) * 2
  const buckets = new Map<string, { lat: number; lon: number; items: MapPoint[] }>()
  for (const p of points) {
    const key = `${Math.round(p.lat / step)}|${Math.round(p.lon / step)}`
    const bucket = buckets.get(key)
    if (bucket) {
      bucket.items.push(p)
      // Держим центр группы, а не координаты первой попавшейся фотографии.
      bucket.lat += (p.lat - bucket.lat) / bucket.items.length
      bucket.lon += (p.lon - bucket.lon) / bucket.items.length
    } else {
      buckets.set(key, { lat: p.lat, lon: p.lon, items: [p] })
    }
  }
  return [...buckets.values()]
}

export function MapView({
  spaceId,
  tileUrl,
  attribution,
  onOpen,
}: {
  spaceId: string
  tileUrl: string
  attribution: string
  onOpen: (fileId: string) => void
}) {
  const ref = useRef<HTMLDivElement | null>(null)
  const openRef = useRef(onOpen)
  openRef.current = onOpen

  useEffect(() => {
    let cleanup: (() => void) | undefined
    let cancelled = false

    void (async () => {
      const [L, points] = await Promise.all([
        import('leaflet'),
        (async () => {
          const { data } = await cloudApi.get<{ points: MapPoint[] }>('/files/map', { params: { spaceId } })
          return data.points
        })(),
      ])
      if (cancelled || !ref.current) return

      await import('leaflet/dist/leaflet.css')
      const map = L.map(ref.current, { zoomControl: true, attributionControl: true })
      L.tileLayer(tileUrl, { attribution, maxZoom: 19 }).addTo(map)

      if (points.length === 0) {
        map.setView([41.7, 44.8], 6)
        cleanup = () => map.remove()
        return
      }

      const layer = L.layerGroup().addTo(map)
      const redraw = () => {
        layer.clearLayers()
        for (const group of clusterize(points, map.getZoom())) {
          const first = group.items[0] as MapPoint
          const count = group.items.length
          const marker = L.marker([group.lat, group.lon], {
            icon: L.divIcon({
              className: 'cl-map-pin',
              html:
                `<img src="${first.thumb}" alt="" loading="lazy" />` +
                (count > 1 ? `<b>${count}</b>` : ''),
              iconSize: [46, 46],
              iconAnchor: [23, 23],
            }),
          })
          marker.on('click', () => {
            // Группа — приближаем к ней, одиночный снимок — открываем.
            if (count > 1) map.flyTo([group.lat, group.lon], Math.min(map.getZoom() + 3, 18))
            else openRef.current(first.id)
          })
          layer.addLayer(marker)
        }
      }

      const bounds = L.latLngBounds(points.map((p) => [p.lat, p.lon] as [number, number]))
      map.fitBounds(bounds.pad(0.2))
      redraw()
      map.on('zoomend', redraw)

      cleanup = () => {
        map.off('zoomend', redraw)
        map.remove()
      }
    })()

    return () => {
      cancelled = true
      cleanup?.()
    }
  }, [spaceId, tileUrl, attribution])

  return <div className="cl-map" ref={ref} />
}
