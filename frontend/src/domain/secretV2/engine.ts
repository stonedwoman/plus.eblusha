import { refreshSecretPrekeys, ensureSecretBootstrap } from './bootstrap'
import {
  clearThreadError,
  getThreadState,
  hasSeenKeyPackage,
  markThreadError,
  markThreadOpened,
  markThreadReady,
  type SecretReasonCode,
  type SecretThreadView,
} from './state'
import {
  ensureCreatorThreadKeyAndShare,
  listPeerActiveDeviceIds,
  localThreadHasKey,
  requestResendFromPeer,
  sendKeyResendRequestToUserDevices,
} from './keyShare'
import { hasSecretThreadKey } from '../secret/secretThreadKeyStore'

type SendQueueItem = {
  id: string
  threadId: string
  peerUserId: string
  text: string
  createdAt: number
}

const queueByThread = new Map<string, SendQueueItem[]>()
const resendRequestTimersByThread = new Map<string, number[]>()

function nextQueueId() {
  return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function mapErrorToReason(message: string): SecretReasonCode {
  const msg = String(message ?? '').toLowerCase()
  if (msg.includes('prekey')) return 'NO_PREKEYS_AVAILABLE'
  if (msg.includes('network') || msg.includes('timeout')) return 'NETWORK_ERROR'
  if (msg.includes('bootstrap')) return 'BOOTSTRAP_FAILED'
  return 'SERVER_REJECTED'
}

function getCurrentUserId(): string | null {
  try {
    const raw = typeof window !== 'undefined' ? localStorage.getItem('eb_user') : null
    if (!raw) return null
    const parsed = JSON.parse(raw) as any
    if (parsed && typeof parsed.id === 'string') return parsed.id
    return null
  } catch {
    return null
  }
}

function scheduleResendRequests(opts: { threadId: string; creatorUserId: string; requesterUserId: string; requesterDeviceId: string }) {
  const threadId = String(opts.threadId ?? '').trim()
  if (!threadId) return
  if (resendRequestTimersByThread.has(threadId)) return
  // Aggressive: if notify is broken, ask for resend early.
  const delays = [1_500, 3_000, 6_000]
  const timers: number[] = []
  for (const delay of delays) {
    const t = window.setTimeout(() => {
      try {
        if (hasSecretThreadKey(threadId)) return
        if (hasSeenKeyPackage(threadId)) return
        const view = getThreadState(threadId)
        if (view.state !== 'WAITING_KEY_PACKAGE') return
        void sendKeyResendRequestToUserDevices(opts).catch(() => {})
      } catch {}
    }, delay)
    timers.push(t)
  }
  resendRequestTimersByThread.set(threadId, timers)
}

export async function ensureReady(opts: {
  threadId: string
  peerUserId: string
  amCreator: boolean
}): Promise<SecretThreadView> {
  const threadId = String(opts.threadId ?? '').trim()
  if (!threadId) {
    return { threadId, state: 'ERROR', reasonCode: 'SERVER_REJECTED', updatedAt: Date.now(), waitingSince: null }
  }
  markThreadOpened(threadId)

  const bootstrap = await ensureSecretBootstrap(threadId)
  if (!bootstrap.ok) {
    markThreadError(threadId, bootstrap.reasonCode)
    return getThreadState(threadId)
  }
  if (hasSecretThreadKey(threadId)) {
    markThreadReady(threadId)
    return getThreadState(threadId)
  }

  try {
    if (opts.amCreator) {
      const r = await ensureCreatorThreadKeyAndShare({ threadId, peerUserId: opts.peerUserId })
      if (!r.ok) markThreadError(threadId, r.reasonCode)
      else if (localThreadHasKey(threadId)) markThreadReady(threadId)
    } else {
      // Peer path: verify peer has devices and ask for resend once.
      const peers = await listPeerActiveDeviceIds(opts.peerUserId)
      if (!peers.length) {
        markThreadError(threadId, 'NO_PEER_DEVICES')
      } else {
        // Hotfix: if no key_package arrives soon, ask creator devices to resend key.
        const requesterUserId = getCurrentUserId()
        const requesterDeviceId = String((bootstrap as any)?.deviceId ?? '').trim()
        if (requesterUserId && requesterDeviceId) {
          scheduleResendRequests({
            threadId,
            creatorUserId: opts.peerUserId,
            requesterUserId,
            requesterDeviceId,
          })
        }
        const rr = await requestResendFromPeer({ threadId, peerUserId: opts.peerUserId })
        if (!rr.ok) markThreadError(threadId, rr.reasonCode)
      }
    }
  } catch (e: any) {
    markThreadError(threadId, mapErrorToReason(String(e?.response?.data?.message ?? e?.message ?? 'unknown')))
  }

  if (hasSecretThreadKey(threadId)) {
    markThreadReady(threadId)
  }
  return getThreadState(threadId)
}

export function getThreadView(threadId: string): SecretThreadView {
  return getThreadState(threadId)
}

export async function refreshKeysAndRetry(opts: {
  threadId: string
  peerUserId: string
  amCreator: boolean
}): Promise<SecretThreadView> {
  await refreshSecretPrekeys('secret_engine_v2_fix')
  clearThreadError(opts.threadId)
  return ensureReady(opts)
}

export function enqueueText(threadId: string, peerUserId: string, text: string): SendQueueItem {
  const id = String(threadId ?? '').trim()
  const peer = String(peerUserId ?? '').trim()
  const t = String(text ?? '').trim()
  const item: SendQueueItem = { id: nextQueueId(), threadId: id, peerUserId: peer, text: t, createdAt: Date.now() }
  const list = queueByThread.get(id) ?? []
  list.push(item)
  queueByThread.set(id, list)
  return item
}

export function getQueuedCount(threadId: string): number {
  const id = String(threadId ?? '').trim()
  return (queueByThread.get(id) ?? []).length
}

export async function flushQueuedText(
  threadId: string,
  sendFn: (item: SendQueueItem) => Promise<void>
): Promise<void> {
  const id = String(threadId ?? '').trim()
  if (!id || !hasSecretThreadKey(id)) return
  const list = queueByThread.get(id) ?? []
  if (!list.length) return
  while (list.length > 0) {
    const item = list[0]!
    await sendFn(item)
    list.shift()
  }
  queueByThread.delete(id)
}

export function removeQueuedById(threadId: string, queueId: string): void {
  const id = String(threadId ?? '').trim()
  const qid = String(queueId ?? '').trim()
  if (!id || !qid) return
  const list = queueByThread.get(id) ?? []
  const next = list.filter((x) => x.id !== qid)
  if (!next.length) queueByThread.delete(id)
  else queueByThread.set(id, next)
}

