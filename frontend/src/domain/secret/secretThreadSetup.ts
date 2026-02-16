import { api } from '../../utils/api'
import { ensureSecretThreadKey } from './secretThreadKeyStore'
import { createEncryptedKeyPackageToDevice } from './secretKeyPackages'
import { getStoredDeviceInfo } from '../device/deviceManager'
import { filterUnackedTargets, getPendingAttempts, markKeyShareSent } from './secretKeyShareState'
import { clientLog } from './secretClientLog'

type ShareRootCause = 'NO_TARGETS' | 'NO_PREKEYS' | 'SEND_FAILED' | 'CLAIM_FAILED'

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

function classifyShareError(err: any): { rootCause: ShareRootCause; status?: number; message: string } {
  const status = typeof err?.response?.status === 'number' ? err.response.status : undefined
  const message = String(err?.response?.data?.message ?? err?.message ?? '')
  if (status === 404 && message.toLowerCase().includes('prekey')) return { rootCause: 'NO_PREKEYS', status, message }
  if (status && status >= 400) return { rootCause: 'CLAIM_FAILED', status, message }
  return { rootCause: 'CLAIM_FAILED', status, message }
}

function backoffMs(attempt: number): number {
  // attempt: 1..N
  const steps = [0, 5_000, 15_000, 45_000, 90_000]
  return steps[Math.min(Math.max(attempt, 1), steps.length) - 1] ?? 90_000
}

const scheduledResends = new Map<string, number[]>()

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

  const attemptShareDevices = async (attempt: number, targetDeviceIds: string[]) => {
    if (!targetDeviceIds.length) return { envelopes: 0, failedNoPrekeys: [] as string[], failedOther: [] as string[] }
    log('share attempt', { attempt, threadId, peerUserId, localDeviceId, targetsCount: targetDeviceIds.length, targets: targetDeviceIds })
    clientLog('secretThreadSetup', 'info', 'share attempt', { threadId, data: { attempt, targetsCount: targetDeviceIds.length } })

    const envelopes: any[] = []
    const byMsgId = new Map<string, string>()
    const failedNoPrekeys: string[] = []
    const failedOther: string[] = []

    for (const toDeviceId of targetDeviceIds) {
      try {
        const env = await createEncryptedKeyPackageToDevice({
          toDeviceId,
          kind: 'thread_key',
          payload: { threadId, key: keyRec.key },
          ttlSeconds: 60 * 60,
        })
        envelopes.push(env)
        byMsgId.set(String(env.msgId), toDeviceId)
        markKeyShareSent(threadId, toDeviceId, String(env.msgId))
        log('claim ok', { toDeviceId, msgId: env.msgId, prekeyId: env?.headerJson?.prekeyId })
        clientLog('secretThreadSetup', 'info', 'claim ok', { threadId, msgId: String(env.msgId), data: { toDeviceId, prekeyId: env?.headerJson?.prekeyId } })
      } catch (err: any) {
        const info = classifyShareError(err)
        if (info.rootCause === 'NO_PREKEYS') failedNoPrekeys.push(toDeviceId)
        else failedOther.push(toDeviceId)
        log('claim failed', { toDeviceId, rootCause: info.rootCause, status: info.status, message: info.message })
        clientLog('secretThreadSetup', 'warn', 'claim failed', { threadId, rootCause: info.rootCause, data: { toDeviceId, status: info.status, message: info.message } })
      }
    }

    // Send envelopes in batches and log delivery per device
    let sent = 0
    try {
      const batches = await chunk(envelopes, 50)
      for (const batch of batches) {
        if (!batch.length) continue
        const resp = await api.post('/secret/send', { messages: batch })
        const results = (resp.data?.results ?? []) as Array<any>
        for (const r of results) {
          const msgId = String(r?.msgId ?? '').trim()
          const toDeviceId = msgId ? (byMsgId.get(msgId) ?? null) : null
          if (!msgId || !toDeviceId) continue
          log('send result', { toDeviceId, msgId, inserted: !!r?.inserted, skippedSeen: !!r?.skippedSeen })
          clientLog('secretThreadSetup', 'info', 'send result', { threadId, msgId, data: { toDeviceId, inserted: !!r?.inserted, skippedSeen: !!r?.skippedSeen } })
        }
        sent += batch.length
      }
    } catch (err: any) {
      const message = String(err?.response?.data?.message ?? err?.message ?? '')
      log('send failed', { attempt, sentSoFar: sent, message })
      clientLog('secretThreadSetup', 'error', 'send failed', { threadId, data: { attempt, sentSoFar: sent, message } })
    }

    return { envelopes: envelopes.length, failedNoPrekeys, failedOther }
  }

  const { myDeviceIds, peerDeviceIds, targets } = await fetchTargets()
  log('targets', { threadId, peerUserId, localDeviceId, myDeviceIds, peerDeviceIds, targetsCount: targets.length })
  if (!targets.length) {
    log('ROOT_CAUSE=NO_TARGETS', { threadId })
    return
  }

  // Retry only devices that reported "No prekeys available"
  let pending = targets.slice()
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const wait = backoffMs(attempt)
    if (wait) await new Promise((r) => setTimeout(r, wait))
    const r = await attemptShareDevices(attempt, pending)
    pending = r.failedNoPrekeys
    if (!pending.length) break
  }

  if (pending.length) {
    log('ROOT_CAUSE=NO_PREKEYS', { threadId, pending })
    clientLog('secretThreadSetup', 'warn', 'ROOT_CAUSE=NO_PREKEYS', { threadId, rootCause: 'NO_PREKEYS', data: { pending } })
  }

  // Hard reliability: schedule automatic resends for devices that didn't confirm import.
  // This addresses OPK_SECRET_MISS / decrypt failures / transient notify/poll issues without user action.
  try {
    if (!scheduledResends.has(threadId)) {
      const timers: number[] = []
      const schedule = (delayMs: number, tag: string) => {
        const t = window.setTimeout(async () => {
          try {
            const { targets: allTargets } = await fetchTargets()
            const unacked = filterUnackedTargets(threadId, allTargets).filter((d) => getPendingAttempts(threadId, d) < 4)
            if (!unacked.length) return
            log('auto-resend', { tag, threadId, unackedCount: unacked.length, unacked })
            clientLog('secretThreadSetup', 'info', 'auto-resend', { threadId, data: { tag, unackedCount: unacked.length, unacked } })
            await attemptShareDevices(99, unacked)
          } catch (e: any) {
            log('auto-resend failed', { tag, message: String(e?.message ?? e) })
            clientLog('secretThreadSetup', 'warn', 'auto-resend failed', { threadId, data: { tag, message: String(e?.message ?? e) } })
          }
        }, delayMs)
        timers.push(t)
      }
      schedule(12_000, 't+12s')
      schedule(24_000, 't+24s')
      scheduledResends.set(threadId, timers)
    }
  } catch {}
}

// Dev helper: allow manual resend without exposing UI banners.
declare global {
  interface Window {
    __ebResendSecretThreadKey?: (threadId: string, peerUserId: string) => Promise<void>
  }
}
if (typeof window !== 'undefined') {
  if (!(window as any).__ebResendSecretThreadKey) {
    ;(window as any).__ebResendSecretThreadKey = (threadId: string, peerUserId: string) =>
      createAndShareSecretThreadKey(threadId, peerUserId)
  }
}

