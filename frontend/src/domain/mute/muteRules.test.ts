/**
 * «Без звука» — правила веба. Тест-векторы те же, что у сервера (test/conversation-mute-rules.test.ts),
 * натива, Android и iOS (docs/conversation-mute.md §6), плюс подписи срока (§7).
 */
import { describe, expect, it } from 'vitest'
import {
  isCallSystemMessage,
  isForever,
  isMuted,
  muteLabel,
  muteToastText,
  muteTooltip,
  MUTE_FOREVER_ISO,
  MUTE_FOREVER_MS,
  MUTE_PRESET_OPTIONS,
  MUTE_TEXT,
  nextExpiry,
  parseMuteInstant,
  replyToSenderOf,
  shouldAlert,
  shouldAlertForNotify,
  totalUnread,
} from './muteRules'

const NOW = Date.parse('2026-10-11T15:30:00.000Z')
const ME = 'me'
const OTHER = 'other'
const BOT = 'bot-eblusha'
const MUTED = NOW + 3_600_000
const MSK = 'Europe/Moscow' // UTC+3 без перехода — подписи детерминированы

describe('isMuted / isForever', () => {
  it('null → нет; now+1ms → да; now → нет (строго); прошлое и мусор → нет', () => {
    expect(isMuted(null, NOW)).toBe(false)
    expect(isMuted(undefined, NOW)).toBe(false)
    expect(isMuted(NOW + 1, NOW)).toBe(true)
    expect(isMuted(NOW, NOW)).toBe(false)
    expect(isMuted(NOW - 1, NOW)).toBe(false)
    expect(isMuted(Number.NaN, NOW)).toBe(false)
  })
  it('FOREVER: заглушено, «навсегда», ISO 2100-01-01T00:00:00.000Z; порог — 2099-12-31', () => {
    expect(MUTE_FOREVER_ISO).toBe('2100-01-01T00:00:00.000Z')
    expect(isMuted(MUTE_FOREVER_MS, NOW)).toBe(true)
    expect(isForever(MUTE_FOREVER_MS)).toBe(true)
    expect(isForever(Date.parse('2099-12-31T00:00:00.000Z'))).toBe(true)
    expect(isForever(Date.parse('2099-12-30T23:59:59.999Z'))).toBe(false)
    expect(isForever(MUTED)).toBe(false)
    expect(isForever(null)).toBe(false)
    expect(muteLabel(MUTE_FOREVER_MS, NOW, MSK)).toBe('навсегда')
    expect(muteTooltip(MUTE_FOREVER_MS, NOW, MSK)).toBe('Без звука навсегда')
  })
  it('parseMuteInstant: ISO и число → мс; null, пусто, мусор → null', () => {
    expect(parseMuteInstant('2026-10-11T18:30:00.000Z')).toBe(Date.parse('2026-10-11T18:30:00.000Z'))
    expect(parseMuteInstant(NOW)).toBe(NOW)
    expect(parseMuteInstant(null)).toBeNull()
    expect(parseMuteInstant('')).toBeNull()
    expect(parseMuteInstant('завтра')).toBeNull()
    expect(parseMuteInstant(Number.POSITIVE_INFINITY)).toBeNull()
  })
})

describe('isCallSystemMessage / replyToSenderOf', () => {
  it('SYSTEM + missed/ended — да; started, участники, текст — нет', () => {
    expect(isCallSystemMessage({ type: 'SYSTEM', metadata: { missed: true } })).toBe(true)
    expect(isCallSystemMessage({ type: 'SYSTEM', metadata: { ended: true, duration: 5 } })).toBe(true)
    expect(isCallSystemMessage({ type: 'SYSTEM', metadata: { started: true } })).toBe(false)
    expect(isCallSystemMessage({ type: 'SYSTEM', metadata: { action: 'participant_left' } })).toBe(false)
    expect(isCallSystemMessage({ type: 'TEXT', metadata: { missed: true } })).toBe(false)
    expect(isCallSystemMessage({ type: 'SYSTEM', metadata: null })).toBe(false)
    expect(isCallSystemMessage({ type: 'SYSTEM', metadata: [1] })).toBe(false)
    expect(isCallSystemMessage(null)).toBe(false)
  })
  it('автор сообщения, на которое ответили: replyTo.senderId, запасной — replyTo.sender.id', () => {
    expect(replyToSenderOf({ replyTo: { senderId: ME } })).toBe(ME)
    expect(replyToSenderOf({ replyTo: { sender: { id: ME } } })).toBe(ME)
    expect(replyToSenderOf({ replyTo: null })).toBeNull()
    expect(replyToSenderOf({})).toBeNull()
    expect(replyToSenderOf(undefined)).toBeNull()
  })
})

describe('shouldAlert — тест-векторы §6', () => {
  const base = { nowMs: NOW, meId: ME, senderId: OTHER }
  it('не заглушено → да (группа, 1:1); истёкший срок — то же', () => {
    expect(shouldAlert({ ...base, mutedUntilMs: null, isGroup: true })).toBe(true)
    expect(shouldAlert({ ...base, mutedUntilMs: null, isGroup: false })).toBe(true)
    expect(shouldAlert({ ...base, mutedUntilMs: NOW - 1, isGroup: true })).toBe(true)
  })
  it('своё сообщение → никогда', () => {
    expect(shouldAlert({ ...base, senderId: ME, mutedUntilMs: null, isGroup: false })).toBe(false)
  })
  it('группа + ответ на МОЁ → будить; на чужое → нет; «навсегда» — так же', () => {
    expect(shouldAlert({ ...base, mutedUntilMs: MUTED, isGroup: true, replyToSenderId: ME })).toBe(true)
    expect(shouldAlert({ ...base, mutedUntilMs: MUTED, isGroup: true, replyToSenderId: OTHER })).toBe(false)
    expect(shouldAlert({ ...base, mutedUntilMs: MUTE_FOREVER_MS, isGroup: true, replyToSenderId: ME })).toBe(true)
  })
  it('группа + ответ бота на моё → будить; группа + «начал звонок» / «продлился» → нет', () => {
    expect(shouldAlert({ ...base, senderId: BOT, mutedUntilMs: MUTED, isGroup: true, replyToSenderId: ME })).toBe(true)
    expect(shouldAlert({ ...base, mutedUntilMs: MUTED, isGroup: true })).toBe(false)
    expect(shouldAlert({ ...base, mutedUntilMs: MUTED, isGroup: true, callSystem: true })).toBe(false)
  })
  it('группа + @упоминание меня (на будущее) → да; другого → нет', () => {
    expect(shouldAlert({ ...base, mutedUntilMs: MUTED, isGroup: true, mentionedUserIds: [OTHER, ME] })).toBe(true)
    expect(shouldAlert({ ...base, mutedUntilMs: MUTED, isGroup: true, mentionedUserIds: [OTHER] })).toBe(false)
  })
  it('1:1 + ответ на моё → нет; бот-чат + ответ бота на моё → нет; секретка → нет', () => {
    expect(shouldAlert({ ...base, mutedUntilMs: MUTED, isGroup: false, replyToSenderId: ME })).toBe(false)
    expect(shouldAlert({ ...base, senderId: BOT, mutedUntilMs: MUTED, isGroup: false, replyToSenderId: ME })).toBe(false)
    expect(shouldAlert({ ...base, mutedUntilMs: MUTED, isGroup: false })).toBe(false)
  })
  it('1:1 + SYSTEM missed / ended → будить (звонок 1:1 не глушится)', () => {
    const missed = { type: 'SYSTEM', metadata: { missed: true } }
    const ended = { type: 'SYSTEM', metadata: { ended: true } }
    expect(shouldAlert({ ...base, mutedUntilMs: MUTED, isGroup: false, callSystem: isCallSystemMessage(missed) })).toBe(true)
    expect(shouldAlert({ ...base, mutedUntilMs: MUTED, isGroup: false, callSystem: isCallSystemMessage(ended) })).toBe(true)
  })
})

describe('shouldAlertForNotify — message:notify', () => {
  const base = { meId: ME, senderId: OTHER, message: { type: 'TEXT' }, isGroup: true, nowMs: NOW }
  it('сервер прислал muted → верим ему, что бы ни думало своё состояние', () => {
    expect(shouldAlertForNotify({ ...base, payloadMuted: true, mutedUntilMs: null })).toBe(false)
    expect(shouldAlertForNotify({ ...base, payloadMuted: false, mutedUntilMs: MUTED })).toBe(true)
  })
  it('поля нет (старый сервер) → локальное правило: ответ на моё в группе пробивает, остальное — нет', () => {
    expect(shouldAlertForNotify({ ...base, payloadMuted: undefined, mutedUntilMs: MUTED })).toBe(false)
    expect(shouldAlertForNotify({ ...base, payloadMuted: undefined, mutedUntilMs: MUTED, message: { type: 'TEXT', replyTo: { senderId: ME } } })).toBe(true)
    expect(shouldAlertForNotify({ ...base, payloadMuted: undefined, mutedUntilMs: null })).toBe(true)
    expect(
      shouldAlertForNotify({ ...base, isGroup: false, payloadMuted: undefined, mutedUntilMs: MUTED, message: { type: 'SYSTEM', metadata: { missed: true } } }),
    ).toBe(true)
  })
  it('своё сообщение → никогда, даже с muted:false', () => {
    expect(shouldAlertForNotify({ ...base, senderId: ME, payloadMuted: false, mutedUntilMs: null })).toBe(false)
  })
})

describe('подписи срока (местное время; здесь — Москва, UTC+3)', () => {
  const now = Date.parse('2026-10-11T12:00:00Z') // 15:00 МСК
  it('сегодня — «до HH:mm» (с ведущим нулём), до конца суток', () => {
    expect(muteLabel(Date.parse('2026-10-11T15:30:00Z'), now, MSK)).toBe('до 18:30')
    expect(muteLabel(Date.parse('2026-10-11T20:59:00Z'), now, MSK)).toBe('до 23:59')
    expect(muteLabel(Date.parse('2026-10-11T12:05:00Z'), Date.parse('2026-10-11T03:00:00Z'), MSK)).toBe('до 15:05')
    expect(muteLabel(Date.parse('2026-10-11T06:05:00Z'), Date.parse('2026-10-11T03:00:00Z'), MSK)).toBe('до 09:05')
  })
  it('граница суток: полночь — уже «завтра»', () => {
    expect(muteLabel(Date.parse('2026-10-11T21:00:00Z'), now, MSK)).toBe('до завтра, 00:00')
    expect(muteLabel(Date.parse('2026-10-12T15:30:00Z'), now, MSK)).toBe('до завтра, 18:30')
  })
  it('в этом году — «до d MMM, HH:mm» с короткими русскими месяцами', () => {
    expect(muteLabel(Date.parse('2026-10-14T15:30:00Z'), now, MSK)).toBe('до 14 окт., 18:30')
    expect(muteLabel(Date.parse('2026-10-18T09:00:00Z'), now, MSK)).toBe('до 18 окт., 12:00')
    expect(muteLabel(Date.parse('2026-05-05T07:00:00Z'), Date.parse('2026-05-01T07:00:00Z'), MSK)).toBe('до 5 мая, 10:00')
    expect(muteLabel(Date.parse('2026-09-30T07:00:00Z'), Date.parse('2026-09-01T07:00:00Z'), MSK)).toBe('до 30 сент., 10:00')
  })
  it('другой год — «до d MMM yyyy, HH:mm»; через Новый год «завтра» тоже работает', () => {
    expect(muteLabel(Date.parse('2027-10-14T15:30:00Z'), now, MSK)).toBe('до 14 окт. 2027, 18:30')
    const nyEve = Date.parse('2026-12-31T20:00:00Z') // 23:00 МСК 31 дек.
    expect(muteLabel(Date.parse('2026-12-31T21:30:00Z'), nyEve, MSK)).toBe('до завтра, 00:30')
    expect(muteLabel(Date.parse('2027-01-02T09:00:00Z'), nyEve, MSK)).toBe('до 2 янв. 2027, 12:00')
  })
  it('подсказка значка: «Без звука до …»', () => {
    expect(muteTooltip(Date.parse('2026-10-11T15:30:00Z'), now, MSK)).toBe('Без звука до 18:30')
    expect(muteTooltip(Date.parse('2026-10-12T15:30:00Z'), now, MSK)).toBe('Без звука до завтра, 18:30')
    expect(muteTooltip(Date.parse('2026-10-14T15:30:00Z'), now, MSK)).toBe('Без звука до 14 окт., 18:30')
    expect(muteTooltip(Date.parse('2027-10-14T15:30:00Z'), now, MSK)).toBe('Без звука до 14 окт. 2027, 18:30')
  })
})

describe('тексты интерфейса — точные подписи §7', () => {
  it('пункты меню, выбор срока, ошибка', () => {
    expect(MUTE_TEXT.mute).toBe('Без звука')
    expect(MUTE_TEXT.unmute).toBe('Включить звук')
    expect(MUTE_TEXT.pickTitle).toBe('Без звука на…')
    expect(MUTE_TEXT.error).toBe('Не удалось изменить звук беседы')
    expect(MUTE_PRESET_OPTIONS.map((o) => o.label)).toEqual(['1 час', '8 часов', '1 день', '1 неделю', 'Навсегда'])
    expect(MUTE_PRESET_OPTIONS.map((o) => o.preset)).toEqual(['1h', '8h', '1d', '1w', 'forever'])
  })
  it('тост после действия', () => {
    expect(muteToastText('1h')).toBe('Без звука на 1 час')
    expect(muteToastText('8h')).toBe('Без звука на 8 часов')
    expect(muteToastText('1d')).toBe('Без звука на 1 день')
    expect(muteToastText('1w')).toBe('Без звука на 1 неделю')
    expect(muteToastText('forever')).toBe('Без звука навсегда')
    expect(muteToastText(null)).toBe('Звук включён')
  })
})

describe('nextExpiry / totalUnread', () => {
  it('ближайший неистёкший конкретный срок; «навсегда», истёкшие и null не в счёт', () => {
    expect(nextExpiry([null, NOW - 5, MUTE_FOREVER_MS, NOW + 9_000, NOW + 2_000], NOW)).toBe(NOW + 2_000)
    expect(nextExpiry([null, MUTE_FOREVER_MS, NOW], NOW)).toBeNull()
    expect(nextExpiry([], NOW)).toBeNull()
  })
  it('общий счётчик — только незаглушённые', () => {
    const rows = [
      { conversationId: 'a', unreadCount: 3 },
      { conversationId: 'b', unreadCount: 5 },
      { conversationId: 'c', unreadCount: 0 },
      { conversationId: 'd', unreadCount: 'x' },
    ]
    expect(totalUnread(rows, () => false)).toBe(8)
    expect(totalUnread(rows, (id) => id === 'b')).toBe(3)
  })
})
