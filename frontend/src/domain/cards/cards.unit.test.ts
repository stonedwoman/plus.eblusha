/**
 * Карточки бота — юнит-тесты механики: часы и смещение, хранилище по rev, диспетчер действий
 * (оптимистично → ответ / откат), события message:update, форматы, оптимистичные переходы.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BotCard } from './cardEnvelope'
import { canAct, nextActionExpiry, newerCard } from './cardEnvelope'
import { _resetCardClockForTests, getClockSkewMs, nextTickDelay, noteServerNow, subscribeCardClock } from './cardClock'
import { _resetCardStoreForTests, getStoredCard, offerCard, resolveCard, setOptimisticCard } from './cardStore'
import { cardFromBody, classifyCardError, replaceCardMessageInCache, runCardAction, type CardTransport } from './cardActions'
import { applyCardUpdateEvent, isStaleCardMessage } from './cardEvents'
import { formatCountdown, formatDayTime, formatDuration, formatHm, groupDigits, plural, zoneOffsetMinutes } from './cardFormat'
import { optimisticPromise, promiseAnnouncement, promiseFailureToast, buildPromiseCard } from './promiseCard'
import { defaultSharePeriod, optimisticShare, shareFailureToast } from './shareCard'

const T = Date.parse('2026-10-11T11:00:00.000Z')

function promiseCard(over: Partial<BotCard> = {}, data: Record<string, any> = {}): BotCard {
  return {
    v: 1,
    type: 'promise',
    id: 'p1',
    rev: 1,
    state: 'running',
    closed: false,
    actions: [
      { id: 'arrived', who: { any: true }, until: null },
      { id: 'cancel', who: { ids: ['roma'] }, until: null },
    ],
    data: {
      promiser: { id: 'vasya', displayName: 'Козёл Ебаный' },
      requester: { id: 'roma', displayName: 'Рома' },
      quote: { text: '15мин', at: new Date(T).toISOString() },
      label: '15 мин',
      startAt: new Date(T).toISOString(),
      deadlineAt: new Date(T + 15 * 60_000).toISOString(),
      originalDeadlineAt: new Date(T + 15 * 60_000).toISOString(),
      cancelBy: ['roma', 'owner'],
      ...data,
    },
    source: 'card',
    ...over,
  }
}

function shareCard(over: Partial<BotCard> = {}, data: Record<string, any> = {}): BotCard {
  return {
    v: 1,
    type: 'share',
    id: 's1',
    rev: 1,
    state: 'pending',
    closed: false,
    actions: [
      { id: 'share', who: { ids: ['roma'] }, until: new Date(T + 30 * 60_000).toISOString() },
      { id: 'decline', who: { ids: ['roma'] }, until: new Date(T + 30 * 60_000).toISOString() },
    ],
    data: {
      asker: { id: 'roma', displayName: 'Рома' },
      suggest: { period: 'today', photos: false },
      options: [
        { period: 'today', messages: 34, photos: 3, enabled: true },
        { period: 'week', messages: 128, photos: 18, enabled: true },
        { period: 'all', messages: 1738, photos: 337, photosUsed: 60, enabled: true },
      ],
      ...data,
    },
    source: 'card',
    ...over,
  }
}

describe('часы карточек', () => {
  beforeEach(() => _resetCardClockForTests())
  afterEach(() => {
    vi.useRealTimers()
    _resetCardClockForTests()
  })

  it('тик выровнен по границе секунды/минуты (+5 мс)', () => {
    expect(nextTickDelay(1_000_000, 'sec')).toBe(1005)
    expect(nextTickDelay(1_000_250, 'sec')).toBe(755)
    expect(nextTickDelay(60_000 * 7 + 59_990, 'min')).toBe(15)
  })

  it('смещение: медиана трёх замеров, применяется только при |Δ| > 2 с', () => {
    noteServerNow(10_000 + 1500, 10_000)
    expect(getClockSkewMs()).toBe(0)
    noteServerNow('1970-01-01T00:00:15.000Z', 10_000) // +5000
    noteServerNow(10_000 + 6000, 10_000)
    expect(getClockSkewMs()).toBe(5000) // медиана [1500, 5000, 6000]
    noteServerNow(10_000 + 100, 10_000) // окно [5000, 6000, 100] → медиана 5000
    expect(getClockSkewMs()).toBe(5000)
    noteServerNow('мусор', 10_000)
    expect(getClockSkewMs()).toBe(5000)
  })

  it('одни часы: секундные подписчики тикают по границам, отписка останавливает', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_250)
    const ticks: number[] = []
    const off = subscribeCardClock('sec', (t) => ticks.push(t))
    vi.advanceTimersByTime(755)
    expect(ticks.length).toBe(1)
    expect(ticks[0] % 1000).toBe(5)
    vi.advanceTimersByTime(3000)
    expect(ticks.length).toBe(4)
    off()
    vi.advanceTimersByTime(5000)
    expect(ticks.length).toBe(4)
  })

  it('минутные подписчики получают тик только на смене минуты', () => {
    vi.useFakeTimers()
    vi.setSystemTime(60_000 * 10 + 30_000)
    const mins: number[] = []
    const secs: number[] = []
    const offM = subscribeCardClock('min', (t) => mins.push(t))
    const offS = subscribeCardClock('sec', (t) => secs.push(t))
    vi.advanceTimersByTime(20_000)
    expect(mins.length).toBe(0)
    vi.advanceTimersByTime(11_000)
    expect(mins.length).toBe(1)
    expect(secs.length).toBeGreaterThan(25)
    offM()
    offS()
  })
})

describe('хранилище карточек', () => {
  beforeEach(() => _resetCardStoreForTests())

  it('свежая версия из ленты сильнее старой в хранилище, оптимистичная — поверх всех', () => {
    offerCard('m', promiseCard({ rev: 2 }))
    expect(resolveCard('m', promiseCard({ rev: 1 }))?.rev).toBe(2)
    expect(resolveCard('m', promiseCard({ rev: 3 }))?.rev).toBe(3)
    setOptimisticCard('m', promiseCard({ rev: 2, state: 'arrived' }))
    expect(resolveCard('m', promiseCard({ rev: 3 }))?.state).toBe('arrived')
    setOptimisticCard('m', null)
    expect(resolveCard('m', null)?.rev).toBe(2)
  })

  it('newerCard: при равенстве — первая', () => {
    const a = promiseCard({ rev: 2 })
    const b = promiseCard({ rev: 2, state: 'cancelled' })
    expect(newerCard(a, b)).toBe(a)
    expect(newerCard(null, b)).toBe(b)
  })
})

describe('права и истечение действий', () => {
  it('nextActionExpiry — ближайший until видимого действия', () => {
    const c = promiseCard({ state: 'cancelled', closed: true, actions: [{ id: 'reopen', who: { ids: ['roma'] }, until: new Date(T + 120_000).toISOString() }] })
    expect(nextActionExpiry(c, 'roma', T)).toBe(T + 120_000)
    expect(nextActionExpiry(c, 'petya', T)).toBeNull()
    expect(nextActionExpiry(c, 'roma', T + 120_000)).toBeNull()
    expect(canAct(c, 'reopen', 'roma', T + 119_999)).toBe(true)
  })
})

describe('диспетчер действий', () => {
  beforeEach(() => _resetCardStoreForTests())

  it('ошибки сервера → что делать клиенту (§2.3)', () => {
    expect(classifyCardError(404, { code: 'CARD_NOT_FOUND' })).toBe('not_found')
    expect(classifyCardError(400, { code: 'CARD_BAD_INPUT' })).toBe('bad_input')
    expect(classifyCardError(403, { code: 'CARD_FORBIDDEN' })).toBe('forbidden')
    expect(classifyCardError(409, { code: 'CARD_CLOSED' })).toBe('closed')
    expect(classifyCardError(409, { code: 'CARD_ACTION_EXPIRED' })).toBe('expired')
    expect(classifyCardError(404, { code: 'CARD_TYPE_DISABLED' })).toBe('disabled')
    expect(classifyCardError(429, {})).toBe('rate_limited')
    expect(classifyCardError(undefined, undefined)).toBe('error')
    expect(classifyCardError(409, { code: 'PROMISE_CLOSED' })).toBe('closed')
    expect(classifyCardError(409, { code: 'PROMISE_REOPEN_EXPIRED' })).toBe('expired')
    expect(classifyCardError(500, { message: 'x' })).toBe('error')
  })

  it('тело ответа: {card} или {promise} (запасной таймер)', () => {
    const env = { v: 1, type: 'share', id: 's', rev: 7, state: 'granted', closed: false, actions: [], data: {} }
    expect(cardFromBody({ card: env })?.rev).toBe(7)
    expect(cardFromBody({ promise: { v: 1, id: 'p', rev: 3, state: 'arrived' } })?.source).toBe('legacy-promise')
    expect(cardFromBody({})).toBeNull()
  })

  it('успех: оптимистично → карточка сервера по rev, сообщение — в кэш ленты', async () => {
    const card = promiseCard()
    let seenDuring: string | undefined
    const served = promiseCard({ rev: 2, state: 'arrived', closed: true })
    const transport: CardTransport = {
      act: async () => {
        seenDuring = resolveCard('m', card)?.state
        return { ok: true, card: served, message: { id: 'm', content: 'новый текст', isBot: true, metadata: { bot: { kind: 'card' }, card: { ...served, source: undefined } } } }
      },
    }
    const cache: any[] = [{ id: 'm', content: 'старый', isBot: true, metadata: { bot: { kind: 'card' }, card: { ...card, source: undefined } } }]
    const client = {
      setQueryData: (_k: unknown, fn: (old: any) => any) => {
        const next = fn(cache)
        cache.splice(0, cache.length, ...next)
      },
    }
    const res = await runCardAction({ transport, messageId: 'm', card, action: 'arrived', optimistic: promiseCard({ state: 'arrived', closed: true }), client, conversationId: 'c' })
    expect(res.ok).toBe(true)
    expect(seenDuring).toBe('arrived')
    expect(resolveCard('m', card)?.rev).toBe(2)
    expect(cache[0].content).toBe('новый текст')
  })

  it('ошибка: откат оптимистичного, 409 — версия из ответа', async () => {
    const card = promiseCard()
    const fail: CardTransport = { act: async () => ({ ok: false, failure: 'error', card: null }) }
    const r1 = await runCardAction({ transport: fail, messageId: 'm', card, action: 'cancel', optimistic: promiseCard({ state: 'cancelled', closed: true }) })
    expect(r1.ok).toBe(false)
    expect(resolveCard('m', card)?.state).toBe('running')

    const closed = promiseCard({ rev: 5, state: 'arrived', closed: true })
    const conflict: CardTransport = { act: async () => ({ ok: false, failure: 'closed', card: closed }) }
    const r2 = await runCardAction({ transport: conflict, messageId: 'm', card, action: 'cancel', optimistic: promiseCard({ state: 'cancelled', closed: true }) })
    expect(r2.ok).toBe(false)
    expect(resolveCard('m', card)?.state).toBe('arrived')
    expect(promiseFailureToast('cancel', 'closed')).toBeNull()
  })

  it('кэш ленты: сообщение старее по rev не перезаписывает', () => {
    const fresh = { id: 'm', content: 'rev3', isBot: true, metadata: { bot: { kind: 'card' }, card: { v: 1, type: 'share', id: 's', rev: 3, state: 'granted', actions: [], data: {} } } }
    const stale = { ...fresh, content: 'rev2', metadata: { bot: { kind: 'card' }, card: { ...fresh.metadata.card, rev: 2 } } }
    const cache: any[] = [fresh]
    const client = { setQueryData: (_k: unknown, fn: (old: any) => any) => cache.splice(0, cache.length, ...fn(cache)) }
    replaceCardMessageInCache(client, 'c', stale)
    expect(cache[0].content).toBe('rev3')
  })
})

describe('события message:update', () => {
  beforeEach(() => {
    _resetCardStoreForTests()
    _resetCardClockForTests()
  })

  it('reason "card": карточка в хранилище, смещение часов', () => {
    const card = { v: 1, type: 'share', id: 's', rev: 4, state: 'granted', closed: false, actions: [], data: {} }
    const serverNow = new Date(Date.now() + 60_000).toISOString()
    expect(applyCardUpdateEvent({ conversationId: 'c', messageId: 'm', reason: 'card', cardType: 'share', card, serverNow, message: { id: 'm' } })).toBe(true)
    expect(getStoredCard('m')?.rev).toBe(4)
    expect(Math.abs(getClockSkewMs() - 60_000)).toBeLessThan(1000)
  })

  it('reason "promise" (до поправок) тоже понимаем; прочие причины — нет', () => {
    expect(applyCardUpdateEvent({ messageId: 'm2', reason: 'promise', promise: { v: 1, id: 'p', rev: 2, state: 'running', cancelBy: [] } })).toBe(true)
    expect(getStoredCard('m2')?.type).toBe('promise')
    expect(applyCardUpdateEvent({ messageId: 'm3', reason: 'link_preview' })).toBe(false)
  })

  it('isStaleCardMessage: событие с меньшим/равным rev не трогает кэш', () => {
    const mk = (rev: number) => ({ id: 'm', isBot: true, metadata: { bot: { kind: 'card' }, card: { v: 1, type: 'share', id: 's', rev, state: 'pending', actions: [], data: {} } } })
    expect(isStaleCardMessage([mk(3)], mk(2))).toBe(true)
    expect(isStaleCardMessage([mk(3)], mk(3))).toBe(true)
    expect(isStaleCardMessage([mk(3)], mk(4))).toBe(false)
    expect(isStaleCardMessage([], mk(4))).toBe(false)
  })
})

describe('форматы', () => {
  it('склонение и числа', () => {
    expect([1, 2, 5, 11, 21, 22, 112].map((n) => plural(n, 'раз', 'раза', 'раз'))).toEqual(['раз', 'раза', 'раз', 'раз', 'раз', 'раза', 'раз'])
    expect(groupDigits(1738)).toBe('1 738')
    expect(groupDigits(30000)).toBe('30 000')
    expect(groupDigits(999)).toBe('999')
  })
  it('отсчёт и длительности', () => {
    expect(formatCountdown(767)).toBe('12:47')
    expect(formatCountdown(4367)).toBe('1:12:47')
    expect(formatCountdown(42, true)).toBe('0:00:42')
    expect(formatCountdown(-5)).toBe('00:00')
    expect(formatDuration(42)).toBe('42 с')
    expect(formatDuration(420)).toBe('7 мин')
    expect(formatDuration(3600)).toBe('1 ч')
    expect(formatDuration(4320)).toBe('1 ч 12 мин')
    expect(formatDuration(-180)).toBe('3 мин')
  })
  it('время в поясе зрителя, дробное смещение, переход на зимнее время', () => {
    expect(formatHm(T, 'Europe/Moscow')).toBe('14:00')
    expect(zoneOffsetMinutes(T, 'Asia/Calcutta')).toBe(330)
    // Бухарест: 25.10.2026 04:00 местного → зимнее время (+2)
    expect(zoneOffsetMinutes(Date.parse('2026-10-24T12:00:00Z'), 'Europe/Bucharest')).toBe(180)
    expect(zoneOffsetMinutes(Date.parse('2026-10-25T12:00:00Z'), 'Europe/Bucharest')).toBe(120)
    expect(formatDayTime(Date.parse('2026-10-13T08:00:00Z'), T, 'Europe/Moscow')).toBe('13 окт., 11:00')
    expect(formatDayTime(Date.parse('2026-10-12T08:00:00Z'), T, 'Europe/Moscow', 'in')).toBe('завтра в 11:00')
  })
})

describe('таймер: переходы и объявления', () => {
  it('«Пришёл» оптимистично: опоздание по сроку, кто отметил', () => {
    const c = promiseCard()
    const late = optimisticPromise(c, 'arrived', { id: 'petya', displayName: 'Петя' }, T + 16 * 60_000)!
    expect(late.state).toBe('arrived')
    expect(late.closed).toBe(true)
    expect((late.data as any).outcome).toMatchObject({ kind: 'late', deltaSec: 60, via: 'button', by: { id: 'petya' } })
    expect(late.actions[0]).toMatchObject({ id: 'reopen' })
    const self = optimisticPromise(c, 'arrived', { id: 'vasya', displayName: 'Козёл Ебаный' }, T + 10 * 60_000)!
    expect((self.data as any).outcome).toMatchObject({ kind: 'onTime', via: 'self', by: null })
    expect(optimisticPromise(late, 'arrived', { id: 'roma', displayName: 'Рома' }, T)).toBeNull()
  })

  it('«Отменить» → «Вернуть» оптимистично', () => {
    const cancelled = optimisticPromise(promiseCard(), 'cancel', { id: 'roma', displayName: 'Рома' }, T)!
    expect(cancelled.state).toBe('cancelled')
    expect((cancelled.data as any).cancelledBy).toMatchObject({ id: 'roma' })
    const back = optimisticPromise(cancelled, 'reopen', { id: 'roma', displayName: 'Рома' }, T + 1000)!
    expect(back.state).toBe('running')
    expect(back.actions.map((a) => a.id)).toEqual(['arrived', 'cancel'])
  })

  it('живая область: смена режима и порог 5 минут, не каждую секунду', () => {
    const c = promiseCard()
    const m = (now: number) => buildPromiseCard(c, now, { id: 'roma', zone: 'Europe/Moscow' })
    const a = m(T + 9 * 60_000 + 1000) // 5:59 осталось
    const b = m(T + 10 * 60_000) // 5:00
    expect(promiseAnnouncement({ view: a.view, minutesLeft: a.minutesLeft }, b)).toBe('Осталось 5 минут')
    expect(promiseAnnouncement({ view: b.view, minutesLeft: b.minutesLeft }, m(T + 10 * 60_000 + 1000))).toBeNull()
    expect(promiseAnnouncement({ view: 'running', minutesLeft: 2 }, m(T + 14 * 60_000 + 30_000))).toBe('Осталась минута')
    expect(promiseAnnouncement({ view: 'final', minutesLeft: 1 }, m(T + 15 * 60_000))).toBe('Козёл Ебаный опаздывает')
    expect(promiseAnnouncement(null, m(T))).toBeNull()
  })

  it('тосты: 409 молча, остальное по действию', () => {
    expect(promiseFailureToast('arrived', 'error')).toBe('Не удалось отметить')
    expect(promiseFailureToast('cancel', 'error')).toBe('Не удалось отменить')
    expect(promiseFailureToast('reopen', 'error')).toBe('Не удалось вернуть')
    expect(promiseFailureToast('arrived', 'expired')).toBeNull()
    expect(promiseFailureToast('arrived', 'disabled')).toBe('Сейчас недоступно')
    expect(promiseFailureToast('arrived', 'rate_limited')).toBe('Слишком часто')
  })
})

describe('переписка: переходы', () => {
  it('«Поделиться» оптимистично → granted с выбором, окно час', () => {
    const g = optimisticShare(shareCard(), 'share', { id: 'roma', displayName: 'Рома' }, T, { period: 'week', photos: true })!
    expect(g.state).toBe('granted')
    expect((g.data as any).choice).toMatchObject({ period: 'week', photos: true })
    expect((g.data as any).until).toBe(new Date(T + 60 * 60_000).toISOString())
    expect(g.actions).toEqual([{ id: 'forget', who: { any: true }, until: new Date(T + 60 * 60_000).toISOString() }])
    expect(optimisticShare(shareCard(), 'share', { id: 'roma', displayName: 'Рома' }, T, null)).toBeNull()
  })
  it('«Не делиться» и «Забыть переписку»', () => {
    const d = optimisticShare(shareCard(), 'decline', { id: 'roma', displayName: 'Рома' }, T)!
    expect(d.state).toBe('declined')
    expect(d.closed).toBe(true)
    const g = optimisticShare(shareCard(), 'share', { id: 'roma', displayName: 'Рома' }, T, { period: 'today', photos: false })!
    const r = optimisticShare(g, 'forget', { id: 'petya', displayName: 'Петя' }, T + 1000)!
    expect(r.state).toBe('revoked')
    expect((r.data as any).endedBy).toMatchObject({ reason: 'revoked', by: { id: 'petya' } })
  })
  it('вариант по умолчанию: подсказка, потом следующий непустой, потом прежние', () => {
    const opts = (today: number, week: number, all: number) => [
      { period: 'today', messages: today, photos: 0, enabled: today > 0 },
      { period: 'week', messages: week, photos: 0, enabled: week > 0 },
      { period: 'all', messages: all, photos: 0, enabled: all > 0 },
    ]
    expect(defaultSharePeriod({ suggest: { period: 'week' }, options: opts(3, 5, 9) as any })).toBe('week')
    expect(defaultSharePeriod({ suggest: { period: 'week' }, options: opts(3, 0, 0) as any })).toBe('today')
    expect(defaultSharePeriod({ suggest: { period: 'today' }, options: opts(0, 0, 9) as any })).toBe('all')
    expect(defaultSharePeriod({ suggest: { period: 'today' }, options: opts(0, 0, 0) as any })).toBeNull()
  })
  it('тосты (SPEC-share §13)', () => {
    expect(shareFailureToast('share', 'error')).toBe('Не получилось поделиться')
    expect(shareFailureToast('share', 'forbidden')).toBe('Решает тот, кто спросил')
    expect(shareFailureToast('share', 'closed')).toBe('Уже не актуально')
    expect(shareFailureToast('decline', 'disabled')).toBe('Сейчас недоступно')
    expect(shareFailureToast('forget', 'not_found')).toBeNull()
  })
})
