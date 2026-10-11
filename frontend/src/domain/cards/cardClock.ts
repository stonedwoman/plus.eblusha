/**
 * CardClock — ОДНИ часы на приложение для всех карточек бота (SPEC.md §10.3, SPEC-share.md §2.7).
 *
 *  - Секундный тик (таймер обещания) выровнен по границе секунды сервера: delay = 1000 − (now % 1000) + 5.
 *    Каждый тик карточки пересчитывают вид от deadlineAt − now (не уменьшают счётчик) — нет дрейфа,
 *    после сна/фона сразу верно.
 *  - Минутный тик («ещё 42 мин» у переписки) — на границе минуты; если идут секундные — на ближайшем
 *    секундном, пересёкшем минуту.
 *  - Подписчиков нет или вкладка в фоне — часы стоят (ни одного setTimeout).
 *  - Смещение часов сервера: serverNow из ответов и событий, медиана последних трёх замеров,
 *    применяется только при |смещение| > 2 с.
 */
import { useEffect, useState } from 'react'

export type ClockGranularity = 'sec' | 'min'
type Listener = (nowMs: number) => void

const SKEW_SAMPLES = 3
const SKEW_APPLY_MS = 2000

let samples: number[] = []
let skewMs = 0

/** Записать serverNow (ISO или мс) из ответа/события; localNowMs — момент получения. */
export function noteServerNow(serverNow: unknown, localNowMs: number = Date.now()): void {
  const ms =
    typeof serverNow === 'number' ? serverNow : typeof serverNow === 'string' ? Date.parse(serverNow) : Number.NaN
  if (!Number.isFinite(ms)) return
  samples.push(ms - localNowMs)
  if (samples.length > SKEW_SAMPLES) samples = samples.slice(-SKEW_SAMPLES)
  const sorted = [...samples].sort((a, b) => a - b)
  const med = sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
  skewMs = Math.abs(med) > SKEW_APPLY_MS ? Math.round(med) : 0
}

export function getClockSkewMs(): number {
  return skewMs
}

/** «Сейчас» по часам сервера. */
export function serverNowMs(): number {
  return Date.now() + skewMs
}

/** Сколько ждать до следующего тика (чистая функция — для тестов). */
export function nextTickDelay(nowMs: number, granularity: ClockGranularity): number {
  const period = granularity === 'sec' ? 1000 : 60_000
  const r = ((nowMs % period) + period) % period
  return period - r + 5
}

const subs: Record<ClockGranularity, Set<Listener>> = { sec: new Set(), min: new Set() }
let timer: ReturnType<typeof setTimeout> | null = null
let lastMinute = -1
let visibilityBound = false

const hidden = (): boolean => typeof document !== 'undefined' && document.visibilityState === 'hidden'

function stop(): void {
  if (timer != null) clearTimeout(timer)
  timer = null
}

function schedule(): void {
  stop()
  if (hidden()) return
  const gran: ClockGranularity | null = subs.sec.size ? 'sec' : subs.min.size ? 'min' : null
  if (!gran) return
  timer = setTimeout(fire, nextTickDelay(serverNowMs(), gran))
}

function fire(): void {
  timer = null
  const now = serverNowMs()
  for (const fn of Array.from(subs.sec)) {
    try {
      fn(now)
    } catch {}
  }
  const minute = Math.floor(now / 60_000)
  if (minute !== lastMinute) {
    lastMinute = minute
    for (const fn of Array.from(subs.min)) {
      try {
        fn(now)
      } catch {}
    }
  }
  schedule()
}

function bindVisibility(): void {
  if (visibilityBound || typeof document === 'undefined') return
  visibilityBound = true
  document.addEventListener('visibilitychange', () => {
    if (hidden()) {
      stop()
      return
    }
    // Вернулись из фона: сразу верные цифры, потом снова по границе секунды.
    lastMinute = -1
    fire()
  })
}

/** Подписаться на тики; вернёт отписку. */
export function subscribeCardClock(granularity: ClockGranularity, fn: Listener): () => void {
  bindVisibility()
  subs[granularity].add(fn)
  if (granularity === 'min' && lastMinute < 0) lastMinute = Math.floor(serverNowMs() / 60_000)
  if (timer == null || granularity === 'sec') schedule()
  return () => {
    subs[granularity].delete(fn)
    if (!subs.sec.size && !subs.min.size) stop()
  }
}

/**
 * «Сейчас» по часам сервера, перерисовка на тиках. granularity null — не тикать (закрытая карточка,
 * карточка вне экрана): значение обновится при следующем рендере по другой причине.
 */
export function useCardClock(granularity: ClockGranularity | null): number {
  const [now, setNow] = useState(() => serverNowMs())
  useEffect(() => {
    if (!granularity) return
    setNow(serverNowMs())
    return subscribeCardClock(granularity, setNow)
  }, [granularity])
  return granularity ? now : serverNowMs()
}

/** Только для тестов. */
export function _resetCardClockForTests(): void {
  samples = []
  skewMs = 0
  stop()
  subs.sec.clear()
  subs.min.clear()
  lastMinute = -1
}
