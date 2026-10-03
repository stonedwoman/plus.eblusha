import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ELECTRON_MIGRATION_SESSION_KEY,
  ELECTRON_MIGRATION_SNOOZE_KEY,
  MIGRATION_TIMING,
  compareVersions,
  detectMigrationHost,
  isMigrationOffer,
  isWindowsTooOldForNative,
  parseNativeUpdateAnswer,
  readSnooze,
  snoozeMsFor,
  startMigrationWatcher,
  writeSnooze,
  type ElectronUpdateBridge,
  type MigrationEnv,
  type MigrationStorage,
  type NativeUpdateAnswer,
} from './electronMigration'

const UA_WIN =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) eblusha-plus-desktop/0.7.5 Chrome/124.0.6367.243 Electron/30.5.1 Safari/537.36'
const UA_MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) eblusha-plus-desktop/0.7.5 Chrome/124.0.6367.243 Electron/30.5.1 Safari/537.36'
const UA_LINUX =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) eblusha-plus-desktop/0.7.5 Chrome/124.0.6367.243 Electron/30.5.1 Safari/537.36'
const UA_CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36'

const DAY = 24 * 60 * 60 * 1000
const fn = async () => ({})
const FULL: ElectronUpdateBridge = { settingsGetState: fn, openSettings: fn }

/** Ответ settings:getState из main.ts. */
const getState = (current: string, update: Record<string, unknown>) => ({
  currentVersion: current,
  latestVersion: current,
  serverLatestVersion: update.latestVersion,
  notificationsEnabled: true,
  update,
})

function memStorage(): MigrationStorage & { map: Map<string, string> } {
  const map = new Map<string, string>()
  return {
    map,
    getItem: (k) => (map.has(k) ? (map.get(k) as string) : null),
    setItem: (k, v) => void map.set(k, String(v)),
    removeItem: (k) => void map.delete(k),
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
  it('без моста, без openSettings или без settingsGetState — нельзя', () => {
    expect(detectMigrationHost({ native: null, userAgent: UA_WIN, platform: 'Win32' })).toBe('electron-no-bridge')
    expect(detectMigrationHost({ native: { settingsGetState: fn }, userAgent: UA_WIN, platform: 'Win32' })).toBe('electron-no-bridge')
    expect(detectMigrationHost({ native: { openSettings: fn }, userAgent: UA_WIN, platform: 'Win32' })).toBe('electron-no-bridge')
  })
  it('мост только с settingsCheckUpdate — НЕ годится (проверку ленты сами не запускаем)', () => {
    const checkOnly = { settingsCheckUpdate: fn, openSettings: fn } as unknown as ElectronUpdateBridge
    expect(detectMigrationHost({ native: checkOnly, userAgent: UA_WIN, platform: 'Win32' })).toBe('electron-no-bridge')
  })
})

describe('isWindowsTooOldForNative (UA-CH platformVersion)', () => {
  it('Windows 10 1507–1803 (1–6) — стара', () => {
    for (const v of ['1.0.0', '3.0.0', '6.0.0']) expect(isWindowsTooOldForNative(v)).toBe(true)
  })
  it('1809 и новее, Windows 11 — годится', () => {
    for (const v of ['7.0.0', '8.0.0', '10.0.0', '15.0.0', '19.0.0']) expect(isWindowsTooOldForNative(v)).toBe(false)
  })
  it('0.x, пусто, мусор — не решаем (годится)', () => {
    for (const v of ['0.0.0', '0.3.0', '', 'x', null, undefined]) expect(isWindowsTooOldForNative(v)).toBe(false)
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
  it('доступна 2.0.0 → переезд', () => {
    const a = parseNativeUpdateAnswer(getState('0.7.5', { status: 'available', latestVersion: '2.0.0', available: true, downloaded: false }))
    expect(a).toEqual({ available: true, latestVersion: '2.0.0', currentVersion: '0.7.5', status: 'available', downloaded: false })
    expect(isMigrationOffer(a)).toBe(true)
  })
  it('2.0.0 скачана', () => {
    const a = parseNativeUpdateAnswer(getState('0.7.5', { status: 'downloaded', latestVersion: '2.0.0', available: true, downloaded: true }))
    expect(a.downloaded).toBe(true)
    expect(isMigrationOffer(a)).toBe(true)
  })
  it('2.0.1 и новее — тоже переезд', () => {
    const a = parseNativeUpdateAnswer(getState('0.7.5', { status: 'available', latestVersion: '2.3.1', available: true, downloaded: false }))
    expect(isMigrationOffer(a)).toBe(true)
  })
  it('0.7.6 — обычное обновление Electron, не переезд', () => {
    const a = parseNativeUpdateAnswer(getState('0.7.5', { status: 'available', latestVersion: '0.7.6', available: true, downloaded: false }))
    expect(isMigrationOffer(a)).toBe(false)
  })
  it('обновления нет', () => {
    const a = parseNativeUpdateAnswer(getState('0.7.5', { status: 'idle', latestVersion: '0.7.5', available: false, downloaded: false }))
    expect(isMigrationOffer(a)).toBe(false)
  })
  it('ошибка проверки — available=false', () => {
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
  it('плоский ответ без update (форма checkUpdate) — не наш, «нет»', () => {
    expect(isMigrationOffer(parseNativeUpdateAnswer({ available: true, version: '2.0.0' }))).toBe(false)
  })
  it('мусор вместо ответа', () => {
    for (const raw of [undefined, null, 42, 'x', [], { update: 'x' }]) {
      expect(isMigrationOffer(parseNativeUpdateAnswer(raw))).toBe(false)
    }
    expect(isMigrationOffer(null)).toBe(false)
  })
})

describe('«Позже»: 3 → 14 → 30 → 30 дней', () => {
  const now = 1_700_000_000_000
  it('сроки по счёту нажатий', () => {
    expect(snoozeMsFor(1)).toBe(3 * DAY)
    expect(snoozeMsFor(2)).toBe(14 * DAY)
    expect(snoozeMsFor(3)).toBe(30 * DAY)
    expect(snoozeMsFor(9)).toBe(30 * DAY)
    expect(snoozeMsFor(0)).toBe(3 * DAY)
  })
  it('каждое следующее «Позже» — дольше; срок читается до истечения', () => {
    const s = memStorage()
    const a = writeSnooze(s, now)
    expect(a).toEqual({ until: now + 3 * DAY, count: 1 })
    expect(readSnooze(s, now + 1000)).toEqual(a)
    expect(readSnooze(s, a.until! - 1).until).toBe(a.until)
    expect(readSnooze(s, a.until!)).toEqual({ until: null, count: 1 })
    const b = writeSnooze(s, a.until! + 1)
    expect(b).toEqual({ until: a.until! + 1 + 14 * DAY, count: 2 })
    const c = writeSnooze(s, b.until! + 1)
    expect(c.count).toBe(3)
    expect(c.until! - (b.until! + 1)).toBe(30 * DAY)
    const d = writeSnooze(s, c.until! + 1)
    expect(d.until! - (c.until! + 1)).toBe(30 * DAY)
  })
  it('нет записи / мусор / часы назад — не отложен (счёт сохраняется)', () => {
    const s = memStorage()
    expect(readSnooze(s, now)).toEqual({ until: null, count: 0 })
    s.setItem(ELECTRON_MIGRATION_SNOOZE_KEY, 'abc')
    expect(readSnooze(s, now)).toEqual({ until: null, count: 0 })
    // срок первого «Позже» — 3 дня; запись на 10 дней вперёд = часы перевели назад
    s.setItem(ELECTRON_MIGRATION_SNOOZE_KEY, JSON.stringify({ until: now + 10 * DAY, count: 1 }))
    expect(readSnooze(s, now)).toEqual({ until: null, count: 1 })
    // а для второго «Позже» 10 дней — законно
    s.setItem(ELECTRON_MIGRATION_SNOOZE_KEY, JSON.stringify({ until: now + 10 * DAY, count: 2 }))
    expect(readSnooze(s, now)).toEqual({ until: now + 10 * DAY, count: 2 })
  })
  it('без хранилища или когда оно бросает — всё равно отдаёт срок', () => {
    expect(writeSnooze(null, now)).toEqual({ until: now + 3 * DAY, count: 1 })
    const throwing: MigrationStorage = {
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {
        throw new Error('denied')
      },
      removeItem: () => {},
    }
    expect(writeSnooze(throwing, now)).toEqual({ until: now + 3 * DAY, count: 1 })
    expect(readSnooze(throwing, now)).toEqual({ until: null, count: 0 })
  })
})

// ── Когда спрашивать Electron (settingsGetState может мигнуть консолью — спрашиваем редко) ──

type Rig = {
  env: MigrationEnv
  calls: () => number
  answers: (NativeUpdateAnswer | null)[]
  tooOld: () => number
  markTooOld: () => void
  setBadge: (v: boolean | null) => void
  setElectron: (latest: string | null, opts?: { fails?: boolean }) => void
  session: ReturnType<typeof memStorage>
}

function rig(opts: {
  latest?: string | null
  badge?: boolean | null
  session?: 'yes' | 'no'
  platformVersion?: string | null
  fails?: boolean
}): Rig {
  let latest = opts.latest ?? null
  let fails = !!opts.fails
  let badge: boolean | null = opts.badge === undefined ? null : opts.badge
  let calls = 0
  let tooOld = 0
  const answers: (NativeUpdateAnswer | null)[] = []
  const session = memStorage()
  if (opts.session) session.setItem(ELECTRON_MIGRATION_SESSION_KEY, opts.session)
  const native: ElectronUpdateBridge = {
    openSettings: fn,
    settingsGetState: async () => {
      calls += 1
      if (fails) throw new Error('ipc')
      const available = !!latest && (compareVersions(latest, '0.7.5') ?? 0) > 0
      return getState('0.7.5', { status: available ? 'available' : 'idle', latestVersion: latest ?? '0.7.5', available, downloaded: false })
    },
  }
  const env: MigrationEnv = {
    native,
    userAgent: UA_WIN,
    platform: 'Win32',
    storage: memStorage(),
    session,
    now: () => Date.now(),
    readBadge: () => badge,
    platformVersion: async () => (opts.platformVersion === undefined ? '15.0.0' : opts.platformVersion),
    firstAskDelayMs: 4000,
  }
  return {
    env,
    calls: () => calls,
    answers,
    tooOld: () => tooOld,
    markTooOld: () => {
      tooOld += 1
    },
    setBadge: (v) => {
      badge = v
    },
    setElectron: (l, o) => {
      latest = l
      if (o?.fails !== undefined) fails = o.fails
    },
    session,
  }
}

function watch(r: Rig, snoozed = false) {
  return startMigrationWatcher(r.env, {
    snoozed,
    onAnswer: (a) => r.answers.push(a),
    onTooOld: r.markTooOld,
  })
}

const lastOffer = (r: Rig) => isMigrationOffer(r.answers[r.answers.length - 1] ?? null)
const HOUR = 60 * 60_000

describe('startMigrationWatcher — когда спрашивать Electron', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(1_700_000_000_000)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('первый запуск, обновлений нет: ни одного вопроса за сутки', async () => {
    const r = rig({ latest: null, badge: null })
    const w = watch(r)
    await vi.advanceTimersByTimeAsync(1500)
    r.setBadge(false) // preload выставил исходное «нет»
    await vi.advanceTimersByTimeAsync(24 * HOUR)
    expect(r.calls()).toBe(0)
    expect(r.session.getItem(ELECTRON_MIGRATION_SESSION_KEY)).toBe('no')
    w.stop()
  })

  it('первый запуск: Electron нашёл 2.0.0 и зажёг «!» → один вопрос, баннер; дальше тишина', async () => {
    const r = rig({ latest: null, badge: false })
    const w = watch(r)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(r.calls()).toBe(0)
    r.setElectron('2.0.0')
    r.setBadge(true)
    await vi.advanceTimersByTimeAsync(MIGRATION_TIMING.badgePollMs + MIGRATION_TIMING.badgeSettleMs + 100)
    expect(r.calls()).toBe(1)
    expect(lastOffer(r)).toBe(true)
    expect(r.session.getItem(ELECTRON_MIGRATION_SESSION_KEY)).toBe('yes')
    await vi.advanceTimersByTimeAsync(48 * HOUR)
    expect(r.calls()).toBe(1)
    w.stop()
  })

  it('«!» уже горит, когда баннер появился в разметке → вопрос через firstAskDelay', async () => {
    const r = rig({ latest: '2.0.0', badge: true })
    const w = watch(r)
    await vi.advanceTimersByTimeAsync(3999)
    expect(r.calls()).toBe(0)
    await vi.advanceTimersByTimeAsync(10)
    expect(r.calls()).toBe(1)
    expect(lastOffer(r)).toBe(true)
    w.stop()
  })

  it('перезагрузка страницы, а обновления в этом запуске не было: ни одного вопроса', async () => {
    const r = rig({ latest: null, badge: null, session: 'no' })
    const w = watch(r)
    await vi.advanceTimersByTimeAsync(1200)
    r.setBadge(false)
    await vi.advanceTimersByTimeAsync(24 * HOUR)
    expect(r.calls()).toBe(0)
    w.stop()
  })

  it('перезагрузка страницы, обновление было («!» сброшен в false) → один вопрос, потом раз в 6 ч', async () => {
    const r = rig({ latest: '2.0.0', badge: null, session: 'yes' })
    const w = watch(r)
    await vi.advanceTimersByTimeAsync(1200)
    r.setBadge(false)
    await vi.advanceTimersByTimeAsync(4000)
    expect(r.calls()).toBe(1)
    expect(lastOffer(r)).toBe(true)
    await vi.advanceTimersByTimeAsync(6 * HOUR - 4000)
    expect(r.calls()).toBe(1)
    r.setElectron(null) // ленту откатили — «!» не скажет (он и так false)
    await vi.advanceTimersByTimeAsync(4000 + 10)
    expect(r.calls()).toBe(2)
    expect(lastOffer(r)).toBe(false)
    // обновления нет и «!» на месте — дальше ждём «!», без вопросов
    await vi.advanceTimersByTimeAsync(24 * HOUR)
    expect(r.calls()).toBe(2)
    w.stop()
  })

  it('0.7.6 (не переезд): вопрос по «!», потом раз в 6 ч — «!» не погаснет, когда в ленте будет 2.0.0', async () => {
    const r = rig({ latest: null, badge: false })
    const w = watch(r)
    r.setElectron('0.7.6')
    r.setBadge(true)
    await vi.advanceTimersByTimeAsync(5000)
    expect(r.calls()).toBe(1)
    expect(lastOffer(r)).toBe(false)
    r.setElectron('2.0.0')
    await vi.advanceTimersByTimeAsync(6 * HOUR)
    expect(r.calls()).toBe(2)
    expect(lastOffer(r)).toBe(true)
    // теперь переезд при горящем «!» — следующую перемену скажет «!»
    await vi.advanceTimersByTimeAsync(24 * HOUR)
    expect(r.calls()).toBe(2)
    w.stop()
  })

  it('«!» погас → прячем без вопроса', async () => {
    const r = rig({ latest: '2.0.0', badge: true })
    const w = watch(r)
    await vi.advanceTimersByTimeAsync(5000)
    expect(r.calls()).toBe(1)
    r.setBadge(false)
    await vi.advanceTimersByTimeAsync(MIGRATION_TIMING.badgePollMs + 10)
    expect(r.calls()).toBe(1)
    expect(r.answers[r.answers.length - 1]).toBeNull()
    expect(r.session.getItem(ELECTRON_MIGRATION_SESSION_KEY)).toBe('no')
    w.stop()
  })

  it('отложено («Позже»): ни одного вопроса; срок вышел — один вопрос', async () => {
    const r = rig({ latest: '2.0.0', badge: true })
    const w = watch(r, true)
    await vi.advanceTimersByTimeAsync(24 * HOUR)
    expect(r.calls()).toBe(0)
    w.setSnoozed(false)
    await vi.advanceTimersByTimeAsync(4010)
    expect(r.calls()).toBe(1)
    expect(lastOffer(r)).toBe(true)
    w.stop()
  })

  it('Windows 10 до 1809: мост не трогаем вовсе', async () => {
    const r = rig({ latest: '2.0.0', badge: true, platformVersion: '6.0.0' })
    const w = watch(r)
    await vi.advanceTimersByTimeAsync(24 * HOUR)
    expect(r.calls()).toBe(0)
    expect(r.tooOld()).toBe(1)
    w.stop()
  })

  it('мост бросает: ответа нет, перепроверка раз в 6 ч', async () => {
    const r = rig({ latest: '2.0.0', badge: true, fails: true })
    const w = watch(r)
    await vi.advanceTimersByTimeAsync(4010)
    expect(r.calls()).toBe(1)
    expect(r.answers).toEqual([null])
    await vi.advanceTimersByTimeAsync(6 * HOUR)
    expect(r.calls()).toBe(2)
    w.stop()
  })

  it('после stop — тишина', async () => {
    const r = rig({ latest: '2.0.0', badge: true })
    const w = watch(r)
    w.stop()
    await vi.advanceTimersByTimeAsync(24 * HOUR)
    expect(r.calls()).toBe(0)
  })
})
