import { api } from '../../utils/api'
import { ensureSecretThreadKey } from './secretThreadKeyStore'
import { createEncryptedKeyPackageToDevice } from './secretKeyPackages'
import { getStoredDeviceInfo } from '../device/deviceManager'

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
  const log = (...args: any[]) => {
    if (!secretDebugEnabled()) return
    // eslint-disable-next-line no-console
    console.log('[secretThreadSetup]', ...args)
  }

  const fetchTargets = async () => {
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

    return { myDeviceIds, peerDeviceIds, targets }
  }

  const attemptShareOnce = async (attempt: number) => {
    const { myDeviceIds, peerDeviceIds, targets } = await fetchTargets()
    log('share attempt', { attempt, threadId, peerUserId, localDeviceId, myDeviceIds, peerDeviceIds, targetsCount: targets.length })
    if (targets.length === 0) return { envelopes: 0, noPrekeys: 0, otherErrors: 0 }

    let noPrekeys = 0
    let otherErrors = 0
    const envelopes: any[] = []
    for (const toDeviceId of targets) {
      try {
        const env = await createEncryptedKeyPackageToDevice({
          toDeviceId,
          kind: 'thread_key',
          payload: { threadId, key: keyRec.key },
          ttlSeconds: 60 * 60,
        })
        envelopes.push(env)
      } catch (err: any) {
        const msg = String(err?.response?.data?.message ?? err?.message ?? '')
        if (String(err?.response?.status ?? '') === '404' && msg.toLowerCase().includes('prekeys')) {
          noPrekeys += 1
        } else {
          otherErrors += 1
        }
        log('share: device failed', { toDeviceId, status: err?.response?.status, message: msg })
      }
    }

    const batches = await chunk(envelopes, 50)
    for (const batch of batches) {
      if (!batch.length) continue
      await api.post('/secret/send', { messages: batch })
    }
    log('share result', { attempt, envelopes: envelopes.length, noPrekeys, otherErrors })
    return { envelopes: envelopes.length, noPrekeys, otherErrors }
  }

  // Best-effort retries: helps when peer device publishes prekeys slightly позже.
  const r1 = await attemptShareOnce(1)
  if (r1.envelopes > 0) return
  if (r1.noPrekeys > 0) {
    await new Promise((r) => setTimeout(r, 8_000))
    const r2 = await attemptShareOnce(2)
    if (r2.envelopes > 0) return
    await new Promise((r) => setTimeout(r, 25_000))
    await attemptShareOnce(3)
  }
}

