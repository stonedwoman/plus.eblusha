import { isAndroidApkShell } from './platform'

export type ApkCallSignalType =
  | 'outgoing_started'
  | 'incoming_accepted'
  | 'call_active'
  | 'call_ended'
  | 'call_canceled'

export type ApkCallSignalPayload = {
  type: ApkCallSignalType
  callId: string
  conversationId: string
  video: boolean
}

type TrackedCallPhase = 'outgoing_started' | 'incoming_accepted' | 'call_active'

type TrackedCallState = {
  phase: TrackedCallPhase
  video: boolean
}

declare global {
  interface Window {
    __EBLUSHA_APK_CALL_SIGNAL__?: (payload: ApkCallSignalPayload) => void
  }
}

const trackedCalls = new Map<string, TrackedCallState>()

function normalizeConversationId(conversationId: string | null | undefined): string | null {
  const normalized = String(conversationId ?? '').trim()
  return normalized ? normalized : null
}

function emitApkCallSignal(type: ApkCallSignalType, conversationId: string, video: boolean): void {
  if (!isAndroidApkShell() || typeof window === 'undefined') return
  const handler = window.__EBLUSHA_APK_CALL_SIGNAL__
  if (typeof handler !== 'function') return
  try {
    handler({
      type,
      callId: conversationId,
      conversationId,
      video: !!video,
    })
  } catch {
    // Ignore bridge errors so frontend call flow stays resilient.
  }
}

function rememberTrackedCall(conversationId: string, phase: TrackedCallPhase, video: boolean): void {
  trackedCalls.set(conversationId, { phase, video: !!video })
}

function resolveTrackedVideo(conversationId: string, fallbackVideo?: boolean): boolean {
  return trackedCalls.get(conversationId)?.video ?? !!fallbackVideo
}

export function signalApkOutgoingStarted(conversationId: string, video: boolean): void {
  const normalizedConversationId = normalizeConversationId(conversationId)
  if (!normalizedConversationId) return

  const existing = trackedCalls.get(normalizedConversationId)
  if (existing) {
    return
  }

  rememberTrackedCall(normalizedConversationId, 'outgoing_started', video)
  emitApkCallSignal('outgoing_started', normalizedConversationId, video)
}

export function signalApkIncomingAccepted(conversationId: string, video: boolean): void {
  const normalizedConversationId = normalizeConversationId(conversationId)
  if (!normalizedConversationId) return

  const existing = trackedCalls.get(normalizedConversationId)
  if (existing?.phase === 'incoming_accepted' || existing?.phase === 'call_active') {
    return
  }

  rememberTrackedCall(normalizedConversationId, 'incoming_accepted', video)
  emitApkCallSignal('incoming_accepted', normalizedConversationId, video)
}

export function signalApkCallActive(conversationId: string, video?: boolean): void {
  const normalizedConversationId = normalizeConversationId(conversationId)
  if (!normalizedConversationId) return

  const resolvedVideo = resolveTrackedVideo(normalizedConversationId, video)
  const existing = trackedCalls.get(normalizedConversationId)
  if (existing?.phase === 'call_active' && existing.video === resolvedVideo) {
    return
  }

  rememberTrackedCall(normalizedConversationId, 'call_active', resolvedVideo)
  emitApkCallSignal('call_active', normalizedConversationId, resolvedVideo)
}

export function signalApkIncomingCanceled(conversationId: string, video: boolean): void {
  const normalizedConversationId = normalizeConversationId(conversationId)
  if (!normalizedConversationId) return

  const existing = trackedCalls.get(normalizedConversationId)
  if (existing?.phase === 'incoming_accepted' || existing?.phase === 'call_active') {
    return
  }

  const resolvedVideo = resolveTrackedVideo(normalizedConversationId, video)
  trackedCalls.delete(normalizedConversationId)
  emitApkCallSignal('call_canceled', normalizedConversationId, resolvedVideo)
}

export function finalizeApkCallSignal(conversationId: string, fallbackVideo?: boolean): void {
  const normalizedConversationId = normalizeConversationId(conversationId)
  if (!normalizedConversationId) return

  const existing = trackedCalls.get(normalizedConversationId)
  if (!existing && typeof fallbackVideo !== 'boolean') {
    return
  }

  const resolvedVideo = resolveTrackedVideo(normalizedConversationId, fallbackVideo)
  trackedCalls.delete(normalizedConversationId)

  if (existing?.phase === 'call_active') {
    emitApkCallSignal('call_ended', normalizedConversationId, resolvedVideo)
    return
  }

  emitApkCallSignal('call_canceled', normalizedConversationId, resolvedVideo)
}
