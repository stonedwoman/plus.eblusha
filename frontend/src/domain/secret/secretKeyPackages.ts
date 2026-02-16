import nacl from 'tweetnacl'
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha256.js'
import { api } from '../../utils/api'
import { base64ToBytes, bytesToBase64, utf8ToBytes, bytesToUtf8 } from '../../utils/base64'
import { consumePrekeySecret, getPrekeySecret, getIdentityKeyPair, getStoredDeviceInfo } from '../device/deviceManager'

type ClaimResponse = {
  deviceId: string
  identityKey: string
  prekey: { keyId: string; publicKey: string }
  alg?: string
  version?: number
}

function secretDebugEnabled(): boolean {
  try {
    if (typeof window === 'undefined') return false
    const q = String(window.location?.search ?? '')
    if (q.includes('SECRET_DEBUG=1')) return true
    return window.localStorage.getItem('eb_secret_debug') === '1'
  } catch {
    return false
  }
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

// The backend OPK claim endpoint is rate-limited. If a user has many active devices,
// key-share fanout can easily exceed the limit and permanently stall bootstrapping.
// We serialize OPK claims with a small delay to avoid 429 storms.
const CLAIM_MIN_INTERVAL_MS = 1100
let lastClaimAt = 0
let claimChain: Promise<void> = Promise.resolve()
const inFlightClaims = new Map<string, Promise<ClaimResponse>>()

async function claimPrekeyRateLimited(deviceId: string): Promise<ClaimResponse> {
  const id = String(deviceId ?? '').trim()
  if (!id) throw new Error('Missing deviceId')
  const existing = inFlightClaims.get(id)
  if (existing) return existing

  const p = (async () => {
    // Ensure serialized scheduling (best-effort, in-tab).
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const prev = claimChain
    claimChain = prev.then(() => gate)
    await prev
    try {
      const now = Date.now()
      const wait = Math.max(0, CLAIM_MIN_INTERVAL_MS - (now - lastClaimAt))
      if (wait) await sleep(wait)

      // Retry a few times on 429 with backoff.
      let attempt = 0
      // eslint-disable-next-line no-constant-condition
      while (true) {
        attempt += 1
        try {
          const claim = await api.post<ClaimResponse>('/e2ee/prekeys/claim', { deviceId: id })
          lastClaimAt = Date.now()
          return claim.data as any
        } catch (err: any) {
          const status = err?.response?.status
          if (status === 429 && attempt < 5) {
            const ra = err?.response?.headers?.['retry-after']
            const retryAfterMs =
              typeof ra === 'string' && ra.trim() && Number.isFinite(Number(ra)) ? Number(ra) * 1000 : 1500
            if (secretDebugEnabled()) {
              // eslint-disable-next-line no-console
              console.warn('[secretKeyPackages] OPK claim rate limited, backing off', { deviceId: id, attempt, retryAfterMs })
            }
            await sleep(retryAfterMs + attempt * 250)
            continue
          }
          throw err
        }
      }
    } finally {
      release()
      inFlightClaims.delete(id)
    }
  })()

  inFlightClaims.set(id, p)
  return p
}

export type SecretDirectEnvelope = {
  toDeviceId: string
  msgId: string
  createdAt: string
  ciphertext: string
  ttlSeconds?: number
  headerJson: Record<string, any>
  contentType: 'ref' | 'text' | 'attachment'
  schemaVersion: number
}

function deriveKey(sharedSecret: Uint8Array, salt: Uint8Array, info: string): Uint8Array {
  return hkdf(sha256, sharedSecret, salt, utf8ToBytes(info), 32)
}

export async function createEncryptedKeyPackageToDevice(opts: {
  toDeviceId: string
  kind: 'thread_key' | 'device_link_keys'
  payload: Record<string, any>
  ttlSeconds?: number
}): Promise<SecretDirectEnvelope> {
  const localInfo = getStoredDeviceInfo()
  const identity = getIdentityKeyPair()
  if (!localInfo || !identity) {
    throw new Error('Device keys are not ready')
  }

  const claimed = (await claimPrekeyRateLimited(opts.toDeviceId)) as any
  const prekeyId = claimed?.prekey?.keyId as string | undefined
  const prekeyPub = claimed?.prekey?.publicKey as string | undefined
  if (!prekeyId || !prekeyPub) {
    throw new Error('Invalid prekey claim')
  }

  const sharedSecret = nacl.scalarMult(base64ToBytes(identity.secretKey), base64ToBytes(prekeyPub))
  const handshakeSaltBytes = nacl.randomBytes(32)
  const hkdfInfo = `eblusha:secret_pkg:${opts.kind}:to:${opts.toDeviceId}:from:${localInfo.deviceId}:prekey:${prekeyId}`
  const sessionKey = deriveKey(sharedSecret, handshakeSaltBytes, hkdfInfo)

  const nonce = nacl.randomBytes(24)
  const plaintextJson = JSON.stringify({ ...opts.payload, kind: opts.kind, v: 1, ts: Date.now() })
  const cipher = nacl.secretbox(utf8ToBytes(plaintextJson), nonce, sessionKey)

  const msgId = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`
  return {
    toDeviceId: opts.toDeviceId,
    msgId,
    createdAt: new Date().toISOString(),
    ciphertext: bytesToBase64(cipher),
    ...(typeof opts.ttlSeconds === 'number' ? { ttlSeconds: opts.ttlSeconds } : {}),
    contentType: 'ref',
    schemaVersion: 1,
    headerJson: {
      kind: 'key_package',
      v: 1,
      packageKind: opts.kind,
      recipientDeviceId: opts.toDeviceId,
      initiatorDeviceId: localInfo.deviceId,
      initiatorIdentityKey: identity.publicKey,
      prekeyId,
      handshakeSalt: bytesToBase64(handshakeSaltBytes),
      hkdfInfo,
      nonce: bytesToBase64(nonce),
      alg: 'xsalsa20_poly1305+hkdf_sha256',
    },
  }
}

export function tryDecryptIncomingKeyPackage(msg: any): { kind: string; payload: any } | null {
  const header = (msg?.headerJson ?? msg?.header ?? msg?.metadata?.headerJson) as any
  if (!header || header.kind !== 'key_package') return null
  const prekeyId = String(header.prekeyId ?? '').trim()
  const initiatorIdentityKey = String(header.initiatorIdentityKey ?? '').trim()
  const handshakeSalt = String(header.handshakeSalt ?? '').trim()
  const hkdfInfo = String(header.hkdfInfo ?? '').trim()
  const nonceB64 = String(header.nonce ?? '').trim()
  if (!prekeyId || !initiatorIdentityKey || !handshakeSalt || !hkdfInfo || !nonceB64) return null

  const prekeySecret = getPrekeySecret(prekeyId)
  if (!prekeySecret) return null

  try {
    const sharedSecret = nacl.scalarMult(base64ToBytes(prekeySecret), base64ToBytes(initiatorIdentityKey))
    const sessionKey = deriveKey(sharedSecret, base64ToBytes(handshakeSalt), hkdfInfo)
    const cipher = base64ToBytes(String(msg?.ciphertext ?? msg?.ciphertextBase64 ?? msg?.cipher ?? ''))
    const nonce = base64ToBytes(nonceB64)
    const plain = nacl.secretbox.open(cipher, nonce, sessionKey)
    if (!plain) return null
    // Consume OPK only after successful decrypt (prevents permanent loss on bootstrap timing).
    consumePrekeySecret(prekeyId)
    const decoded = JSON.parse(bytesToUtf8(plain))
    return { kind: String(decoded?.kind ?? header.packageKind ?? ''), payload: decoded }
  } catch {
    return null
  }
}

