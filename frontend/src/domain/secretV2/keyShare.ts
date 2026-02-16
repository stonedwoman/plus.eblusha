import { createAndShareSecretThreadKey } from '../secret/secretThreadSetup'
import { requestSecretThreadKeyResend } from '../secret/secretChatFix'
import { api } from '../../utils/api'
import { ensureSecretThreadKey, hasSecretThreadKey } from '../secret/secretThreadKeyStore'
import { markThreadError, markThreadOpened, type SecretReasonCode } from './state'
import { bytesToBase64, utf8ToBytes } from '../../utils/base64'

function mapShareError(err: any): SecretReasonCode {
  const status = err?.response?.status
  const msg = String(err?.response?.data?.message ?? err?.message ?? '').toLowerCase()
  if (status === 404 && msg.includes('prekey')) return 'NO_PREKEYS_AVAILABLE'
  if (status === 400 || status === 403) return 'SERVER_REJECTED'
  if (status === 0 || msg.includes('network') || msg.includes('timeout')) return 'NETWORK_ERROR'
  return 'NETWORK_ERROR'
}

export async function ensureCreatorThreadKeyAndShare(opts: {
  threadId: string
  peerUserId: string
}): Promise<{ ok: true } | { ok: false; reasonCode: SecretReasonCode; message: string }> {
  const threadId = String(opts.threadId ?? '').trim()
  if (!threadId) return { ok: false, reasonCode: 'SERVER_REJECTED', message: 'Missing threadId' }
  try {
    ensureSecretThreadKey(threadId)
    markThreadOpened(threadId)
    await createAndShareSecretThreadKey(threadId, opts.peerUserId)
    return { ok: true }
  } catch (e: any) {
    const reasonCode = mapShareError(e)
    markThreadError(threadId, reasonCode)
    return { ok: false, reasonCode, message: String(e?.response?.data?.message ?? e?.message ?? 'share failed') }
  }
}

export async function requestResendFromPeer(opts: {
  threadId: string
  peerUserId: string
}): Promise<{ ok: true } | { ok: false; reasonCode: SecretReasonCode; message: string }> {
  const threadId = String(opts.threadId ?? '').trim()
  if (!threadId) return { ok: false, reasonCode: 'SERVER_REJECTED', message: 'Missing threadId' }
  try {
    await requestSecretThreadKeyResend(threadId, opts.peerUserId)
    return { ok: true }
  } catch (e: any) {
    const message = String(e?.response?.data?.message ?? e?.message ?? 'resend request failed')
    const reasonCode =
      message.includes('NO_PEER_TARGETS')
        ? ('NO_PEER_DEVICES' as SecretReasonCode)
        : mapShareError(e)
    markThreadError(threadId, reasonCode)
    return { ok: false, reasonCode, message }
  }
}

export async function listPeerActiveDeviceIds(peerUserId: string): Promise<string[]> {
  const resp = await api.get('/e2ee/prekeys/bundles', { params: { userId: peerUserId } })
  return ((resp.data?.bundles ?? []) as any[])
    .map((b) => String(b?.deviceId ?? '').trim())
    .filter(Boolean)
}

export function localThreadHasKey(threadId: string): boolean {
  return hasSecretThreadKey(String(threadId ?? '').trim())
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

function nowIso() {
  return new Date().toISOString()
}

function randomId(): string {
  return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function controlCiphertextBase64(): string {
  return bytesToBase64(utf8ToBytes('ctrl'))
}

export async function sendKeyResendRequestToUserDevices(opts: {
  threadId: string
  creatorUserId: string
  requesterUserId: string
  requesterDeviceId: string
}): Promise<void> {
  const threadId = String(opts.threadId ?? '').trim()
  const creatorUserId = String(opts.creatorUserId ?? '').trim()
  const requesterUserId = String(opts.requesterUserId ?? '').trim()
  const requesterDeviceId = String(opts.requesterDeviceId ?? '').trim()
  if (!threadId || !creatorUserId || !requesterUserId || !requesterDeviceId) return

  const deviceIds = await listPeerActiveDeviceIds(creatorUserId)
  const targets = Array.from(new Set(deviceIds)).slice(0, 200)
  if (!targets.length) return

  const createdAt = nowIso()
  const ciphertext = controlCiphertextBase64()
  const messages = targets.map((toDeviceId) => ({
    toDeviceId,
    msgId: randomId(),
    createdAt,
    ciphertext,
    ttlSeconds: 10 * 60,
    contentType: 'ref' as const,
    schemaVersion: 1,
    headerJson: {
      kind: 'key_resend_request',
      v: 1,
      threadId,
      requesterUserId,
      requesterDeviceId,
      ts: Date.now(),
    },
  }))

  for (const batch of chunk(messages, 200)) {
    if (!batch.length) continue
    await api.post('/secret/send', { messages: batch })
  }
}

