import { io } from 'socket.io-client'
import { useAppStore } from '../domain/store/appStore'
import { Capacitor } from '@capacitor/core'

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
  // Allow fallback to HTTP long-polling when WebSocket upgrade is blocked/flaky.
  // This is critical for reliably receiving realtime statuses (presence/call) on restrictive networks.
  transports: ['websocket', 'polling'],
  upgrade: true,
  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 500,
  reconnectionDelayMax: 5000,
  timeout: 12000,
})

function isDebugSocketEnabled(): boolean {
  if (typeof window === 'undefined') return false
  try {
    const qs = new URLSearchParams(window.location.search)
    const q = qs.get('ebDebugSocket')
    if (q === '1' || q === 'true') return true
    const raw = window.localStorage.getItem('eb-debug-socket')
    return raw === '1' || raw === 'true'
  } catch {
    return false
  }
}

function dbg(...args: any[]) {
  if (!isDebugSocketEnabled()) return
  // eslint-disable-next-line no-console
  console.log('[SocketDbg]', ...args)
}

export type PresenceVisibility = 'visible' | 'hidden'
export type PresenceSource = 'web' | 'electron' | 'mobile'
export type PresenceStatePayload = { active: boolean; visibility: PresenceVisibility; source: PresenceSource }

const PRESENCE_STATE_DEBOUNCE_MS = 180
const PRESENCE_SYNC_FLAG = '__ebPresenceStateSyncInstalled'

let presenceSyncTimer: number | null = null
let lastSentPresenceState: PresenceStatePayload | null = null

function detectPresenceSource(): PresenceSource {
  try {
    // If we're running inside a native wrapper, treat as mobile.
    if (Capacitor.isNativePlatform()) return 'mobile'
  } catch {}
  try {
    const ua = typeof navigator !== 'undefined' ? navigator.userAgent : ''
    if (/Electron/i.test(ua)) return 'electron'
  } catch {}
  return 'web'
}

function computePresenceState(): { active: boolean; visibility: PresenceVisibility } {
  if (typeof document === 'undefined') return { active: true, visibility: 'visible' }
  const visibility: PresenceVisibility = document.visibilityState === 'visible' ? 'visible' : 'hidden'
  const hasFocus = typeof document.hasFocus === 'function' ? document.hasFocus() : true
  const active = visibility === 'visible' && hasFocus
  return { active, visibility }
}

function emitPresenceStateNow(opts?: { force?: boolean }) {
  if (!socket.connected) return
  const { active, visibility } = computePresenceState()
  const payload: PresenceStatePayload = { active, visibility, source: detectPresenceSource() }

  if (!opts?.force && lastSentPresenceState) {
    if (
      lastSentPresenceState.active === payload.active &&
      lastSentPresenceState.visibility === payload.visibility &&
      lastSentPresenceState.source === payload.source
    ) {
      return
    }
  }

  lastSentPresenceState = payload
  dbg('presence:state ->', payload)
  socket.emit('presence:state', payload)
}

function scheduleEmitPresenceState(opts?: { force?: boolean }) {
  if (typeof window === 'undefined') return
  if (presenceSyncTimer) window.clearTimeout(presenceSyncTimer)
  presenceSyncTimer = window.setTimeout(() => {
    presenceSyncTimer = null
    emitPresenceStateNow(opts)
  }, PRESENCE_STATE_DEBOUNCE_MS)
}

export function initPresenceStateSync() {
  // Make it resilient to HMR / multiple entrypoints
  if (typeof window !== 'undefined') {
    if ((window as any)[PRESENCE_SYNC_FLAG]) return
    ;(window as any)[PRESENCE_SYNC_FLAG] = true
  }

  if (typeof window === 'undefined' || typeof document === 'undefined') return

  const onVis = () => scheduleEmitPresenceState()
  const onFocus = () => scheduleEmitPresenceState()
  const onBlur = () => scheduleEmitPresenceState()

  document.addEventListener('visibilitychange', onVis)
  window.addEventListener('focus', onFocus)
  window.addEventListener('blur', onBlur)

  // Initial state immediately after connect (auth already complete at this point).
  const onConnect = () => scheduleEmitPresenceState({ force: true })
  socket.on('connect', onConnect)

  // If we're already connected (edge-case), send once.
  if (socket.connected) scheduleEmitPresenceState({ force: true })
}

// Expose socket globally for Electron overlay bridge
if (typeof window !== 'undefined') {
  // Prevent overwriting if already exists
  if (!(window as any).socket) {
    (window as any).socket = socket;
  }
}

export function connectSocket() {
  // На Android используем только нативный сокет, JS сокет отключен
  if (Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android') {
    console.log('[Socket] Skipping JS socket connection on Android (using native socket)')
    return
  }
  // Ensure presence state sync is installed BEFORE connecting
  initPresenceStateSync()
  const token = useAppStore.getState().session?.accessToken
  if (!token) return
  let deviceId: string | undefined
  try {
    const raw = typeof window !== 'undefined' ? window.localStorage.getItem('eb_device_info_v1') : null
    if (raw) {
      const parsed = JSON.parse(raw) as any
      const did = typeof parsed?.deviceId === 'string' ? parsed.deviceId.trim() : ''
      if (did) deviceId = did
    }
  } catch {}
  socket.auth = { token, ...(deviceId ? { deviceId } : {}) }
  // дублируем токен в query на случай прокси/нестандартных клиентов
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(socket.io.opts as any).query = { token }
  if (!socket.connected) {
    dbg('connect()', { WS_URL, hasToken: !!token, transports: socket.io.opts.transports })
    socket.connect()
  }
}

// Обновляем токен при попытках реконнекта (только для веб-платформы)
if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== 'android') {
  socket.io.on('reconnect_attempt', () => {
    const token = useAppStore.getState().session?.accessToken
    if (token) {
      let deviceId: string | undefined
      try {
        const raw = typeof window !== 'undefined' ? window.localStorage.getItem('eb_device_info_v1') : null
        if (raw) {
          const parsed = JSON.parse(raw) as any
          const did = typeof parsed?.deviceId === 'string' ? parsed.deviceId.trim() : ''
          if (did) deviceId = did
        }
      } catch {}
      socket.auth = { token, ...(deviceId ? { deviceId } : {}) }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(socket.io.opts as any).query = { token }
    }
  })
}

socket.on('disconnect', () => {
  dbg('disconnect', { connected: socket.connected })
  console.log('socket disconnected')
})

socket.on('connect', () => {
  dbg('connect', { id: socket.id, connected: socket.connected, transport: socket.io.engine?.transport?.name })
})

socket.on('connect_error', (err) => {
  dbg('connect_error', { message: (err as any)?.message, description: (err as any)?.description, context: (err as any)?.context })
})

// Helpful to confirm we actually receive realtime status events in the browser
socket.on('presence:update', (p) => {
  dbg('presence:update', p)
})

export type PresenceGame = {
  discordAppId: string
  name: string
  steamAppId?: string | number
  startedAt: number
  imageUrl?: string | null
}
export type PresenceGameClearReason = 'no_game' | 'privacy_off'
export type PresenceGamePayload = { userId: string; ts: number; game: PresenceGame | null; reason?: PresenceGameClearReason }
export type PresenceGameSnapshotBatchPayload = { items: PresenceGamePayload[] }

// Helpful to confirm we actually receive game presence events in the browser
socket.on('presence:game', (p) => {
  dbg('presence:game', p)
})

socket.on('presence:game:snapshot', (p) => {
  dbg('presence:game:snapshot', p)
})

socket.on('presence:game:snapshot:batch', (p) => {
  dbg('presence:game:snapshot:batch', p)
})

socket.on('call:status', (p) => {
  dbg('call:status', p)
})

socket.on('call:status:bulk', (p) => {
  dbg('call:status:bulk', p)
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

export function onPresenceGame(cb: (payload: PresenceGamePayload) => void) {
  socket.on('presence:game', cb)
}

export function onPresenceGameSnapshot(cb: (payload: PresenceGamePayload) => void) {
  socket.on('presence:game:snapshot', cb)
}

export function onPresenceGameSnapshotBatch(cb: (payload: PresenceGameSnapshotBatchPayload) => void) {
  socket.on('presence:game:snapshot:batch', cb)
}

export function subscribePresenceGame(peerUserId: string) {
  if (!peerUserId || typeof peerUserId !== 'string') return
  if (!socket.connected) {
    connectSocket()
  }
  socket.emit('presence:game:subscribe', { peerUserId })
}

export function helloPresenceGame(openPeers: string[]) {
  const peers = Array.isArray(openPeers) ? openPeers.filter((v) => typeof v === 'string' && v.trim()).map((v) => v.trim()) : []
  if (!socket.connected) {
    connectSocket()
  }
  socket.emit('presence:game:hello', { openPeers: peers })
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
export function onCallAccepted(cb: (payload: { conversationId: string; by: { id: string }; video: boolean }) => void) {
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



