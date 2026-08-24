import { useEffect, useRef, useState } from 'react'
import { cloudApi } from '../api'
import { clusterize } from './mapCluster'

/**
 * Карта точек съёмки по EXIF GPS.
 *
 * Leaflet подгружается лениво — он не нужен никому, кто не открыл вкладку
 * «Карта». Провайдер тайлов берётся из конфигурации сервера (CLOUD_MAP_TILE_URL),
 * так что при желании его можно заменить на собственный, не трогая код.
 *
 * Здесь всё обёрнуто в try/catch и состояние ошибки не случайно: любое
 * исключение внутри async-эффекта (Leaflet в контейнере нулевого размера,
 * вырожденный bounds, повторная инициализация) раньше давало ПУСТУЮ КАРТУ без
 * единого сообщения — тайлы есть, маркеров нет, и не за что зацепиться.
 */
export type MapPoint = {
  id: string
  lat: number
  lon: number
  takenAt: string
  kind: string
  name: string
  /** null, пока превью не построено — тогда рисуем заглушку, а не битую картинку. */
  thumb: string | null
}

type Status = { kind: 'loading' } | { kind: 'ready'; count: number } | { kind: 'empty' } | { kind: 'error'; text: string }

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
  const [status, setStatus] = useState<Status>({ kind: 'loading' })

  useEffect(() => {
    let disposed = false
    // Ссылку на карту держим снаружи async-функции: иначе при быстром
    // размонтировании cleanup не успевал её получить, карта оставалась висеть
    // на контейнере, и следующая инициализация падала с
    // «Map container is already initialized».
    let mapRef: import('leaflet').Map | null = null

    void (async () => {
      try {
        const [L, points] = await Promise.all([
          import('leaflet'),
          cloudApi
            .get<{ points: MapPoint[] }>('/files/map', { params: { spaceId } })
            .then((r) => r.data.points ?? []),
        ])
        if (disposed || !ref.current) return

        await import('leaflet/dist/leaflet.css')
        if (disposed || !ref.current) return

        const map = L.map(ref.current, { zoomControl: true, attributionControl: true })
        mapRef = map
        L.tileLayer(tileUrl, { attribution, maxZoom: 19 }).addTo(map)

        const valid = points.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon))
        if (valid.length === 0) {
          // Вид ставим ДО выхода: карта без view вообще ничего не рисует.
          map.setView([41.7, 44.8], 5)
          setStatus({ kind: 'empty' })
          return
        }

        // Вид выставляем ПЕРВЫМ делом. Без него getZoom() не определён, а
        // именно от него зависит шаг сетки кластеров.
        const bounds = L.latLngBounds(valid.map((p) => [p.lat, p.lon] as [number, number]))
        if (bounds.isValid()) {
          const sw = bounds.getSouthWest()
          const ne = bounds.getNorthEast()
          // Вырожденный bounds (все снимки из одной точки) fitBounds приводит к
          // максимальному зуму, где карта показывает пустоту вокруг маркера.
          if (sw.equals(ne)) map.setView(sw, 15)
          else map.fitBounds(bounds.pad(0.15), { animate: false })
        } else {
          map.setView([valid[0]!.lat, valid[0]!.lon], 12)
        }

        const layer = L.layerGroup().addTo(map)
        const redraw = () => {
          if (disposed) return
          layer.clearLayers()
          for (const group of clusterize(valid, map.getZoom())) {
            const first = group.items[0]!
            const count = group.items.length
            const marker = L.marker([group.lat, group.lon], {
              icon: L.divIcon({
                className: 'cl-map-pin',
                // Превью может быть ещё не построено, а может исчезнуть из кэша
                // производных. И то, и другое раньше давало битую картинку и
                // визуально пустой маркер, поэтому здесь и заглушка, и onerror.
                // width/height атрибутами, без loading="lazy": все маркеры по
                // построению во вьюпорте, а иконки пересоздаются на каждом
                // zoomend — ленивость тут только добавляет мигание.
                html:
                  (first.thumb
                    ? `<img src="${first.thumb}" alt="" width="46" height="46" decoding="async" draggable="false"` +
                      ` onerror="this.replaceWith(Object.assign(document.createElement('i'),{className:'cl-map-fallback',textContent:'🖼'}))" />`
                    : `<i class="cl-map-fallback">${first.kind === 'VIDEO' ? '🎬' : '🖼'}</i>`) +
                  (count > 1 ? `<b>${count}</b>` : ''),
                iconSize: [46, 46],
                iconAnchor: [23, 23],
              }),
              // Группа поверх одиночных: под ней прячется больше снимков.
              zIndexOffset: count > 1 ? 1000 : 0,
            })
            marker.on('click', () => {
              if (count === 1) {
                openRef.current(first.id)
                return
              }
              /*
               * Целевой зум спрашиваем У КАРТЫ (getBoundsZoom уже зажат её
               * собственными min/max), а не задаём константой. Прежний
               * fitBounds(..., {maxZoom: 18}) упирался в тот же потолок, что и
               * сетка: когда карта уже на 18 — а после первого клика она именно
               * там, — зум не менялся, zoomend не стрелял, redraw не звался.
               * Клик выглядел как микропан и полное бездействие.
               */
              const padded = L.latLngBounds(
                group.items.map((i) => [i.lat, i.lon] as [number, number])
              ).pad(0.3)
              const target = map.getBoundsZoom(padded)
              // Двигаемся, только если это реально разобьёт группу.
              if (target > map.getZoom() && clusterize(group.items, target).length > 1) {
                map.fitBounds(padded)
                return
              }
              // Группа не распадётся ни на каком доступном масштабе — кадры сняты
              // с одной точки. Открываем первый: остальные рядом в ленте
              // просмотрщика и долистываются стрелками.
              openRef.current(first.id)
            })
            layer.addLayer(marker)
          }
        }

        redraw()
        map.on('zoomend', redraw)
        // Карта могла быть смонтирована в скрытом контейнере — после появления
        // размеров Leaflet нужно пересчитать, иначе тайлы и маркеры смещены.
        setTimeout(() => {
          if (!disposed) map.invalidateSize()
        }, 0)
        setStatus({ kind: 'ready', count: valid.length })
      } catch (err) {
        if (!disposed) {
          setStatus({ kind: 'error', text: err instanceof Error ? err.message : 'Не удалось построить карту' })
        }
      }
    })()

    return () => {
      disposed = true
      try {
        mapRef?.remove()
      } catch {
        // карта могла не успеть создаться — не мешаем размонтированию
      }
      mapRef = null
    }
  }, [spaceId, tileUrl, attribution])

  return (
    <div style={{ position: 'relative' }}>
      <div className="cl-map" ref={ref} />
      {status.kind === 'empty' ? (
        <div className="cl-map-note">
          Ни у одной фотографии нет координат. Съёмка с выключенной геометкой — обычное дело;
          карта заполнится, когда появятся кадры с GPS.
        </div>
      ) : null}
      {status.kind === 'error' ? (
        <div className="cl-map-note error">Карта не построилась: {status.text}</div>
      ) : null}
    </div>
  )
}
