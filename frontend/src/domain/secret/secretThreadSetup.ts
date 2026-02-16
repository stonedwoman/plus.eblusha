import { api } from '../../utils/api'
import { ensureSecretThreadKey } from './secretThreadKeyStore'
import { createEncryptedKeyPackageToDevice } from './secretKeyPackages'
import { getStoredDeviceInfo } from '../device/deviceManager'

async function chunk<T>(arr: T[], size: number): Promise<T[][]> {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

export async function createAndShareSecretThreadKey(threadId: string, peerUserId: string): Promise<void> {
  const local = getStoredDeviceInfo()
  const localDeviceId = local?.deviceId ?? null

  const keyRec = ensureSecretThreadKey(threadId)

  // Gather device list for both users
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

  const targets = Array.from(new Set([...myDeviceIds, ...peerDeviceIds]))
    .filter((id) => (localDeviceId ? id !== localDeviceId : true))
    .slice(0, 200)

  if (targets.length === 0) return

  const envelopes = []
  for (const toDeviceId of targets) {
    try {
      const env = await createEncryptedKeyPackageToDevice({
        toDeviceId,
        kind: 'thread_key',
        payload: { threadId, key: keyRec.key },
        ttlSeconds: 60 * 60,
      })
      envelopes.push(env)
    } catch {
      // ignore per-device failures (e.g. no prekeys)
    }
  }

  const batches = await chunk(envelopes, 50)
  for (const batch of batches) {
    if (!batch.length) continue
    await api.post('/secret/send', { messages: batch })
  }
}

