/**
 * Карточки бота — общие русские форматы (без React; гоняют юнит-тесты и общие векторы).
 *
 * Время всегда — в поясе ЗРИТЕЛЯ (по умолчанию пояс браузера); тесты передают пояс явно, чтобы не
 * зависеть от машины. Числа группируем неразрывным пробелом сами (не toLocaleString): одинаково в
 * любом браузере и в тестах — «1 738».
 */

/** «сообщение / сообщения / сообщений». */
export function plural(n: number, one: string, few: string, many: string): string {
  const a = Math.abs(Math.trunc(n))
  const m10 = a % 10
  const m100 = a % 100
  if (m10 === 1 && m100 !== 11) return one
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few
  return many
}

/** 1738 → «1 738» (неразрывный пробел). */
export function groupDigits(n: number): string {
  const s = String(Math.trunc(Math.abs(n)))
  const g = s.replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
  return n < 0 ? `−${g}` : g
}

const pad2 = (n: number) => String(n).padStart(2, '0')

/** Обратный/прямой отсчёт: «12:47», «1:12:47»; withHours — сразу под «ч:мм:сс» (без сдвигов раскладки). */
export function formatCountdown(totalSec: number, withHours = false): string {
  const sec = Math.max(0, Math.floor(totalSec))
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = sec % 60
  return withHours || h > 0 ? `${h}:${pad2(m)}:${pad2(s)}` : `${pad2(m)}:${pad2(s)}`
}

/** Длительность словами: «42 с», «7 мин», «1 ч», «1 ч 12 мин» (минуты вниз). */
export function formatDuration(totalSec: number): string {
  const sec = Math.floor(Math.abs(totalSec))
  if (sec < 60) return `${sec} с`
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  if (!h) return `${m} мин`
  return m ? `${h} ч ${m} мин` : `${h} ч`
}

/** Минуты словами для скринридера: «1 минута», «12 минут». */
export function minutesWords(n: number): string {
  return `${n} ${plural(n, 'минута', 'минуты', 'минут')}`
}

function viewerZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined
  } catch {
    return undefined
  }
}

const hmCache = new Map<string, Intl.DateTimeFormat | null>()
const ymdCache = new Map<string, Intl.DateTimeFormat | null>()
const fullCache = new Map<string, Intl.DateTimeFormat | null>()

function cached(map: Map<string, Intl.DateTimeFormat | null>, zone: string | undefined, make: (z: string | undefined) => Intl.DateTimeFormat) {
  const key = zone ?? ''
  if (map.has(key)) return map.get(key) ?? null
  let f: Intl.DateTimeFormat | null = null
  try {
    f = make(zone)
  } catch {
    f = null
  }
  map.set(key, f)
  return f
}

/** «14:15» (24 ч) в поясе; неизвестный браузеру пояс — пояс браузера. */
export function formatHm(ms: number, zone?: string): string {
  const f =
    cached(hmCache, zone, (z) => new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: z })) ??
    cached(hmCache, undefined, () => new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }))
  if (!f) {
    const d = new Date(ms)
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
  }
  return f.format(new Date(ms))
}

type Parts = { y: number; mo: number; d: number; h: number; mi: number; s: number }

function partsIn(ms: number, zone?: string): Parts {
  const f = cached(
    fullCache,
    zone,
    (z) =>
      new Intl.DateTimeFormat('en-US', {
        timeZone: z,
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      }),
  )
  if (!f) {
    const d = new Date(ms)
    return { y: d.getFullYear(), mo: d.getMonth() + 1, d: d.getDate(), h: d.getHours(), mi: d.getMinutes(), s: d.getSeconds() }
  }
  const out: Record<string, number> = {}
  for (const p of f.formatToParts(new Date(ms))) {
    if (p.type !== 'literal') out[p.type] = Number(p.value)
  }
  return { y: out.year, mo: out.month, d: out.day, h: out.hour === 24 ? 0 : out.hour, mi: out.minute, s: out.second }
}

/** Смещение пояса от UTC в минутах в момент ms (Asia/Krasnoyarsk → 420). */
export function zoneOffsetMinutes(ms: number, zone?: string): number {
  const p = partsIn(ms, zone)
  const asUtc = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s)
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60000)
}

/** Номер дня (UTC-сутки местной даты) — чтобы сравнивать «сегодня/завтра/вчера». */
function dayIndex(ms: number, zone?: string): number {
  const p = partsIn(ms, zone)
  return Math.round(Date.UTC(p.y, p.mo - 1, p.d) / 86_400_000)
}

const MONTHS_SHORT = ['янв.', 'февр.', 'мар.', 'апр.', 'мая', 'июн.', 'июл.', 'авг.', 'сент.', 'окт.', 'нояб.', 'дек.']

/**
 * Момент относительно «сейчас» зрителя: «14:15», «завтра, 02:00», «вчера, 23:50», «12 окт., 02:00».
 * withComma=false даёт «завтра в 02:00» (для «обещал завтра в …»).
 */
export function formatDayTime(ms: number, nowMs: number, zone?: string, style: 'comma' | 'in' = 'comma'): string {
  const hm = formatHm(ms, zone)
  const diff = dayIndex(ms, zone) - dayIndex(nowMs, zone)
  const sep = style === 'comma' ? ', ' : ' в '
  if (diff === 0) return hm
  if (diff === 1) return `завтра${sep}${hm}`
  if (diff === -1) return `вчера${sep}${hm}`
  const p = partsIn(ms, zone)
  return `${p.d} ${MONTHS_SHORT[p.mo - 1]}${sep}${hm}`
}

/** Пояс зрителя (браузера); undefined — не знаем (тогда форматтеры берут пояс по умолчанию). */
export function defaultViewerZone(): string | undefined {
  return viewerZone()
}

/** Имя человека в карточке: свежее из кэша пользователей, иначе снимок сервера. */
export function freshName(id: string | null | undefined, snapshot: string | null | undefined, resolve?: (id: string) => string | null | undefined): string {
  const fromCache = id && resolve ? resolve(id) : null
  const s = (fromCache && String(fromCache).trim()) || (snapshot && String(snapshot).trim()) || ''
  return s || 'Участник'
}

/** Часть строки с выделением (имена жирным — как **Рома** в запасном тексте). */
export type RichPart = { text: string; bold?: boolean; tone?: 'ok' }
export type RichLine = RichPart[]

export const richText = (line: RichLine): string => line.map((p) => p.text).join('')
