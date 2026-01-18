import { DateTime } from 'luxon'
import type { IntervalUTC } from './availability.types'

export const GRID_START_HOUR = 0
export const GRID_END_HOUR = 24
export const SLOT_MINUTES = 60
export const SLOTS_PER_DAY = ((GRID_END_HOUR - GRID_START_HOUR) * 60) / SLOT_MINUTES
export const LOCALE = 'ru'

export const getFallbackTimeZone = () => {
  if (typeof Intl === 'undefined') return 'UTC'
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
}

export const getTodayInZone = (timeZone: string) => {
  return DateTime.now().setZone(timeZone).startOf('day')
}

export const buildDayColumns = (timeZone: string, days = 5) => {
  const today = getTodayInZone(timeZone)
  return Array.from({ length: days }, (_, idx) => today.plus({ days: idx }))
}

export const buildTimeSlots = (day: DateTime) => {
  const base = day.set({ hour: GRID_START_HOUR, minute: 0, second: 0, millisecond: 0 })
  return Array.from({ length: SLOTS_PER_DAY }, (_, idx) => base.plus({ minutes: idx * SLOT_MINUTES }))
}

export const getCellDateTime = (day: DateTime, rowIndex: number) => {
  const base = day.set({ hour: GRID_START_HOUR, minute: 0, second: 0, millisecond: 0 })
  const start = base.plus({ minutes: rowIndex * SLOT_MINUTES })
  const end = start.plus({ minutes: SLOT_MINUTES })
  return { start, end }
}

export const toUtcInterval = (start: DateTime, end: DateTime): IntervalUTC => {
  const startUtc = start.toUTC().toISO({ suppressMilliseconds: true }) ?? start.toUTC().toISO()
  const endUtc = end.toUTC().toISO({ suppressMilliseconds: true }) ?? end.toUTC().toISO()
  return { startUtcISO: startUtc ?? start.toUTC().toISO() ?? '', endUtcISO: endUtc ?? end.toUTC().toISO() ?? '' }
}

export const intervalKey = (interval: IntervalUTC) => `${interval.startUtcISO}|${interval.endUtcISO}`

export const intervalToMillis = (interval: IntervalUTC) => {
  const startUtc = DateTime.fromISO(interval.startUtcISO, { zone: 'utc' }).toMillis()
  const endUtc = DateTime.fromISO(interval.endUtcISO, { zone: 'utc' }).toMillis()
  return { startUtc, endUtc }
}

export const isIntervalCovering = (interval: IntervalUTC, cellStartUtc: number, cellEndUtc: number) => {
  const { startUtc, endUtc } = intervalToMillis(interval)
  return startUtc <= cellStartUtc && endUtc >= cellEndUtc
}

export const isIntervalIntersecting = (interval: IntervalUTC, cellStartUtc: number, cellEndUtc: number) => {
  const { startUtc, endUtc } = intervalToMillis(interval)
  return startUtc < cellEndUtc && endUtc > cellStartUtc
}

export const formatDayLabel = (date: DateTime) => date.setLocale(LOCALE).toFormat('ccc dd.MM')

export const formatTimeLabel = (date: DateTime) => date.setLocale(LOCALE).toFormat('HH:mm')

export const formatDateTimeRange = (startUtcISO: string, endUtcISO: string, timeZone: string) => {
  const start = DateTime.fromISO(startUtcISO, { zone: 'utc' }).setZone(timeZone)
  const end = DateTime.fromISO(endUtcISO, { zone: 'utc' }).setZone(timeZone)
  return {
    dayLabel: formatDayLabel(start),
    startLabel: formatTimeLabel(start),
    endLabel: formatTimeLabel(end),
  }
}
