import { api } from '../../utils/api'
import { ensureSecretThreadKey, getSecretThreadKey } from './secretThreadKeyStore'
import { encryptSecretThreadText, decryptSecretThreadText } from './secretThreadCrypto'
import { getStoredDeviceInfo } from '../device/deviceManager'

export type SecretHistoryPage = {
  items: Array<any>
  hasMore: boolean
  nextCursor: string | null
}

export async function fetchSecretHistory(threadId: string, opts?: { cursor?: string | null; limit?: number }): Promise<SecretHistoryPage> {
  const resp = await api.get('/secret/history', {
    params: {
      threadId,
      ...(opts?.cursor ? { cursor: opts.cursor } : {}),
      limit: opts?.limit ?? 50,
    },
  })
  return {
    items: (resp.data?.items ?? []) as any[],
    hasMore: !!resp.data?.hasMore,
    nextCursor: (resp.data?.nextCursor ?? null) as string | null,
  }
}

export async function resolveSecretThreadReceiverDeviceIds(threadId: string, peerUserId: string): Promise<string[]> {
  const [myDevicesResp, peerBundlesResp] = await Promise.all([
    api.get('/devices'),
    api.get('/e2ee/prekeys/bundles', { params: { userId: peerUserId } }),
  ])
  const myDeviceIds = ((myDevicesResp.data?.devices ?? []) as any[])
    .filter((d) => !d?.revokedAt)
    .map((d) => String(d?.id ?? '').trim())
    .filter(Boolean)
  const peerDeviceIds = ((peerBundlesResp.data?.bundles ?? []) as any[])
    .map((b) => String(b?.deviceId ?? '').trim())
    .filter(Boolean)

  // Include self-fanout to *all* my devices (including current).
  return Array.from(new Set([...myDeviceIds, ...peerDeviceIds])).slice(0, 500)
}

export function transformSecretHistoryItemToMessage(threadId: string, item: any): any {
  const msgId = String(item?.msgId ?? '').trim()
  const createdAt = String(item?.createdAt ?? new Date().toISOString())
  const senderUserId = String(item?.senderUserId ?? 'unknown')
  const headerJson = item?.headerJson ?? {}
  const nonce = typeof headerJson?.nonce === 'string' ? headerJson.nonce : null
  const ciphertext = String(item?.ciphertext ?? '')

  const keyRec = getSecretThreadKey(threadId)
  const decrypted =
    keyRec && nonce ? decryptSecretThreadText(keyRec.key, ciphertext, nonce) : null

  return {
    id: msgId,
    conversationId: threadId,
    senderId: senderUserId,
    sender: { id: senderUserId },
    type: 'TEXT',
    content: decrypted == null ? '🔒 Сообщение зашифровано' : decrypted,
    createdAt,
    updatedAt: createdAt,
    metadata: {
      e2ee: {
        kind: 'ciphertext',
        version: 1,
        algorithm: 'xsalsa20_poly1305',
        ...(nonce ? { nonce } : {}),
        decrypted: decrypted != null,
      },
      secretV2: {
        msgId,
        threadId,
        headerJson,
        ciphertext,
        contentType: item?.contentType ?? 'text',
        schemaVersion: item?.schemaVersion ?? 1,
      },
    },
    attachments: [],
    reactions: [],
    receipts: [],
    deletedAt: null,
  }
}

export async function sendSecretThreadText(opts: {
  threadId: string
  peerUserId: string
  text: string
  // If true, generates a new key epoch when no key exists.
  allowGenerateKey?: boolean
}): Promise<{ msgId: string; localMessage: any }> {
  const localDevice = getStoredDeviceInfo()
  const senderDeviceId = localDevice?.deviceId ?? null

  const keyRec = opts.allowGenerateKey ? ensureSecretThreadKey(opts.threadId) : getSecretThreadKey(opts.threadId)
  if (!keyRec) {
    throw new Error('SECRET_HISTORY_LOCKED')
  }

  const { ciphertextBase64, nonceBase64 } = encryptSecretThreadText(keyRec.key, opts.text)
  const msgId = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`
  const createdAt = new Date().toISOString()

  // Fanout targets: all devices for A and B.
  const receiverDeviceIds = await resolveSecretThreadReceiverDeviceIds(opts.threadId, opts.peerUserId)

  const headerJson = { v: 1, kind: 'msg', nonce: nonceBase64 }

  await api.post('/secret/messages/push', {
    threadId: opts.threadId,
    msgId,
    createdAt,
    headerJson,
    ciphertext: ciphertextBase64,
    contentType: 'text',
    schemaVersion: 1,
    receiverDeviceIds,
  })

  const localMessage = {
    id: msgId,
    conversationId: opts.threadId,
    senderId: 'me',
    sender: { id: 'me' },
    type: 'TEXT',
    content: opts.text,
    createdAt,
    updatedAt: createdAt,
    metadata: {
      e2ee: { kind: 'ciphertext', version: 1, algorithm: 'xsalsa20_poly1305', nonce: nonceBase64, decrypted: true },
      secretV2: {
        msgId,
        threadId: opts.threadId,
        headerJson,
        ciphertext: ciphertextBase64,
        contentType: 'text',
        schemaVersion: 1,
        senderDeviceId,
      },
    },
    attachments: [],
    reactions: [],
    receipts: [],
    deletedAt: null,
  }

  return { msgId, localMessage }
}

