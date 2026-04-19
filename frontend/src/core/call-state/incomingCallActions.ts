import { useChatUiStore } from '../chat-sync/chatUiStore'
import { createCallIntent, useNavigationIntentStore } from '../navigation/intents'
import { nativeBridge } from '../../platform/native-bridge/bridge'
import { useCallStore } from './callStore'

export type IncomingCallActionSource =
  | 'web_ui'
  | 'android_native'
  | 'bootstrap_replay'
  | 'remote_event'

export type ResolvedIncomingCall = {
  callId: string
  conversationId: string
  callerId?: string
  callerDisplayName?: string
  isVideo: boolean
  eventVersion?: number
  timestamp?: number
  source?: string
  roomName?: string
  tokenHint?: string
}

export type ResolvedActiveCall = {
  callId: string
  conversationId: string
  source?: string
  roomName?: string
  tokenHint?: string
}

export type IncomingCallActionRequest = {
  callId?: string
  conversationId?: string
  callerId?: string
  callerDisplayName?: string
  isVideo?: boolean
  eventVersion?: number
  timestamp?: number
  source?: string
  roomName?: string
  tokenHint?: string
}

type PendingActionKind = 'accept' | 'decline' | 'open' | 'end'

type PendingNativeCallAction = {
  kind: PendingActionKind
  request: IncomingCallActionRequest
}

type IncomingCallActionRuntime = {
  id: string
  priority: number
  isReady?: () => boolean
  acceptIncomingCall: (call: ResolvedIncomingCall, source: IncomingCallActionSource) => Promise<boolean> | boolean
  declineIncomingCall: (call: ResolvedIncomingCall, source: IncomingCallActionSource) => Promise<boolean> | boolean
}

type ActiveCallActionRuntime = {
  id: string
  priority: number
  isReady?: () => boolean
  endActiveCall: (call: ResolvedActiveCall, source: IncomingCallActionSource) => Promise<boolean> | boolean
}

const runtimes = new Map<string, IncomingCallActionRuntime>()
const activeCallRuntimes = new Map<string, ActiveCallActionRuntime>()
const trackedIncomingCalls = new Map<string, ResolvedIncomingCall>()
const trackedActiveCalls = new Map<string, ResolvedActiveCall>()
const pendingNativeActions = new Map<string, PendingNativeCallAction>()
const appliedActionKeys = new Set<string>()
const inFlightActionKeys = new Set<string>()
let bootstrapReady = false
let replayInProgress = false

function normalizeCallId(value: string | null | undefined, fallback?: string | null | undefined): string | null {
  const candidate = String(value ?? fallback ?? '').trim()
  return candidate ? candidate : null
}

function actionKey(kind: PendingActionKind, callId: string): string {
  return `${kind}:${callId}`
}

function compareCallFingerprint(
  current: ResolvedIncomingCall | undefined,
  next: ResolvedIncomingCall,
): boolean {
  if (!current) return false
  return (
    current.conversationId === next.conversationId &&
    current.callerId === next.callerId &&
    current.callerDisplayName === next.callerDisplayName &&
    current.isVideo === next.isVideo &&
    current.eventVersion === next.eventVersion &&
    current.timestamp === next.timestamp
  )
}

function normalizeIncomingCallRequest(request: IncomingCallActionRequest): ResolvedIncomingCall | null {
  const conversationId = normalizeCallId(request.conversationId, request.callId)
  const callId = normalizeCallId(request.callId, conversationId)
  if (!conversationId || !callId) {
    return null
  }

  return {
    callId,
    conversationId,
    callerId: request.callerId,
    callerDisplayName: request.callerDisplayName,
    isVideo: !!request.isVideo,
    eventVersion: request.eventVersion,
    timestamp: request.timestamp,
    source: request.source,
    roomName: request.roomName,
    tokenHint: request.tokenHint,
  }
}

function getCurrentRuntime(): IncomingCallActionRuntime | null {
  const candidates = Array.from(runtimes.values()).filter((runtime) => runtime.isReady?.() ?? true)
  if (!candidates.length) return null
  candidates.sort((left, right) => right.priority - left.priority)
  return candidates[0] ?? null
}

function getCurrentActiveCallRuntime(): ActiveCallActionRuntime | null {
  const candidates = Array.from(activeCallRuntimes.values()).filter(
    (runtime) => runtime.isReady?.() ?? true,
  )
  if (!candidates.length) return null
  candidates.sort((left, right) => right.priority - left.priority)
  return candidates[0] ?? null
}

function mapActionSourceToIntentSource(source: IncomingCallActionSource) {
  switch (source) {
    case 'android_native':
    case 'bootstrap_replay':
    case 'remote_event':
      return 'incoming-call' as const
    case 'web_ui':
    default:
      return 'manual' as const
  }
}

function queueNativeAction(kind: PendingActionKind, request: IncomingCallActionRequest): void {
  const callId = normalizeCallId(request.callId, request.conversationId)
  if (!callId) return
  const key = actionKey(kind, callId)
  if (appliedActionKeys.has(key) || inFlightActionKeys.has(key)) return
  pendingNativeActions.set(key, {
    kind,
    request: {
      ...request,
      callId,
      conversationId: normalizeCallId(request.conversationId, callId) ?? callId,
    },
  })
}

function clearCallActionState(callId: string): void {
  pendingNativeActions.delete(actionKey('accept', callId))
  pendingNativeActions.delete(actionKey('decline', callId))
  pendingNativeActions.delete(actionKey('open', callId))
  pendingNativeActions.delete(actionKey('end', callId))
}

function markActionApplied(kind: PendingActionKind, callId: string): void {
  appliedActionKeys.add(actionKey(kind, callId))
  pendingNativeActions.delete(actionKey(kind, callId))
}

function clearAppliedActionMarks(callId: string): void {
  appliedActionKeys.delete(actionKey('accept', callId))
  appliedActionKeys.delete(actionKey('decline', callId))
  appliedActionKeys.delete(actionKey('open', callId))
  appliedActionKeys.delete(actionKey('end', callId))
}

function resolveFromCurrentStore(callId: string): ResolvedIncomingCall | null {
  const incoming = useCallStore.getState().incoming
  if (!incoming) return null

  const normalizedCallId = normalizeCallId(callId, incoming.callId ?? incoming.conversationId)
  const conversationId = normalizeCallId(incoming.conversationId)
  if (!normalizedCallId || !conversationId) return null
  if (
    normalizedCallId !== callId &&
    conversationId !== callId &&
    normalizeCallId(incoming.callId) !== callId
  ) {
    return null
  }

  return {
    callId: normalizedCallId,
    conversationId,
    callerId: incoming.from.id,
    callerDisplayName: incoming.from.name,
    isVideo: incoming.video,
    eventVersion: incoming.eventVersion,
    timestamp: incoming.timestamp,
    source: incoming.source ?? 'web_ui',
    tokenHint: undefined,
  }
}

function resolveTrackedIncomingCall(request: IncomingCallActionRequest): ResolvedIncomingCall | null {
  const normalized = normalizeIncomingCallRequest(request)
  if (normalized) {
    const tracked = trackedIncomingCalls.get(normalized.callId)
    if (tracked) {
      return {
        ...tracked,
        callerId: normalized.callerId ?? tracked.callerId,
        callerDisplayName: normalized.callerDisplayName ?? tracked.callerDisplayName,
        isVideo: typeof request.isVideo === 'boolean' ? request.isVideo : tracked.isVideo,
        eventVersion: normalized.eventVersion ?? tracked.eventVersion,
        timestamp: normalized.timestamp ?? tracked.timestamp,
        roomName: normalized.roomName ?? tracked.roomName,
        tokenHint: normalized.tokenHint ?? tracked.tokenHint,
      }
    }
    const fromStore =
      resolveFromCurrentStore(normalized.callId) ??
      resolveFromCurrentStore(normalized.conversationId)
    if (!fromStore) {
      return null
    }
    return {
      ...fromStore,
      callerId: normalized.callerId ?? fromStore.callerId,
      callerDisplayName: normalized.callerDisplayName ?? fromStore.callerDisplayName,
      isVideo: typeof request.isVideo === 'boolean' ? request.isVideo : fromStore.isVideo,
      eventVersion: normalized.eventVersion ?? fromStore.eventVersion,
      timestamp: normalized.timestamp ?? fromStore.timestamp,
      roomName: normalized.roomName ?? fromStore.roomName,
      tokenHint: normalized.tokenHint ?? fromStore.tokenHint,
    }
  }

  const callId = normalizeCallId(request.callId, request.conversationId)
  if (!callId) return null
  return trackedIncomingCalls.get(callId) ?? resolveFromCurrentStore(callId)
}

async function replayPendingNativeActions(): Promise<void> {
  if (!bootstrapReady || replayInProgress) return
  const runtime = getCurrentRuntime()
  if (!runtime) return

  replayInProgress = true
  try {
    const actions = Array.from(pendingNativeActions.values())
    for (const action of actions) {
      if (action.kind === 'accept') {
        await acceptIncomingCallAction(action.request, 'bootstrap_replay')
      } else if (action.kind === 'decline') {
        await declineIncomingCallAction(action.request, 'bootstrap_replay')
      } else if (action.kind === 'end') {
        await endActiveCallAction(action.request, 'bootstrap_replay')
      } else {
        openCallRoute(action.request, 'bootstrap_replay')
      }
    }
  } finally {
    replayInProgress = false
  }
}

export function registerIncomingCallRuntime(runtime: IncomingCallActionRuntime): () => void {
  runtimes.set(runtime.id, runtime)
  void replayPendingNativeActions()

  return () => {
    if (runtimes.get(runtime.id) === runtime) {
      runtimes.delete(runtime.id)
    }
  }
}

export function registerActiveCallRuntime(runtime: ActiveCallActionRuntime): () => void {
  activeCallRuntimes.set(runtime.id, runtime)
  void replayPendingNativeActions()

  return () => {
    if (activeCallRuntimes.get(runtime.id) === runtime) {
      activeCallRuntimes.delete(runtime.id)
    }
  }
}

export function setIncomingCallBootstrapReady(ready: boolean): void {
  bootstrapReady = ready
  if (ready) {
    void replayPendingNativeActions()
  }
}

export function rememberIncomingCall(request: IncomingCallActionRequest): ResolvedIncomingCall | null {
  const normalized = normalizeIncomingCallRequest(request)
  if (!normalized) return null

  const current = trackedIncomingCalls.get(normalized.callId)
  if (!compareCallFingerprint(current, normalized)) {
    clearAppliedActionMarks(normalized.callId)
  }
  trackedIncomingCalls.set(normalized.callId, normalized)
  void replayPendingNativeActions()
  return normalized
}

export function clearIncomingCallTracking(callId: string | null | undefined): void {
  const normalizedCallId = normalizeCallId(callId)
  if (!normalizedCallId) return
  trackedIncomingCalls.delete(normalizedCallId)
  clearCallActionState(normalizedCallId)
}

function rememberActiveCall(call: ResolvedActiveCall): void {
  trackedActiveCalls.set(call.callId, call)
  trackedActiveCalls.set(call.conversationId, call)
}

export function clearActiveCallTracking(callId: string | null | undefined): void {
  const normalizedCallId = normalizeCallId(callId)
  if (!normalizedCallId) return
  const tracked = trackedActiveCalls.get(normalizedCallId)
  if (tracked) {
    trackedActiveCalls.delete(tracked.callId)
    trackedActiveCalls.delete(tracked.conversationId)
    clearCallActionState(tracked.callId)
    clearCallActionState(tracked.conversationId)
  } else {
    trackedActiveCalls.delete(normalizedCallId)
    clearCallActionState(normalizedCallId)
  }
}

function resolveActiveCallTarget(request: IncomingCallActionRequest): ResolvedActiveCall | null {
  const normalizedCallId = normalizeCallId(request.callId, request.conversationId)
  const normalizedConversationId = normalizeCallId(request.conversationId, request.callId)
  const tracked =
    (normalizedCallId ? trackedActiveCalls.get(normalizedCallId) : null) ??
    (normalizedConversationId ? trackedActiveCalls.get(normalizedConversationId) : null) ??
    null
  if (tracked) {
    return {
      ...tracked,
      roomName: request.roomName ?? tracked.roomName,
      tokenHint: request.tokenHint ?? tracked.tokenHint,
      source: request.source ?? tracked.source,
    }
  }

  const state = useCallStore.getState()
  const conversationId =
    state.overlayConvId ??
    state.activeConvId ??
    state.outgoingCall?.conversationId ??
    normalizedConversationId ??
    null
  if (!conversationId) {
    return null
  }

  const currentIds = [conversationId, normalizedConversationId, normalizedCallId].filter(Boolean)
  if (
    currentIds.length > 0 &&
    normalizedCallId &&
    normalizedCallId !== conversationId &&
    normalizedConversationId !== conversationId
  ) {
    return null
  }

  return {
    callId: normalizedCallId ?? conversationId,
    conversationId,
    source: request.source,
    roomName: request.roomName,
    tokenHint: request.tokenHint,
  }
}

export function resolveIncomingCall(callId: string): ResolvedIncomingCall | null {
  const normalizedCallId = normalizeCallId(callId)
  if (!normalizedCallId) return null
  return trackedIncomingCalls.get(normalizedCallId) ?? resolveFromCurrentStore(normalizedCallId)
}

export function openCallRoute(
  request: IncomingCallActionRequest,
  source: IncomingCallActionSource,
): boolean {
  if (!bootstrapReady && source !== 'web_ui') {
    queueNativeAction('open', request)
    return false
  }

  const call = resolveTrackedIncomingCall(request)
  const conversationId = normalizeCallId(call?.conversationId, request.conversationId ?? request.callId)
  const callId = normalizeCallId(call?.callId, request.callId ?? conversationId)
  const wasPending = !!callId && pendingNativeActions.has(actionKey('open', callId))
  if (!conversationId || !callId) {
    if (source !== 'web_ui') {
      queueNativeAction('open', request)
    }
    return false
  }

  useNavigationIntentStore.getState().setActiveCallConversationId(conversationId)
  useChatUiStore.getState().setActiveConversationId(conversationId)
  useChatUiStore.getState().setMobileView('conversation')
  useNavigationIntentStore.getState().setIntent(
    createCallIntent(conversationId, mapActionSourceToIntentSource(source)),
  )

  markActionApplied('open', callId)
  if (wasPending || source === 'bootstrap_replay') {
    nativeBridge.ackPendingIncomingCallAction(callId, 'open')
  }
  return true
}

export async function acceptIncomingCallAction(
  request: IncomingCallActionRequest,
  source: IncomingCallActionSource,
): Promise<boolean> {
  const call = resolveTrackedIncomingCall(request)
  const callId = normalizeCallId(call?.callId, request.callId ?? request.conversationId)
  const runtime = getCurrentRuntime()
  const key = callId ? actionKey('accept', callId) : null
  const wasPending = !!key && pendingNativeActions.has(key)

  if (key && inFlightActionKeys.has(key)) {
    return false
  }

  if (!bootstrapReady || !runtime || !call) {
    if (source !== 'web_ui' && callId) {
      queueNativeAction('accept', request)
    }
    return false
  }

  if (key) {
    inFlightActionKeys.add(key)
  }
  try {
    const accepted = await runtime.acceptIncomingCall(call, source)
    if (!accepted) {
      if (source !== 'web_ui' && callId) {
        queueNativeAction('accept', request)
      }
      return false
    }

    markActionApplied('accept', call.callId)
    trackedIncomingCalls.delete(call.callId)
    rememberActiveCall({
      callId: call.callId,
      conversationId: call.conversationId,
      source: call.source,
      roomName: call.roomName,
      tokenHint: call.tokenHint,
    })

    if (source !== 'web_ui') {
      openCallRoute(call, source)
    }

    if (wasPending || source === 'bootstrap_replay') {
      nativeBridge.ackPendingIncomingCallAction(call.callId, 'accept')
    }

    return true
  } finally {
    if (key) {
      inFlightActionKeys.delete(key)
    }
  }
}

export async function declineIncomingCallAction(
  request: IncomingCallActionRequest,
  source: IncomingCallActionSource,
): Promise<boolean> {
  const call = resolveTrackedIncomingCall(request)
  const callId = normalizeCallId(call?.callId, request.callId ?? request.conversationId)
  const runtime = getCurrentRuntime()
  const key = callId ? actionKey('decline', callId) : null
  const wasPending = !!key && pendingNativeActions.has(key)

  if (key && inFlightActionKeys.has(key)) {
    return false
  }

  if (!bootstrapReady || !runtime || !call) {
    if (source !== 'web_ui' && callId) {
      queueNativeAction('decline', request)
    }
    return false
  }

  if (key) {
    inFlightActionKeys.add(key)
  }
  try {
    const declined = await runtime.declineIncomingCall(call, source)
    if (!declined) {
      if (source !== 'web_ui' && callId) {
        queueNativeAction('decline', request)
      }
      return false
    }

    markActionApplied('decline', call.callId)
    trackedIncomingCalls.delete(call.callId)
    if (wasPending || source === 'bootstrap_replay') {
      nativeBridge.ackPendingIncomingCallAction(call.callId, 'decline')
    }
    return true
  } finally {
    if (key) {
      inFlightActionKeys.delete(key)
    }
  }
}

export function cancelIncomingCallAction(
  request: IncomingCallActionRequest,
  _source: IncomingCallActionSource,
): void {
  const call = resolveTrackedIncomingCall(request)
  const callId = normalizeCallId(call?.callId, request.callId ?? request.conversationId)
  const conversationId = normalizeCallId(call?.conversationId, request.conversationId ?? request.callId)

  if (callId) {
    clearIncomingCallTracking(callId)
    clearActiveCallTracking(callId)
  }

  if (!conversationId) return

  const callState = useCallStore.getState()
  if (callState.incoming?.conversationId === conversationId) {
    callState.setIncoming(null)
  }
  if (
    callState.overlayConvId === conversationId ||
    callState.activeConvId === conversationId ||
    callState.outgoingCall?.conversationId === conversationId
  ) {
    callState.endCall()
  }

  if (useNavigationIntentStore.getState().activeCallConversationId === conversationId) {
    useNavigationIntentStore.getState().setActiveCallConversationId(null)
  }
}

export async function endActiveCallAction(
  request: IncomingCallActionRequest,
  source: IncomingCallActionSource,
): Promise<boolean> {
  const call = resolveActiveCallTarget(request)
  const callId = normalizeCallId(call?.callId, request.callId ?? request.conversationId)
  const runtime = getCurrentActiveCallRuntime()
  const key = callId ? actionKey('end', callId) : null

  if (key && inFlightActionKeys.has(key)) {
    return false
  }

  if (!bootstrapReady || !runtime || !call) {
    if (source !== 'web_ui' && callId) {
      queueNativeAction('end', request)
    }
    return false
  }

  if (key) {
    inFlightActionKeys.add(key)
  }
  try {
    const ended = await runtime.endActiveCall(call, source)
    if (!ended) {
      if (source !== 'web_ui' && callId) {
        queueNativeAction('end', request)
      }
      return false
    }

    markActionApplied('end', call.callId)
    clearActiveCallTracking(call.callId)
    return true
  } finally {
    if (key) {
      inFlightActionKeys.delete(key)
    }
  }
}
