import { describe, expect, it } from 'vitest'
import { computeMode, nearestTile, panelSize, phoneSpans, resultsPerTile } from './settingsLayout'

describe('режимы раскладки', () => {
  it('панель — min(1240, W−48) × min(760, H−48)', () => {
    expect(panelSize(1600, 1000)).toEqual({ w: 1240, h: 760 })
    expect(panelSize(1000, 720)).toEqual({ w: 952, h: 672 })
  })

  it('широкий — панель ≥ 1060×640', () => {
    expect(computeMode(1600, 1000)).toBe('wide')
    expect(computeMode(1216, 893)).toBe('wide')
    expect(computeMode(1108, 688)).toBe('wide')
  })

  it('компактный — панель меньше 1060 или 640, но не меньше 880×560', () => {
    expect(computeMode(1000, 720)).toBe('cmp')
    expect(computeMode(1600, 680)).toBe('cmp')
    expect(computeMode(928, 700)).toBe('cmp')
  })

  it('телефонный — ширина ≤ 768 (как isMobile) или панель меньше 880×560', () => {
    expect(computeMode(768, 1000)).toBe('phone')
    expect(computeMode(390, 844)).toBe('phone')
    expect(computeMode(900, 900)).toBe('phone')
    expect(computeMode(1600, 600)).toBe('phone')
  })

  it('ширина 769 уже не isMobile, но панель 721 < 880 — всё равно телефонная', () => {
    expect(computeMode(769, 900)).toBe('phone')
  })
})

describe('сетка плиток телефона', () => {
  it('«Профиль» всегда во всю ширину, остальные парами', () => {
    expect(phoneSpans(['profile', 'conn', 'av', 'security', 'app'])).toEqual({ profile: 2, conn: 1, av: 1, security: 1, app: 1 })
  })

  it('нечётное число остальных — последняя тоже во всю ширину', () => {
    expect(phoneSpans(['profile', 'av', 'security', 'app'])).toEqual({ profile: 2, av: 1, security: 1, app: 2 })
  })
})

describe('выдача в плитке', () => {
  it('профиль — 6, широкие 3, компакт 2, телефон — все', () => {
    expect(resultsPerTile('profile', 'wide')).toBe(6)
    expect(resultsPerTile('conn', 'wide')).toBe(3)
    expect(resultsPerTile('conn', 'cmp')).toBe(2)
    expect(resultsPerTile('conn', 'phone')).toBe(99)
  })
})

describe('стрелки между плитками', () => {
  // сетка 4×2 из SPEC §2.2 при панели 1240: колонки по ~300, «Профиль» на два ряда, «Звук и видео» и «Безопасность» на две колонки
  const rects = [
    { id: 'profile', cx: 172, cy: 330 },
    { id: 'conn', cx: 472, cy: 175 },
    { id: 'av', cx: 922, cy: 175 },
    { id: 'security', cx: 622, cy: 485 },
    { id: 'app', cx: 1072, cy: 485 },
  ]
  it('вправо от «Профиля» — ближайшая по центрам', () => {
    expect(['conn', 'security']).toContain(nearestTile('profile', 'right', rects))
  })
  it('вниз от «Соединения» — «Безопасность»', () => {
    expect(nearestTile('conn', 'down', rects)).toBe('security')
  })
  it('вверх от «Безопасности» — «Соединение» (ближе по поперечной оси)', () => {
    expect(nearestTile('security', 'up', rects)).toBe('conn')
  })
  it('в стену — null', () => {
    expect(nearestTile('app', 'right', rects)).toBeNull()
    expect(nearestTile('profile', 'left', rects)).toBeNull()
  })
})
