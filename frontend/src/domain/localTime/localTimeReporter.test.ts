import { describe, expect, it } from 'vitest'
import type { LocalTimeShareState } from './localTime'
import {
  createLocalTimeReporter,
  REPORT_AFTER_CONNECT_FALLBACK_MS,
  REPORT_RETRY_MS,
  type LocalTimeReportPayload,
} from './localTimeReporter'

const ME = 'u-me'

/** Ручные часы, таймеры, «сокет» и «localStorage»: тест управляет всем сам. */
function harness(opts: { tz?: string | null; userId?: string | null; stored?: LocalTimeShareState | null; connected?: boolean } = {}) {
  let t = 1_000_000
  const timers = new Map<number, { at: number; fn: () => void }>()
  let nextHandle = 1
  let tz: string | null = opts.tz === undefined ? 'Asia/Krasnoyarsk' : opts.tz
  let connected = opts.connected ?? true
  const storage = new Map<string, LocalTimeShareState>()
  if (opts.stored) storage.set(ME, opts.stored)
  const sent: { payload: LocalTimeReportPayload; cb: (err: unknown, ack: unknown) => void }[] = []
  const shown: (LocalTimeShareState | null)[] = []
  const userId = opts.userId === undefined ? ME : opts.userId

  const r = createLocalTimeReporter({
    isConnected: () => connected,
    emitReport: (payload, cb) => sent.push({ payload, cb }),
    detectTimeZone: () => tz,
    getUserId: () => userId,
    loadShare: (uid) => storage.get(uid) ?? null,
    saveShare: (uid, s) => storage.set(uid, s),
    onShareState: (s) => shown.push(s),
    setTimer: (fn, ms) => {
      const h = nextHandle++
      timers.set(h, { at: t + ms, fn })
      return h
    },
    clearTimer: (h) => {
      timers.delete(h as number)
    },
  })
  function advance(ms: number) {
    const target = t + ms
    for (;;) {
      const due = [...timers.entries()].filter(([, v]) => v.at <= target).sort((a, b) => a[1].at - b[1].at)[0]
      if (!due) break
      timers.delete(due[0])
      t = due[1].at
      due[1].fn()
    }
    t = target
  }
  return {
    r,
    sent,
    shown,
    storage,
    advance,
    setTz: (v: string | null) => {
      tz = v
    },
    setConnected: (v: boolean) => {
      connected = v
    },
    lastShown: () => shown[shown.length - 1],
  }
}

describe('localTimeReporter: когда шлём пояс', () => {
  it('после connect ждёт presence:state и шлёт пояс сразу за ним', () => {
    const h = harness()
    h.r.onConnect()
    expect(h.sent).toHaveLength(0)
    h.r.onPresenceSent()
    expect(h.sent.map((s) => s.payload)).toEqual([{ timeZone: 'Asia/Krasnoyarsk' }])
    // Следующие presence:state (фокус/блюр) пояс не повторяют.
    h.r.onPresenceSent()
    h.advance(REPORT_AFTER_CONNECT_FALLBACK_MS * 2)
    expect(h.sent).toHaveLength(1)
  })

  it('presence:state не ушёл — шлёт сам через 2 с', () => {
    const h = harness()
    h.r.onConnect()
    h.advance(REPORT_AFTER_CONNECT_FALLBACK_MS - 1)
    expect(h.sent).toHaveLength(0)
    h.advance(1)
    expect(h.sent).toHaveLength(1)
  })

  it('каждый reconnect — снова', () => {
    const h = harness()
    h.r.onConnect()
    h.r.onPresenceSent()
    h.r.onDisconnect()
    h.r.onConnect()
    h.r.onPresenceSent()
    expect(h.sent).toHaveLength(2)
  })

  it('обрыв до presence:state отменяет запасной таймер', () => {
    const h = harness()
    h.r.onConnect()
    h.r.onDisconnect()
    h.advance(REPORT_AFTER_CONNECT_FALLBACK_MS * 2)
    expect(h.sent).toHaveLength(0)
  })

  it('без сокета или без пояса — не шлёт', () => {
    const h = harness({ connected: false })
    expect(h.r.reportNow()).toBe(false)
    const h2 = harness({ tz: null })
    h2.r.onConnect()
    h2.r.onPresenceSent()
    expect(h2.sent).toHaveLength(0)
  })

  it('смена пояса системы — шлёт; тот же пояс — нет; пока ждём presence после connect — нет', () => {
    const h = harness()
    h.r.onConnect()
    expect(h.r.checkTimeZone()).toBe(false)
    h.r.onPresenceSent()
    expect(h.r.checkTimeZone()).toBe(false)
    h.setTz('Europe/Bucharest')
    expect(h.r.checkTimeZone()).toBe(true)
    expect(h.sent.map((s) => s.payload.timeZone)).toEqual(['Asia/Krasnoyarsk', 'Europe/Bucharest'])
    expect(h.r.checkTimeZone()).toBe(false)
  })
})

describe('localTimeReporter: напоминание о настройке', () => {
  it('пока с сервера ничего не получали — полей настройки нет', () => {
    const h = harness()
    h.r.onConnect()
    h.r.onPresenceSent()
    expect(h.sent[0]!.payload).toEqual({ timeZone: 'Asia/Krasnoyarsk' })
  })

  it('сохранённая пара уходит как есть', () => {
    const h = harness({ stored: { shareLocalTime: false, shareLocalTimeAt: 5000 } })
    h.r.onConnect()
    expect(h.lastShown()).toEqual({ shareLocalTime: false, shareLocalTimeAt: 5000 })
    h.r.onPresenceSent()
    expect(h.sent[0]!.payload).toEqual({ timeZone: 'Asia/Krasnoyarsk', shareLocalTime: false, shareLocalTimeAt: 5000 })
  })

  it('ответ ok — его пара сохраняется и показывается (даже если старее: сервер своё слово сказал)', () => {
    const h = harness({ stored: { shareLocalTime: false, shareLocalTimeAt: 5000 } })
    h.r.reportNow()
    h.sent[0]!.cb(null, { ok: true, timeZone: 'Asia/Krasnoyarsk', shareLocalTime: true, shareLocalTimeAt: 4000 })
    expect(h.storage.get(ME)).toEqual({ shareLocalTime: true, shareLocalTimeAt: 4000 })
    expect(h.lastShown()).toEqual({ shareLocalTime: true, shareLocalTimeAt: 4000 })
  })

  it('событие localtime:settings новее сохранённого — сохраняем', () => {
    const h = harness({ stored: { shareLocalTime: true, shareLocalTimeAt: 1000 } })
    h.r.applyServerShare({ shareLocalTime: false, shareLocalTimeAt: 2000 })
    expect(h.storage.get(ME)).toEqual({ shareLocalTime: false, shareLocalTimeAt: 2000 })
    expect(h.sent).toHaveLength(0)
  })

  it('сервер прислал СТАРЕЕ сохранённого (Redis откатился) — держим своё и сразу напоминаем', () => {
    const h = harness({ stored: { shareLocalTime: false, shareLocalTimeAt: 9000 } })
    const res = h.r.applyServerShare({ shareLocalTime: true, shareLocalTimeAt: 0 })
    expect(res).toEqual({ shareLocalTime: false, shareLocalTimeAt: 9000 })
    expect(h.lastShown()).toEqual({ shareLocalTime: false, shareLocalTimeAt: 9000 })
    expect(h.sent.map((s) => s.payload)).toEqual([{ timeZone: 'Asia/Krasnoyarsk', shareLocalTime: false, shareLocalTimeAt: 9000 }])
    // Сервер принял напоминание.
    h.sent[0]!.cb(null, { ok: true, timeZone: 'Asia/Krasnoyarsk', shareLocalTime: false, shareLocalTimeAt: 9000 })
    expect(h.storage.get(ME)).toEqual({ shareLocalTime: false, shareLocalTimeAt: 9000 })
  })

  it('мусор вместо настройки — ничего не трогаем', () => {
    const h = harness({ stored: { shareLocalTime: false, shareLocalTimeAt: 9000 } })
    expect(h.r.applyServerShare({ shareLocalTime: 'yes' })).toBeNull()
    expect(h.storage.get(ME)).toEqual({ shareLocalTime: false, shareLocalTimeAt: 9000 })
  })
})

describe('localTimeReporter: ответы-ошибки', () => {
  it('invalid_time_zone — этот пояс больше не шлём, другой — шлём', () => {
    const h = harness({ tz: 'Bad/Zone' })
    h.r.reportNow()
    h.sent[0]!.cb(null, { ok: false, error: 'invalid_time_zone' })
    expect(h.r.reportNow()).toBe(false)
    h.setTz('Asia/Krasnoyarsk')
    expect(h.r.checkTimeZone()).toBe(true)
  })

  it('rate_limited — повтор через минуту', () => {
    const h = harness()
    h.r.reportNow()
    h.sent[0]!.cb(null, { ok: false, error: 'rate_limited' })
    h.advance(REPORT_RETRY_MS - 1)
    expect(h.sent).toHaveLength(1)
    h.advance(1)
    expect(h.sent).toHaveLength(2)
  })

  it('нет ответа (старый сервер) — без повторов', () => {
    const h = harness()
    h.r.reportNow()
    h.sent[0]!.cb(new Error('operation has timed out'), undefined)
    h.advance(REPORT_RETRY_MS * 3)
    expect(h.sent).toHaveLength(1)
    expect(h.r._state().retryArmed).toBe(false)
  })
})
