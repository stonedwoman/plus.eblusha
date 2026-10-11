/**
 * Свежайшая версия каждой карточки бота по messageId (SPEC-share.md §2.7 п. 2).
 *
 * Источники приходят в любом порядке: сообщение в ленте (REST/кэш), событие message:update
 * {reason:"card"}, ответ на действие, GET /api/cards/:id. Храним лучшую по `rev`; меньший или равный
 * игнорируем. Поверх — оптимистичный вид на время запроса действия (снимается ответом или откатом).
 * Ленте (memo-строкам) перерисовываться не нужно: карточка подписана на своё значение сама.
 */
import { useMemo, useSyncExternalStore } from 'react'
import { newerCard, type BotCard } from './cardEnvelope'

const MAX_ENTRIES = 400

const latest = new Map<string, BotCard>()
const optimistic = new Map<string, BotCard>()
const versions = new Map<string, number>()
const listeners = new Map<string, Set<() => void>>()

function bump(messageId: string): void {
  versions.set(messageId, (versions.get(messageId) ?? 0) + 1)
  const set = listeners.get(messageId)
  if (set) for (const fn of Array.from(set)) fn()
}

function trim(): void {
  while (latest.size > MAX_ENTRIES) {
    const oldest = latest.keys().next().value as string | undefined
    if (oldest == null) break
    latest.delete(oldest)
  }
}

/** Предложить версию карточки; true — принята (rev больше прежней). */
export function offerCard(messageId: string, card: BotCard | null | undefined): boolean {
  if (!messageId || !card) return false
  const prev = latest.get(messageId)
  if (prev && !(card.rev > prev.rev)) return false
  latest.delete(messageId) // переставить в конец (свежие — дольше живут)
  latest.set(messageId, card)
  trim()
  bump(messageId)
  return true
}

/** Оптимистичный вид (null — снять). */
export function setOptimisticCard(messageId: string, card: BotCard | null): void {
  if (!messageId) return
  if (card) optimistic.set(messageId, card)
  else if (!optimistic.delete(messageId)) return
  bump(messageId)
}

export function getStoredCard(messageId: string): BotCard | null {
  return latest.get(messageId) ?? null
}

/** Что рисовать: оптимистичное, иначе свежайшее из хранилища и сообщения. */
export function resolveCard(messageId: string, fromMessage: BotCard | null): BotCard | null {
  const opt = optimistic.get(messageId)
  if (opt) return opt
  return newerCard(latest.get(messageId) ?? null, fromMessage)
}

function subscribe(messageId: string, fn: () => void): () => void {
  let set = listeners.get(messageId)
  if (!set) {
    set = new Set()
    listeners.set(messageId, set)
  }
  set.add(fn)
  return () => {
    set!.delete(fn)
    if (!set!.size) listeners.delete(messageId)
  }
}

/** Хук: карточка сообщения с учётом хранилища и оптимистичного вида. */
export function useBotCard(messageId: string, fromMessage: BotCard | null): BotCard | null {
  const version = useSyncExternalStore(
    (fn) => subscribe(messageId, fn),
    () => versions.get(messageId) ?? 0,
    () => versions.get(messageId) ?? 0,
  )
  return useMemo(() => resolveCard(messageId, fromMessage), [messageId, fromMessage, version])
}

/** Только для тестов. */
export function _resetCardStoreForTests(): void {
  latest.clear()
  optimistic.clear()
  versions.clear()
  listeners.clear()
}
