import { api } from '../../utils/api'
import { bytesToBase64, utf8ToBytes } from '../../utils/base64'

export type SecretControlType = 'key_receipt' | 'key_request'

export type SecretControlHeader = {
  kind: 'control'
  v: 1
  type: SecretControlType
  threadId: string
  // who sent it (deviceId)
  fromDeviceId?: string
  // who needs a key (deviceId)
  requesterDeviceId?: string
  // optional extra debugging
  ts?: number
  reasonCode?: string
}

function nowIso() {
  return new Date().toISOString()
}

function randomId(): string {
  return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function controlCiphertextBase64(): string {
  // Must be valid base64 for backend storage; content is irrelevant (control payload is in headerJson).
  return bytesToBase64(utf8ToBytes('ctrl'))
}

export async function sendSecretControl(toDeviceId: string, header: Omit<SecretControlHeader, 'kind' | 'v'> & Partial<Pick<SecretControlHeader, 'kind' | 'v'>>, opts?: { ttlSeconds?: number }) {
  const to = String(toDeviceId ?? '').trim()
  if (!to) throw new Error('Missing toDeviceId')
  const threadId = String((header as any)?.threadId ?? '').trim()
  if (!threadId) throw new Error('Missing threadId')

  const headerJson: SecretControlHeader = {
    kind: 'control',
    v: 1,
    type: header.type as any,
    threadId,
    ...(header.fromDeviceId ? { fromDeviceId: String(header.fromDeviceId) } : {}),
    ...(header.requesterDeviceId ? { requesterDeviceId: String(header.requesterDeviceId) } : {}),
    ...(typeof header.ts === 'number' ? { ts: header.ts } : {}),
    ...(header.reasonCode ? { reasonCode: String(header.reasonCode) } : {}),
  }

  await api.post('/secret/send', {
    messages: [
      {
        toDeviceId: to,
        msgId: randomId(),
        createdAt: nowIso(),
        ciphertext: controlCiphertextBase64(),
        ttlSeconds: opts?.ttlSeconds ?? 15 * 60,
        headerJson,
        contentType: 'ref',
        schemaVersion: 1,
      },
    ],
  })
}

export function isSecretControlHeader(h: any): h is SecretControlHeader {
  return !!(h && typeof h === 'object' && String(h.kind) === 'control' && (String(h.type) === 'key_receipt' || String(h.type) === 'key_request'))
}

