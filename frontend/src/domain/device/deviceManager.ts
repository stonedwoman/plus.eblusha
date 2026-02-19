import axios from 'axios'
import nacl from 'tweetnacl'
import { api } from '../../utils/api'

const DEVICE_INFO_KEY = 'eb_device_info_v1'
const DEVICE_SECRET_KEY = 'eb_device_secret_v1'
const DEFAULT_PREKEY_BATCH = 50
const MIN_SERVER_PREKEY_RESERVE = 20
// Keep this low: missing OPKs blocks key delivery. We still guard with rate limiting server-side.
const PREKEY_PUBLISH_COOLDOWN_MS = 5_000

type StoredDeviceInfo = {
  deviceId: string
  name: string
  platform?: string | null
  publicKey: string
  registeredAt: number
}

type StoredDeviceSecrets = {
  deviceId: string
  identitySecret: string
  prekeys: Record<string, string>
}

type GeneratedPrekey = {
  keyId: string
  publicKey: string
  secretKey: string
}

export type DeviceBootstrapResult = {
  deviceId: string
  publicKey: string
  name?: string
  platform?: string | null
}

let bootstrapPromise: Promise<DeviceBootstrapResult | null> | null = null
let lastForcePublishAt = 0

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

function isDeviceBelongsToAnotherUserConflict(err: unknown): boolean {
  if (!axios.isAxiosError(err)) return false
  if (err.response?.status !== 409) return false
  const msg = String((err.response?.data as any)?.message ?? err.message ?? '').toLowerCase()
  return msg.includes('another user') || msg.includes('друг') || msg.includes('чуж')
}

async function publishPrekeysBatch(deviceId: string, count: number, opts?: { reason?: string }) {
  const id = String(deviceId ?? '').trim()
  if (!id) return
  const n = Math.max(1, Math.min(200, Math.floor(count || DEFAULT_PREKEY_BATCH)))
  const secrets = loadDeviceSecrets()
  if (!secrets || secrets.deviceId !== id) return

  const prekeys = generatePrekeys(n)
  for (const pk of prekeys) {
    secrets.prekeys[pk.keyId] = pk.secretKey
  }
  saveDeviceSecrets(secrets)

  await api.post(`/devices/${id}/prekeys`, {
    prekeys: prekeys.map((pk) => ({ keyId: pk.keyId, publicKey: pk.publicKey })),
  })

  if (secretDebugEnabled()) {
    // eslint-disable-next-line no-console
    console.log('[deviceManager] published prekeys', { deviceId: id, published: prekeys.length, reason: opts?.reason ?? null })
  }
}

export async function forcePublishPrekeys(opts?: { count?: number; reason?: string; force?: boolean }) {
  const now = Date.now()
  const force = !!opts?.force
  if (!force && now - lastForcePublishAt < PREKEY_PUBLISH_COOLDOWN_MS) return
  const boot = await ensureDeviceBootstrap()
  const deviceId = boot?.deviceId
  if (!deviceId) return
  await publishPrekeysBatch(deviceId, opts?.count ?? DEFAULT_PREKEY_BATCH, { reason: opts?.reason })
  // Only advance cooldown after a successful publish.
  lastForcePublishAt = Date.now()
}

async function maybeReplenishPrekeys(deviceId: string) {
  try {
    const resp = await api.get('/devices')
    const devices = (resp.data?.devices ?? []) as any[]
    const me = devices.find((d) => String(d?.id ?? '') === deviceId)
    const available = typeof me?.availablePrekeys === 'number' ? me.availablePrekeys : null
    if (available != null && available >= MIN_SERVER_PREKEY_RESERVE) return

    await publishPrekeysBatch(deviceId, DEFAULT_PREKEY_BATCH, { reason: 'reserve_low' })
    if (secretDebugEnabled()) {
      // eslint-disable-next-line no-console
      console.log('[deviceManager] replenished prekeys', { deviceId, published: DEFAULT_PREKEY_BATCH, previousAvailable: available })
    }
  } catch (err) {
    if (secretDebugEnabled()) {
      // eslint-disable-next-line no-console
      console.warn('[deviceManager] prekey replenish failed', err)
    }
  }
}

export function ensureDeviceBootstrap(): Promise<DeviceBootstrapResult | null> {
  if (bootstrapPromise) return bootstrapPromise
  bootstrapPromise = (async () => {
    try {
      let storedInfo = loadDeviceInfo()
      let storedSecret = loadDeviceSecrets()

      if (storedInfo && storedSecret && storedInfo.deviceId === storedSecret.deviceId) {
        try {
          const desiredName = detectDeviceName()
          const desiredPlatform = detectPlatform()
          // IMPORTANT: always upsert the device server-side.
          // If the server lost/never had this device row (DB restore, proxy issues, old builds),
          // we must re-register it; otherwise /devices/:id/prekeys → 404 and /secret/inbox/pull → 400.
          await api.post('/devices/register', {
            deviceId: storedInfo.deviceId,
            name: desiredName,
            platform: desiredPlatform,
            publicKey: storedInfo.publicKey,
          })
          if (storedInfo.name !== desiredName || storedInfo.platform !== desiredPlatform) {
            saveDeviceInfo({
              ...storedInfo,
              name: desiredName,
              platform: desiredPlatform,
            })
            storedInfo.name = desiredName
            storedInfo.platform = desiredPlatform
          }
        } catch (metadataError) {
          // CRITICAL: If this stored deviceId belongs to another user (e.g. browser reused localStorage across accounts),
          // we must wipe local device material and bootstrap a fresh device.
          if (isDeviceBelongsToAnotherUserConflict(metadataError)) {
            console.warn('[deviceManager] stored device belongs to another user; re-bootstrapping this device')
            clearStoredDevice()
            storedInfo = null
            storedSecret = null
          } else {
            console.warn('Device metadata sync failed:', metadataError)
          }
        }

        if (storedInfo && storedSecret && storedInfo.deviceId === storedSecret.deviceId) {
          // Best-effort: keep some OPKs on server so other devices can encrypt key packages to us.
          void maybeReplenishPrekeys(storedInfo.deviceId)
          return {
            deviceId: storedInfo.deviceId,
            publicKey: storedInfo.publicKey,
            name: storedInfo.name,
            platform: storedInfo.platform,
          }
        }
      }

      // Fresh bootstrap: generate new deviceId + identity + OPKs, and publish them.
      // If we still hit a 409 (deviceId belongs to another user), retry with a new deviceId.
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const deviceId = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`
        const identityPair = nacl.box.keyPair()
        const identityPublic = toBase64(identityPair.publicKey)
        const identitySecret = toBase64(identityPair.secretKey)
        const prekeys = generatePrekeys(DEFAULT_PREKEY_BATCH)

        const payload = {
          deviceId,
          name: detectDeviceName(),
          platform: detectPlatform(),
          publicKey: identityPublic,
          prekeys: prekeys.map((pk) => ({ keyId: pk.keyId, publicKey: pk.publicKey })),
        }

        try {
          await api.post('/devices/register', payload)
        } catch (registerError) {
          if (isDeviceBelongsToAnotherUserConflict(registerError)) {
            console.warn('[deviceManager] deviceId conflict (belongs to another user), retrying', { attempt })
            continue
          }
          throw registerError
        }

        saveDeviceInfo({
          deviceId,
          name: payload.name,
          platform: payload.platform,
          publicKey: identityPublic,
          registeredAt: Date.now(),
        })
        saveDeviceSecrets({
          deviceId,
          identitySecret,
          prekeys: prekeys.reduce<Record<string, string>>((acc, pk) => {
            acc[pk.keyId] = pk.secretKey
            return acc
          }, {}),
        })

        // Fire-and-forget replenish check (should be already >= reserve after register, but keep it robust).
        void maybeReplenishPrekeys(deviceId)

        return { deviceId, publicKey: identityPublic, name: payload.name, platform: payload.platform ?? undefined }
      }

      throw new Error('DEVICE_REGISTER_CONFLICT')
    } catch (error) {
      console.error('Device bootstrap failed:', error)
      return null
    } finally {
      bootstrapPromise = null
    }
  })()
  return bootstrapPromise
}

export function getStoredDeviceInfo(): DeviceBootstrapResult | null {
  const info = loadDeviceInfo()
  if (!info) return null
  return {
    deviceId: info.deviceId,
    publicKey: info.publicKey,
    name: info.name,
    platform: info.platform ?? undefined,
  }
}

export function getIdentityKeyPair(): { publicKey: string; secretKey: string } | null {
  const info = loadDeviceInfo()
  const secrets = loadDeviceSecrets()
  if (!info || !secrets) return null
  if (info.deviceId !== secrets.deviceId) return null
  return {
    publicKey: info.publicKey,
    secretKey: secrets.identitySecret,
  }
}

function clearStoredDevice() {
  try {
    localStorage.removeItem(DEVICE_INFO_KEY)
    localStorage.removeItem(DEVICE_SECRET_KEY)
  } catch {}
}

export async function rebootstrapDevice(): Promise<DeviceBootstrapResult | null> {
  clearStoredDevice()
  return ensureDeviceBootstrap()
}

export function getPrekeySecret(keyId: string): string | null {
  const secrets = loadDeviceSecrets()
  if (!secrets || !secrets.prekeys[keyId]) {
    return null
  }
  return secrets.prekeys[keyId]
}

export function consumePrekeySecret(keyId: string): string | null {
  const secrets = loadDeviceSecrets()
  if (!secrets || !secrets.prekeys[keyId]) return null
  const secret = secrets.prekeys[keyId]
  delete secrets.prekeys[keyId]
  saveDeviceSecrets(secrets)
  return secret
}

function loadDeviceInfo(): StoredDeviceInfo | null {
  try {
    const raw = localStorage.getItem(DEVICE_INFO_KEY)
    if (!raw) return null
    return JSON.parse(raw) as StoredDeviceInfo
  } catch {
    return null
  }
}

function saveDeviceInfo(info: StoredDeviceInfo) {
  try {
    localStorage.setItem(DEVICE_INFO_KEY, JSON.stringify(info))
  } catch {}
}

function loadDeviceSecrets(): StoredDeviceSecrets | null {
  try {
    const raw = localStorage.getItem(DEVICE_SECRET_KEY)
    if (!raw) return null
    return JSON.parse(raw) as StoredDeviceSecrets
  } catch {
    return null
  }
}

function saveDeviceSecrets(data: StoredDeviceSecrets) {
  try {
    localStorage.setItem(DEVICE_SECRET_KEY, JSON.stringify(data))
  } catch {}
}

function generatePrekeys(count: number): GeneratedPrekey[] {
  const list: GeneratedPrekey[] = []
  for (let i = 0; i < count; i += 1) {
    const pair = nacl.box.keyPair()
    const keyId = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${i}-${Math.random().toString(36).slice(2)}`
    list.push({
      keyId,
      publicKey: toBase64(pair.publicKey),
      secretKey: toBase64(pair.secretKey),
    })
  }
  return list
}

export function isElectron(): boolean {
  try {
    if (typeof navigator !== 'undefined' && /Electron/i.test(navigator.userAgent || '')) return true
    if (typeof (window as any)?.process?.versions?.electron === 'string') return true
    return false
  } catch {
    return false
  }
}

function detectDeviceName(): string {
  try {
    if (isElectron()) return 'Еблуша для ПК'
    const userAgentData = (navigator as any).userAgentData
    if (userAgentData && Array.isArray(userAgentData.brands)) {
      const preferredBrand = userAgentData.brands.find(
        (entry: { brand: string }) => entry?.brand && !/not.*brand/i.test(entry.brand) && !/generic/i.test(entry.brand),
      )
      if (preferredBrand?.brand) {
        return `${preferredBrand.brand} (${detectPlatformLabel()})`
      }
    }
    const ua = navigator.userAgent || ''
    if (/iPhone/i.test(ua)) return 'iPhone'
    if (/iPad/i.test(ua)) return 'iPad'
    if (/Android/i.test(ua)) return 'Android'
    if (/Macintosh/i.test(ua)) return 'Mac'
    if (/Windows/i.test(ua)) return 'Windows'
    const platform = detectPlatformLabel()
    if (platform !== 'Web') {
      return platform
    }
    return 'Браузер'
  } catch {
    return 'Браузер'
  }
}

function detectPlatform(): string {
  try {
    if (isElectron()) return 'Еблуша для ПК'
    const uaPlatform = (navigator as any).userAgentData?.platform
    return (uaPlatform || navigator.platform || 'web').toString()
  } catch {
    return 'web'
  }
}

function detectPlatformLabel(): string {
  const platform = detectPlatform().toLowerCase()
  if (platform.includes('mac')) return 'Mac'
  if (platform.includes('win')) return 'Windows'
  if (platform.includes('iphone')) return 'iPhone'
  if (platform.includes('ipad')) return 'iPad'
  if (platform.includes('android')) return 'Android'
  if (platform.includes('linux')) return 'Linux'
  return 'Web'
}

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  const len = bytes.byteLength
  for (let i = 0; i < len; i += 1) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}

