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
        map.setView([40.1772, 44.5035], 3)
      } else {
        const markers = points.map((p) =>
          L.marker([p.lat, p.lon], {
            icon: L.divIcon({
              className: 'cl-map-pin',
              html: `<img src="${p.thumb}" alt="" loading="lazy" />`,
              iconSize: [46, 46],
              iconAnchor: [23, 23],
            }),
          })
            .on('click', () => openRef.current(p.id))
            .addTo(map)
        )
        map.fitBounds(L.featureGroup(markers).getBounds().pad(0.2))
      }

      cleanup = () => map.remove()
    })()

    return () => {
      cancelled = true
      cleanup?.()
    }
  }, [spaceId, tileUrl, attribution])

  return <div className="cl-map" ref={ref} />
}
