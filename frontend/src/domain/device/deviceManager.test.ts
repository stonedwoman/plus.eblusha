import { beforeEach, describe, expect, it, vi } from 'vitest'

// W-H04 (OPK по счётчику сервера, без вечного потолка 200, чистка устаревших секретов) и
// W-X5 (отозванный id не перерегистрируется — ключи стираются, событие eb:device:revoked).
type ServerDevice = { id: string; userId: string; revokedAt: string | null; availablePrekeys: number }
const server: { devices: ServerDevice[]; posts: Array<{ url: string; body: any }> } = { devices: [], posts: [] }

vi.mock('../../utils/api', () => ({
  api: {
    get: vi.fn(async (url: string) => {
      if (url === '/devices') return { data: { devices: server.devices } }
      return { data: {} }
    }),
    post: vi.fn(async (url: string, body: any) => {
      server.posts.push({ url, body })
      if (/\/devices\/[^/]+\/prekeys$/.test(url)) {
        return { data: { insertedKeyIds: (body?.prekeys ?? []).map((p: any) => p.keyId) } }
      }
      return { data: {} }
    }),
  },
}))

import { ensureDeviceBootstrap, forcePublishPrekeys } from './deviceManager'

const INFO = 'eb_device_info_v1'
const SECRETS = 'eb_device_secret_v1'
let store: Map<string, string>

function installStorage() {
  store = new Map<string, string>()
  const ls = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => void store.clear(),
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    get length() {
      return store.size
    },
  }
  ;(globalThis as any).localStorage = ls
  const target = new EventTarget()
  ;(globalThis as any).window = Object.assign(target, { localStorage: ls, location: { search: '' } })
}

function seedDevice(prekeyCount: number, ageMs = 0) {
  store.set(INFO, JSON.stringify({ deviceId: 'dev-1', name: 'Браузер', platform: 'web', publicKey: 'PUB', registeredAt: 1 }))
  const prekeys: Record<string, string> = {}
  const createdAt: Record<string, number> = {}
  for (let i = 0; i < prekeyCount; i += 1) {
    prekeys[`pk-${i}`] = `secret-${i}`
    createdAt[`pk-${i}`] = Date.now() - ageMs - i
  }
  store.set(SECRETS, JSON.stringify({ deviceId: 'dev-1', identitySecret: 'SEC', prekeys, prekeyCreatedAt: createdAt }))
}
const storedPrekeyCount = () => Object.keys(JSON.parse(store.get(SECRETS) ?? '{"prekeys":{}}').prekeys ?? {}).length

describe('W-H04 публикация OPK по счётчику сервера', () => {
  beforeEach(() => {
    installStorage()
    server.posts.length = 0
  })

  it('200 локальных секретов, а на сервере 0 OPK — публикуем (раньше потолок 200 навсегда останавливал публикацию)', async () => {
    seedDevice(200)
    server.devices = [{ id: 'dev-1', userId: 'me', revokedAt: null, availablePrekeys: 0 }]
    await forcePublishPrekeys({ reason: 'test', count: 50, force: true })
    const pub = server.posts.filter((p) => p.url === '/devices/dev-1/prekeys')
    expect(pub.length).toBe(1)
    expect(pub[0]!.body.prekeys.length).toBe(50)
  })

  it('на сервере OPK у потолка — лишнего не генерируем', async () => {
    seedDevice(10)
    server.devices = [{ id: 'dev-1', userId: 'me', revokedAt: null, availablePrekeys: 240 }]
    await forcePublishPrekeys({ reason: 'test2', count: 50, force: true })
    const pub = server.posts.filter((p) => p.url === '/devices/dev-1/prekeys')
    expect(pub[0]?.body.prekeys.length).toBe(10)
  })

  it('секреты старше 14 суток вне окна «свежих» (доступно на сервере + 50) вычищаются', async () => {
    seedDevice(300, 20 * 24 * 60 * 60_000)
    server.devices = [{ id: 'dev-1', userId: 'me', revokedAt: null, availablePrekeys: 30 }]
    await forcePublishPrekeys({ reason: 'test3', count: 1, force: true })
    // окно 30+50=80 старых остаётся, +1 только что опубликованный
    expect(storedPrekeyCount()).toBe(81)
  })
})

describe('W-X5 отозванное устройство не воскрешается', () => {
  beforeEach(() => {
    installStorage()
    server.posts.length = 0
  })

  it('сервер показывает revokedAt нашего id → регистрации нет, ключи стёрты, событие eb:device:revoked', async () => {
    seedDevice(5)
    store.set('eb_secret_thread_keys_v1', JSON.stringify({ t1: { key: 'x', createdAt: 1, version: 1 } }))
    server.devices = [{ id: 'dev-1', userId: 'me', revokedAt: '2026-10-03T00:00:00Z', availablePrekeys: 0 }]
    let fired = 0
    ;(globalThis as any).window.addEventListener('eb:device:revoked', () => {
      fired += 1
    })
    const res = await ensureDeviceBootstrap({ forceRegister: true, skipReserveCheck: true })
    expect(res).toBeNull()
    expect(server.posts.some((p) => p.url === '/devices/register')).toBe(false)
    expect(store.has(INFO)).toBe(false)
    expect(store.has('eb_secret_thread_keys_v1')).toBe(false)
    expect(fired).toBe(1)
  })

  it('id не найден на сервере (восстановление БД) — самолечение перерегистрацией сохраняется', async () => {
    seedDevice(5)
    server.devices = []
    const res = await ensureDeviceBootstrap({ forceRegister: true, skipReserveCheck: true })
    expect(res?.deviceId).toBe('dev-1')
    expect(server.posts.some((p) => p.url === '/devices/register' && p.body?.deviceId === 'dev-1')).toBe(true)
  })
})
