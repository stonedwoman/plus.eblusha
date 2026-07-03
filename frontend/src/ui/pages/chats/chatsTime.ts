/**
 * Форматирование времени и дат сообщений (единый русский стиль 24ч, ru-RU).
 * Часы приведены к ru-RU/24ч намеренно, чтобы не зависеть от локали браузера.
 */

export function formatMessageClockLabel(d: Date | null): string {
  if (!d || !Number.isFinite(d.getTime())) return ''
  return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', hour12: false })
}

/** «сегодня» / «вчера» / «N дней назад», иначе краткая дата (локальный календарь) */
export function formatRuRelativeSendDay(at: Date | null): string | null {
  if (!at || !Number.isFinite(at.getTime())) return null

  const startOfLocalDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate())
  const dayDiffCal = (): number =>
    Math.round((startOfLocalDay(new Date()).getTime() - startOfLocalDay(at).getTime()) / 86_400_000)

  const dd = dayDiffCal()
  if (dd < 0) {
    const now = new Date()
    const y = now.getFullYear() !== at.getFullYear()
    return at.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', ...(y ? { year: 'numeric' as const } : {}) })
  }
  if (dd === 0) return 'сегодня'
  if (dd === 1) return 'вчера'
  const MAX_DAY_COUNT = 45
  if (dd <= MAX_DAY_COUNT) return ruPluralDaysAgo(dd)

  const now = new Date()
  const y = now.getFullYear() !== at.getFullYear()
  return at.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', ...(y ? { year: 'numeric' as const } : {}) })
}

export function ruPluralDaysAgo(daysAgoFromToday: number): string {
  const n = Math.max(2, Math.floor(daysAgoFromToday))
  const mod100 = n % 100
  const mod10 = n % 10
  if (mod100 >= 11 && mod100 <= 14) return `${n} дней назад`
  if (mod10 === 1) return `${n} день назад`
  if (mod10 >= 2 && mod10 <= 4) return `${n} дня назад`
  return `${n} дней назад`
}

/**
 * Время для маленьких бабблов (карточки ответа/пересылки), право-выровненное.
 * Сегодня → «19:32»; иначе → «<день>, 19:32» («вчера, 19:32», «2 дня назад, 19:32», «14 авг, 19:32»).
 */
export function formatSmallBubbleTimeLabel(d: Date | null): string {
  const clock = formatMessageClockLabel(d)
  if (!clock) return ''
  const rel = formatRuRelativeSendDay(d)
  if (!rel || rel === 'сегодня') return clock
  return `${clock}, ${rel}`
}
