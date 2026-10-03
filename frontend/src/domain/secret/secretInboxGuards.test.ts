import { describe, expect, it } from 'vitest'
import nacl from 'tweetnacl'
import { bytesToBase64 } from '../../utils/base64'
import {
  canForwardFromConversation,
  decideLinkDeviceJoin,
  sameKeyBytes,
  verifyDeviceLinkKeys,
  verifyKeyReceipt,
  verifyKeyRequest,
  verifyThreadKeyPackage,
  type InboxLookups,
  type MyDevice,
} from './secretInboxGuards'

const ME = 'user-me'
const PEER = 'user-peer'
const STRANGER = 'user-stranger'
const T = 'thread-1'
const KEY = bytesToBase64(nacl.randomBytes(32))

function lookups(over: Partial<{ threads: Record<string, string[] | null>; mine: MyDevice[]; bundles: Record<string, string[]>; fail: boolean }> = {}): InboxLookups {
  const threads = over.threads ?? { [T]: [ME, PEER] }
  const mine = over.mine ?? [
    { id: 'my-d1', userId: ME, publicKey: 'AAAA', identityPublicKey: null },
    { id: 'my-old', userId: ME, revokedAt: '2026-10-01T00:00:00Z', publicKey: 'BBBB' },
  ]
  const bundles = over.bundles ?? { [PEER]: ['peer-d1', 'peer-d2'], [STRANGER]: ['str-d1'] }
  return {
    async threadParticipants(id) {
      if (over.fail) throw new Error('network')
      return id in threads ? threads[id]! : null
    },
    async myDevices() {
      if (over.fail) throw new Error('network')
      return mine
    },
    async userLiveDeviceIds(uid) {
      if (over.fail) throw new Error('network')
      return bundles[uid] ?? []
    },
  }
}

const tk = (senderUserId: string, headerThread: string | null, payload: any = { threadId: T, key: KEY }, kind = 'thread_key') => ({
  item: { senderUserId, headerJson: { kind: 'key_package', packageKind: 'thread_key', ...(headerThread ? { threadId: headerThread } : {}) } },
  attempt: { kind, payload },
})

describe('W-H01 verifyThreadKeyPackage', () => {
  it('участник треда — ключ принимается', async () => {
    const { item, attempt } = tk(PEER, T)
    expect(await verifyThreadKeyPackage(item, attempt, lookups())).toEqual({ ok: true, threadId: T, key: KEY })
  })
  it('посторонний (не участник треда из payload) — отказ без повтора', async () => {
    const { item, attempt } = tk(STRANGER, T)
    expect(await verifyThreadKeyPackage(item, attempt, lookups())).toMatchObject({ ok: false, reason: 'sender_not_participant', retry: false })
  })
  it('тред заголовка не совпадает с тредом payload (подмена треда) — отказ', async () => {
    const { item, attempt } = tk(PEER, 'thread-other')
    expect(await verifyThreadKeyPackage(item, attempt, lookups())).toMatchObject({ ok: false, reason: 'thread_mismatch' })
  })
  it('легаси без threadId в заголовке (Б1) — НЕ отказ: тред из payload, проверка членства по нему', async () => {
    const { item, attempt } = tk(PEER, null)
    expect(await verifyThreadKeyPackage(item, attempt, lookups())).toMatchObject({ ok: true, threadId: T })
    const s = tk(STRANGER, null)
    expect(await verifyThreadKeyPackage(s.item, s.attempt, lookups())).toMatchObject({ ok: false, reason: 'sender_not_participant' })
  })
  it('внутри пакета другой вид (device_link_keys под заголовком thread_key) — отказ', async () => {
    const { item, attempt } = tk(PEER, T, { threadId: T, key: KEY }, 'device_link_keys')
    expect(await verifyThreadKeyPackage(item, attempt, lookups())).toMatchObject({ ok: false, reason: 'kind_mismatch' })
  })
  it('ключ не 32 байта — отказ', async () => {
    const { item, attempt } = tk(PEER, T, { threadId: T, key: bytesToBase64(nacl.randomBytes(16)) })
    expect(await verifyThreadKeyPackage(item, attempt, lookups())).toMatchObject({ ok: false, reason: 'bad_key' })
  })
  it('тред нам неизвестен — отказ без повтора; сбой сети — повтор (без ack)', async () => {
    const { item, attempt } = tk(PEER, 'thread-x', { threadId: 'thread-x', key: KEY })
    expect(await verifyThreadKeyPackage(item, attempt, lookups())).toMatchObject({ ok: false, reason: 'unknown_thread', retry: false })
    const ok = tk(PEER, T)
    expect(await verifyThreadKeyPackage(ok.item, ok.attempt, lookups({ fail: true }))).toMatchObject({ ok: false, retry: true })
  })
})

describe('W-H03 verifyKeyRequest (key_request / key_resend_request)', () => {
  const req = (senderUserId: string, requesterDeviceId: string, extra: any = {}) => ({
    senderUserId,
    headerJson: { kind: 'control', type: 'key_request', threadId: T, requesterDeviceId, ...extra },
  })
  it('устройство собеседника-участника — отвечаем этому устройству', async () => {
    expect(await verifyKeyRequest(req(PEER, 'peer-d2'), lookups())).toEqual({ ok: true, threadId: T, toDeviceId: 'peer-d2' })
  })
  it('своё живое устройство — да; своё отозванное — нет', async () => {
    expect(await verifyKeyRequest(req(ME, 'my-d1'), lookups())).toMatchObject({ ok: true })
    expect(await verifyKeyRequest(req(ME, 'my-old'), lookups())).toMatchObject({ ok: false, reason: 'device_not_senders' })
  })
  it('посторонний просит ключ на своё устройство — отказ (ключ не уходит)', async () => {
    expect(await verifyKeyRequest(req(STRANGER, 'str-d1'), lookups())).toMatchObject({ ok: false, reason: 'sender_not_participant' })
  })
  it('участник просит ключ на ЧУЖОЕ устройство — отказ', async () => {
    expect(await verifyKeyRequest(req(PEER, 'str-d1'), lookups())).toMatchObject({ ok: false, reason: 'device_not_senders' })
  })
  it('requesterUserId в заголовке не совпал с отправителем по серверу — отказ', async () => {
    expect(await verifyKeyRequest(req(PEER, 'peer-d1', { requesterUserId: ME }), lookups())).toMatchObject({ ok: false, reason: 'requester_mismatch' })
  })
})

describe('W-H07/X2 verifyKeyReceipt', () => {
  const rc = (senderUserId: string, fromDeviceId: string) => ({ senderUserId, headerJson: { kind: 'control', type: 'key_receipt', threadId: T, fromDeviceId } })
  it('от устройства участника — засчитываем', async () => {
    expect(await verifyKeyReceipt(rc(PEER, 'peer-d1'), lookups())).toEqual({ ok: true, threadId: T, fromDeviceId: 'peer-d1' })
  })
  it('от постороннего или с чужим fromDeviceId — нет', async () => {
    expect(await verifyKeyReceipt(rc(STRANGER, 'str-d1'), lookups())).toMatchObject({ ok: false })
    expect(await verifyKeyReceipt(rc(PEER, 'my-d1'), lookups())).toMatchObject({ ok: false, reason: 'device_not_senders' })
  })
})

describe('W-X4 verifyDeviceLinkKeys', () => {
  const idPub = nacl.box.keyPair().publicKey
  const std = btoa(String.fromCharCode(...idPub)) // обычный base64 (как пишут Android/iOS)
  const url = bytesToBase64(idPub) // base64url (как веб)
  const mine: MyDevice[] = [
    { id: 'my-d1', userId: ME, publicKey: std, identityPublicKey: std },
    { id: 'my-old', userId: ME, revokedAt: '2026-10-01', publicKey: std },
  ]
  const dl = (senderUserId: string, initiatorDeviceId: string, initiatorIdentityKey: string) => ({
    senderUserId,
    headerJson: { kind: 'key_package', packageKind: 'device_link_keys', initiatorDeviceId, initiatorIdentityKey },
  })
  it('своё живое устройство с его зарегистрированным ключом (base64url против base64) — принимаем', async () => {
    expect(await verifyDeviceLinkKeys(dl(ME, 'my-d1', url), { kind: 'device_link_keys' }, lookups({ mine }))).toEqual({ ok: true })
  })
  it('чужой аккаунт, подставивший id моего устройства, — отказ', async () => {
    expect(await verifyDeviceLinkKeys(dl(STRANGER, 'my-d1', url), { kind: 'device_link_keys' }, lookups({ mine }))).toMatchObject({ ok: false, reason: 'not_my_account' })
  })
  it('ключ инициатора не совпал с зарегистрированным — отказ', async () => {
    const other = bytesToBase64(nacl.box.keyPair().publicKey)
    expect(await verifyDeviceLinkKeys(dl(ME, 'my-d1', other), { kind: 'device_link_keys' }, lookups({ mine }))).toMatchObject({ ok: false, reason: 'identity_mismatch' })
  })
  it('отозванное устройство — отказ', async () => {
    expect(await verifyDeviceLinkKeys(dl(ME, 'my-old', url), { kind: 'device_link_keys' }, lookups({ mine }))).toMatchObject({ ok: false, reason: 'not_my_live_device' })
  })
  it('sameKeyBytes сравнивает байты, а не строки', () => {
    expect(sameKeyBytes(std, url)).toBe(true)
    expect(sameKeyBytes(std, bytesToBase64(nacl.randomBytes(32)))).toBe(false)
  })
})

describe('X3/Б8 decideLinkDeviceJoin (веб и Electron)', () => {
  const join = (senderUserId: string, requesterDeviceId: string) => ({
    senderUserId,
    headerJson: { kind: 'link_device_join', v: 1, requesterDeviceId, token: 't', code: '12345678' },
  })
  it('чужой аккаунт с id МОЕГО устройства и без приглашения — ack сразу (раньше висел до 7 суток и клинил инбокс)', async () => {
    expect(await decideLinkDeviceJoin(join(STRANGER, 'my-d1'), false, lookups())).toEqual({ action: 'ack', reason: 'not_my_account' })
  })
  it('чужой аккаунт с id моего устройства и подходящим приглашением — ack, ключи не отдаются', async () => {
    expect(await decideLinkDeviceJoin(join(STRANGER, 'my-d1'), true, lookups())).toMatchObject({ action: 'ack' })
  })
  it('чужой по сессии — ack без запроса GET /devices', async () => {
    let calls = 0
    const lk = lookups()
    const counted: InboxLookups = { ...lk, myDevices: async () => { calls += 1; return lk.myDevices() } }
    expect(await decideLinkDeviceJoin(join(STRANGER, 'my-d1'), false, counted, ME)).toEqual({ action: 'ack', reason: 'not_my_account' })
    expect(calls).toBe(0)
  })
  it('свой аккаунт, своё живое устройство, приглашения нет — wait (не ack, доживёт TTL)', async () => {
    expect(await decideLinkDeviceJoin(join(ME, 'my-d1'), false, lookups(), ME)).toEqual({ action: 'wait', reason: 'no_invite' })
  })
  it('свой аккаунт, своё живое устройство, приглашение есть — proceed', async () => {
    expect(await decideLinkDeviceJoin(join(ME, 'my-d1'), true, lookups(), ME)).toEqual({ action: 'proceed', requesterDeviceId: 'my-d1' })
  })
  it('свой аккаунт, но устройство отозвано или не моё — ack', async () => {
    expect(await decideLinkDeviceJoin(join(ME, 'my-old'), true, lookups())).toEqual({ action: 'ack', reason: 'not_my_live_device' })
    expect(await decideLinkDeviceJoin(join(ME, 'peer-d1'), false, lookups())).toEqual({ action: 'ack', reason: 'not_my_live_device' })
  })
  it('без requesterDeviceId — ack; сбой сети при проверке своего — retry (не ack)', async () => {
    expect(await decideLinkDeviceJoin({ senderUserId: ME, headerJson: { kind: 'link_device_join' } }, false, lookups())).toEqual({ action: 'ack', reason: 'bad_request' })
    expect(await decideLinkDeviceJoin(join(ME, 'my-d1'), true, lookups({ fail: true }), ME)).toEqual({ action: 'retry', reason: 'lookup_failed' })
  })
})

describe('W-X6 пересылка из секретки', () => {
  it('из V2-секретки и легаси-секретки — нельзя; из облака — можно', () => {
    expect(canForwardFromConversation({ type: 'SECRET', isSecret: true })).toBe(false)
    expect(canForwardFromConversation({ type: 'CLOUD', isSecret: true })).toBe(false)
    expect(canForwardFromConversation({ type: 'CLOUD', isSecret: false })).toBe(true)
    expect(canForwardFromConversation(null)).toBe(false)
  })
})
