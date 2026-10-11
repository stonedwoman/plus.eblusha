import { describe, expect, it } from 'vitest'
import {
  canRevokeOthers,
  cleanDeviceLabel,
  deviceCount,
  groupSessions,
  hasOwnDevice,
  lastSeenLabel,
  platformLabel,
  serverHint,
  serverRoute,
  sessionKind,
  shareSummary,
  voiceSummary,
} from './settingsFormat'

describe('склонения', () => {
  it('«устройство» по числу', () => {
    expect(deviceCount(1)).toBe('1 устройство')
    expect(deviceCount(2)).toBe('2 устройства')
    expect(deviceCount(4)).toBe('4 устройства')
    expect(deviceCount(5)).toBe('5 устройств')
    expect(deviceCount(11)).toBe('11 устройств')
    expect(deviceCount(21)).toBe('21 устройство')
  })
})

describe('сервер по адресу сайта', () => {
  it('eblusha.org — напрямую, ru.eblusha.org — через СПб, иное — сам адрес', () => {
    expect(serverRoute('eblusha.org')).toMatchObject({ kind: 'direct', label: 'Напрямую' })
    expect(serverRoute('ru.eblusha.org')).toMatchObject({ kind: 'spb', label: 'Через СПб' })
    expect(serverRoute('settingsweb.localhost')).toMatchObject({ kind: 'other', label: 'settingsweb.localhost' })
    expect(serverRoute('')).toMatchObject({ kind: 'other' })
  })
  it('подсказка называет второй адрес', () => {
    expect(serverHint(serverRoute('eblusha.org'))).toContain('ru.eblusha.org')
    expect(serverHint(serverRoute('ru.eblusha.org'))).toContain('eblusha.org')
  })
})

describe('сеансы', () => {
  const devs = [
    { id: 'a', name: 'iPhone', platform: 'ios', lastIp: '1.1.1.1', lastCity: 'Бухарест', lastCountry: 'Румыния', availablePrekeys: 40, lastSeenAt: '2026-10-11T08:00:00Z', createdAt: '2026-09-01T00:00:00Z' },
    { id: 'b', name: 'Edge · Windows', platform: 'web', lastIp: '1.1.1.2', lastCity: 'Бухарест', lastCountry: 'Румыния', availablePrekeys: 40, lastSeenAt: '2026-10-11T09:00:00Z' },
    { id: 'c', name: 'Pixel 8', platform: 'android', availablePrekeys: 0, lastSeenAt: '2026-10-10T09:00:00Z' },
    { id: 'd', name: 'Pixel 8', platform: 'android', availablePrekeys: 0, lastSeenAt: '2026-10-09T09:00:00Z' },
    { id: 'x', name: 'Старый', platform: 'windows', revokedAt: '2026-10-01T00:00:00Z' },
  ]

  it('отозванные скрыты, одинаковые склеены, своё — первым', () => {
    const rows = groupSessions(devs, 'b')
    expect(rows.map((r) => r.device.id)).toEqual(['b', 'a', 'c'])
    expect(rows[0].isCurrent).toBe(true)
    expect(rows.find((r) => r.device.id === 'c')?.count).toBe(2)
  })

  it('подписи: платформа с большой буквы, пустые части опускаются', () => {
    const rows = groupSessions(devs, 'b')
    expect(rows.find((r) => r.device.id === 'a')?.meta).toBe('iOS · Бухарест, Румыния · 1.1.1.1')
    expect(rows.find((r) => r.device.id === 'c')?.meta).toBe('Android')
    expect(rows[0].meta).toBe('Браузер · Бухарест, Румыния · 1.1.1.2')
  })

  it('«ключи готовы» — только при prekeys > 0', () => {
    const rows = groupSessions(devs, 'b')
    expect(rows.find((r) => r.device.id === 'a')?.keysReady).toBe(true)
    expect(rows.find((r) => r.device.id === 'c')?.keysReady).toBe(false)
  })

  it('своё устройство в склейке не прячется за более свежим двойником', () => {
    const twins = [
      { id: 'own', name: 'Edge', platform: 'web', lastIp: '1.1.1.1', lastSeenAt: '2026-10-10T00:00:00Z' },
      { id: 'twin', name: 'Edge', platform: 'web', lastIp: '1.1.1.1', lastSeenAt: '2026-10-11T00:00:00Z' },
    ]
    const rows = groupSessions(twins, 'own')
    expect(rows).toHaveLength(1)
    expect(rows[0].isCurrent).toBe(true)
    expect(rows[0].count).toBe(2)
  })

  it('«отключить все другие» — только если своё устройство в списке и есть чужие', () => {
    expect(canRevokeOthers(devs, 'b')).toBe(true)
    expect(canRevokeOthers(devs, null)).toBe(false)
    expect(canRevokeOthers(devs, 'нет-такого')).toBe(false)
    expect(canRevokeOthers([devs[1]], 'b')).toBe(false)
    expect(hasOwnDevice(devs, 'x')).toBe(false) // отозванное не считается
  })

  it('значок по платформе', () => {
    expect(sessionKind('ios')).toBe('phone')
    expect(sessionKind('android')).toBe('phone')
    expect(sessionKind('web')).toBe('browser')
    expect(sessionKind('windows')).toBe('desktop')
    expect(sessionKind('iPad')).toBe('tablet')
    expect(platformLabel('ios')).toBe('iOS')
    expect(platformLabel('')).toBe('')
  })

  it('«был в сети»: сегодня / вчера / дата', () => {
    const now = new Date(2026, 9, 11, 15, 0)
    expect(lastSeenLabel(new Date(2026, 9, 11, 11, 52), now)).toBe('был в сети сегодня, 11:52')
    expect(lastSeenLabel(new Date(2026, 9, 10, 23, 5), now)).toBe('был в сети вчера, 23:05')
    expect(lastSeenLabel(new Date(2026, 9, 2, 18, 52), now)).toBe('был в сети 02.10.2026, 18:52')
    expect(lastSeenLabel(null, now)).toBe('')
  })
})

describe('сводки', () => {
  it('обработка голоса', () => {
    expect(voiceSummary(true, true, true)).toBe('вкл: эхо · шум · усиление')
    expect(voiceSummary(true, false, true)).toBe('вкл: эхо · усиление')
    expect(voiceSummary(false, false, false)).toBe('всё выключено')
  })
  it('показ экрана', () => {
    expect(shareSummary('1080p', 30, true)).toBe('1080p · 30 кадр/с · со звуком')
    expect(shareSummary('720p', 60, false)).toBe('720p · 60 кадр/с')
  })
  it('имя устройства звонка без префиксов и кодов', () => {
    expect(cleanDeviceLabel('Default - Микрофон (Realtek) (0bda:0567)')).toBe('Микрофон (Realtek)')
    expect(cleanDeviceLabel('По умолчанию - Динамики')).toBe('Динамики')
    expect(cleanDeviceLabel('Камера (10d6:')).toBe('Камера')
  })
})
