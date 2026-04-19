import { Capacitor } from '@capacitor/core'
import type { RealtimeInboundEventMap, RealtimeOutboundEventMap } from './events'
import type { RealtimeClient } from './client'
import { nativeRealtimeClient } from './nativeRealtimeClient'
import { WebRealtimeClient } from './webRealtimeClient'
import type { SocketService } from '../../capacitor/services/socket-service'

const webRealtimeClient = new WebRealtimeClient()

function isNativeRealtimeMode(): boolean {
  try {
    return Capacitor.isNativePlatform()
  } catch {
    return false
  }
}

export function getRealtimeClient(): RealtimeClient {
  return isNativeRealtimeMode() ? nativeRealtimeClient : webRealtimeClient
}

export function bindNativeSocketService(service: SocketService): void {
  nativeRealtimeClient.bindService(service)
}

const socketListeners = new Map<string, Map<Function, () => void>>()

function rememberSocketListener(event: string, listener: Function, unsubscribe: () => void): void {
  const bucket = socketListeners.get(event) ?? new Map()
  bucket.set(listener, unsubscribe)
  socketListeners.set(event, bucket)
}

function forgetSocketListener(event: string, listener: Function): void {
  const bucket = socketListeners.get(event)
  if (!bucket) return
  const unsubscribe = bucket.get(listener)
  if (!unsubscribe) return
  unsubscribe()
  bucket.delete(listener)
  if (bucket.size === 0) {
    socketListeners.delete(event)
  }
}

export const socket = {
  get connected() {
    return getRealtimeClient().isConnected()
  },
  on<K extends keyof RealtimeInboundEventMap>(
    event: K,
    listener: (payload: RealtimeInboundEventMap[K]) => void,
  ) {
    const unsubscribe = getRealtimeClient().on(event, listener)
    rememberSocketListener(event as string, listener, unsubscribe)
  },
  off<K extends keyof RealtimeInboundEventMap>(
    event: K,
    listener: (payload: RealtimeInboundEventMap[K]) => void,
  ) {
    forgetSocketListener(event as string, listener)
  },
  emit<K extends keyof RealtimeOutboundEventMap>(
    event: K,
    payload: RealtimeOutboundEventMap[K],
  ) {
    getRealtimeClient().emit(event, payload)
  },
}

export function connectSocket() {
  getRealtimeClient().connect()
}

export function onSessionNew(
  cb: (payload: RealtimeInboundEventMap['session:new']) => void,
) {
  return getRealtimeClient().on('session:new', cb)
}

export function onContactRequest(
  cb: (payload: RealtimeInboundEventMap['contacts:request:new']) => void,
) {
  return getRealtimeClient().on('contacts:request:new', cb)
}

export function onContactAccepted(
  cb: (payload: RealtimeInboundEventMap['contacts:request:accepted']) => void,
) {
  return getRealtimeClient().on('contacts:request:accepted', cb)
}

export function onContactRejected(
  cb: (payload: RealtimeInboundEventMap['contacts:request:rejected']) => void,
) {
  return getRealtimeClient().on('contacts:request:rejected', cb)
}

export function onContactRemoved(
  cb: (payload: RealtimeInboundEventMap['contacts:removed']) => void,
) {
  return getRealtimeClient().on('contacts:removed', cb)
}

export function onConversationNew(
  cb: (payload: RealtimeInboundEventMap['conversations:new']) => void,
) {
  return getRealtimeClient().on('conversations:new', cb)
}

export function onConversationDeleted(
  cb: (payload: RealtimeInboundEventMap['conversations:deleted']) => void,
) {
  return getRealtimeClient().on('conversations:deleted', cb)
}

export function onConversationUpdated(
  cb: (payload: RealtimeInboundEventMap['conversations:updated']) => void,
) {
  return getRealtimeClient().on('conversations:updated', cb)
}

export function onConversationMemberRemoved(
  cb: (payload: RealtimeInboundEventMap['conversations:member:removed']) => void,
) {
  return getRealtimeClient().on('conversations:member:removed', cb)
}

export function onReceiptsUpdate(
  cb: (payload: RealtimeInboundEventMap['receipts:update']) => void,
) {
  return getRealtimeClient().on('receipts:update', cb)
}

export function onMessageNotify(
  cb: (payload: RealtimeInboundEventMap['message:notify']) => void,
) {
  return getRealtimeClient().on('message:notify', cb)
}

export function onPresenceUpdate(
  cb: (payload: RealtimeInboundEventMap['presence:update']) => void,
) {
  return getRealtimeClient().on('presence:update', cb)
}

export function onPresenceGame(
  cb: (payload: RealtimeInboundEventMap['presence:game']) => void,
) {
  return getRealtimeClient().on('presence:game', cb)
}

export function onPresenceGameSnapshot(
  cb: (payload: RealtimeInboundEventMap['presence:game:snapshot']) => void,
) {
  return getRealtimeClient().on('presence:game:snapshot', cb)
}

export function onPresenceGameSnapshotBatch(
  cb: (payload: RealtimeInboundEventMap['presence:game:snapshot:batch']) => void,
) {
  return getRealtimeClient().on('presence:game:snapshot:batch', cb)
}

export function subscribePresenceGame(peerUserId: string) {
  if (!peerUserId || typeof peerUserId !== 'string') return
  getRealtimeClient().emit('presence:game:subscribe', { peerUserId })
}

export function helloPresenceGame(openPeers: string[]) {
  const peers = Array.isArray(openPeers)
    ? openPeers.filter((value) => typeof value === 'string' && value.trim()).map((value) => value.trim())
    : []
  getRealtimeClient().emit('presence:game:hello', { openPeers: peers })
}

export function inviteCall(conversationId: string, video: boolean) {
  getRealtimeClient().emit('call:invite', { conversationId, video })
}

export function onIncomingCall(
  cb: (payload: RealtimeInboundEventMap['call:incoming']) => void,
) {
  return getRealtimeClient().on('call:incoming', cb)
}

export function acceptCall(conversationId: string, video: boolean) {
  getRealtimeClient().emit('call:accept', { conversationId, video })
}

export function declineCall(conversationId: string) {
  getRealtimeClient().emit('call:decline', { conversationId })
}

export function endCall(conversationId: string) {
  getRealtimeClient().emit('call:end', { conversationId })
}

export function onCallAccepted(
  cb: (payload: RealtimeInboundEventMap['call:accepted']) => void,
) {
  return getRealtimeClient().on('call:accepted', cb)
}

export function onCallDeclined(
  cb: (payload: RealtimeInboundEventMap['call:declined']) => void,
) {
  return getRealtimeClient().on('call:declined', cb)
}

export function onCallEnded(
  cb: (payload: RealtimeInboundEventMap['call:ended']) => void,
) {
  return getRealtimeClient().on('call:ended', cb)
}

export function onProfileUpdate(
  cb: (payload: RealtimeInboundEventMap['profile:update']) => void,
) {
  return getRealtimeClient().on('profile:update', cb)
}

export function onCallStatus(
  cb: (payload: RealtimeInboundEventMap['call:status']) => void,
) {
  return getRealtimeClient().on('call:status', cb)
}

export function onCallStatusBulk(
  cb: (payload: RealtimeInboundEventMap['call:status:bulk']) => void,
) {
  return getRealtimeClient().on('call:status:bulk', cb)
}

export function requestCallStatuses(conversationIds: string[]) {
  getRealtimeClient().emit('call:status:request', { conversationIds })
}

export function joinConversation(conversationId: string) {
  getRealtimeClient().emit('conversation:join', conversationId)
}

export function leaveConversation(conversationId: string) {
  getRealtimeClient().emit('conversation:leave', conversationId)
}

export function joinCallRoom(conversationId: string, video?: boolean) {
  getRealtimeClient().emit('call:room:join', { conversationId, video })
}

export function leaveCallRoom(conversationId: string) {
  getRealtimeClient().emit('call:room:leave', { conversationId })
}

export type {
  PresenceGamePayload,
  PresenceGameSnapshotBatchPayload,
  RealtimeInboundEventMap,
  RealtimeOutboundEventMap,
  SessionNewPayload,
} from './events'
