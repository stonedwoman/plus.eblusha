/**
 * «Это устройство живёт в таком-то поясе» → сервер (сокет-событие localtime:report).
 *
 * Когда шлём (контракт сервера):
 *  - на КАЖДОМ connect/reconnect сокета, ПОСЛЕ обычного presence:state — сервер помечает устройство
 *    «на переднем плане» по presence:state и по нему же выбирает, чей пояс показывать собеседникам;
 *    если presence:state почему-то не ушёл за 2 с — шлём всё равно;
 *  - при смене пояса системы: у браузера события нет, поэтому сверяемся раз в минуту и при возврате
 *    в окно.
 *
 * Вместе с поясом — напоминание о своей настройке «Показывать моё местное время»
 * {shareLocalTime, shareLocalTimeAt}: последнее, что сказал сервер (хранится в localStorage по
 * человеку). Если Redis сервера откатился и выключенная настройка потерялась, сервер примет
 * напоминание (оно новее его собственного) — и время снова никому не покажется. Пока с сервера
 * ничего не получали — не шлём (иначе включили бы «по умолчанию» поверх чужого выключения).
 *
 * Ответ (ack): {ok:true, timeZone, shareLocalTime, shareLocalTimeAt} | {ok:false, error}.
 * Старый сервер не отвечает вовсе — это нормально: ждём следующего подключения.
 *
 * Модуль не знает ни про socket.io, ни про localStorage — всё передаётся снаружи (и подменяется в тесте).
 */
import { normalizeShareState, pickNewerShareState, type LocalTimeShareState } from './localTime'

export const LOCALTIME_REPORT_EVENT = 'localtime:report'
export const LOCALTIME_UPDATE_EVENT = 'localtime:update'
export const LOCALTIME_SETTINGS_EVENT = 'localtime:settings'

/** Сколько ждать presence:state после connect, прежде чем слать пояс без него. */
export const REPORT_AFTER_CONNECT_FALLBACK_MS = 2_000
/** Повтор после rate_limited / error. */
export const REPORT_RETRY_MS = 60_000
/** Как часто сверяем пояс системы. */
export const TIME_ZONE_CHECK_MS = 60_000

export type LocalTimeReportPayload = {
  timeZone: string
  shareLocalTime?: boolean
  shareLocalTimeAt?: number
}

export type LocalTimeReporterDeps = {
  isConnected: () => boolean
  /** Отправка с ответом; cb(err) — ответа не было (таймаут/старый сервер). */
  emitReport: (payload: LocalTimeReportPayload, cb: (err: unknown, ack: unknown) => void) => void
  detectTimeZone: () => string | null
  getUserId: () => string | null
  loadShare: (userId: string) => LocalTimeShareState | null
  saveShare: (userId: string, state: LocalTimeShareState) => void
  /** Новое состояние своей настройки для интерфейса (переключатель). */
  onShareState: (state: LocalTimeShareState | null) => void
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

export type LocalTimeReporter = ReturnType<typeof createLocalTimeReporter>

export function createLocalTimeReporter(deps: LocalTimeReporterDeps) {
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms))
  const clearTimer = deps.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>))

  let pendingAfterConnect = false
  let fallbackTimer: unknown = null
  let retryTimer: unknown = null
  let lastSentTz: string | null = null
  let rejectedTz: string | null = null

  function cancelFallback() {
    if (fallbackTimer !== null) {
      clearTimer(fallbackTimer)
      fallbackTimer = null
    }
  }

  function scheduleRetry() {
    if (retryTimer !== null) return
    retryTimer = setTimer(() => {
      retryTimer = null
      reportNow()
    }, REPORT_RETRY_MS)
  }

  /**
   * Состояние настройки от сервера (ответ на report, GET/PUT /status/me/local-time, localtime:settings).
   * fromReport — это ответ на наше же напоминание: сервер его уже учёл, его слово последнее.
   * Иначе, если сохранённое у нас новее (Redis сервера откатился) — оставляем своё и напоминаем.
   */
  function applyServerShare(raw: unknown, opts: { fromReport?: boolean } = {}): LocalTimeShareState | null {
    const incoming = normalizeShareState(raw)
    if (!incoming) return null
    const userId = deps.getUserId()
    if (!userId) {
      deps.onShareState(incoming)
      return incoming
    }
    const stored = deps.loadShare(userId)
    if (!opts.fromReport && stored && pickNewerShareState(stored, incoming) === stored) {
      deps.onShareState(stored)
      reportNow()
      return stored
    }
    deps.saveShare(userId, incoming)
    deps.onShareState(incoming)
    return incoming
  }

  function reportNow(): boolean {
    if (!deps.isConnected()) return false
    const tz = deps.detectTimeZone()
    if (!tz || tz === rejectedTz) return false
    const userId = deps.getUserId()
    const share = userId ? deps.loadShare(userId) : null
    const payload: LocalTimeReportPayload = share
      ? { timeZone: tz, shareLocalTime: share.shareLocalTime, shareLocalTimeAt: share.shareLocalTimeAt }
      : { timeZone: tz }
    lastSentTz = tz
    if (retryTimer !== null) {
      clearTimer(retryTimer)
      retryTimer = null
    }
    try {
      deps.emitReport(payload, (err, ack) => {
        if (err) return // старый сервер или обрыв — следующий connect пришлёт снова
        const a = ack as { ok?: unknown; error?: unknown } | null | undefined
        if (a && a.ok === true) {
          applyServerShare(a, { fromReport: true })
          return
        }
        const error = typeof a?.error === 'string' ? a.error : 'error'
        if (error === 'invalid_time_zone') {
          rejectedTz = tz
          return
        }
        scheduleRetry()
      })
    } catch {
      return false
    }
    return true
  }

  return {
    /** Сокет подключился: ждём presence:state, но не дольше REPORT_AFTER_CONNECT_FALLBACK_MS. */
    onConnect(): void {
      pendingAfterConnect = true
      cancelFallback()
      const userId = deps.getUserId()
      deps.onShareState(userId ? deps.loadShare(userId) : null)
      fallbackTimer = setTimer(() => {
        fallbackTimer = null
        if (!pendingAfterConnect) return
        pendingAfterConnect = false
        reportNow()
      }, REPORT_AFTER_CONNECT_FALLBACK_MS)
    },
    /** presence:state ушёл на сервер. */
    onPresenceSent(): void {
      if (!pendingAfterConnect) return
      pendingAfterConnect = false
      cancelFallback()
      reportNow()
    },
    onDisconnect(): void {
      pendingAfterConnect = false
      cancelFallback()
    },
    /** Сверка пояса системы (раз в минуту, при возврате в окно): сменился — сообщаем. */
    checkTimeZone(): boolean {
      if (pendingAfterConnect) return false
      const tz = deps.detectTimeZone()
      if (!tz || tz === lastSentTz) return false
      return reportNow()
    },
    applyServerShare,
    reportNow,
    /** Для тестов. */
    _state: () => ({ pendingAfterConnect, lastSentTz, rejectedTz, retryArmed: retryTimer !== null }),
  }
}
