import { beforeEach, describe, expect, it, vi } from 'vitest'

// W-H02: «Восстановить» у создателя без ключа раньше выпускал НОВЫЙ ключ треда и рассылал его —
// у собеседника история становилась нечитаемой. Теперь ключ только запрашивается (key_request).
const posted: Array<{ url: string; body: any }> = []
vi.mock('../../utils/api', () => ({
  api: {
    get: vi.fn(async (url: string, cfg?: any) => {
      if (url === '/devices') return { data: { devices: [{ id: 'me-d1', userId: 'me' }, { id: 'me-d2', userId: 'me' }] } }
      if (url === '/e2ee/prekeys/bundles') return { data: { bundles: [{ deviceId: `${cfg?.params?.userId}-d1` }] } }
      return { data: {} }
    }),
    post: vi.fn(async (url: string, body: any) => {
      posted.push({ url, body })
      return { data: { results: [] } }
    }),
  },
}))
vi.mock('../device/deviceManager', () => ({
  ensureDeviceBootstrap: vi.fn(async () => ({ deviceId: 'me-d1', publicKey: 'x' })),
  getStoredDeviceInfo: vi.fn(() => ({ deviceId: 'me-d1', publicKey: 'x' })),
  forcePublishPrekeys: vi.fn(async () => {}),
  getIdentityKeyPair: vi.fn(() => null),
  getPrekeySecret: vi.fn(() => null),
}))

import { ensureCreatorThreadKeyAndShare } from './keyShare'
import { hasSecretThreadKey } from '../secret/secretThreadKeyStore'

function installLocalStorage() {
  const m = new Map<string, string>()
  ;(globalThis as any).localStorage = {
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
    clear: () => void m.clear(),
  }
}

describe('W-H02 ensureCreatorThreadKeyAndShare', () => {
  beforeEach(() => {
    installLocalStorage()
    posted.length = 0
  })

  it('создатель без ключа: новый ключ НЕ выпускается, ключ запрашивается у своих устройств и у собеседника', async () => {
    const r = await ensureCreatorThreadKeyAndShare({ threadId: 'thr-h02', peerUserId: 'peer' })
    expect(r.ok).toBe(false)
    expect(hasSecretThreadKey('thr-h02')).toBe(false)
    const sent = posted.filter((p) => p.url === '/secret/send').flatMap((p) => p.body?.messages ?? [])
    expect(sent.length).toBeGreaterThan(0)
    // ни одного пакета ключа — только просьбы key_request
    expect(sent.every((m: any) => m.headerJson?.kind === 'control' && m.headerJson?.type === 'key_request')).toBe(true)
    const targets = sent.map((m: any) => m.toDeviceId).sort()
    expect(targets).toEqual(['me-d2', 'peer-d1'])
  })
})
