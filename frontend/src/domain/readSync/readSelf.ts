/**
 * read-sync для веба и Electron: «беседу прочитали на другом моём устройстве».
 *
 * Сервер шлёт в комнату user:<я> сокет-событие "conversation:read-self"
 * {conversationId, readAt (мс, часы сервера), byDeviceId?, replay?} на каждое настоящее прочтение
 * (обычной беседы и секретки) — всем моим сокетам, в том числе читающему. При каждом подключении
 * сокета он ещё досылает «догон» тех же событий за сутки (replay:true, без byDeviceId).
 *
 * Что с этим делает веб:
 *  1) счётчики непрочитанных в списке бесед — перечитать с сервера (одним запросом на пачку событий:
 *     догон — до сотни штук разом);
 *  2) Electron (старый ПК-клиент, заморожен; его плашки живут в main-процессе): у моста наружу есть
 *     только «спрятать ВСЕ плашки» (window.native.hideOverlay — и звонковую тоже). Гасить ими одну
 *     беседу нельзя, поэтому прячем всё только когда это заведомо безопасно: событие НЕ с этого
 *     устройства, после перечитывания непрочитанных нет НИ В ОДНОЙ беседе и нет никакого звонка
 *     (входящего, исходящего, идущего), и пока список перечитывался, не пришло ни одного нового входящего
 *     (его плашка — уже про непрочитанное). Обычные плашки сообщений Electron и так убирает через 5 с —
 *     этим путём уходят «липкие»: пропущенный звонок, итог звонка.
 *
 * Модуль без React и сокета — всё передаётся снаружи (и подменяется в тесте).
 */

export const READ_SELF_EVENT = 'conversation:read-self'

/** Пачку событий (догон при подключении) сводим в один запрос списка бесед. */
export const READ_SELF_REFRESH_DEBOUNCE_MS = 400
/** Входящее, пришедшее незадолго до перечитывания списка или во время него, — повод ничего не прятать. */
export const INCOMING_GRACE_MS = 1_500

export type ReadSelfEvent = {
  conversationId: string
  /** Мс по часам сервера; null — не прислали. */
  readAt: number | null
  /** Устройство, на котором прочитали; null — неизвестно (догон, REST без устройства). */
  byDeviceId: string | null
  replay: boolean
}

export function parseReadSelf(raw: unknown): ReadSelfEvent | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as { conversationId?: unknown; readAt?: unknown; byDeviceId?: unknown; replay?: unknown }
  const conversationId = typeof r.conversationId === 'string' ? r.conversationId.trim() : ''
  if (!conversationId) return null
  const readAt = typeof r.readAt === 'number' && Number.isFinite(r.readAt) && r.readAt > 0 ? r.readAt : null
  const byDeviceId = typeof r.byDeviceId === 'string' && r.byDeviceId.trim() ? r.byDeviceId.trim() : null
  return { conversationId, readAt, byDeviceId, replay: r.replay === true }
}

/** Прочитали НЕ здесь (или неизвестно где — тогда считаем, что не здесь). */
export function isFromOtherDevice(ev: ReadSelfEvent, myDeviceId: string | null | undefined): boolean {
  if (!ev.byDeviceId) return true
  return !myDeviceId || ev.byDeviceId !== myDeviceId
}

/** Во всём списке бесед нет непрочитанного. Нет списка (или он битый) — «не знаем» = false. */
export function allConversationsRead(rows: unknown): boolean {
  if (!Array.isArray(rows) || rows.length === 0) return false
  for (const row of rows) {
    if (!row || typeof row !== 'object') return false
    const n = Number((row as { unreadCount?: unknown }).unreadCount ?? 0)
    if (!Number.isFinite(n) || n > 0) return false
  }
  return true
}

export type ReadSelfSyncDeps = {
  myDeviceId: () => string | null
  /** Перечитать список бесед с сервера; промис — когда свежие данные уже в кэше. */
  refreshConversations: () => Promise<unknown>
  /** Текущий список бесед из кэша (строки с unreadCount). */
  getConversationRows: () => unknown
  /** Есть ли сейчас хоть какой-то звонок (входящий/исходящий/идущий/свёрнутый). */
  hasCallActivity: () => boolean
  /** Когда (локальные мс) пришло последнее входящее сообщение от другого человека; 0 — не было. */
  lastIncomingMessageAt: () => number
  /** Спрятать все плашки Electron; null — не Electron (или моста нет). */
  hideAllOverlays: (() => void) | null
  debounceMs?: number
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

export function createReadSelfSync(deps: ReadSelfSyncDeps) {
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms))
  const clearTimer = deps.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>))
  const debounceMs = deps.debounceMs ?? READ_SELF_REFRESH_DEBOUNCE_MS
  const now = deps.now ?? (() => Date.now())

  let timer: unknown = null
  let overlayCheckPending = false
  let disposed = false

  async function flush() {
    timer = null
    const wantOverlayCheck = overlayCheckPending
    overlayCheckPending = false
    const startedAt = now()
    try {
      await deps.refreshConversations()
    } catch {
      return // без свежего списка ничего не гасим
    }
    if (disposed || !wantOverlayCheck || !deps.hideAllOverlays) return
    if (deps.hasCallActivity()) return
    // Входящее во время перечитывания: сервер мог посчитать список ДО него, а плашка — уже про него.
    if (deps.lastIncomingMessageAt() >= startedAt - INCOMING_GRACE_MS) return
    if (!allConversationsRead(deps.getConversationRows())) return
    try {
      deps.hideAllOverlays()
    } catch {
      /* мост Electron мог отвалиться — не страшно */
    }
  }

  return {
    /** Событие read-self с сокета. Возвращает разобранное событие (или null, если мусор). */
    handle(raw: unknown): ReadSelfEvent | null {
      if (disposed) return null
      const ev = parseReadSelf(raw)
      if (!ev) return null
      if (deps.hideAllOverlays && isFromOtherDevice(ev, deps.myDeviceId())) overlayCheckPending = true
      if (timer !== null) clearTimer(timer)
      timer = setTimer(() => {
        void flush()
      }, debounceMs)
      return ev
    },
    dispose(): void {
      disposed = true
      if (timer !== null) clearTimer(timer)
      timer = null
    },
  }
}
