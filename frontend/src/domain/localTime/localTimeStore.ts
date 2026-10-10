/**
 * Местное время — состояние вне React-дерева (как presenceDeviceStore): шапку диалога перерисовываем
 * ровно тогда, когда у её собеседника сменился пояс, а не на каждое событие сокета.
 *
 * Что здесь лежит:
 *  - «живые» пояса собеседников: из сокет-события localtime:update и из GET /users/:id/local-time.
 *    Пояс из списка бесед (participants[].user.localTime) сюда НЕ кладётся — шапка берёт его сама
 *    как запасной, пока живого нет. Живое всегда важнее: список обновляется раз в 20 с;
 *  - «эпоха» соединения: растёт на каждом connect сокета. Пока сокета не было, события терялись, —
 *    поэтому на новой эпохе живые записи сбрасываются, а открытый диалог перезапрашивает пояс;
 *  - своя настройка «Показывать моё местное время» (последнее, что сказал сервер).
 */
import { useSyncExternalStore } from 'react'
import { msUntilNextMinute, type LocalTimeInfo, type LocalTimeShareState } from './localTime'

export type PeerLocalTimeEntry = {
  info: LocalTimeInfo | null
  /** Когда получено (локальные мс) — чтобы ответ запроса, начатого ДО события, не затёр событие. */
  at: number
}

const peers = new Map<string, PeerLocalTimeEntry>()
let epoch = 0
let share: LocalTimeShareState | null = null
const listeners = new Set<() => void>()

function notify(): void {
  listeners.forEach((fn) => {
    try {
      fn()
    } catch {
      /* подписчик отвалился — остальных не роняем */
    }
  })
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

function sameInfo(a: LocalTimeInfo | null, b: LocalTimeInfo | null): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return a.timeZone === b.timeZone && a.city === b.city && a.offsetMinutes === b.offsetMinutes
}

export function getPeerLocalTime(userId: string | null | undefined): PeerLocalTimeEntry | undefined {
  if (!userId) return undefined
  return peers.get(userId)
}

/**
 * Живое значение (событие или ответ запроса). `at` — момент, к которому оно верно: для ответа
 * запроса — момент ОТПРАВКИ запроса. Если уже есть запись новее (событие пришло, пока запрос летел),
 * старый ответ её не затирает.
 */
export function setPeerLocalTime(userId: string, info: LocalTimeInfo | null, at: number = Date.now()): void {
  if (!userId) return
  const prev = peers.get(userId)
  if (prev && prev.at > at) return
  if (prev && sameInfo(prev.info, info)) {
    prev.at = at
    return
  }
  peers.set(userId, { info, at })
  notify()
}

export function clearPeerLocalTimes(): void {
  if (peers.size === 0) return
  peers.clear()
  notify()
}

export function getLocalTimeEpoch(): number {
  return epoch
}

/** Новое соединение сокета: живые записи могли устареть (события терялись) — сбрасываем. */
export function bumpLocalTimeEpoch(): void {
  epoch += 1
  peers.clear()
  notify()
}

export function getOwnShareState(): LocalTimeShareState | null {
  return share
}

export function setOwnShareState(next: LocalTimeShareState | null): void {
  if (share === next) return
  if (share && next && share.shareLocalTime === next.shareLocalTime && share.shareLocalTimeAt === next.shareLocalTimeAt) return
  share = next
  notify()
}

export function usePeerLocalTime(userId: string | null | undefined): PeerLocalTimeEntry | undefined {
  return useSyncExternalStore(
    subscribe,
    () => getPeerLocalTime(userId),
    () => undefined,
  )
}

export function useLocalTimeEpoch(): number {
  return useSyncExternalStore(subscribe, getLocalTimeEpoch, () => 0)
}

export function useOwnShareState(): LocalTimeShareState | null {
  return useSyncExternalStore(subscribe, getOwnShareState, () => null)
}

/* ---------- «тик» раз в минуту: один таймер на всех подписчиков ---------- */

const tickListeners = new Set<() => void>()
let tickStamp = Math.floor(Date.now() / 60_000)
let tickTimer: ReturnType<typeof setTimeout> | null = null
let visibilityHooked = false

function fireTick(): void {
  const stamp = Math.floor(Date.now() / 60_000)
  if (stamp !== tickStamp) {
    tickStamp = stamp
    tickListeners.forEach((fn) => {
      try {
        fn()
      } catch {
        /* ignore */
      }
    })
  }
}

function armTick(): void {
  if (tickTimer || tickListeners.size === 0) return
  tickTimer = setTimeout(() => {
    tickTimer = null
    fireTick()
    armTick()
  }, msUntilNextMinute(Date.now()))
}

function onVisibility(): void {
  // Фоновая вкладка душит таймеры — при возврате время должно быть верным сразу.
  try {
    if (typeof document !== 'undefined' && document.visibilityState === 'visible') fireTick()
  } catch {
    /* ignore */
  }
}

function subscribeTick(fn: () => void): () => void {
  tickListeners.add(fn)
  if (!visibilityHooked && typeof document !== 'undefined') {
    visibilityHooked = true
    try {
      document.addEventListener('visibilitychange', onVisibility)
      window.addEventListener('focus', onVisibility)
    } catch {
      /* ignore */
    }
  }
  tickStamp = Math.floor(Date.now() / 60_000)
  armTick()
  return () => {
    tickListeners.delete(fn)
    if (tickListeners.size === 0 && tickTimer) {
      clearTimeout(tickTimer)
      tickTimer = null
    }
  }
}

/** Номер текущей минуты; меняется на границе минуты — компонент перерисовывается. */
export function useMinuteTick(): number {
  return useSyncExternalStore(subscribeTick, () => tickStamp, () => tickStamp)
}
