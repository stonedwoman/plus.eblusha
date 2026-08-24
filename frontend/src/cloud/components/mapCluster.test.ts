import { describe, expect, it } from 'vitest'
import { clusterize } from './mapCluster'
import type { MapPoint } from './MapView'

const p = (id: string, lat: number, lon: number): MapPoint => ({
  id,
  lat,
  lon,
  takenAt: '2023-03-24T14:04:43.000Z',
  kind: 'IMAGE',
  name: `${id}.jpg`,
  thumb: `/api/cloud/files/${id}/thumb`,
})

// Реальная география поездки: Тбилиси, Кутаиси, точка южнее Тбилиси.
const TBILISI = p('a', 41.6938, 44.8015)
const TBILISI_NEXT = p('b', 41.694, 44.8017)
const KUTAISI = p('c', 42.2679, 42.6946)
const SOUTH = p('d', 41.54, 45.0)

describe('clusterize', () => {
  it('на мелком масштабе собирает всё в одну группу', () => {
    const groups = clusterize([TBILISI, TBILISI_NEXT, KUTAISI, SOUTH], 6)
    expect(groups).toHaveLength(1)
    expect(groups[0]!.items).toHaveLength(4)
  })

  it('на крупном масштабе разделяет удалённые точки', () => {
    const groups = clusterize([TBILISI, TBILISI_NEXT, KUTAISI, SOUTH], 14)
    expect(groups.length).toBeGreaterThan(1)
    // Соседние кадры остаются вместе — иначе на карте каша из миниатюр.
    const withTbilisi = groups.find((g) => g.items.some((i) => i.id === 'a'))
    expect(withTbilisi!.items.map((i) => i.id).sort()).toEqual(['a', 'b'])
  })

  it('центр группы — среднее, а не координаты первой точки', () => {
    const groups = clusterize([TBILISI, TBILISI_NEXT], 6)
    expect(groups[0]!.lat).toBeCloseTo((41.6938 + 41.694) / 2, 6)
    expect(groups[0]!.lon).toBeCloseTo((44.8015 + 44.8017) / 2, 6)
  })

  it('никогда не отдаёт NaN-координаты при невалидном масштабе', () => {
    // Карта может не успеть получить view к моменту первой отрисовки: тогда
    // getZoom() отдаёт undefined, шаг становится NaN и маркеры уезжают в никуда.
    for (const zoom of [Number.NaN, undefined as unknown as number, -1, Infinity]) {
      const groups = clusterize([TBILISI, KUTAISI], zoom)
      expect(groups.length).toBeGreaterThan(0)
      for (const g of groups) {
        expect(Number.isFinite(g.lat)).toBe(true)
        expect(Number.isFinite(g.lon)).toBe(true)
      }
    }
  })

  it('отбрасывает точки с битыми координатами, не роняя остальные', () => {
    const broken = { ...p('x', Number.NaN, 44), lat: Number.NaN }
    const groups = clusterize([broken, TBILISI], 10)
    expect(groups.flatMap((g) => g.items).map((i) => i.id)).toEqual(['a'])
  })

  it('не теряет ни одной точки', () => {
    const points = [TBILISI, TBILISI_NEXT, KUTAISI, SOUTH]
    for (const zoom of [4, 8, 12, 16, 18, 19]) {
      const total = clusterize(points, zoom).reduce((n, g) => n + g.items.length, 0)
      expect(total).toBe(points.length)
    }
  })

  it('пустой вход даёт пустой выход', () => {
    expect(clusterize([], 10)).toEqual([])
  })
})
