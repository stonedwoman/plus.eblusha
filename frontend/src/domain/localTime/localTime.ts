/**
 * Местное время собеседника — чистые функции (без React, сокета и хранилищ; всё проверяется тестом).
 *
 * Что показываем. В открытом диалоге 1:1 под строкой статуса («В сети» / «В фоне» / «был(а)…») мелкой
 * серой строкой: «14:30, Красноярск». Время идёт само (перерисовка на границе минуты). Строки нет:
 *  - в группах (сервер там поля и не отдаёт);
 *  - если у собеседника сейчас то же время, что у меня (одинаковое смещение от UTC);
 *  - если сервер прислал null (не собеседник по 1:1, человек скрыл время, пояс неизвестен) или
 *    вообще ничего не прислал (старый сервер).
 *
 * Что присылает сервер (контракт, src/lib/localTime.ts на сервере): LocalTimeInfo =
 * { timeZone: IANA (канонический по ICU сервера: Asia/Kolkata приходит как Asia/Calcutta),
 *   city: «Красноярск» | null (у Etc/GMT-7 и UTC города нет — пишем «UTC+7»),
 *   offsetMinutes: смещение на момент ответа сервера — ТОЛЬКО запасной вариант, если браузер
 *   пояса не знает: со временем оно устаревает (летнее время). }
 */

export type LocalTimeInfo = {
  timeZone: string
  city: string | null
  offsetMinutes: number
}

/**
 * Из чего угодно — в LocalTimeInfo.
 *  undefined — поля нет вовсе (старый сервер, группа): «ничего не знаем»;
 *  null — сервер явно сказал «не показывать»;
 *  объект — показываем.
 * Битый объект (нет пояса) приравниваем к null: показывать нечего.
 */
export function normalizeLocalTimeInfo(raw: unknown): LocalTimeInfo | null | undefined {
  if (raw === undefined) return undefined
  if (raw === null || typeof raw !== 'object') return null
  const r = raw as { timeZone?: unknown; city?: unknown; offsetMinutes?: unknown }
  const timeZone = typeof r.timeZone === 'string' ? r.timeZone.trim() : ''
  if (!timeZone) return null
  const city = typeof r.city === 'string' && r.city.trim() ? r.city.trim() : null
  const offset = typeof r.offsetMinutes === 'number' && Number.isFinite(r.offsetMinutes) ? Math.round(r.offsetMinutes) : 0
  // Реальные смещения лежат в −12…+14 ч; всё за пределами — мусор, считаем 0, чтобы не нарисовать чушь.
  const offsetMinutes = offset >= -16 * 60 && offset <= 16 * 60 ? offset : 0
  return { timeZone, city, offsetMinutes }
}

const timeFormatters = new Map<string, Intl.DateTimeFormat | null>()
const partsFormatters = new Map<string, Intl.DateTimeFormat | null>()

/** «ЧЧ:ММ» (24 ч) в поясе; null — браузер такого пояса не знает. */
function timeFormatter(timeZone: string): Intl.DateTimeFormat | null {
  if (timeFormatters.has(timeZone)) return timeFormatters.get(timeZone) ?? null
  let f: Intl.DateTimeFormat | null = null
  try {
    f = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone })
  } catch {
    f = null
  }
  timeFormatters.set(timeZone, f)
  return f
}

function partsFormatter(timeZone: string): Intl.DateTimeFormat | null {
  if (partsFormatters.has(timeZone)) return partsFormatters.get(timeZone) ?? null
  let f: Intl.DateTimeFormat | null = null
  try {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    })
  } catch {
    f = null
  }
  partsFormatters.set(timeZone, f)
  return f
}

/** Знает ли браузер пояс (Intl принимает имя). */
export function isKnownTimeZone(timeZone: string): boolean {
  return !!timeZone && partsFormatter(timeZone) !== null
}

/**
 * Смещение пояса от UTC в минутах в момент `at` (с учётом летнего времени); null — пояс неизвестен.
 * Считаем по стенным часам пояса: «какая там дата и время» минус «сколько это в UTC».
 */
export function zoneOffsetMinutes(timeZone: string, at: Date): number | null {
  const f = partsFormatter(timeZone)
  if (!f) return null
  try {
    const parts = f.formatToParts(at)
    const get = (type: string) => Number(parts.find((p) => p.type === type)?.value)
    let hour = get('hour')
    if (hour === 24) hour = 0 // старые движки пишут полночь как 24 даже при h23
    const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), hour, get('minute'), get('second'))
    if (!Number.isFinite(asUtc)) return null
    const atSeconds = Math.floor(at.getTime() / 1000) * 1000
    return Math.round((asUtc - atSeconds) / 60_000)
  } catch {
    return null
  }
}

/** Моё смещение сейчас (пояс браузера). */
export function myOffsetMinutes(at: Date): number {
  return -at.getTimezoneOffset()
}

/** «UTC», «UTC+7», «UTC+5:30», «UTC-3», «UTC-9:30». */
export function formatOffsetLabel(offsetMinutes: number): string {
  const m = Math.round(offsetMinutes)
  if (m === 0) return 'UTC'
  const sign = m > 0 ? '+' : '-'
  const abs = Math.abs(m)
  const h = Math.floor(abs / 60)
  const mm = abs % 60
  return mm === 0 ? `UTC${sign}${h}` : `UTC${sign}${h}:${String(mm).padStart(2, '0')}`
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/**
 * «14:30, Красноярск» / «14:30, UTC+7» — время в поясе и место. null — нет данных.
 * Без проверки «совпадает ли с моим» (для своего экрана настроек).
 */
export function formatLocalTimeLabel(info: LocalTimeInfo | null | undefined, now: Date): string | null {
  if (!info) return null
  const known = zoneOffsetMinutes(info.timeZone, now)
  const offset = known ?? info.offsetMinutes
  let time: string
  const f = known !== null ? timeFormatter(info.timeZone) : null
  if (f) {
    time = f.format(now)
  } else {
    // Пояс браузеру неизвестен — считаем по смещению с сервера.
    const shifted = new Date(now.getTime() + offset * 60_000)
    time = `${pad2(shifted.getUTCHours())}:${pad2(shifted.getUTCMinutes())}`
  }
  const place = info.city ?? formatOffsetLabel(offset)
  return `${time}, ${place}`
}

/**
 * Строка под статусом собеседника. null — показывать не надо (нет данных или у собеседника сейчас
 * то же время, что у меня).
 */
export function formatPeerLocalTime(
  info: LocalTimeInfo | null | undefined,
  now: Date,
  mineOffsetMinutes: number = myOffsetMinutes(now),
): string | null {
  if (!info) return null
  const peerOffset = zoneOffsetMinutes(info.timeZone, now) ?? info.offsetMinutes
  if (peerOffset === mineOffsetMinutes) return null
  return formatLocalTimeLabel(info, now)
}

/** Сколько мс до начала следующей минуты (+ небольшой запас, чтобы точно перейти границу). */
export function msUntilNextMinute(nowMs: number, slackMs = 50): number {
  const into = ((nowMs % 60_000) + 60_000) % 60_000
  return 60_000 - into + slackMs
}

/**
 * Пояс этого устройства для сервера: только имена IANA. Смещение вида «+07:00»/«GMT+07:00» сервер
 * отвергает — переводим целые часы в Etc/GMT∓N (знак у Etc наоборот), остальное не шлём (null).
 */
export function normalizeDeviceTimeZone(raw: unknown): string | null {
  const tz = typeof raw === 'string' ? raw.trim() : ''
  if (!tz || tz.length > 64) return null
  if (tz === 'Etc/Unknown' || tz === 'Factory') return null
  const m = /^(?:UTC|GMT)?\s*([+-])(\d{1,2})(?::?(\d{2}))?$/i.exec(tz)
  if (m) {
    const sign = m[1] === '+' ? 1 : -1
    const h = Number(m[2])
    const mm = m[3] ? Number(m[3]) : 0
    if (mm !== 0 || h > 14) return null
    if (h === 0) return 'UTC'
    return `Etc/GMT${sign > 0 ? '-' : '+'}${h}`
  }
  if (!/^[A-Za-z][A-Za-z0-9_+\-]*(\/[A-Za-z0-9_+\-]+)*$/.test(tz)) return null
  return tz
}

/** Пояс браузера сейчас (Intl). null — определить нельзя. */
export function detectDeviceTimeZone(): string | null {
  try {
    return normalizeDeviceTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone)
  } catch {
    return null
  }
}

/** Состояние своей настройки «Показывать моё местное время», как его прислал сервер. */
export type LocalTimeShareState = { shareLocalTime: boolean; shareLocalTimeAt: number }

export function normalizeShareState(raw: unknown): LocalTimeShareState | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as { shareLocalTime?: unknown; shareLocalTimeAt?: unknown }
  if (typeof r.shareLocalTime !== 'boolean') return null
  const at = typeof r.shareLocalTimeAt === 'number' && Number.isFinite(r.shareLocalTimeAt) ? r.shareLocalTimeAt : 0
  return { shareLocalTime: r.shareLocalTime, shareLocalTimeAt: Math.max(0, Math.floor(at)) }
}

/**
 * Какую пару хранить: новее по shareLocalTimeAt (часы сервера). При равенстве — пришедшую (сервер
 * мог вернуть то же время, но это его последнее слово).
 */
export function pickNewerShareState(
  stored: LocalTimeShareState | null,
  incoming: LocalTimeShareState | null,
): LocalTimeShareState | null {
  if (!incoming) return stored
  if (!stored) return incoming
  return incoming.shareLocalTimeAt >= stored.shareLocalTimeAt ? incoming : stored
}
