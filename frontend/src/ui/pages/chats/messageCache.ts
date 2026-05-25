/** Keep at most this many messages per conversation in the React Query client cache. */
export const MAX_CACHED_CHAT_MESSAGES = 800

/** Drop oldest messages when the in-memory list grows too large (newest kept). */
export function trimMessageCache<T extends { id?: string; createdAt?: string | Date | null }>(
  messages: T[],
  max = MAX_CACHED_CHAT_MESSAGES,
): T[] {
  if (!Array.isArray(messages) || messages.length <= max) return messages
  return messages.slice(messages.length - max)
}
