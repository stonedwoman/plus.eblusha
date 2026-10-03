import { api } from '../../utils/api'
import { ensureDeviceBootstrap, forcePublishPrekeys, getStoredDeviceInfo } from '../device/deviceManager'
import { createAndShareSecretThreadKey } from './secretThreadSetup'
import { sendSecretControl } from './secretControl'
import { hasSecretThreadKey } from './secretThreadKeyStore'

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

export async function requestSecretThreadKeyResend(
  threadId: string,
  peerUserId: string,
  opts?: { includeOwnDevices?: boolean },
): Promise<void> {
  const boot = await ensureDeviceBootstrap()
  const requesterDeviceId = boot?.deviceId ?? getStoredDeviceInfo()?.deviceId ?? null
  if (!requesterDeviceId) throw new Error('DEVICE_NOT_READY')

  // Best-effort: send request to a few peer devices; whichever has the key can respond.
  const bundlesResp = await api.get('/e2ee/prekeys/bundles', { params: { userId: peerUserId } })
  const peerDeviceIds = ((bundlesResp.data?.bundles ?? []) as any[])
    .map((b) => String(b?.deviceId ?? '').trim())
    .filter(Boolean)
    .slice(0, 3)

  // W-H02: создателю без ключа ключ отдают его же устройства (там он был выпущен) — их спрашиваем тоже.
  let ownDeviceIds: string[] = []
  if (opts?.includeOwnDevices) {
    try {
      const mine = await api.get('/devices')
      ownDeviceIds = ((mine.data?.devices ?? []) as any[])
        .filter((d) => !d?.revokedAt)
        .map((d) => String(d?.id ?? '').trim())
        .filter((id) => !!id && id !== requesterDeviceId)
        .slice(0, 10)
    } catch {
      ownDeviceIds = []
    }
  }

  const targets = Array.from(new Set([...ownDeviceIds, ...peerDeviceIds]))
  if (!targets.length) throw new Error('NO_PEER_TARGETS')

  await Promise.all(
    targets.map((toDeviceId) =>
      sendSecretControl(
        toDeviceId,
        { type: 'key_request', threadId, requesterDeviceId, fromDeviceId: requesterDeviceId, ts: Date.now() },
        { ttlSeconds: 10 * 60 },
      ).catch((e) => {
        if (secretDebugEnabled()) {
          // eslint-disable-next-line no-console
          console.warn('[secretChatFix] key_request failed', { toDeviceId, message: String((e as any)?.message ?? e) })
        }
      }),
    ),
  )
}

export async function fixSecretChat(opts: { threadId: string; peerUserId: string; amCreator: boolean }): Promise<void> {
  await ensureDeviceBootstrap()
  await forcePublishPrekeys({ reason: 'fix_secret_chat' })
  if (opts.amCreator && hasSecretThreadKey(opts.threadId)) {
    await createAndShareSecretThreadKey(opts.threadId, opts.peerUserId)
  } else {
    // W-H02: у кого ключа нет (в том числе у создателя на новом устройстве) — просим, а не выпускаем.
    await requestSecretThreadKeyResend(opts.threadId, opts.peerUserId, { includeOwnDevices: true })
  }
}

declare global {
  interface Window {
    __ebFixSecretChat?: (threadId: string, peerUserId: string, amCreator: boolean) => Promise<void>
  }
}
// Отладочный хук — только в dev-сборке (W-H02).
if (typeof window !== 'undefined' && !!(import.meta as any).env?.DEV) {
  if (!(window as any).__ebFixSecretChat) {
    ;(window as any).__ebFixSecretChat = (threadId: string, peerUserId: string, amCreator: boolean) =>
      fixSecretChat({ threadId, peerUserId, amCreator })
  }
}

