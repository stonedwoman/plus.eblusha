import { appLifecycle, type NetworkChangePayload } from '../../core/lifecycle/appLifecycle'

export type PushMessagePayload = {
  version: 1
  conversationId: string
  messageId: string
  senderId: string
  receivedAt: number
  preview?: string
}

export type IncomingCallBridgePayload = {
  version: 1
  callId?: string
  conversationId?: string
  fromUserId?: string
  fromName?: string
  video?: boolean
  callerId?: string
  callerDisplayName?: string
  isVideo?: boolean
  eventVersion?: number
  timestamp?: number
  eventTimestamp?: number
  source?: string
  roomName?: string
  roomHint?: string
  startedAt?: number
  tokenHint?: string
  callTokenHint?: string
}

export type CallCanceledBridgePayload = {
  version: 1
  callId?: string
  conversationId?: string
  byUserId?: string
  reason?: 'declined' | 'ended' | 'timeout' | 'missed'
  callerId?: string
  callerDisplayName?: string
  isVideo?: boolean
  eventVersion?: number
  timestamp?: number
  eventTimestamp?: number
  source?: string
  roomName?: string
  roomHint?: string
  tokenHint?: string
  callTokenHint?: string
}

export type NativeCallActionPayload = {
  version: 1
  callId?: string
  conversationId?: string
  callerId?: string
  callerDisplayName?: string
  isVideo?: boolean
  eventVersion?: number
  timestamp?: number
  eventTimestamp?: number
  source?: string
  roomName?: string
  roomHint?: string
  tokenHint?: string
  callTokenHint?: string
}

export type NotificationOpenedPayload = {
  version: 1
  target: 'conversation' | 'call'
  conversationId?: string
  messageId?: string
  source: 'push' | 'local' | 'incoming-call'
}

export type PendingSyncPayload = {
  version: 1
  needsFullSync: boolean
  conversationIds: string[]
  pendingReceipts: string[]
  needSecretInboxPull: boolean
  activeCallConversationId?: string | null
}

export type PresenceMode = 'foreground' | 'background' | 'offline' | 'dnd' | 'in_call'

type BridgeEvents = {
  pushMessage: PushMessagePayload
  incomingCall: IncomingCallBridgePayload
  callCanceled: CallCanceledBridgePayload
  notificationOpened: NotificationOpenedPayload
  acceptIncomingCallFromNative: NativeCallActionPayload
  declineIncomingCallFromNative: NativeCallActionPayload
  openCallFromNative: NativeCallActionPayload
  endActiveCallFromNative: NativeCallActionPayload
  networkChanged: NetworkChangePayload
}

type EventName = keyof BridgeEvents
type Listener<K extends EventName> = (payload: BridgeEvents[K]) => void

declare global {
  interface Window {
    onPushMessage?: (payload: PushMessagePayload) => void
    onIncomingCall?: (payload: IncomingCallBridgePayload) => void
    onCallCanceled?: (payload: CallCanceledBridgePayload) => void
    onNotificationOpened?: (payload: NotificationOpenedPayload) => void
    acceptIncomingCallFromNative?: (payload: NativeCallActionPayload) => void
    declineIncomingCallFromNative?: (payload: NativeCallActionPayload) => void
    openCallFromNative?: (payload: NativeCallActionPayload) => void
    endActiveCallFromNative?: (payload: NativeCallActionPayload) => void
    onAppForeground?: () => void
    onAppBackground?: () => void
    onNetworkChanged?: (payload: NetworkChangePayload) => void
    getPendingSync?: () => Promise<PendingSyncPayload>
    setPresenceMode?: (mode: PresenceMode) => Promise<{ applied: boolean }>
    notifyWebReady?: () => void
    ackPendingIncomingCallAction?: (callId: string, action: 'accept' | 'decline' | 'open') => void
  }
}

function normalizeIncomingCallBridgePayload(
  payload: IncomingCallBridgePayload,
): IncomingCallBridgePayload {
  return {
    ...payload,
    callId: payload.callId ?? payload.conversationId,
    conversationId: payload.conversationId ?? payload.callId,
    fromUserId: payload.fromUserId ?? payload.callerId,
    fromName: payload.fromName ?? payload.callerDisplayName,
    video: payload.video ?? payload.isVideo,
    callerId: payload.callerId ?? payload.fromUserId,
    callerDisplayName: payload.callerDisplayName ?? payload.fromName,
    isVideo: payload.isVideo ?? payload.video,
    timestamp: payload.timestamp ?? payload.eventTimestamp ?? payload.startedAt,
    eventTimestamp: payload.eventTimestamp ?? payload.timestamp ?? payload.startedAt,
    roomName: payload.roomName ?? payload.roomHint,
    roomHint: payload.roomHint ?? payload.roomName,
    tokenHint: payload.tokenHint ?? payload.callTokenHint,
    callTokenHint: payload.callTokenHint ?? payload.tokenHint,
  }
}

function normalizeCallCanceledBridgePayload(
  payload: CallCanceledBridgePayload,
): CallCanceledBridgePayload {
  return {
    ...payload,
    callId: payload.callId ?? payload.conversationId,
    conversationId: payload.conversationId ?? payload.callId,
    timestamp: payload.timestamp ?? payload.eventTimestamp,
    eventTimestamp: payload.eventTimestamp ?? payload.timestamp,
    roomName: payload.roomName ?? payload.roomHint,
    roomHint: payload.roomHint ?? payload.roomName,
    tokenHint: payload.tokenHint ?? payload.callTokenHint,
    callTokenHint: payload.callTokenHint ?? payload.tokenHint,
  }
}

function normalizeNativeCallActionPayload(
  payload: NativeCallActionPayload,
): NativeCallActionPayload {
  return {
    ...payload,
    callId: payload.callId ?? payload.conversationId,
    conversationId: payload.conversationId ?? payload.callId,
    timestamp: payload.timestamp ?? payload.eventTimestamp,
    eventTimestamp: payload.eventTimestamp ?? payload.timestamp,
    roomName: payload.roomName ?? payload.roomHint,
    roomHint: payload.roomHint ?? payload.roomName,
    tokenHint: payload.tokenHint ?? payload.callTokenHint,
    callTokenHint: payload.callTokenHint ?? payload.tokenHint,
  }
}

class NativeBridge {
  private listeners: {
    [K in EventName]: Set<Listener<K>>
  } = {
    pushMessage: new Set(),
    incomingCall: new Set(),
    callCanceled: new Set(),
    notificationOpened: new Set(),
    acceptIncomingCallFromNative: new Set(),
    declineIncomingCallFromNative: new Set(),
    openCallFromNative: new Set(),
    endActiveCallFromNative: new Set(),
    networkChanged: new Set(),
  }
  private bufferedEvents: Partial<{
    [K in EventName]: BridgeEvents[K][]
  }> = {}

  private globalsInstalled = false
  private pendingSyncProvider: () => Promise<PendingSyncPayload> = async () => ({
    version: 1,
    needsFullSync: true,
    conversationIds: [],
    pendingReceipts: [],
    needSecretInboxPull: false,
    activeCallConversationId: null,
  })
  private presenceModeHandler: (mode: PresenceMode) => Promise<{ applied: boolean }> = async () => ({
    applied: false,
  })

  on<K extends EventName>(event: K, listener: Listener<K>): () => void {
    const bucket = this.listeners[event] as Set<Listener<K>>
    bucket.add(listener)
    const buffered = this.bufferedEvents[event] as BridgeEvents[K][] | undefined
    if (buffered?.length) {
      delete this.bufferedEvents[event]
      for (const payload of buffered) {
        try {
          listener(payload)
        } catch {
          // ignore buffered listener errors
        }
      }
    }
    return () => {
      bucket.delete(listener)
    }
  }

  emit<K extends EventName>(event: K, payload: BridgeEvents[K]): void {
    const bucket = this.listeners[event] as Set<Listener<K>>
    if (bucket.size === 0) {
      const buffered = (this.bufferedEvents[event] as BridgeEvents[K][] | undefined) ?? []
      buffered.push(payload)
      ;(this.bufferedEvents as Record<EventName, unknown[]>)[event] = buffered as unknown[]
      return
    }
    for (const listener of bucket) {
      try {
        listener(payload)
      } catch {
        // ignore bridge listener errors
      }
    }
  }

  setPendingSyncProvider(provider: () => Promise<PendingSyncPayload>): void {
    this.pendingSyncProvider = provider
  }

  setPresenceModeHandler(handler: (mode: PresenceMode) => Promise<{ applied: boolean }>): void {
    this.presenceModeHandler = handler
  }

  notifyWebReady(): void {
    if (typeof window === 'undefined') return
    try {
      window.notifyWebReady?.()
    } catch {
      // ignore host handshake errors
    }
  }

  ackPendingIncomingCallAction(callId: string, action: 'accept' | 'decline' | 'open'): void {
    if (typeof window === 'undefined') return
    try {
      window.ackPendingIncomingCallAction?.(callId, action)
    } catch {
      // ignore host handshake errors
    }
  }

  installGlobals(): void {
    if (this.globalsInstalled || typeof window === 'undefined') return
    this.globalsInstalled = true

    window.onPushMessage = (payload) => {
      this.emit('pushMessage', payload)
    }
    window.onIncomingCall = (payload) => {
      this.emit('incomingCall', normalizeIncomingCallBridgePayload(payload))
    }
    window.onCallCanceled = (payload) => {
      this.emit('callCanceled', normalizeCallCanceledBridgePayload(payload))
    }
    window.onNotificationOpened = (payload) => {
      this.emit('notificationOpened', payload)
    }
    window.acceptIncomingCallFromNative = (payload) => {
      this.emit('acceptIncomingCallFromNative', normalizeNativeCallActionPayload(payload))
    }
    window.declineIncomingCallFromNative = (payload) => {
      this.emit('declineIncomingCallFromNative', normalizeNativeCallActionPayload(payload))
    }
    window.openCallFromNative = (payload) => {
      this.emit('openCallFromNative', normalizeNativeCallActionPayload(payload))
    }
    window.endActiveCallFromNative = (payload) => {
      this.emit('endActiveCallFromNative', normalizeNativeCallActionPayload(payload))
    }
    window.onAppForeground = () => {
      appLifecycle.emit('foreground', undefined)
    }
    window.onAppBackground = () => {
      appLifecycle.emit('background', undefined)
    }
    window.onNetworkChanged = (payload) => {
      appLifecycle.emit('networkChange', payload)
      this.emit('networkChanged', payload)
    }
    window.getPendingSync = () => this.pendingSyncProvider()
    window.setPresenceMode = (mode) => this.presenceModeHandler(mode)
  }
}

export const nativeBridge = new NativeBridge()
