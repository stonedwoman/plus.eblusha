/**
 * Действия по карточкам бота — один диспетчер для всех типов (SPEC-share.md §2.3, §2.7 п. 5).
 *
 *   GET  /api/cards/:messageId                        → { message, card, serverNow }
 *   POST /api/cards/:messageId/act { action, input? } → { message, card, serverNow }
 *
 * Запасной путь (таймер по SPEC.md до поправок, card.source === "legacy-promise"):
 *   GET  /api/promises/:id                  → { promise, serverNow }
 *   POST /api/promises/:id/{arrived|cancel|reopen} → { promise, serverNow }
 *
 * Поток: оптимистичный вид (по желанию типа) → ответ сервера заменяет карточку (по rev) → 409 —
 * молча перерисовать по card из ответа → прочее — откат и тост (тексты — у типа карточки).
 */
import { botCardOfMessage, legacyPromiseToCard, parseCardEnvelope, type BotCard } from './cardEnvelope'
import { offerCard, setOptimisticCard } from './cardStore'

export type CardFailure =
  | 'not_found' // 404 CARD_NOT_FOUND — нет карточки / не участник: молча убрать оптимистичное
  | 'bad_input' // 400 CARD_BAD_INPUT
  | 'forbidden' // 403 CARD_FORBIDDEN
  | 'closed' // 409 CARD_CLOSED {card}
  | 'expired' // 409 CARD_ACTION_EXPIRED {card}
  | 'disabled' // 404 CARD_TYPE_DISABLED (BOT_SHARE=off / PROMISE_TIMERS=off)
  | 'rate_limited' // 429
  | 'error' // прочее, сеть

export type CardActResult = { ok: true; card: BotCard | null; message: any | null } | { ok: false; failure: CardFailure; card: BotCard | null }

/** Транспорт действий: в приложении — HTTP, на dev-стенде — поддельный сервер. */
export type CardTransport = {
  act: (messageId: string, card: BotCard, action: string, input?: unknown) => Promise<CardActResult>
  fetch?: (messageId: string, card: BotCard) => Promise<CardActResult>
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)

/** Карточка из тела ответа: {card} (конверт) или {promise} (запасной таймер). */
export function cardFromBody(body: any): BotCard | null {
  if (!body || typeof body !== 'object') return null
  if (body.card) {
    const c = parseCardEnvelope(body.card)
    if (c) return c
  }
  if (body.promise) {
    const c = legacyPromiseToCard(body.promise)
    if (c) return c
  }
  if (body.message) return botCardOfMessage(body.message)
  return null
}

/** Код ошибки HTTP → что делать клиенту (§2.3; запасной таймер — коды PROMISE_*). */
export function classifyCardError(status: number | undefined, body: any): CardFailure {
  const code = str(body?.code) ?? str(body?.error) ?? ''
  if (status === 429) return 'rate_limited'
  if (code === 'CARD_TYPE_DISABLED' || code === 'PROMISE_DISABLED' || code === 'SHARE_DISABLED') return 'disabled'
  if (code === 'CARD_ACTION_EXPIRED' || code === 'PROMISE_REOPEN_EXPIRED') return 'expired'
  if (code === 'CARD_CLOSED' || code === 'PROMISE_CLOSED') return 'closed'
  if (status === 403 || code === 'CARD_FORBIDDEN' || code === 'PROMISE_CANCEL_FORBIDDEN') return 'forbidden'
  if (status === 400 || code === 'CARD_BAD_INPUT') return 'bad_input'
  if (status === 404) return 'not_found'
  if (status === 409) return 'closed'
  return 'error'
}

/** Заменить сообщение в кэше ленты (как updateMessageInCache в ChatsPage), только если оно не старее. */
export function replaceCardMessageInCache(client: any, conversationId: string | null | undefined, message: any): void {
  if (!client || !conversationId || !message?.id) return
  const incoming = botCardOfMessage(message)
  client.setQueryData(['messages', conversationId], (old: any) => {
    if (!Array.isArray(old)) return old
    const idx = old.findIndex((m: any) => m && m.id === message.id)
    if (idx === -1) return old
    const cur = botCardOfMessage(old[idx])
    if (cur && incoming && !(incoming.rev > cur.rev)) return old
    const next = [...old]
    next[idx] = { ...next[idx], ...message }
    return next
  })
}

/**
 * Выполнить действие: оптимистичный вид → запрос → свежая карточка по rev; при ошибке — откат.
 * Возвращает итог (тост решает вызывающий: тексты у каждого типа свои).
 */
export async function runCardAction(opts: {
  transport: CardTransport
  messageId: string
  card: BotCard
  action: string
  input?: unknown
  optimistic?: BotCard | null
  client?: any
  conversationId?: string | null
}): Promise<CardActResult> {
  const { transport, messageId, card, action, input, optimistic, client, conversationId } = opts
  if (optimistic) setOptimisticCard(messageId, optimistic)
  let res: CardActResult
  try {
    res = await transport.act(messageId, card, action, input)
  } catch {
    res = { ok: false, failure: 'error', card: null }
  }
  if (res.card) offerCard(messageId, res.card)
  if (res.ok && res.message) replaceCardMessageInCache(client, conversationId, res.message)
  setOptimisticCard(messageId, null)
  return res
}

const refreshed = new Set<string>()

/**
 * Один раз за сеанс перечитать незакрытую карточку (GET): свежая версия и serverNow для смещения часов
 * (SPEC.md §4.3). Закрытые не перечитываем — им часы не нужны.
 */
export function refreshCardOnce(opts: { transport: CardTransport; messageId: string; card: BotCard; client?: any; conversationId?: string | null }): void {
  const { transport, messageId, card, client, conversationId } = opts
  if (!transport.fetch || card.closed || refreshed.has(messageId)) return
  refreshed.add(messageId)
  if (refreshed.size > 500) refreshed.delete(refreshed.values().next().value as string)
  transport
    .fetch(messageId, card)
    .then((res) => {
      if (res.card) offerCard(messageId, res.card)
      if (res.ok && res.message) replaceCardMessageInCache(client, conversationId, res.message)
    })
    .catch(() => {})
}
