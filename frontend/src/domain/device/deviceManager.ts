import axios from 'axios'
import nacl from 'tweetnacl'
import { api } from '../../utils/api'

const DEVICE_INFO_KEY = 'eb_device_info_v1'
const DEVICE_SECRET_KEY = 'eb_device_secret_v1'
const DEFAULT_PREKEY_BATCH = 50
const MIN_SERVER_PREKEY_RESERVE = 20

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

async function maybeReplenishPrekeys(deviceId: string) {
  try {
    const resp = await api.get('/devices')
    const devices = (resp.data?.devices ?? []) as any[]
    const me = devices.find((d) => String(d?.id ?? '') === deviceId)
    const available = typeof me?.availablePrekeys === 'number' ? me.availablePrekeys : null
    if (available != null && available >= MIN_SERVER_PREKEY_RESERVE) return

    const secrets = loadDeviceSecrets()
    if (!secrets || secrets.deviceId !== deviceId) return

    const prekeys = generatePrekeys(DEFAULT_PREKEY_BATCH)
    for (const pk of prekeys) {
      secrets.prekeys[pk.keyId] = pk.secretKey
    }
    saveDeviceSecrets(secrets)

    await api.post(`/devices/${deviceId}/prekeys`, {
      prekeys: prekeys.map((pk) => ({ keyId: pk.keyId, publicKey: pk.publicKey })),
    })
    if (secretDebugEnabled()) {
      // eslint-disable-next-line no-console
      console.log('[deviceManager] replenished prekeys', { deviceId, published: prekeys.length, previousAvailable: available })
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
      const storedInfo = loadDeviceInfo()
      const storedSecret = loadDeviceSecrets()
      if (storedInfo && storedSecret && storedInfo.deviceId === storedSecret.deviceId) {
      try {
        const desiredName = detectDeviceName()
        const desiredPlatform = detectPlatform()
        if (storedInfo.name !== desiredName || storedInfo.platform !== desiredPlatform) {
          await api.post('/devices/register', {
            deviceId: storedInfo.deviceId,
            name: desiredName,
            platform: desiredPlatform,
            publicKey: storedInfo.publicKey,
          })
          saveDeviceInfo({
            ...storedInfo,
            name: desiredName,
            platform: desiredPlatform,
          })
          storedInfo.name = desiredName
          storedInfo.platform = desiredPlatform
        }
      } catch (metadataError) {
        if (axios.isAxiosError(metadataError) && metadataError.response?.status === 409) {
          console.debug('[deviceManager] Device metadata already up to date')
        } else {
          console.warn('Device metadata sync failed:', metadataError)
        }
      }
      // Best-effort: keep some OPKs on server so other devices can encrypt key packages to us.
      void maybeReplenishPrekeys(storedInfo.deviceId)
      return {
        deviceId: storedInfo.deviceId,
        publicKey: storedInfo.publicKey,
        name: storedInfo.name,
        platform: storedInfo.platform,
      }
      }

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
        if (axios.isAxiosError(registerError) && registerError.response?.status === 409) {
          console.debug('[deviceManager] Device already registered, reusing local keys')
        } else {
          throw registerError
        }
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

export function consumePrekeySecret(keyId: string): string | null {
  const secrets = loadDeviceSecrets()
  if (!secrets || !secrets.prekeys[keyId]) {
    return null
  }
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

function detectDeviceName(): string {
  try {
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

