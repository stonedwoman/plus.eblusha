/**
 * Проверки входящих секретных конвертов на вебе (W-H01, W-H03, W-H07/X2, W-X4).
 *
 * Чему верим. `item.senderUserId` ставит СЕРВЕР из авторизации отправителя — это единственное
 * поле, которое клиент не может подделать. Всё, что в `headerJson` (initiatorDeviceId,
 * requesterDeviceId, fromDeviceId, threadId) пишет отправитель — сверяем с тем, что знаем сами:
 * участники треда (GET /conversations), свои живые устройства (GET /devices), живые устройства
 * собеседника (GET /e2ee/prekeys/bundles). Ключи и шифротекст сервер по-прежнему не видит —
 * E2EE не меняется, это только отказ принимать/выдавать ключи кому не следует.
 *
 * Правка скептика Б1: у старых веб-клиентов (до 2026-02) `thread_key` шёл БЕЗ `threadId` в
 * открытом заголовке. Отказ «нет threadId в заголовке» НЕ вводим: тред берём из payload, а если
 * заголовок его несёт — он обязан совпасть с payload.
 *
 * Результат проверки: ok — действовать; {ok:false, retry:false} — подтвердить (ack) и выбросить;
 * {ok:false, retry:true} — не удалось проверить (сеть) — не подтверждать, разберём на следующем pull.
 */
import { base64ToBytes } from '../../utils/base64'

export type GuardFail = { ok: false; reason: string; retry: boolean }

export type MyDevice = { id: string; userId?: string | null; revokedAt?: unknown; publicKey?: string | null; identityPublicKey?: string | null }

export type InboxLookups = {
  /** Участники треда (userId) или null, если такого треда у нас нет (не участник / удалён). Бросает при сбое сети. */
  threadParticipants(threadId: string): Promise<string[] | null>
  /** Мои устройства (GET /devices) — вместе с отозванными (поле revokedAt). Бросает при сбое сети. */
  myDevices(): Promise<MyDevice[]>
  /** Живые устройства пользователя (GET /e2ee/prekeys/bundles). Бросает при сбое сети. */
  userLiveDeviceIds(userId: string): Promise<string[]>
}

const fail = (reason: string, retry = false): GuardFail => ({ ok: false, reason, retry })

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

/** Сравнение ключей по байтам (base64 и base64url одного ключа равны), за постоянное время. */
export function sameKeyBytes(a: string, b: string): boolean {
  try {
    const x = base64ToBytes(str(a))
    const y = base64ToBytes(str(b))
    if (!x.length || x.length !== y.length) return false
    let diff = 0
    for (let i = 0; i < x.length; i += 1) diff |= x[i]! ^ y[i]!
    return diff === 0
  } catch {
    return false
  }
}

/** Устройство `deviceId` — живое устройство пользователя `userId` (своё — по GET /devices, чужое — по bundles). */
async function isLiveDeviceOf(userId: string, deviceId: string, lk: InboxLookups): Promise<boolean> {
  const mine = await lk.myDevices()
  const myUserId = mine.find((d) => str(d.userId))?.userId ?? null
  if (myUserId && userId === myUserId) {
    return mine.some((d) => str(d.id) === deviceId && !d.revokedAt)
  }
  const ids = await lk.userLiveDeviceIds(userId)
  return ids.includes(deviceId)
}

async function participantsOrFail(threadId: string, lk: InboxLookups): Promise<string[] | GuardFail> {
  try {
    const list = await lk.threadParticipants(threadId)
    if (!list) return fail('unknown_thread')
    return list
  } catch {
    return fail('lookup_failed', true)
  }
}

export type ThreadKeyVerdict = { ok: true; threadId: string; key: string } | GuardFail

/**
 * W-H01: импорт `thread_key`. Отправитель (senderUserId от сервера) обязан быть участником
 * треда из payload; тред заголовка (если он есть) — тем же; вид пакета внутри — `thread_key`;
 * ключ — 32 байта. Только после этого ключ можно ставить (или менять — автоматически, решение
 * владельца, но без потери прежнего: см. applyIncomingThreadKey).
 */
export async function verifyThreadKeyPackage(
  item: { senderUserId?: string | null; headerJson?: any },
  attempt: { kind: string; payload: any },
  lk: InboxLookups,
): Promise<ThreadKeyVerdict> {
  const header = item?.headerJson ?? {}
  const headerKind = str(header?.packageKind)
  if (attempt.kind !== 'thread_key' || (headerKind && headerKind !== 'thread_key')) return fail('kind_mismatch')
  const threadId = str(attempt.payload?.threadId)
  const key = str(attempt.payload?.key)
  if (!threadId || !key) return fail('bad_payload')
  try {
    if (base64ToBytes(key).length !== 32) return fail('bad_key')
  } catch {
    return fail('bad_key')
  }
  const headerThread = str(header?.threadId)
  if (headerThread && headerThread !== threadId) return fail('thread_mismatch')
  const sender = str(item?.senderUserId)
  if (!sender) return fail('no_sender')
  const members = await participantsOrFail(threadId, lk)
  if (!Array.isArray(members)) return members
  if (!members.includes(sender)) return fail('sender_not_participant')
  return { ok: true, threadId, key }
}

export type KeyRequestVerdict = { ok: true; threadId: string; toDeviceId: string } | GuardFail

/**
 * W-H03: `control/key_request` и `key_resend_request` — отдаём ключ треда только устройству,
 * которое принадлежит ОТПРАВИТЕЛЮ запроса (senderUserId от сервера), а он — участник треда.
 * `requesterUserId` из заголовка не используется как адресат; если он есть и не совпал с
 * senderUserId — запрос подделан. `senderDeviceId`/`fromDeviceId` запасным адресатом не служат (X8).
 */
export async function verifyKeyRequest(
  item: { senderUserId?: string | null; headerJson?: any },
  lk: InboxLookups,
): Promise<KeyRequestVerdict> {
  const header = item?.headerJson ?? {}
  const threadId = str(header?.threadId)
  const toDeviceId = str(header?.requesterDeviceId)
  const sender = str(item?.senderUserId)
  if (!threadId || !toDeviceId || !sender) return fail('bad_request')
  const claimedUser = str(header?.requesterUserId)
  if (claimedUser && claimedUser !== sender) return fail('requester_mismatch')
  const members = await participantsOrFail(threadId, lk)
  if (!Array.isArray(members)) return members
  if (!members.includes(sender)) return fail('sender_not_participant')
  try {
    if (!(await isLiveDeviceOf(sender, toDeviceId, lk))) return fail('device_not_senders')
  } catch {
    return fail('lookup_failed', true)
  }
  return { ok: true, threadId, toDeviceId }
}

export type KeyReceiptVerdict = { ok: true; threadId: string; fromDeviceId: string } | GuardFail

/** W-H07/X2: `control/key_receipt` засчитываем только от живого устройства участника треда. */
export async function verifyKeyReceipt(
  item: { senderUserId?: string | null; headerJson?: any },
  lk: InboxLookups,
): Promise<KeyReceiptVerdict> {
  const header = item?.headerJson ?? {}
  const threadId = str(header?.threadId)
  const fromDeviceId = str(header?.fromDeviceId)
  const sender = str(item?.senderUserId)
  if (!threadId || !fromDeviceId || !sender) return fail('bad_receipt')
  const members = await participantsOrFail(threadId, lk)
  if (!Array.isArray(members)) return members
  if (!members.includes(sender)) return fail('sender_not_participant')
  try {
    if (!(await isLiveDeviceOf(sender, fromDeviceId, lk))) return fail('device_not_senders')
  } catch {
    return fail('lookup_failed', true)
  }
  return { ok: true, threadId, fromDeviceId }
}

export type DeviceLinkVerdict = { ok: true } | GuardFail

/**
 * W-X4: `device_link_keys` (все ключи секреток!) принимаем только от СВОЕГО живого устройства:
 * senderUserId (сервер) == я; initiatorDeviceId — моё неотозванное устройство; initiatorIdentityKey
 * по БАЙТАМ совпадает с его зарегистрированным ключом. Раньше хватало, чтобы initiatorDeviceId
 * (простое поле заголовка, id всех устройств видны через bundles) был в моём списке.
 */
export async function verifyDeviceLinkKeys(
  item: { senderUserId?: string | null; headerJson?: any },
  attempt: { kind: string },
  lk: InboxLookups,
): Promise<DeviceLinkVerdict> {
  const header = item?.headerJson ?? {}
  const headerKind = str(header?.packageKind)
  if (attempt.kind !== 'device_link_keys' || (headerKind && headerKind !== 'device_link_keys')) return fail('kind_mismatch')
  let mine: MyDevice[]
  try {
    mine = await lk.myDevices()
  } catch {
    return fail('lookup_failed', true)
  }
  const myUserId = str(mine.find((d) => str(d.userId))?.userId)
  const sender = str(item?.senderUserId)
  if (!myUserId || !sender || sender !== myUserId) return fail('not_my_account')
  const initiatorDeviceId = str(header?.initiatorDeviceId)
  const dev = mine.find((d) => str(d.id) === initiatorDeviceId)
  if (!dev || dev.revokedAt) return fail('not_my_live_device')
  const identity = str(header?.initiatorIdentityKey)
  const registered = [str(dev.identityPublicKey), str(dev.publicKey)].filter(Boolean)
  if (!identity || !registered.some((k) => sameKeyBytes(k, identity))) return fail('identity_mismatch')
  return { ok: true }
}

/** Секретку (V2 type=SECRET или легаси isSecret) нельзя пересылать никуда (W-X6, как Android/iOS). */
export function canForwardFromConversation(conv: any): boolean {
  if (!conv) return false
  if (String(conv?.type ?? '').toUpperCase() === 'SECRET') return false
  if (conv?.isSecret) return false
  return true
}
