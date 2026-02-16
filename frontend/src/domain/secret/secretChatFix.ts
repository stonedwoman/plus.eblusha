import { api } from '../../utils/api'
import { ensureDeviceBootstrap, forcePublishPrekeys, getStoredDeviceInfo } from '../device/deviceManager'
import { createAndShareSecretThreadKey } from './secretThreadSetup'
import { sendSecretControl } from './secretControl'

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

export async function requestSecretThreadKeyResend(threadId: string, peerUserId: string): Promise<void> {
  const boot = await ensureDeviceBootstrap()
  const requesterDeviceId = boot?.deviceId ?? getStoredDeviceInfo()?.deviceId ?? null
  if (!requesterDeviceId) throw new Error('DEVICE_NOT_READY')

  // Best-effort: send request to a few peer devices; whichever has the key can respond.
  const bundlesResp = await api.get('/e2ee/prekeys/bundles', { params: { userId: peerUserId } })
  const peerDeviceIds = ((bundlesResp.data?.bundles ?? []) as any[])
    .map((b) => String(b?.deviceId ?? '').trim())
    .filter(Boolean)
    .slice(0, 3)

  if (!peerDeviceIds.length) throw new Error('NO_PEER_TARGETS')

  await Promise.all(
    peerDeviceIds.map((toDeviceId) =>
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
  if (opts.amCreator) {
    await createAndShareSecretThreadKey(opts.threadId, opts.peerUserId)
  } else {
    await requestSecretThreadKeyResend(opts.threadId, opts.peerUserId)
  }
}

declare global {
  interface Window {
    __ebFixSecretChat?: (threadId: string, peerUserId: string, amCreator: boolean) => Promise<void>
  }
}
if (typeof window !== 'undefined') {
  if (!(window as any).__ebFixSecretChat) {
    ;(window as any).__ebFixSecretChat = (threadId: string, peerUserId: string, amCreator: boolean) =>
      fixSecretChat({ threadId, peerUserId, amCreator })
  }
}

