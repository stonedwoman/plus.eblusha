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

/**
 * Дескриптор вложений V2-секретки. Едет ВНУТРИ шифртекста сообщения (contentType
 * 'attachment'); серверу наружу отдаются только objectKey и суммарный размер
 * (headerJson.attachment — так спроектирован SecretAttachmentRef/GC). Nonce файла,
 * имя, mime и подпись сервер не видит никогда.
 */
export type SecretAttachmentDescriptorItem = {
  objectKey: string
  url: string
  nonce: string
  name?: string
  mime?: string
  size?: number
  attType: 'IMAGE' | 'VIDEO' | 'AUDIO' | 'FILE'
  width?: number
  height?: number
  duration?: number
  waveform?: number[]
}

export type SecretAttachmentDescriptor = {
  v: 1
  text?: string
  attachments: SecretAttachmentDescriptorItem[]
}

/** Дескриптор → вид сообщения для ленты (общий для отправки-эха и приёма). */
function buildSecretAttachmentView(descriptor: SecretAttachmentDescriptor): {
  type: string
  content: string
  attachments: any[]
  metadataExtras: Record<string, any>
} {
  const items = Array.isArray(descriptor?.attachments) ? descriptor.attachments : []
  const attachments = items.map((a) => ({
    url: a.url || `/api/files/${String(a.objectKey || '').replace(/^\//, '')}`,
    type: a.attType || 'FILE',
    ...(typeof a.size === 'number' ? { size: a.size } : {}),
    ...(a.width && a.height ? { width: a.width, height: a.height } : {}),
    metadata: {
      ...(a.name ? { originalName: a.name } : {}),
      ...(a.mime ? { mime: a.mime } : {}),
      ...(typeof a.size === 'number' ? { size: a.size } : {}),
      ...(a.width && a.height ? { width: a.width, height: a.height } : {}),
      objectKey: a.objectKey,
      // Тот же формат, что у легаси: рендер-машинерия needsDecrypt/attachmentDecryptMap
      // подхватывает без изменений; расшифровка — ключом ТРЕДА (см. decryptAttachment).
      e2ee: {
        kind: 'ciphertext',
        version: 1,
        algorithm: 'xsalsa20_poly1305',
        nonce: a.nonce,
        originalName: a.name,
        originalType: a.mime,
        originalSize: a.size,
      },
    },
  }))
  const types = Array.from(new Set(attachments.map((a) => a.type)))
  const type = types.length === 1 ? types[0] : 'FILE'
  const first = items[0]
  const metadataExtras: Record<string, any> = {}
  if (type === 'AUDIO' && first?.duration != null) metadataExtras.duration = first.duration
  if (type === 'AUDIO' && Array.isArray(first?.waveform)) metadataExtras.waveform = first.waveform
  return { type, content: String(descriptor?.text ?? ''), attachments, metadataExtras }
}

export function transformSecretHistoryItemToMessage(threadId: string, item: any): any {
  const msgId = String(item?.msgId ?? '').trim()
  const createdAt = String(item?.createdAt ?? new Date().toISOString())
  const senderUserId = String(item?.senderUserId ?? 'unknown')
  const headerJson = item?.headerJson ?? {}
  const nonce = typeof headerJson?.nonce === 'string' ? headerJson.nonce : null
  const ciphertext = String(item?.ciphertext ?? '')
  const contentType = String(item?.contentType ?? 'text')

  const keyRec = getSecretThreadKey(threadId)
  const decrypted =
    keyRec && nonce ? decryptSecretThreadText(keyRec.key, ciphertext, nonce) : null

  // Вложение: шифртекст содержит JSON-дескриптор, а не текст.
  let view: { type: string; content: string; attachments: any[]; metadataExtras: Record<string, any> } | null = null
  if (contentType === 'attachment' && decrypted != null) {
    try {
      const descriptor = JSON.parse(decrypted) as SecretAttachmentDescriptor
      if (descriptor && Array.isArray(descriptor.attachments) && descriptor.attachments.length > 0) {
        view = buildSecretAttachmentView(descriptor)
      }
    } catch {
      view = null // битый дескриптор → упадём в «зашифровано», не роняя ленту
    }
  }

  const locked = decrypted == null
  return {
    id: msgId,
    conversationId: threadId,
    senderId: senderUserId,
    sender: { id: senderUserId },
    type: view ? view.type : 'TEXT',
    // Вложение без валидного дескриптора НИКОГДА не показывает сырой расшифрованный
    // JSON (ревью): либо карточка, либо «зашифровано».
    content: view
      ? view.content
      : contentType === 'attachment'
        ? '🔒 Вложение зашифровано'
        : locked
          ? '🔒 Сообщение зашифровано'
          : decrypted,
    createdAt,
    updatedAt: createdAt,
    metadata: {
      ...(view?.metadataExtras ?? {}),
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
        contentType,
        schemaVersion: item?.schemaVersion ?? 1,
      },
    },
    attachments: view ? view.attachments : [],
    reactions: [],
    receipts: [],
    deletedAt: null,
  }
}

/**
 * Отправка вложений в V2-секретку ОДНИМ сообщением (альбом поддержан).
 * Файлы уже зашифрованы ключом треда и загружены (.enc); здесь шифруется дескриптор
 * и уходит push contentType='attachment'. Наружу — только objectKey+size (для GC):
 * первый едет в headerJson.attachment (сервер сам делает SecretAttachmentRef),
 * остальные регистрируются явно через /secret/attachments/ref.
 */
export async function sendSecretThreadAttachments(opts: {
  threadId: string
  peerUserId: string
  text?: string
  attachments: SecretAttachmentDescriptorItem[]
}): Promise<{ msgId: string; localMessage: any }> {
  const localDevice = getStoredDeviceInfo()
  const senderDeviceId = localDevice?.deviceId ?? null
  const keyRec = getSecretThreadKey(opts.threadId)
  if (!keyRec) throw new Error('SECRET_HISTORY_LOCKED')
  if (!opts.attachments.length) throw new Error('NO_ATTACHMENTS')

  const descriptor: SecretAttachmentDescriptor = {
    v: 1,
    ...(opts.text?.trim() ? { text: opts.text.trim() } : {}),
    attachments: opts.attachments,
  }
  const { ciphertextBase64, nonceBase64 } = encryptSecretThreadText(keyRec.key, JSON.stringify(descriptor))
  const msgId = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`
  const createdAt = new Date().toISOString()
  const receiverDeviceIds = await resolveSecretThreadReceiverDeviceIds(opts.threadId, opts.peerUserId)

  const totalSize = opts.attachments.reduce((s, a) => s + (a.size ?? 0), 0)
  const headerJson = {
    v: 1,
    kind: 'msg',
    nonce: nonceBase64,
    attachment: { objectKey: opts.attachments[0].objectKey, size: totalSize },
  }

  await api.post('/secret/messages/push', {
    threadId: opts.threadId,
    msgId,
    createdAt,
    headerJson,
    ciphertext: ciphertextBase64,
    contentType: 'attachment',
    schemaVersion: 1,
    receiverDeviceIds,
  })

  // Остальные файлы альбома — в реестр GC (первый upsert-ится сервером из headerJson).
  for (const extra of opts.attachments.slice(1)) {
    try {
      await api.post('/secret/attachments/ref', { threadId: opts.threadId, objectKey: extra.objectKey })
    } catch {
      // best-effort: реф нужен только для сборки мусора, само сообщение уже ушло
    }
  }

  const view = buildSecretAttachmentView(descriptor)
  const localMessage = {
    id: msgId,
    conversationId: opts.threadId,
    senderId: 'me',
    sender: { id: 'me' },
    type: view.type,
    content: view.content,
    createdAt,
    updatedAt: createdAt,
    metadata: {
      ...view.metadataExtras,
      e2ee: { kind: 'ciphertext', version: 1, algorithm: 'xsalsa20_poly1305', nonce: nonceBase64, decrypted: true },
      secretV2: {
        msgId,
        threadId: opts.threadId,
        headerJson,
        ciphertext: ciphertextBase64,
        contentType: 'attachment',
        schemaVersion: 1,
        senderDeviceId,
      },
    },
    attachments: view.attachments,
    reactions: [],
    receipts: [],
    deletedAt: null,
  }

  return { msgId, localMessage }
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

