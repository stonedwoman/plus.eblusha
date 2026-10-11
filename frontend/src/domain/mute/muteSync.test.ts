/**
 * «Без звука» — хранилище веба (domain/mute/muteSync.ts): порядок по asOf, снапшот-замена, истечение по
 * таймеру, оценка часов сервера. Часы и таймеры подменены.
 */
import { describe, expect, it } from 'vitest'
import { createMuteStore, EXPIRY_SLACK_MS, untilFromWire } from './muteSync'
import { MUTE_FOREVER_ISO, MUTE_FOREVER_MS } from './muteRules'

const T0 = Date.parse('2026-10-11T15:30:00.000Z')
const iso = (ms: number) => new Date(ms).toISOString()

function harness() {
  let now = T0
  const timers: Array<{ fn: () => void; at: number; id: number }> = []
  let seq = 0
  const store = createMuteStore({
    now: () => now,
    setTimer: (fn, ms) => {
      const t = { fn, at: now + ms, id: ++seq }
      timers.push(t)
      return t.id
    },
    clearTimer: (h) => {
      const i = timers.findIndex((t) => t.id === h)
      if (i >= 0) timers.splice(i, 1)
    },
  })
  let renders = 0
  store.subscribe(() => {
    renders += 1
  })
  return {
    store,
    renders: () => renders,
    timers,
    advance(ms: number) {
      now += ms
      for (;;) {
        const due = timers.filter((t) => t.at <= now).sort((a, b) => a.at - b.at)[0]
        if (!due) break
        timers.splice(timers.indexOf(due), 1)
        due.fn()
      }
    },
    setNow(ms: number) {
      now = ms
    },
  }
}

const list = (serverNow: number | null, rows: Array<{ id: string; mutedUntil: string | null; mutedForever?: boolean }>) => ({
  conversations: rows.map((r) => ({ conversation: { id: r.id }, unreadCount: 0, mutedUntil: r.mutedUntil, mutedForever: !!r.mutedForever })),
  ...(serverNow !== null ? { serverNow: iso(serverNow) } : {}),
})

describe('untilFromWire', () => {
  it('mutedForever → FOREVER; ISO → мс; null и мусор → null', () => {
    expect(untilFromWire(null, true)).toBe(MUTE_FOREVER_MS)
    expect(untilFromWire(MUTE_FOREVER_ISO, false)).toBe(MUTE_FOREVER_MS)
    expect(untilFromWire(iso(T0 + 1000), false)).toBe(T0 + 1000)
    expect(untilFromWire(null, false)).toBeNull()
    expect(untilFromWire('мусор', undefined)).toBeNull()
  })
})

describe('createMuteStore', () => {
  it('список: свой mutedUntil каждой строки; строки без полей (старый кэш) не трогают состояние', () => {
    const h = harness()
    h.store.applyListResponse(list(T0, [{ id: 'g', mutedUntil: iso(T0 + 3_600_000) }, { id: 'd', mutedUntil: null }]), T0 - 20)
    expect(h.store.isMuted('g')).toBe(true)
    expect(h.store.mutedUntil('g')).toBe(T0 + 3_600_000)
    expect(h.store.isMuted('d')).toBe(false)
    h.store.applyListResponse({ conversations: [{ conversation: { id: 'g' }, unreadCount: 1 }], serverNow: iso(T0 + 10) }, T0)
    expect(h.store.isMuted('g')).toBe(true)
  })

  it('событие новее списка; ответ списка, начатого ДО события, его не откатывает', () => {
    const h = harness()
    h.store.applyListResponse(list(T0, [{ id: 'g', mutedUntil: null }]), T0)
    h.store.applyEvent({ conversationId: 'g', mutedUntil: iso(T0 + 8 * 3_600_000), mutedForever: false, at: iso(T0 + 500) })
    expect(h.store.isMuted('g')).toBe(true)
    // Список посчитан в T0+200 (до события в T0+500), пришёл после — старое «не заглушено» не берём.
    h.store.applyListResponse(list(T0 + 200, [{ id: 'g', mutedUntil: null }]), T0 + 150)
    expect(h.store.isMuted('g')).toBe(true)
    // Более свежий список (после события) — берём.
    h.store.applyListResponse(list(T0 + 900, [{ id: 'g', mutedUntil: null }]), T0 + 850)
    expect(h.store.isMuted('g')).toBe(false)
  })

  it('события с другого устройства: более старое at не перетирает более свежее', () => {
    const h = harness()
    h.store.applyEvent({ conversationId: 'g', mutedUntil: null, mutedForever: false, at: iso(T0 + 2000) })
    h.store.applyEvent({ conversationId: 'g', mutedUntil: MUTE_FOREVER_ISO, mutedForever: true, at: iso(T0 + 1000) })
    expect(h.store.isMuted('g')).toBe(false)
    h.store.applyEvent({ conversationId: 'g', mutedUntil: MUTE_FOREVER_ISO, mutedForever: true, at: iso(T0 + 3000) })
    expect(h.store.isMuted('g')).toBe(true)
    expect(h.store.mutedUntil('g')).toBe(MUTE_FOREVER_MS)
  })

  it('снапшот — замена целиком: беседы не из items не заглушены; старые ответы после него не воскрешают', () => {
    const h = harness()
    h.store.applyEvent({ conversationId: 'a', mutedUntil: iso(T0 + 3_600_000), mutedForever: false, at: iso(T0) })
    h.store.applyEvent({ conversationId: 'b', mutedUntil: iso(T0 + 3_600_000), mutedForever: false, at: iso(T0) })
    h.store.applySnapshot({ items: [{ conversationId: 'b', mutedUntil: MUTE_FOREVER_ISO, mutedForever: true }], serverNow: iso(T0 + 5000) })
    expect(h.store.isMuted('a')).toBe(false) // «Включить звук», нажатый, пока вкладка была без связи
    expect(h.store.mutedUntil('b')).toBe(MUTE_FOREVER_MS)
    // Беседа, которой не было в хранилище, но список с более старым serverNow говорит «заглушена» — нет.
    h.store.applyListResponse(list(T0 + 4000, [{ id: 'c', mutedUntil: iso(T0 + 3_600_000) }]), T0 + 3900)
    expect(h.store.isMuted('c')).toBe(false)
    h.store.applyListResponse(list(T0 + 6000, [{ id: 'c', mutedUntil: iso(T0 + 3_600_000) }]), T0 + 5900)
    expect(h.store.isMuted('c')).toBe(true)
  })

  it('ответ своего POST применяется сразу; своё же событие следом — без перерисовки', () => {
    const h = harness()
    h.store.applyMuteResponse({ conversationId: 'g', mutedUntil: iso(T0 + 3_600_000), mutedForever: false, serverNow: iso(T0) }, T0 - 30, T0 + 30)
    expect(h.store.isMuted('g')).toBe(true)
    const r = h.renders()
    h.store.applyEvent({ conversationId: 'g', mutedUntil: iso(T0 + 3_600_000), mutedForever: false, at: iso(T0) })
    expect(h.renders()).toBe(r)
  })

  it('истечение по таймеру: один таймер на ближайший срок (+50 мс), перерисовка ровно на истечении', () => {
    const h = harness()
    h.store.applyListResponse(
      list(T0, [
        { id: 'soon', mutedUntil: iso(T0 + 1500) },
        { id: 'later', mutedUntil: iso(T0 + 60_000) },
        { id: 'forever', mutedUntil: MUTE_FOREVER_ISO, mutedForever: true },
      ]),
      T0,
    )
    expect(h.timers.length).toBe(1)
    expect(h.timers[0].at).toBe(T0 + 1500 + EXPIRY_SLACK_MS)
    const r = h.renders()
    h.advance(1000)
    expect(h.store.isMuted('soon')).toBe(true)
    expect(h.renders()).toBe(r)
    h.advance(600)
    expect(h.store.isMuted('soon')).toBe(false)
    expect(h.renders()).toBe(r + 1)
    expect(h.timers.length).toBe(1)
    expect(h.timers[0].at).toBe(T0 + 60_000 + EXPIRY_SLACK_MS)
    h.advance(60_000)
    expect(h.store.isMuted('later')).toBe(false)
    expect(h.store.isMuted('forever')).toBe(true)
    expect(h.timers.length).toBe(0) // «навсегда» таймера не требует
  })

  it('recheck (фокус/возврат во вкладку) перерисовывает только при настоящей смене', () => {
    const h = harness()
    h.store.applyEvent({ conversationId: 'g', mutedUntil: iso(T0 + 1000), mutedForever: false, at: iso(T0) })
    const r = h.renders()
    h.store.recheck()
    expect(h.renders()).toBe(r)
    h.setNow(T0 + 5000) // таймер «проспали» (фоновая вкладка)
    h.store.recheck()
    expect(h.renders()).toBe(r + 1)
    expect(h.store.isMuted('g')).toBe(false)
  })

  it('часы: расхождение с сервером по serverNow ответа (середина запроса) — сравнение по часам сервера', () => {
    const h = harness()
    // Местные часы отстают на 5 минут: сервер ответил «T0», а у нас T0-5мин ± 20 мс.
    const lag = 5 * 60_000
    h.setNow(T0 - lag + 20)
    h.store.applyListResponse(list(T0, [{ id: 'g', mutedUntil: iso(T0 + 60_000) }]), T0 - lag - 20)
    expect(Math.abs(h.store.getSkewMs() - lag)).toBeLessThanOrEqual(1)
    // Через 61 с по местным часам срок по часам сервера уже истёк.
    h.setNow(T0 - lag + 20 + 61_000)
    expect(h.store.isMuted('g')).toBe(false)
  })

  it('старый сервер (нет serverNow): asOf — местное время отправки; reset забывает всё', () => {
    const h = harness()
    h.store.applyListResponse(list(null, [{ id: 'g', mutedUntil: iso(T0 + 3_600_000) }]), T0)
    expect(h.store.isMuted('g')).toBe(true)
    h.store.reset()
    expect(h.store.isMuted('g')).toBe(false)
    expect(h.store.debugEntries()).toEqual([])
  })

  it('мусор на входе ничего не ломает', () => {
    const h = harness()
    h.store.applyEvent(null)
    h.store.applyEvent({ conversationId: '', mutedUntil: MUTE_FOREVER_ISO })
    h.store.applySnapshot({ items: 'x' })
    h.store.applyListResponse({ conversations: [null, 1, { conversation: null, mutedUntil: null }] }, T0)
    h.store.applyMuteResponse('x')
    expect(h.store.debugEntries()).toEqual([])
  })
})
