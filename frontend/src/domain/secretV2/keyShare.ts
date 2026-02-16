import { createAndShareSecretThreadKey } from '../secret/secretThreadSetup'
import { requestSecretThreadKeyResend } from '../secret/secretChatFix'
import { api } from '../../utils/api'
import { ensureSecretThreadKey, hasSecretThreadKey } from '../secret/secretThreadKeyStore'
import { markThreadError, markThreadOpened, type SecretReasonCode } from './state'

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

