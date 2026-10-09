/**
 * «Секретку прочитали здесь» → POST /messages/mark-conversation-read { conversationId }.
 *
 * У секретной беседы облачных Message и квитанций нет, сервер ничего не пишет в БД. Но именно этот
 * вызов — единственный способ сообщить ему «прочитано на этом устройстве»: по нему он шлёт тихий
 * пуш на айфоны того же человека, и те снимают баннеры беседы (read-sync, src/push/readSync.ts).
 *
 * Что уходит на сервер — ТОЛЬКО conversationId. Ни текста, ни msgId, ни счётчиков: для секреток
 * сервер не должен знать ничего сверх того, что беседа открыта. Локальных счётчиков непрочитанных
 * этот модуль не трогает.
 *
 * Правила (проверяются в момент самой отправки, а не запроса — так хвост не уйдёт в беседу,
 * которую успели закрыть):
 *  - вызов только пока беседа реально на экране и читаема (это решает `isEligible`);
 *  - троттл ≈1.5 с на беседу, как у iOS (ChatViewModel.markRead);
 *  - «состояние» (открыли, вернулись в окно, пришёл ключ) — только передний вызов: ничего нового
 *    с прошлой отправки не появилось, лишний вызов = лишний тихий пуш на телефон;
 *  - «пришло новое входящее» — передний + хвостовой: без хвоста сообщение, пришедшее внутри окна
 *    троттла, осталось бы непрочитанным на телефоне.
 *
 * Модуль не знает ни про React, ни про axios — зависимости передаются снаружи (и подменяются в тесте).
 */

export const SECRET_READ_THROTTLE_MS = 1500

export type SecretReadSignalDeps = {
  /** Отправка. Получает только id беседы. Ошибки сети глотает вызывающий. */
  send: (conversationId: string) => void
  /** Можно ли сообщать о прочтении ПРЯМО СЕЙЧАС (беседа на экране, окно в фокусе, ключ есть). */
  isEligible: (conversationId: string) => boolean
  throttleMs?: number
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

export type SecretReadRequestOptions = {
  /** true — «пришло новое входящее»: внутри окна троттла оставить хвостовую отправку. */
  trailing?: boolean
}

/** Id самого свежего ВХОДЯЩЕГО сообщения ленты (свои и без id — пропускаем). null — входящих нет. */
export function newestIncomingMessageId(messages: unknown, meId: string | null | undefined): string | null {
  if (!Array.isArray(messages) || !meId) return null
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { id?: unknown; senderId?: unknown } | null | undefined
    const id = typeof m?.id === 'string' ? m.id : ''
    if (!id) continue
    const sender = typeof m?.senderId === 'string' ? m.senderId : ''
    if (!sender || sender === meId) continue
    return id
  }
  return null
}

export function createSecretReadSignal(deps: SecretReadSignalDeps) {
  const throttleMs = deps.throttleMs ?? SECRET_READ_THROTTLE_MS
  const now = deps.now ?? (() => Date.now())
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms))
  const clearTimer = deps.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>))

  const lastSentAt = new Map<string, number>()
  const trailing = new Map<string, unknown>()
  /** Последнее входящее, которое мы уже видели в ленте беседы (null — входящих не было). */
  const seenIncoming = new Map<string, string | null>()

  function fire(conversationId: string): void {
    if (!deps.isEligible(conversationId)) return
    lastSentAt.set(conversationId, now())
    try {
      deps.send(conversationId)
    } catch {
      // «прочитано» не должно ронять интерфейс
    }
  }

  function request(conversationId: string, opts: SecretReadRequestOptions = {}): void {
    const cid = String(conversationId ?? '').trim()
    if (!cid) return
    // Хвост уже стоит — он отправит всё накопленное к концу окна.
    if (trailing.has(cid)) return
    if (!deps.isEligible(cid)) return
    const last = lastSentAt.get(cid)
    const elapsed = last === undefined ? Number.POSITIVE_INFINITY : now() - last
    if (elapsed >= throttleMs) {
      fire(cid)
      return
    }
    if (!opts.trailing) return
    // Часы могли скакнуть назад (elapsed < 0): ждём не дольше одного окна.
    const wait = Math.min(throttleMs, Math.max(0, throttleMs - elapsed))
    trailing.set(
      cid,
      setTimer(() => {
        trailing.delete(cid)
        fire(cid)
      }, wait),
    )
  }

  /**
   * Лента беседы обновилась. Сигналим, только если в ней появилось НОВОЕ входящее: периодический
   * refetch данные не меняет, а каждый лишний вызов — это тихий пуш на телефон. Первое наблюдение
   * беседы только запоминается: «открыли» сообщает отдельный вызов `request`.
   */
  function observeMessages(conversationId: string, messages: unknown, meId: string | null | undefined): void {
    const cid = String(conversationId ?? '').trim()
    if (!cid || !Array.isArray(messages)) return
    const newest = newestIncomingMessageId(messages, meId)
    if (!seenIncoming.has(cid)) {
      seenIncoming.set(cid, newest)
      return
    }
    if (seenIncoming.get(cid) === newest) return
    seenIncoming.set(cid, newest)
    if (newest !== null) request(cid, { trailing: true })
  }

  /**
   * Беседу закрыли: при следующем входе первое наблюдение ленты снова только запоминается
   * (иначе накопившиеся за время отсутствия входящие дали бы второй вызов вслед за «открыли»).
   */
  function forgetSeen(conversationId: string): void {
    seenIncoming.delete(String(conversationId ?? '').trim())
  }

  /** Снять отложенные отправки (размонтирование страницы). */
  function cancel(): void {
    for (const handle of trailing.values()) clearTimer(handle)
    trailing.clear()
  }

  return { request, observeMessages, forgetSeen, cancel }
}
