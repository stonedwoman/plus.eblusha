/**
 * Событие message:update для карточек бота (SPEC-share.md §2.4):
 *   { conversationId, messageId, reason: "card", cardType, message, card, serverNow }
 * Запасной таймер (SPEC.md §7.3 до поправок): { reason: "promise", message, promise, serverNow }.
 * Новые клиенты заменяют сообщение на месте, не перечитывая ленту; событий «раз в секунду» нет.
 */
import { botCardOfMessage, legacyPromiseToCard, parseCardEnvelope, type BotCard } from './cardEnvelope'
import { noteServerNow } from './cardClock'
import { offerCard } from './cardStore'

/** Карточка из события (конверт → запасной таймер → из message). */
export function cardFromUpdateEvent(payload: any): BotCard | null {
  if (!payload || typeof payload !== 'object') return null
  if (payload.reason === 'card') return parseCardEnvelope(payload.card) ?? botCardOfMessage(payload.message)
  if (payload.reason === 'promise') return legacyPromiseToCard(payload.promise) ?? botCardOfMessage(payload.message)
  return null
}

/** Обработать событие карточки: смещение часов + свежая версия в хранилище. true — это было событие карточки. */
export function applyCardUpdateEvent(payload: any): boolean {
  if (!payload || (payload.reason !== 'card' && payload.reason !== 'promise')) return false
  if (payload.serverNow != null) noteServerNow(payload.serverNow)
  const messageId = String(payload.messageId ?? payload.message?.id ?? '')
  const card = cardFromUpdateEvent(payload)
  if (messageId && card) offerCard(messageId, card)
  return true
}

/** Сообщение из события старее того, что уже лежит в кэше ленты (по rev карточки). */
export function isStaleCardMessage(cachedList: unknown, incoming: any): boolean {
  if (!Array.isArray(cachedList) || !incoming?.id) return false
  const cur = cachedList.find((m: any) => m && m.id === incoming.id)
  if (!cur) return false
  const a = botCardOfMessage(cur)
  const b = botCardOfMessage(incoming)
  return !!a && !!b && !(b.rev > a.rev)
}
