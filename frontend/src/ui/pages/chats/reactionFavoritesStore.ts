/**
 * Локальные быстрые реакции: запоминаем, что пользователь выбирал (в расширенном пикере),
 * и подставляем в 4 слота рядом с дефолтами.
 */
const STORAGE_VER = 1
const MAX_FAV = 96

/** Синхронизация быстрых реакций между всеми сообщениями в ленте (useSyncExternalStore). */
let reactionFavoritesVersion = 0
const reactionFavoritesListeners = new Set<() => void>()

export function subscribeReactionFavoritesVersion(onStoreChange: () => void): () => void {
  reactionFavoritesListeners.add(onStoreChange)
  return () => {
    reactionFavoritesListeners.delete(onStoreChange)
  }
}

export function getReactionFavoritesVersion(): number {
  return reactionFavoritesVersion
}

function bumpReactionFavoritesVersion(): void {
  reactionFavoritesVersion += 1
  reactionFavoritesListeners.forEach((fn) => fn())
}

function keyFor(userId: string) {
  return `eblusha:reaction-fav:v${STORAGE_VER}:${userId}`
}

export const DEFAULT_QUICK_REACTIONS: readonly string[] = ['👍', '😂', '❤️', '🤘']

export function loadFavoriteOrder(userId: string | null | undefined): string[] {
  if (!userId || typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(keyFor(String(userId)))
    if (!raw) return []
    const data = JSON.parse(raw) as { order?: unknown }
    if (!data || !Array.isArray(data.order)) return []
    return data.order.filter((e): e is string => typeof e === 'string' && e.trim().length > 0)
  } catch {
    return []
  }
}

/** После успешной постановки реакции (не снятия) */
export function recordReactionChoice(userId: string | null | undefined, emoji: string): void {
  if (!userId || typeof window === 'undefined' || !emoji) return
  try {
    const u = String(userId)
    const order = loadFavoriteOrder(u).filter((e) => e !== emoji)
    order.unshift(emoji)
    window.localStorage.setItem(keyFor(u), JSON.stringify({ order: order.slice(0, MAX_FAV) }))
    bumpReactionFavoritesVersion()
  } catch {
    /* quota / private mode */
  }
}

/** Четыре эмодзи для быстрого ряда: сначала недавние пользователя, затем дефолты */
export function getQuickReactionSlots(userId: string | null | undefined): string[] {
  const defaults = [...DEFAULT_QUICK_REACTIONS]
  const fav = loadFavoriteOrder(userId)
  const seen = new Set<string>()
  const out: string[] = []
  for (const e of [...fav, ...defaults]) {
    if (seen.has(e)) continue
    seen.add(e)
    out.push(e)
    if (out.length >= 4) break
  }
  return out.slice(0, 4)
}
