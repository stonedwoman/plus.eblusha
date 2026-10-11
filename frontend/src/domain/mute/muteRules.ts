/**
 * «Без звука» для бесед — чистые правила веба (без React, сокета и сети; их гоняет muteRules.test.ts).
 *
 * Повторяет серверные правила src/lib/conversationMuteRules.ts и контракт docs/conversation-mute.md;
 * те же тест-векторы — у натива, Android и iOS. Хранится одно поле — ConversationParticipant.mutedUntil
 * (момент по часам СЕРВЕРА, UTC):
 *   null           — звук включён;
 *   > now          — заглушено до этого момента;
 *   ≤ now          — истекло, то же, что null (истечение = сравнение с now, ничего не стирается);
 *   MUTE_FOREVER   — «Навсегда» (2100-01-01T00:00:00.000Z).
 * Здесь все моменты — числа (мс эпохи), чтобы не плодить Date в рендере.
 */

/** «Навсегда» — так его записывает сервер. */
export const MUTE_FOREVER_ISO = '2100-01-01T00:00:00.000Z'
export const MUTE_FOREVER_MS = Date.parse(MUTE_FOREVER_ISO)
/** С этого момента срок считается «навсегда» (как на сервере). */
export const MUTE_FOREVER_FROM_MS = Date.parse('2099-12-31T00:00:00.000Z')

export type MutePreset = '1h' | '8h' | '1d' | '1w' | 'forever'

/** Варианты срока — в этом порядке в подменю и в выборе на телефонной ширине. */
export const MUTE_PRESET_OPTIONS: ReadonlyArray<{ preset: MutePreset; label: string }> = [
  { preset: '1h', label: '1 час' },
  { preset: '8h', label: '8 часов' },
  { preset: '1d', label: '1 день' },
  { preset: '1w', label: '1 неделю' },
  { preset: 'forever', label: 'Навсегда' },
]

/** Точные подписи (одинаковые на всех платформах — docs/conversation-mute.md §7). */
export const MUTE_TEXT = {
  /** Пункт меню, беседа не заглушена; доступное имя значка. */
  mute: 'Без звука',
  /** Пункт меню, беседа заглушена. */
  unmute: 'Включить звук',
  /** Заголовок выбора срока (телефонная ширина). */
  pickTitle: 'Без звука на…',
  cancel: 'Отмена',
  unmutedToast: 'Звук включён',
  error: 'Не удалось изменить звук беседы',
} as const

const TOAST_BY_PRESET: Record<MutePreset, string> = {
  '1h': 'Без звука на 1 час',
  '8h': 'Без звука на 8 часов',
  '1d': 'Без звука на 1 день',
  '1w': 'Без звука на 1 неделю',
  forever: 'Без звука навсегда',
}

/** Тост после действия: пресет — «Без звука на 1 час» …; null («Включить звук») — «Звук включён». */
export function muteToastText(preset: MutePreset | null): string {
  return preset ? TOAST_BY_PRESET[preset] : MUTE_TEXT.unmutedToast
}

/** ISO-строка (или число мс) → мс; мусор и null → null. */
export function parseMuteInstant(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v !== 'string' || !v.trim()) return null
  const t = Date.parse(v)
  return Number.isFinite(t) ? t : null
}

/** Заглушено ли в момент nowMs: until > now (строго). */
export function isMuted(untilMs: number | null | undefined, nowMs: number): boolean {
  return typeof untilMs === 'number' && Number.isFinite(untilMs) && untilMs > nowMs
}

/** «Навсегда» (until ≥ 2099-12-31T00:00Z). */
export function isForever(untilMs: number | null | undefined): boolean {
  return typeof untilMs === 'number' && Number.isFinite(untilMs) && untilMs >= MUTE_FOREVER_FROM_MS
}

/* ---------------------------- подписи срока ---------------------------- */

const RU_MONTHS_SHORT = ['янв.', 'февр.', 'мар.', 'апр.', 'мая', 'июня', 'июля', 'авг.', 'сент.', 'окт.', 'нояб.', 'дек.']

type DayParts = { y: number; m: number; d: number; hh: number; mm: number }

const partsFormatters = new Map<string, Intl.DateTimeFormat>()
function formatterFor(timeZone: string | undefined): Intl.DateTimeFormat {
  const key = timeZone ?? ''
  let f = partsFormatters.get(key)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      ...(timeZone ? { timeZone } : {}),
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      hourCycle: 'h23',
    })
    partsFormatters.set(key, f)
  }
  return f
}

function dayParts(ms: number, timeZone?: string): DayParts {
  let f: Intl.DateTimeFormat
  try {
    f = formatterFor(timeZone)
  } catch {
    f = formatterFor(undefined) // неизвестный пояс — местный
  }
  const p: Record<string, number> = {}
  for (const part of f.formatToParts(new Date(ms))) {
    if (part.type === 'year' || part.type === 'month' || part.type === 'day' || part.type === 'hour' || part.type === 'minute') {
      p[part.type] = Number(part.value)
    }
  }
  return { y: p.year, m: p.month, d: p.day, hh: p.hour === 24 ? 0 : p.hour, mm: p.minute }
}

const pad2 = (n: number) => String(n).padStart(2, '0')

/**
 * Срок в местном времени устройства: сегодня «до 18:30»; завтра «до завтра, 18:30»; в этом году
 * «до 14 окт., 18:30»; иначе «до 14 окт. 2027, 18:30»; «навсегда». timeZone — для тестов.
 */
export function muteLabel(untilMs: number, nowMs: number, timeZone?: string): string {
  if (isForever(untilMs)) return 'навсегда'
  const u = dayParts(untilMs, timeZone)
  const n = dayParts(nowMs, timeZone)
  const time = `${pad2(u.hh)}:${pad2(u.mm)}`
  if (u.y === n.y && u.m === n.m && u.d === n.d) return `до ${time}`
  const tomorrow = new Date(Date.UTC(n.y, n.m - 1, n.d + 1))
  if (u.y === tomorrow.getUTCFullYear() && u.m === tomorrow.getUTCMonth() + 1 && u.d === tomorrow.getUTCDate()) {
    return `до завтра, ${time}`
  }
  const month = RU_MONTHS_SHORT[u.m - 1] ?? ''
  if (u.y === n.y) return `до ${u.d} ${month}, ${time}`
  return `до ${u.d} ${month} ${u.y}, ${time}`
}

/** Подсказка значка: «Без звука до 18:30» … «Без звука навсегда». */
export function muteTooltip(untilMs: number, nowMs: number, timeZone?: string): string {
  return `${MUTE_TEXT.mute} ${muteLabel(untilMs, nowMs, timeZone)}`
}

/* ---------------------------- «будить ли» ---------------------------- */

/** Системная запись о звонке 1:1, которая пробивает «Без звука»: «Пропущенный звонок», «Звонок продлился…». */
export function isCallSystemMessage(msg: unknown): boolean {
  if (!msg || typeof msg !== 'object') return false
  const m = msg as { type?: unknown; metadata?: unknown }
  if (m.type !== 'SYSTEM') return false
  const md = m.metadata
  if (!md || typeof md !== 'object' || Array.isArray(md)) return false
  const r = md as Record<string, unknown>
  return r.missed === true || r.ended === true
}

/** Автор сообщения, на которое ответили (message.replyTo.senderId). */
export function replyToSenderOf(msg: unknown): string | null {
  if (!msg || typeof msg !== 'object') return null
  const rt = (msg as { replyTo?: unknown }).replyTo
  if (!rt || typeof rt !== 'object') return null
  const r = rt as { senderId?: unknown; sender?: { id?: unknown } | null }
  if (typeof r.senderId === 'string' && r.senderId) return r.senderId
  if (r.sender && typeof r.sender.id === 'string' && r.sender.id) return r.sender.id
  return null
}

/**
 * Будить ли меня этим сообщением (звук, плашка, уведомление). Как на сервере (shouldAlert) и в Telegram:
 *   - своё сообщение → нет (как и раньше);
 *   - беседа не заглушена → да;
 *   - группа: ответ на МОЁ сообщение (в т.ч. ответ бота на мой вопрос) или @упоминание меня → да;
 *   - 1:1 (обычная, секретная, «Чат с Еблушей»): только записи о звонке (пропущенный, «продлился») → да;
 *   - остальное → нет.
 * «Группа» — только серверный флаг conversation.isGroup, без эвристики по числу участников.
 */
export function shouldAlert(opts: {
  mutedUntilMs: number | null | undefined
  nowMs: number
  isGroup: boolean
  meId: string | null | undefined
  senderId?: string | null
  /** message.replyTo?.senderId */
  replyToSenderId?: string | null
  /** isCallSystemMessage(message) */
  callSystem?: boolean
  /** Кого упомянули (@) — когда упоминания появятся; сейчас их нет нигде. */
  mentionedUserIds?: readonly string[] | null
}): boolean {
  if (opts.meId && opts.senderId && opts.senderId === opts.meId) return false
  if (!isMuted(opts.mutedUntilMs, opts.nowMs)) return true
  if (opts.isGroup) {
    if (opts.meId && opts.replyToSenderId && opts.replyToSenderId === opts.meId) return true
    if (opts.meId && opts.mentionedUserIds && opts.mentionedUserIds.includes(opts.meId)) return true
    return false
  }
  return opts.callSystem === true
}

/**
 * Решение по message:notify: если сервер прислал muted (boolean) — верим ему (он считал для меня);
 * поля нет (старый сервер) — локальное правило по своему состоянию. Своё сообщение — никогда.
 */
export function shouldAlertForNotify(opts: {
  payloadMuted: unknown
  meId: string | null | undefined
  senderId: string | null | undefined
  message: unknown
  isGroup: boolean
  mutedUntilMs: number | null | undefined
  nowMs: number
}): boolean {
  if (opts.meId && opts.senderId && opts.senderId === opts.meId) return false
  if (typeof opts.payloadMuted === 'boolean') return !opts.payloadMuted
  return shouldAlert({
    mutedUntilMs: opts.mutedUntilMs,
    nowMs: opts.nowMs,
    isGroup: opts.isGroup,
    meId: opts.meId,
    senderId: opts.senderId,
    replyToSenderId: replyToSenderOf(opts.message),
    callSystem: isCallSystemMessage(opts.message),
  })
}

/* ---------------------------- таймер и счётчик ---------------------------- */

/** Ближайший неистёкший конкретный (не «навсегда») срок; нет — null. По нему ставится один таймер. */
export function nextExpiry(untils: Iterable<number | null | undefined>, nowMs: number): number | null {
  let best: number | null = null
  for (const u of untils) {
    if (!isMuted(u, nowMs) || isForever(u)) continue
    if (best === null || (u as number) < best) best = u as number
  }
  return best
}

/** Общий счётчик непрочитанного: сумма по НЕзаглушённым беседам (заглушённые в него не входят). */
export function totalUnread(
  rows: ReadonlyArray<{ conversationId: string; unreadCount: unknown }>,
  isMutedFn: (conversationId: string) => boolean,
): number {
  let sum = 0
  for (const r of rows) {
    const n = Number(r.unreadCount ?? 0)
    if (!Number.isFinite(n) || n <= 0) continue
    if (isMutedFn(r.conversationId)) continue
    sum += Math.floor(n)
  }
  return sum
}
