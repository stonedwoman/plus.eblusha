import { io } from 'socket.io-client'
import { useAppStore } from '../domain/store/appStore'

function computeWsUrl() {
  const envUrl = (import.meta as any).env?.VITE_WS_URL as string | undefined
  if (envUrl) return envUrl
  try {
    const { hostname, port } = window.location
    // Разработка через Vite: используем прокси на /socket.io
    if ((hostname === 'localhost' || hostname === '127.0.0.1') && port === '5173') {
      return '/'
    }
    // Локально без прокси
    if (hostname === 'localhost' || hostname === '127.0.0.1') {
      return 'http://localhost:4000'
    }
    // Прод: тот же origin
    return '/'
  } catch {
    return '/'
  }
}

const WS_URL = computeWsUrl()
export const socket = io(WS_URL, {
  autoConnect: false,
  transports: ['websocket'],
})

// Expose socket globally for Electron overlay bridge
if (typeof window !== 'undefined') {
  // Prevent overwriting if already exists
  if (!(window as any).socket) {
    (window as any).socket = socket;
  }
}

export function connectSocket() {
  const token = useAppStore.getState().session?.accessToken
  if (!token) return
  socket.auth = { token }
  // дублируем токен в query на случай прокси/нестандартных клиентов
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(socket.io.opts as any).query = { token }
  if (!socket.connected) {
    socket.connect()
  }
}

// Обновляем токен при попытках реконнекта
socket.io.on('reconnect_attempt', () => {
  const token = useAppStore.getState().session?.accessToken
  if (token) {
    socket.auth = { token }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(socket.io.opts as any).query = { token }
  }
})

socket.on('disconnect', () => {
  console.log('socket disconnected')
})

// Contact request events
export function onContactRequest(cb: (payload: any) => void) {
  socket.on('contacts:request:new', cb)
}
export function onContactAccepted(cb: (payload: any) => void) {
  socket.on('contacts:request:accepted', cb)
}
export function onContactRemoved(cb: (payload: { contactId: string }) => void) {
  socket.on('contacts:removed', cb)
}
export function onConversationNew(cb: (payload: any) => void) {
  socket.on('conversations:new', cb)
}
export function onConversationDeleted(cb: (payload: any) => void) {
  socket.on('conversations:deleted', cb)
}
export function onConversationUpdated(cb: (payload: any) => void) {
  socket.on('conversations:updated', cb)
}
export function onConversationMemberRemoved(cb: (payload: any) => void) {
  socket.on('conversations:member:removed', cb)
}

// Secret chat helpers
export function offerSecretChat(conversationId: string) {
  if (!socket.connected) {
    connectSocket()
  }
  socket.emit('secret:chat:offer', { conversationId })
}
export function onSecretChatOffer(cb: (payload: { conversationId: string; from: { id: string; name: string; deviceId?: string | null } }) => void) {
  const handler = (payload: { conversationId: string; from: { id: string; name: string; deviceId?: string | null } }) => cb(payload)
  socket.on('secret:chat:offer', handler)
  return () => socket.off('secret:chat:offer', handler)
}
export function acceptSecretChat(conversationId: string, deviceId: string) {
  socket.emit('secret:chat:accept', { conversationId, deviceId })
}
export function declineSecretChat(conversationId: string) {
  socket.emit('secret:chat:decline', { conversationId })
}
export function onSecretChatAccepted(cb: (payload: { conversationId: string; peerDeviceId: string }) => void) {
  const handler = (payload: { conversationId: string; peerDeviceId: string }) => cb(payload)
  socket.on('secret:chat:accepted', handler)
  return () => socket.off('secret:chat:accepted', handler)
}

export function onReceiptsUpdate(cb: (payload: { conversationId: string; messageIds: string[] }) => void) {
  socket.on('receipts:update', cb)
}

export function onMessageNotify(cb: (payload: { conversationId: string; messageId: string; senderId: string }) => void) {
  socket.on('message:notify', (payload) => {
    // Log payload for debugging (especially for Electron overlay)
    console.log('[socket.ts] message:notify received:', JSON.stringify(payload, null, 2))
    console.log('[socket.ts] message:notify fields:', {
      conversationId: payload?.conversationId,
      messageId: payload?.messageId,
      senderId: payload?.senderId,
      hasMessageId: !!payload?.messageId
    })
    cb(payload)
  })
}

export function onPresenceUpdate(cb: (payload: { userId: string; status: string }) => void) {
  socket.on('presence:update', cb)
}

export function inviteCall(conversationId: string, video: boolean) {
  if (!socket.connected) {
    connectSocket()
  }
  socket.emit('call:invite', { conversationId, video })
}

export function onIncomingCall(cb: (payload: { conversationId: string; from: { id: string; name: string }; video: boolean }) => void) {
  socket.on('call:incoming', cb)
}

export function acceptCall(conversationId: string, video: boolean) {
  socket.emit('call:accept', { conversationId, video })
}
export function declineCall(conversationId: string) {
  socket.emit('call:decline', { conversationId })
}
export function endCall(conversationId: string) {
  socket.emit('call:end', { conversationId })
}
export function onCallAccepted(cb: (payload: { conversationId: string; by: { id: string } }) => void) {
  socket.on('call:accepted', cb)
}
export function onCallDeclined(cb: (payload: { conversationId: string; by: { id: string } }) => void) {
  socket.on('call:declined', cb)
}
export function onCallEnded(cb: (payload: { conversationId: string; by: { id: string } }) => void) {
  socket.on('call:ended', cb)
}

export function onProfileUpdate(cb: (payload: { userId: string; avatarUrl?: string | null; displayName?: string | null }) => void) {
  socket.on('profile:update', cb)
}

// Call status events
type CallStatusPayload = {
  conversationId: string
  active: boolean
  startedAt?: number
  elapsedMs?: number
  participants?: string[]
}
type CallStatusBulkPayload = {
  statuses: Record<string, CallStatusPayload>
}
export function onCallStatus(cb: (payload: CallStatusPayload) => void) {
  socket.on('call:status', cb)
}
export function onCallStatusBulk(cb: (payload: CallStatusBulkPayload) => void) {
  socket.on('call:status:bulk', cb)
}
export function requestCallStatuses(conversationIds: string[]) {
  socket.emit('call:status:request', { conversationIds })
}
export function joinConversation(conversationId: string) {
  // server expects event name "conversation:join" and payload as raw id
  socket.emit('conversation:join', conversationId)
}

// Call room management
export function joinCallRoom(conversationId: string, video?: boolean) {
  socket.emit('call:room:join', { conversationId, video })
}
export function leaveCallRoom(conversationId: string) {
  socket.emit('call:room:leave', { conversationId })
}



