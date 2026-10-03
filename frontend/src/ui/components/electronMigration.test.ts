import { describe, expect, it } from 'vitest'
import {
  ELECTRON_MIGRATION_SNOOZE_KEY,
  ELECTRON_MIGRATION_SNOOZE_MS,
  compareVersions,
  detectMigrationHost,
  isMigrationOffer,
  parseNativeUpdateAnswer,
  readSnooze,
  writeSnooze,
  type ElectronUpdateBridge,
  type MigrationStorage,
} from './electronMigration'

const UA_WIN =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) eblusha-plus-desktop/0.7.5 Chrome/124.0.6367.243 Electron/30.5.1 Safari/537.36'
const UA_MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) eblusha-plus-desktop/0.7.5 Chrome/124.0.6367.243 Electron/30.5.1 Safari/537.36'
const UA_LINUX =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) eblusha-plus-desktop/0.7.5 Chrome/124.0.6367.243 Electron/30.5.1 Safari/537.36'
const UA_CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36'

const fn = async () => ({})
const FULL: ElectronUpdateBridge = { settingsGetState: fn, settingsCheckUpdate: fn, openSettings: fn }

/** Ответ settings:getState из main.ts. */
const getState = (current: string, update: Record<string, unknown>) => ({
  currentVersion: current,
  latestVersion: current,
  serverLatestVersion: update.latestVersion,
  notificationsEnabled: true,
  update,
})

function memStorage(): MigrationStorage {
  const m = new Map<string, string>()
  return {
    getItem: (k) => (m.has(k) ? (m.get(k) as string) : null),
    setItem: (k, v) => void m.set(k, String(v)),
    removeItem: (k) => void m.delete(k),
  }
}

describe('detectMigrationHost', () => {
  it('обычный браузер — не Electron', () => {
    expect(detectMigrationHost({ native: FULL, userAgent: UA_CHROME, platform: 'Win32' })).toBe('browser')
  })
  it('Electron на Windows с мостом', () => {
    expect(detectMigrationHost({ native: FULL, userAgent: UA_WIN, platform: 'Win32' })).toBe('electron-windows')
  })
  it('Mac — никогда (и по userAgent, и по platform)', () => {
    expect(detectMigrationHost({ native: FULL, userAgent: UA_MAC, platform: 'MacIntel' })).toBe('electron-mac')
    expect(detectMigrationHost({ native: FULL, userAgent: UA_WIN, platform: 'MacIntel' })).toBe('electron-mac')
  })
  it('Linux — не Windows', () => {
    expect(detectMigrationHost({ native: FULL, userAgent: UA_LINUX, platform: 'Linux x86_64' })).toBe('electron-other-os')
  })
  it('без моста или без openSettings — нельзя', () => {
    expect(detectMigrationHost({ native: null, userAgent: UA_WIN, platform: 'Win32' })).toBe('electron-no-bridge')
    expect(detectMigrationHost({ native: { settingsGetState: fn }, userAgent: UA_WIN, platform: 'Win32' })).toBe('electron-no-bridge')
    expect(detectMigrationHost({ native: { openSettings: fn }, userAgent: UA_WIN, platform: 'Win32' })).toBe('electron-no-bridge')
  })
  it('мост только с settingsCheckUpdate — годится', () => {
    expect(detectMigrationHost({ native: { settingsCheckUpdate: fn, openSettings: fn }, userAgent: UA_WIN, platform: 'Win32' })).toBe(
      'electron-windows',
    )
  })
})

describe('compareVersions', () => {
  it('как compareSemver в main.ts', () => {
    expect(compareVersions('2.0.0', '0.7.5')).toBe(1)
    expect(compareVersions('0.7.6', '2.0.0')).toBe(-1)
    expect(compareVersions('2.0.0', '2.0.0')).toBe(0)
    expect(compareVersions('v2.0.1', '2.0.0')).toBe(1)
    expect(compareVersions('2.0.0-beta.1', '2.0.0')).toBe(0)
    expect(compareVersions('10.0.0', '9.9.9')).toBe(1)
    expect(compareVersions('', '2.0.0')).toBeNull()
    expect(compareVersions(null, '2.0.0')).toBeNull()
  })
})

describe('parseNativeUpdateAnswer + isMigrationOffer', () => {
  it('getState: доступна 2.0.0 → переезд', () => {
    const a = parseNativeUpdateAnswer(getState('0.7.5', { status: 'available', latestVersion: '2.0.0', available: true, downloaded: false }))
    expect(a).toEqual({ available: true, latestVersion: '2.0.0', currentVersion: '0.7.5', status: 'available', downloaded: false })
    expect(isMigrationOffer(a)).toBe(true)
  })
  it('getState: 2.0.0 скачана', () => {
    const a = parseNativeUpdateAnswer(getState('0.7.5', { status: 'downloaded', latestVersion: '2.0.0', available: true, downloaded: true }))
    expect(a.downloaded).toBe(true)
    expect(isMigrationOffer(a)).toBe(true)
  })
  it('getState: 2.0.1 и новее — тоже переезд', () => {
    const a = parseNativeUpdateAnswer(getState('0.7.5', { status: 'available', latestVersion: '2.3.1', available: true, downloaded: false }))
    expect(isMigrationOffer(a)).toBe(true)
  })
  it('getState: 0.7.6 — обычное обновление Electron, не переезд', () => {
    const a = parseNativeUpdateAnswer(getState('0.7.5', { status: 'available', latestVersion: '0.7.6', available: true, downloaded: false }))
    expect(isMigrationOffer(a)).toBe(false)
  })
  it('getState: обновления нет', () => {
    const a = parseNativeUpdateAnswer(getState('0.7.5', { status: 'idle', latestVersion: '0.7.5', available: false, downloaded: false }))
    expect(isMigrationOffer(a)).toBe(false)
  })
  it('getState: ошибка проверки — available=false', () => {
    const a = parseNativeUpdateAnswer(
      getState('0.7.5', { status: 'error', latestVersion: '2.0.0', available: false, downloaded: false, message: 'net' }),
    )
    expect(isMigrationOffer(a)).toBe(false)
  })
  it('идёт проверка, а 2.0.0 уже была найдена — остаётся переездом', () => {
    const a = parseNativeUpdateAnswer(getState('0.7.5', { status: 'checking', latestVersion: '2.0.0', available: true, downloaded: false }))
    expect(a.status).toBe('checking')
    expect(isMigrationOffer(a)).toBe(true)
  })
  it('версия не новее установленной — нет', () => {
    const a = parseNativeUpdateAnswer(getState('2.0.0', { status: 'available', latestVersion: '2.0.0', available: true, downloaded: false }))
    expect(isMigrationOffer(a)).toBe(false)
  })
  it('checkUpdate: { available, version, update }', () => {
    const a = parseNativeUpdateAnswer({
      available: true,
      version: '2.0.0',
      downloaded: false,
      update: { status: 'available', latestVersion: '2.0.0', available: true, downloaded: false },
    })
    expect(isMigrationOffer(a)).toBe(true)
  })
  it('checkUpdate без update (плоский ответ)', () => {
    expect(isMigrationOffer(parseNativeUpdateAnswer({ available: true, version: '2.0.0' }))).toBe(true)
    expect(isMigrationOffer(parseNativeUpdateAnswer({ available: false, version: null }))).toBe(false)
  })
  it('checkUpdate вне Windows/в dev-сборке: not_supported', () => {
    const a = parseNativeUpdateAnswer({
      available: false,
      version: null,
      reason: 'not_supported',
      update: { status: 'idle', latestVersion: '0.7.5', available: false, downloaded: false },
    })
    expect(a.status).toBe('not_supported')
    expect(isMigrationOffer(a)).toBe(false)
  })
  it('мусор вместо ответа', () => {
    for (const raw of [undefined, null, 42, 'x', [], { update: 'x' }]) {
      expect(isMigrationOffer(parseNativeUpdateAnswer(raw))).toBe(false)
    }
    expect(isMigrationOffer(null)).toBe(false)
  })
})

describe('«Позже»', () => {
  const now = 1_700_000_000_000
  it('пишет срок и читает его до истечения', () => {
    const s = memStorage()
    const until = writeSnooze(s, now)
    expect(until).toBe(now + ELECTRON_MIGRATION_SNOOZE_MS)
    expect(readSnooze(s, now + 1000)).toBe(until)
    expect(readSnooze(s, until - 1)).toBe(until)
    expect(readSnooze(s, until)).toBeNull()
  })
  it('нет записи / мусор / часы назад — не отложен', () => {
    const s = memStorage()
    expect(readSnooze(s, now)).toBeNull()
    s.setItem(ELECTRON_MIGRATION_SNOOZE_KEY, 'abc')
    expect(readSnooze(s, now)).toBeNull()
    s.setItem(ELECTRON_MIGRATION_SNOOZE_KEY, String(now + ELECTRON_MIGRATION_SNOOZE_MS * 5))
    expect(readSnooze(s, now)).toBeNull()
  })
  it('без хранилища или когда оно бросает — всё равно отдаёт срок', () => {
    expect(writeSnooze(null, now)).toBe(now + ELECTRON_MIGRATION_SNOOZE_MS)
    const throwing: MigrationStorage = {
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {
        throw new Error('denied')
      },
      removeItem: () => {},
    }
    expect(writeSnooze(throwing, now)).toBe(now + ELECTRON_MIGRATION_SNOOZE_MS)
    expect(readSnooze(throwing, now)).toBeNull()
  })
})
