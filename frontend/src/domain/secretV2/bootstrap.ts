import { ensureDeviceBootstrap, forcePublishPrekeys, getStoredDeviceInfo } from '../device/deviceManager'
import { type SecretReasonCode, markBootstrapReady } from './state'

export type BootstrapResult =
  | { ok: true; deviceId: string }
  | { ok: false; reasonCode: SecretReasonCode; message: string }

export async function ensureSecretBootstrap(threadId?: string): Promise<BootstrapResult> {
  try {
    const boot = await ensureDeviceBootstrap()
    const deviceId = String(boot?.deviceId ?? getStoredDeviceInfo()?.deviceId ?? '').trim()
    if (!deviceId) {
      if (threadId) markBootstrapReady(threadId, false)
      return { ok: false, reasonCode: 'BOOTSTRAP_FAILED', message: 'Device bootstrap failed' }
    }
    if (threadId) markBootstrapReady(threadId, true)
    return { ok: true, deviceId }
  } catch (e: any) {
    if (threadId) markBootstrapReady(threadId, false)
    return {
      ok: false,
      reasonCode: 'BOOTSTRAP_FAILED',
      message: String(e?.response?.data?.message ?? e?.message ?? 'Device bootstrap failed'),
    }
  }
}

export async function refreshSecretPrekeys(reason = 'refresh_secret_keys'): Promise<void> {
  await forcePublishPrekeys({ reason })
}

