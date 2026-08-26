/**
 * Присутствие: с какого устройства человек сейчас в сети (телефон / ПК-клиент / браузер).
 *
 * Сервер шлёт устройство двумя путями:
 *  - `presence:update` → третьим полем `device` (null = неизвестно или офлайн);
 *  - `presence:device:snapshot:batch` → снапшот по всем, кто уже в сети на момент коннекта.
 *
 * Держим это ОТДЕЛЬНО от статуса (ONLINE/BACKGROUND/IN_CALL) и вне React-дерева:
 * бейдж устройства нужен в десятке мест (аватары в списке бесед, шапка, карточка профиля),
 * а прокидывать карту пропсами через весь ChatsPage — значит ре-рендерить 150-строчный
 * список на каждое presence-событие. Поэтому внешний стор + useSyncExternalStore:
 * перерисовывается ровно тот аватар, у которого реально сменилось устройство.
 */
import { useSyncExternalStore } from 'react'

export type PresenceDevice = 'mobile' | 'desktop' | 'web'

const deviceByUserId = new Map<string, PresenceDevice>()
const listeners = new Set<() => void>()

function notify(): void {
  listeners.forEach((fn) => {
    try {
      fn()
    } catch {
      /* подписчик отвалился — не роняем остальных */
    }
  })
}

function subscribePresenceDevices(onStoreChange: () => void): () => void {
  listeners.add(onStoreChange)
  return () => {
    listeners.delete(onStoreChange)
  }
}

/** 'mobile' | 'desktop' | 'web' из чего угодно; всё прочее → null («устройство неизвестно»). */
export function normalizePresenceDevice(raw: unknown): PresenceDevice | null {
  const v = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  if (v === 'mobile' || v === 'desktop' || v === 'web') return v
  return null
}

export function getPresenceDevice(userId: string | null | undefined): PresenceDevice | null {
  if (!userId || typeof userId !== 'string') return null
  return deviceByUserId.get(userId) ?? null
}

/** device=null стирает запись (человек ушёл в офлайн либо устройство неизвестно). */
export function setPresenceDevice(userId: string | null | undefined, device: PresenceDevice | null): void {
  if (!userId || typeof userId !== 'string') return
  const prev = deviceByUserId.get(userId) ?? null
  if (prev === device) return
  if (device) deviceByUserId.set(userId, device)
  else deviceByUserId.delete(userId)
  notify()
}

/** Снапшот `presence:device:snapshot:batch`: применяем пачкой, дёргаем подписчиков один раз. */
export function applyPresenceDeviceSnapshot(
  items: ReadonlyArray<{ userId?: unknown; device?: unknown }> | null | undefined,
): void {
  if (!Array.isArray(items) || items.length === 0) return
  let changed = false
  for (const item of items) {
    const userId = typeof item?.userId === 'string' ? item.userId : null
    if (!userId) continue
    const device = normalizePresenceDevice(item?.device)
    const prev = deviceByUserId.get(userId) ?? null
    if (prev === device) continue
    if (device) deviceByUserId.set(userId, device)
    else deviceByUserId.delete(userId)
    changed = true
  }
  if (changed) notify()
}

export function clearPresenceDevices(): void {
  if (deviceByUserId.size === 0) return
  deviceByUserId.clear()
  notify()
}

/**
 * Подписка на устройство конкретного пользователя. useSyncExternalStore сравнивает
 * снапшот через Object.is, поэтому чужие изменения ре-рендер не вызывают.
 */
export function usePresenceDevice(userId: string | null | undefined): PresenceDevice | null {
  return useSyncExternalStore(
    subscribePresenceDevices,
    () => getPresenceDevice(userId),
    () => null,
  )
}

/** Подпись устройства для тултипов: «В сети · Телефон». */
export const PRESENCE_DEVICE_LABEL_RU: Record<PresenceDevice, string> = {
  mobile: 'Телефон',
  desktop: 'ПК',
  web: 'Браузер',
}

/** Подпись статуса для тултипов. */
export function presenceStatusLabelRu(status: string | null | undefined): string | null {
  const v = (status ?? '').toString().toUpperCase()
  if (v === 'ONLINE') return 'В сети'
  if (v === 'BACKGROUND') return 'В фоне'
  if (v === 'AWAY') return 'Отошёл'
  if (v === 'IN_CALL') return 'В звонке'
  return null
}

/** Цвет глифа устройства = цвет статуса (тот же, что был у точки). */
export function presenceStatusColor(status: string | null | undefined): string {
  const v = (status ?? '').toString().toUpperCase()
  if (v === 'ONLINE') return '#22c55e'
  if (v === 'IN_CALL') return '#ef4444'
  if (v === 'BACKGROUND') return '#facc15'
  if (v === 'AWAY') return '#f59e0b'
  return '#9ca3af'
}

/** Тултип «В сети · Телефон». Если статус неизвестен — только устройство. */
export function presenceDeviceTitleRu(status: string | null | undefined, device: PresenceDevice | null): string | null {
  const deviceLabel = device ? PRESENCE_DEVICE_LABEL_RU[device] : null
  const statusLabel = presenceStatusLabelRu(status)
  if (statusLabel && deviceLabel) return `${statusLabel} · ${deviceLabel}`
  return statusLabel ?? deviceLabel
}
