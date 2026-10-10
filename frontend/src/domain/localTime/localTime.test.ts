import { describe, expect, it } from 'vitest'
import {
  formatLocalTimeLabel,
  formatOffsetLabel,
  formatPeerLocalTime,
  isKnownTimeZone,
  msUntilNextMinute,
  normalizeDeviceTimeZone,
  normalizeLocalTimeInfo,
  normalizeShareState,
  pickNewerShareState,
  zoneOffsetMinutes,
} from './localTime'

const WINTER = new Date('2026-01-15T07:30:00Z')
const SUMMER = new Date('2026-07-15T07:30:00Z')
const MSK = 180

describe('normalizeLocalTimeInfo', () => {
  it('различает «поля нет» (undefined) и «не показывать» (null)', () => {
    expect(normalizeLocalTimeInfo(undefined)).toBeUndefined()
    expect(normalizeLocalTimeInfo(null)).toBeNull()
    expect(normalizeLocalTimeInfo('Asia/Krasnoyarsk')).toBeNull()
    expect(normalizeLocalTimeInfo({})).toBeNull()
    expect(normalizeLocalTimeInfo({ timeZone: '  ' })).toBeNull()
  })
  it('берёт пояс, город и смещение; пустой город — null, мусорное смещение — 0', () => {
    expect(normalizeLocalTimeInfo({ timeZone: 'Asia/Krasnoyarsk', city: 'Красноярск', offsetMinutes: 420 })).toEqual({
      timeZone: 'Asia/Krasnoyarsk',
      city: 'Красноярск',
      offsetMinutes: 420,
    })
    expect(normalizeLocalTimeInfo({ timeZone: 'Etc/GMT-7', city: '', offsetMinutes: 'x' })).toEqual({
      timeZone: 'Etc/GMT-7',
      city: null,
      offsetMinutes: 0,
    })
    expect(normalizeLocalTimeInfo({ timeZone: 'Etc/GMT-7', city: null, offsetMinutes: 99999 })?.offsetMinutes).toBe(0)
  })
})

describe('zoneOffsetMinutes', () => {
  it('считает смещение по базе поясов, с летним временем', () => {
    expect(zoneOffsetMinutes('Asia/Krasnoyarsk', WINTER)).toBe(420)
    expect(zoneOffsetMinutes('Asia/Calcutta', WINTER)).toBe(330)
    expect(zoneOffsetMinutes('Asia/Kolkata', WINTER)).toBe(330)
    expect(zoneOffsetMinutes('Asia/Kathmandu', WINTER)).toBe(345)
    expect(zoneOffsetMinutes('America/Sao_Paulo', WINTER)).toBe(-180)
    expect(zoneOffsetMinutes('Europe/Bucharest', WINTER)).toBe(120)
    expect(zoneOffsetMinutes('Europe/Bucharest', SUMMER)).toBe(180)
    expect(zoneOffsetMinutes('Etc/GMT-7', WINTER)).toBe(420)
    expect(zoneOffsetMinutes('UTC', WINTER)).toBe(0)
  })
  it('неизвестный пояс — null', () => {
    expect(zoneOffsetMinutes('Mars/Olympus_Mons', WINTER)).toBeNull()
    expect(isKnownTimeZone('Mars/Olympus_Mons')).toBe(false)
    expect(isKnownTimeZone('Europe/Kiev')).toBe(true)
    expect(isKnownTimeZone('Europe/Kyiv')).toBe(true)
  })
})

describe('formatOffsetLabel', () => {
  it('пишет как в контракте', () => {
    expect(formatOffsetLabel(0)).toBe('UTC')
    expect(formatOffsetLabel(420)).toBe('UTC+7')
    expect(formatOffsetLabel(330)).toBe('UTC+5:30')
    expect(formatOffsetLabel(345)).toBe('UTC+5:45')
    expect(formatOffsetLabel(-180)).toBe('UTC-3')
    expect(formatOffsetLabel(-570)).toBe('UTC-9:30')
  })
})

describe('formatPeerLocalTime', () => {
  const krsk = { timeZone: 'Asia/Krasnoyarsk', city: 'Красноярск', offsetMinutes: 420 }

  it('«14:30, Красноярск» — время по поясу собеседника, 24 ч', () => {
    expect(formatPeerLocalTime(krsk, WINTER, MSK)).toBe('14:30, Красноярск')
  })
  it('полночь — 00:00, а не 24:00', () => {
    expect(formatPeerLocalTime(krsk, new Date('2026-01-15T17:00:00Z'), MSK)).toBe('00:00, Красноярск')
  })
  it('время совпадает с моим — строки нет', () => {
    expect(formatPeerLocalTime(krsk, WINTER, 420)).toBeNull()
  })
  it('нет данных — строки нет', () => {
    expect(formatPeerLocalTime(null, WINTER, MSK)).toBeNull()
    expect(formatPeerLocalTime(undefined, WINTER, MSK)).toBeNull()
  })
  it('пояс без города — смещение', () => {
    expect(formatPeerLocalTime({ timeZone: 'Etc/GMT-7', city: null, offsetMinutes: 420 }, WINTER, MSK)).toBe('14:30, UTC+7')
    expect(formatPeerLocalTime({ timeZone: 'UTC', city: null, offsetMinutes: 0 }, WINTER, MSK)).toBe('07:30, UTC')
    expect(formatPeerLocalTime({ timeZone: 'Asia/Calcutta', city: null, offsetMinutes: 330 }, WINTER, MSK)).toBe('13:00, UTC+5:30')
  })
  it('пояс, которого браузер не знает, — по смещению с сервера', () => {
    expect(formatPeerLocalTime({ timeZone: 'Mars/Olympus_Mons', city: 'Олимп', offsetMinutes: 420 }, WINTER, MSK)).toBe('14:30, Олимп')
    expect(formatPeerLocalTime({ timeZone: 'Mars/Olympus_Mons', city: null, offsetMinutes: -180 }, WINTER, MSK)).toBe('04:30, UTC-3')
    expect(formatPeerLocalTime({ timeZone: 'Mars/Olympus_Mons', city: null, offsetMinutes: 180 }, WINTER, MSK)).toBeNull()
  })
  it('летнее время: смещение берётся из базы поясов, а не устаревшее с сервера', () => {
    const bucharest = { timeZone: 'Europe/Bucharest', city: 'Бухарест', offsetMinutes: 120 }
    // Зимой Бухарест на час позади Москвы, летом — совпадает с ней.
    expect(formatPeerLocalTime(bucharest, WINTER, MSK)).toBe('09:30, Бухарест')
    expect(formatPeerLocalTime(bucharest, SUMMER, MSK)).toBeNull()
    expect(formatPeerLocalTime(bucharest, SUMMER, 420)).toBe('10:30, Бухарест')
  })
})

describe('formatLocalTimeLabel (свой экран настроек)', () => {
  it('показывает и при совпадении с моим временем', () => {
    const krsk = { timeZone: 'Asia/Krasnoyarsk', city: 'Красноярск', offsetMinutes: 420 }
    expect(formatLocalTimeLabel(krsk, WINTER)).toBe('14:30, Красноярск')
    expect(formatLocalTimeLabel(null, WINTER)).toBeNull()
  })
})

describe('msUntilNextMinute', () => {
  it('до границы минуты плюс запас', () => {
    expect(msUntilNextMinute(Date.UTC(2026, 0, 1, 10, 0, 59, 900), 50)).toBe(150)
    expect(msUntilNextMinute(Date.UTC(2026, 0, 1, 10, 0, 0, 0), 50)).toBe(60_050)
  })
})

describe('normalizeDeviceTimeZone', () => {
  it('имена IANA — как есть', () => {
    expect(normalizeDeviceTimeZone('Asia/Krasnoyarsk')).toBe('Asia/Krasnoyarsk')
    expect(normalizeDeviceTimeZone('America/Argentina/Buenos_Aires')).toBe('America/Argentina/Buenos_Aires')
    expect(normalizeDeviceTimeZone('Etc/GMT+3')).toBe('Etc/GMT+3')
    expect(normalizeDeviceTimeZone('UTC')).toBe('UTC')
  })
  it('голое смещение в целых часах — в Etc/GMT с обратным знаком; дробное и мусор — не шлём', () => {
    expect(normalizeDeviceTimeZone('+07:00')).toBe('Etc/GMT-7')
    expect(normalizeDeviceTimeZone('GMT-03:00')).toBe('Etc/GMT+3')
    expect(normalizeDeviceTimeZone('+00:00')).toBe('UTC')
    expect(normalizeDeviceTimeZone('+05:30')).toBeNull()
    expect(normalizeDeviceTimeZone('Etc/Unknown')).toBeNull()
    expect(normalizeDeviceTimeZone('')).toBeNull()
    expect(normalizeDeviceTimeZone(undefined)).toBeNull()
    expect(normalizeDeviceTimeZone('Asia/Krasnoyarsk; DROP')).toBeNull()
  })
})

describe('настройка «Показывать моё местное время»', () => {
  it('normalizeShareState', () => {
    expect(normalizeShareState({ shareLocalTime: false, shareLocalTimeAt: 1700 })).toEqual({ shareLocalTime: false, shareLocalTimeAt: 1700 })
    expect(normalizeShareState({ shareLocalTime: true })).toEqual({ shareLocalTime: true, shareLocalTimeAt: 0 })
    expect(normalizeShareState({ shareLocalTime: 'no' })).toBeNull()
    expect(normalizeShareState(null)).toBeNull()
  })
  it('pickNewerShareState — новее по часам сервера, при равенстве пришедшее', () => {
    const off = { shareLocalTime: false, shareLocalTimeAt: 2000 }
    const on = { shareLocalTime: true, shareLocalTimeAt: 1000 }
    expect(pickNewerShareState(off, on)).toBe(off)
    expect(pickNewerShareState(on, off)).toBe(off)
    expect(pickNewerShareState(null, on)).toBe(on)
    expect(pickNewerShareState(on, null)).toBe(on)
    const sameAt = { shareLocalTime: true, shareLocalTimeAt: 2000 }
    expect(pickNewerShareState(off, sameAt)).toBe(sameAt)
  })
})
