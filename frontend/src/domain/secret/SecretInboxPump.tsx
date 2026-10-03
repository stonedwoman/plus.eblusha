import { useEffect, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { api } from '../../utils/api'
import { socket, connectSocket } from '../../core/realtime'
import { consumePrekeySecret, ensureDeviceBootstrap, forcePublishPrekeys } from '../device/deviceManager'
import { applyIncomingThreadKey, exportSecretThreadKeys, getSecretThreadKey, importSecretThreadKeys } from './secretThreadKeyStore'
import { transformSecretHistoryItemToMessage } from './secretThreadMessaging'
import { tryDecryptIncomingKeyPackage } from './secretKeyPackages'
import { sendSecretControl } from './secretControl'
import { markKeyReceipt } from './secretKeyShareState'
import { createEncryptedKeyPackageToDevice } from './secretKeyPackages'
import { clientLog } from './secretClientLog'
import { shareExistingSecretThreadKeyToDevice } from './secretThreadSetup'
import { getDefaultStorageAdapter } from '../../core/storage'
import { getDeviceLinkInvite, clearDeviceLinkInvite, inviteMatches } from '../device/deviceLinkInvite'
import {
  type InboxLookups,
  type MyDevice,
  decideLinkDeviceJoin,
  verifyDeviceLinkKeys,
  verifyKeyReceipt,
  verifyKeyRequest,
  verifyThreadKeyPackage,
} from './secretInboxGuards'
import { systemToast } from '../store/systemUiStore'
import { useAppStore } from '../store/appStore'

type InboxItem = {
  msgId: string
  threadId: string | null
  senderUserId?: string | null
  senderDeviceId?: string | null
  createdAt: string
  headerJson?: any
  ciphertext: string
  contentType?: string
  schemaVersion?: number
}

const RESEND_REQUEST_THROTTLE_MS = 30_000
const lastResendHandledAt = new Map<string, number>()
// H04: каждый prekeys_needed раньше публиковал +50 OPK без ограничений (шторм). Теперь не чаще
// раза в 30 с, а сколько публиковать — решает deviceManager по счётчику СЕРВЕРА.
const PREKEYS_NEEDED_THROTTLE_MS = 30_000
let lastPrekeysNeededAt = 0
const LINK_DEVICE_JOIN_THROTTLE_MS = 120_000
const lastLinkDeviceJoinSentAt = new Map<string, number>()

function secretDebugEnabled(): boolean {
  try {
    if (typeof window === 'undefined') return false
    const q = String(window.location?.search ?? '')
    if (q.includes('SECRET_DEBUG=1')) return true
    return storage.getItem('eb_secret_debug') === '1'
  } catch {
    return false
  }
}

function isBootstrapRepairableError(err: any): boolean {
  const status = typeof err?.response?.status === 'number' ? err.response.status : null
  const message = String(err?.response?.data?.message ?? err?.message ?? '').toLowerCase()
  if (status !== 400 && status !== 404) return false
  return message.includes('device') || message.includes('bootstrap')
}

type InboxAttemptRec = { count: number; firstAt: number; lastAt: number; rootCause?: string; prekeyId?: string }
const ATTEMPTS_KEY = 'eb_secret_inbox_attempts_v1'
const LAST_ROOT_CAUSE_KEY = 'eb_secret_last_root_cause_v1'
const ROOT_CAUSE_COUNTS_KEY = 'eb_secret_root_cause_counts_v1'
const ATTEMPT_TTL_MS = 30 * 60_000
const POISON_THRESHOLD = 20
const storage = getDefaultStorageAdapter()

function loadAttempts(): Record<string, InboxAttemptRec> {
  try {
    const raw = storage.getItem(ATTEMPTS_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as any
    if (!parsed || typeof parsed !== 'object') return {}
    return parsed
  } catch {
    return {}
  }
}
function saveAttempts(next: Record<string, InboxAttemptRec>) {
  try {
    storage.setItem(ATTEMPTS_KEY, JSON.stringify(next))
  } catch {}
}
function bumpAttempt(msgId: string, info?: { rootCause?: string; prekeyId?: string }) {
  const id = String(msgId ?? '').trim()
  if (!id) return { count: 0, poisoned: false }
  const now = Date.now()
  const store = loadAttempts()
  // cleanup
  for (const [k, v] of Object.entries(store)) {
    if (!v || typeof v !== 'object') {
      delete store[k]
      continue
    }
    const lastAt = typeof (v as any).lastAt === 'number' ? (v as any).lastAt : 0
    if (lastAt && now - lastAt > ATTEMPT_TTL_MS) delete store[k]
  }
  const prev = store[id]
  const next: InboxAttemptRec = {
    count: (prev?.count ?? 0) + 1,
    firstAt: prev?.firstAt ?? now,
    lastAt: now,
    ...(info?.rootCause ? { rootCause: info.rootCause } : {}),
    ...(info?.prekeyId ? { prekeyId: info.prekeyId } : {}),
  }
  store[id] = next
  saveAttempts(store)
  const poisoned = next.count > POISON_THRESHOLD || now - next.firstAt > ATTEMPT_TTL_MS
  return { count: next.count, poisoned }
}

function setLastRootCause(code: string, details?: Record<string, any>) {
  try {
    storage.setItem(LAST_ROOT_CAUSE_KEY, JSON.stringify({ code, at: Date.now(), ...(details ? { details } : {}) }))
  } catch {}
  try {
    const raw = storage.getItem(ROOT_CAUSE_COUNTS_KEY)
    const parsed = raw ? (JSON.parse(raw) as any) : {}
    const obj = parsed && typeof parsed === 'object' ? parsed : {}
    const prev = typeof obj[code] === 'number' ? obj[code] : 0
    obj[code] = prev + 1
    storage.setItem(ROOT_CAUSE_COUNTS_KEY, JSON.stringify(obj))
  } catch {}
}

/**
 * Справочники для проверок входящих (secretInboxGuards) на ОДНУ пачку pull: каждый запрос — не
 * чаще раза за пачку. Сбой сети пробрасывается — проверка вернёт retry (конверт не подтверждаем).
 */
function createInboxLookups(client: ReturnType<typeof useQueryClient>): InboxLookups {
  let devicesP: Promise<MyDevice[]> | null = null
  let conversationsP: Promise<any[]> | null = null
  const bundles = new Map<string, Promise<string[]>>()
  const participantsOf = (row: any): string[] =>
    ((row?.conversation?.participants ?? []) as any[])
      .map((p) => String(p?.user?.id ?? p?.userId ?? '').trim())
      .filter(Boolean)
  return {
    async threadParticipants(threadId: string) {
      const id = String(threadId ?? '').trim()
      if (!id) return null
      const cached = client.getQueryData(['conversations']) as any[] | undefined
      const hit = Array.isArray(cached) ? cached.find((r: any) => r?.conversation?.id === id) : null
      if (hit) return participantsOf(hit)
      if (!conversationsP) {
        conversationsP = api.get('/conversations').then((r) => (r.data?.conversations ?? []) as any[])
        conversationsP.catch(() => {
          conversationsP = null
        })
      }
      const rows = await conversationsP
      const row = rows.find((r: any) => r?.conversation?.id === id)
      return row ? participantsOf(row) : null
    },
    async myDevices() {
      if (!devicesP) {
        devicesP = api.get('/devices').then((r) => (r.data?.devices ?? []) as MyDevice[])
        devicesP.catch(() => {
          devicesP = null
        })
      }
      return devicesP
    },
    async userLiveDeviceIds(userId: string) {
      const uid = String(userId ?? '').trim()
      if (!uid) return []
      let p = bundles.get(uid)
      if (!p) {
        p = api
          .get('/e2ee/prekeys/bundles', { params: { userId: uid } })
          .then((r) => ((r.data?.bundles ?? []) as any[]).map((b) => String(b?.deviceId ?? '').trim()).filter(Boolean))
        bundles.set(uid, p)
        p.catch(() => bundles.delete(uid))
      }
      return p
    },
  }
}

function toMessageObject(threadId: string, item: InboxItem, decryptedContent: string | null) {
  const header = item.headerJson ?? {}
  const nonce = typeof header?.nonce === 'string' ? header.nonce : null
  const locked = decryptedContent == null
  return {
    id: item.msgId,
    conversationId: threadId,
    senderId: item.senderUserId ?? 'unknown',
    sender: { id: item.senderUserId ?? 'unknown' },
    type: 'TEXT',
    content: locked ? '🔒 Сообщение зашифровано' : decryptedContent,
    createdAt: item.createdAt,
    updatedAt: item.createdAt,
    metadata: {
      e2ee: {
        kind: 'ciphertext',
        version: 1,
        algorithm: 'xsalsa20_poly1305',
        ...(nonce ? { nonce } : {}),
        decrypted: !locked,
      },
      secretV2: {
        msgId: item.msgId,
        threadId,
        headerJson: item.headerJson ?? {},
        ciphertext: item.ciphertext,
        contentType: item.contentType ?? 'text',
        schemaVersion: item.schemaVersion ?? 1,
      },
    },
    attachments: [],
    reactions: [],
    receipts: [],
    deletedAt: null,
  }
}

export function SecretInboxPump() {
  const client = useQueryClient()
  const pullingRef = useRef(false)
  // A secret:notify that lands while a pull is in flight must not be dropped — queue ONE
  // trailing pull (dropping it used to leave delivery to the slow poll/history fallback).
  const pendingPullRef = useRef(false)
  const bootstrapReadyRef = useRef<Promise<any> | null>(null)
  const lastSelfHealAtRef = useRef<number>(0)
  const lastBootstrapRepairAtRef = useRef<number>(0)

  useEffect(() => {
    let mounted = true
    // Expose a best-effort manual pull hook for SecretEngine v2 hotfix loops.
    let pullNowFn: (() => Promise<void>) | null = null
    if (!bootstrapReadyRef.current) {
      bootstrapReadyRef.current = ensureDeviceBootstrap().catch((err) => {
        if (secretDebugEnabled()) {
          // eslint-disable-next-line no-console
          console.warn('[SecretInboxPump] ensureDeviceBootstrap failed', err)
        }
        return null
      })
    }

    const pullOnce = async () => {
      if (!mounted) return
      if (pullingRef.current) {
        pendingPullRef.current = true
        return
      }
      pullingRef.current = true
      try {
        // Ensure device keys exist before we attempt to decrypt key packages.
        const bootstrapRes = await (bootstrapReadyRef.current ?? Promise.resolve(null))
        const bootstrapReady = !!bootstrapRes
        if (!bootstrapReady) return

        const resp = await api.get('/secret/inbox/pull', {
          params: { limit: 50 },
          // A hung pull would freeze the pump behind pullingRef for the default 15 s axios
          // timeout, no-op'ing every 3.5 s tick meanwhile — cap it, the next tick retries.
          timeout: 5000,
          // Avoid conditional caching (If-None-Match → 304) for polling endpoints.
          headers: { 'Cache-Control': 'no-cache', Pragma: 'no-cache' },
        })
        const items = (resp.data?.messages ?? []) as InboxItem[]
        if (!items.length) return

        const ackIds: string[] = []
        // W-X9: секреты OPK снимаем только после подтверждённого ack (см. ниже).
        const consumeAfterAck: string[] = []
        const lookups = createInboxLookups(client)
        const myDeviceId = String((bootstrapRes as any)?.deviceId ?? '').trim()

        for (const item of items) {
          if (!item?.msgId) continue
          const header = item.headerJson ?? {}
          const isKeyPackage = header && typeof header === 'object' && String((header as any).kind ?? '') === 'key_package'
          const isControl = header && typeof header === 'object' && String((header as any).kind ?? '') === 'control'
          const isResendRequest =
            header && typeof header === 'object' && String((header as any).kind ?? '') === 'key_resend_request'
          const isPrekeysNeeded =
            header && typeof header === 'object' && String((header as any).kind ?? '') === 'prekeys_needed'
          const isLinkDeviceJoin =
            header && typeof header === 'object' && String((header as any).kind ?? '') === 'link_device_join'

          if (isLinkDeviceJoin) {
            // Запрос — это удалённая выгрузка всех ключей секреток, поэтому (decideLinkDeviceJoin):
            // 1) отправитель (senderUserId ставит сервер) — МОЙ аккаунт, иначе ack сразу: id моих
            //    устройств виден всем через /e2ee/prekeys/bundles, и чужой запрос «от моего
            //    устройства» без ack клинил бы инбокс до 7 суток (X3/Б8);
            // 2) устройство — моё и не отозвано, иначе ack;
            // 3) запрос предъявил token/код ЖИВОГО приглашения, показанного на этом устройстве
            //    (карточка «Добавить устройство»). Своё без приглашения — НЕ ack: конверт доживёт
            //    TTL и сработает, как только код покажут.
            const invite = getDeviceLinkInvite()
            const joinToken = String((header as any).token ?? '').trim()
            const joinCode = String((header as any).code ?? '').trim()
            const inviteOk = !!invite && (inviteMatches(invite, joinToken) || inviteMatches(invite, joinCode))
            const myUserIdHint = (() => {
              try {
                return String(useAppStore.getState().session?.user?.id ?? '').trim() || null
              } catch {
                return null
              }
            })()
            const decision = await decideLinkDeviceJoin(item, inviteOk, lookups, myUserIdHint)
            if (decision.action !== 'proceed') {
              clientLog('SecretInboxPump', 'warn', 'link_device_join rejected', {
                data: {
                  requesterDeviceId: String((header as any).requesterDeviceId ?? '').trim(),
                  inviteOk,
                  action: decision.action,
                  reason: decision.reason,
                },
              })
              if (decision.action === 'ack') ackIds.push(item.msgId)
              continue
            }
            const requesterDeviceId = decision.requesterDeviceId
            {
              const now = Date.now()
              const last = lastLinkDeviceJoinSentAt.get(requesterDeviceId) ?? 0
              if (now - last >= LINK_DEVICE_JOIN_THROTTLE_MS) {
                lastLinkDeviceJoinSentAt.set(requesterDeviceId, now)
                try {
                  const payload = { threadKeys: exportSecretThreadKeys() }
                  const env = await createEncryptedKeyPackageToDevice({
                    toDeviceId: requesterDeviceId,
                    kind: 'device_link_keys',
                    payload,
                    ttlSeconds: 60 * 60,
                  })
                  await api.post('/secret/send', { messages: [env] })
                  if (secretDebugEnabled()) {
                    // eslint-disable-next-line no-console
                    console.log('[SecretInboxPump] link_device_join: sent device_link_keys', {
                      requesterDeviceId,
                      msgId: env.msgId,
                    })
                  }
                  clientLog('SecretInboxPump', 'info', 'link_device_join: sent device_link_keys', {
                    data: { toDeviceId: requesterDeviceId, msgId: env.msgId },
                  })
                  try { clearDeviceLinkInvite() } catch {} // приглашение одноразовое
                  // Отдающая сторона показывает «устройство подключено» с ИМЕНЕМ устройства:
                  // имя знает только сервер, поэтому резолвим его по списку своих устройств.
                  try {
                    const threadCount = Object.keys(payload?.threadKeys?.keys ?? {}).length
                    let deviceName = ''
                    try {
                      const found = (await lookups.myDevices()).find(
                        (d) => String(d?.id ?? '').trim() === requesterDeviceId,
                      ) as any
                      deviceName = String(found?.name ?? '').trim()
                    } catch {}
                    window.dispatchEvent(
                      new CustomEvent('eb:deviceLinkedOut', {
                        detail: { deviceId: requesterDeviceId, name: deviceName, threadCount },
                      }),
                    )
                  } catch {}
                  const token = String((header as any).token ?? '').trim()
                  if (token) {
                    try {
                      await api.post('/devices/pairing/consume', { token })
                    } catch {}
                  }
                } catch (e: any) {
                  lastLinkDeviceJoinSentAt.delete(requesterDeviceId)
                  if (secretDebugEnabled()) {
                    // eslint-disable-next-line no-console
                    console.warn('[SecretInboxPump] link_device_join: failed to send keys', {
                      requesterDeviceId,
                      message: String(e?.response?.data?.message ?? e?.message ?? ''),
                    })
                  }
                }
              }
            }
            ackIds.push(item.msgId)
            continue
          }

          if (isControl) {
            const type = String((header as any).type ?? '')
            const threadId = String((header as any).threadId ?? '').trim()
            if (type === 'key_receipt') {
              // W-H07/X2: квитанцию засчитываем только от живого устройства участника треда —
              // иначе посторонний «подтверждал» доставку и гасил повторные отправки ключа.
              const v = await verifyKeyReceipt(item, lookups)
              if (!v.ok && v.retry) continue
              if (v.ok) {
                markKeyReceipt(v.threadId, v.fromDeviceId)
                clientLog('SecretInboxPump', 'info', 'key_receipt received', { threadId: v.threadId, data: { fromDeviceId: v.fromDeviceId } })
                try {
                  window.dispatchEvent(
                    new CustomEvent('eb:secretV2:keyReceipt', { detail: { threadId: v.threadId, fromDeviceId: v.fromDeviceId } }),
                  )
                } catch {}
              } else {
                clientLog('SecretInboxPump', 'warn', 'key_receipt rejected', { threadId, data: { reason: v.reason } })
              }
              ackIds.push(item.msgId)
              continue
            }
            if (type === 'key_request') {
              // W-H03: ключ треда уходит только устройству ОТПРАВИТЕЛЯ запроса (senderUserId ставит
              // сервер), и только если он участник треда. Раньше ключ получал любой requesterDeviceId.
              const v = await verifyKeyRequest(item, lookups)
              if (!v.ok && v.retry) continue
              if (v.ok) {
                const keyRec = getSecretThreadKey(v.threadId)
                if (keyRec?.key) {
                  try {
                    const msgId = await shareExistingSecretThreadKeyToDevice(v.threadId, v.toDeviceId)
                    clientLog('SecretInboxPump', 'info', 'key_request handled: resent thread_key', {
                      threadId: v.threadId,
                      msgId,
                      data: { toDeviceId: v.toDeviceId },
                    })
                  } catch (e: any) {
                    clientLog('SecretInboxPump', 'warn', 'key_request handling failed', {
                      threadId: v.threadId,
                      data: { requesterDeviceId: v.toDeviceId, message: String(e?.response?.data?.message ?? e?.message ?? '') },
                    })
                  }
                }
              } else {
                clientLog('SecretInboxPump', 'warn', 'key_request rejected', { threadId, data: { reason: v.reason } })
              }
              ackIds.push(item.msgId)
              continue
            }
            // Неизвестный тип control — подтверждаем, иначе он навсегда занимает голову входящих (X2).
            ackIds.push(item.msgId)
            continue
          }

          if (isResendRequest) {
            // W-H02/W-H03: отвечаем АДРЕСНО — уже имеющимся ключом и только устройству отправителя
            // запроса (участника треда). Ни полной рассылки, ни выпуска нового ключа: раньше здесь
            // звался createAndShareSecretThreadKey (fanout по requesterUserId ИЗ ЗАГОЛОВКА).
            const v = await verifyKeyRequest(item, lookups)
            if (!v.ok && v.retry) continue
            if (v.ok) {
              const keyRec = getSecretThreadKey(v.threadId)
              const throttleKey = `${v.threadId}:${v.toDeviceId}`
              const now = Date.now()
              const last = lastResendHandledAt.get(throttleKey) ?? 0
              if (keyRec?.key && now - last > RESEND_REQUEST_THROTTLE_MS) {
                lastResendHandledAt.set(throttleKey, now)
                void shareExistingSecretThreadKeyToDevice(v.threadId, v.toDeviceId).catch(() => {
                  lastResendHandledAt.delete(throttleKey)
                })
              }
            } else {
              clientLog('SecretInboxPump', 'warn', 'key_resend_request rejected', {
                threadId: String((header as any).threadId ?? '').trim() || undefined,
                data: { reason: v.reason },
              })
            }
            ackIds.push(item.msgId)
            continue
          }

          if (isPrekeysNeeded) {
            // Creator can send this signal when OPK claim fails with "No prekeys available".
            // It does not reveal anything; it only asks the peer device to publish OPKs ASAP.
            try {
              const now = Date.now()
              if (now - lastPrekeysNeededAt >= PREKEYS_NEEDED_THROTTLE_MS) {
                lastPrekeysNeededAt = now
                await forcePublishPrekeys({ reason: 'prekeys_needed', count: 50, force: true })
              }
              if (secretDebugEnabled()) {
                // eslint-disable-next-line no-console
                console.log('[SecretInboxPump] prekeys_needed: published OPKs')
              }
            } catch (e: any) {
              if (secretDebugEnabled()) {
                // eslint-disable-next-line no-console
                console.warn('[SecretInboxPump] prekeys_needed: publish failed', {
                  message: String(e?.response?.data?.message ?? e?.message ?? ''),
                })
              }
            }
            ackIds.push(item.msgId)
            continue
          }

          // Key packages (device-link / thread-key share) arrive via direct inbox (threadId null).
          const attempt = isKeyPackage ? tryDecryptIncomingKeyPackage(item) : null
          if (attempt && attempt.ok) {
            if (attempt.kind === 'thread_key') {
              // W-H01: ключ треда принимаем только от участника ЭТОГО треда (тред — из payload;
              // если заголовок несёт threadId, он обязан совпасть), с ключом ровно 32 байта.
              const v = await verifyThreadKeyPackage(item, attempt, lookups)
              if (!v.ok && v.retry) continue // не смогли проверить — разберём на следующем pull
              if (!v.ok) {
                clientLog('SecretInboxPump', 'warn', 'thread_key rejected', {
                  msgId: item.msgId,
                  threadId: String(attempt.payload?.threadId ?? '').trim() || undefined,
                  data: { reason: v.reason, senderUserId: item.senderUserId ?? null },
                })
                ackIds.push(item.msgId)
                consumeAfterAck.push(attempt.debug.prekeyId)
                continue
              }
              const threadId = v.threadId
              // Смена ключа — автоматически (решение владельца), но не молча и без потери истории:
              // прежний ключ остаётся для расшифровки старых сообщений.
              const applied = applyIncomingThreadKey(threadId, v.key)
              const importOk = applied !== 'invalid'
              if (secretDebugEnabled()) {
                // eslint-disable-next-line no-console
                console.log('[SecretInboxPump] key_package thread_key', {
                  msgId: item.msgId,
                  threadId,
                  prekeyId: attempt.debug.prekeyId,
                  bootstrapReady,
                  applied,
                })
              }
              if (applied === 'rotated') {
                clientLog('SecretInboxPump', 'warn', 'thread_key rotated by participant', {
                  threadId,
                  msgId: item.msgId,
                  data: { senderUserId: item.senderUserId ?? null, initiatorDeviceId: (item.headerJson as any)?.initiatorDeviceId },
                })
                try {
                  window.dispatchEvent(
                    new CustomEvent('eb:secretV2:threadKeyRotated', {
                      detail: { threadId, msgId: item.msgId, senderUserId: item.senderUserId ?? null },
                    }),
                  )
                } catch {}
                try {
                  systemToast.info('Ключ шифрования секретного чата сменился. Прежние сообщения остаются читаемыми.', {
                    title: 'Секретный чат',
                    ttlMs: 6000,
                  })
                } catch {}
              }
              if (importOk) {
                client.invalidateQueries({ queryKey: ['messages', threadId] })
                ackIds.push(item.msgId)
                consumeAfterAck.push(attempt.debug.prekeyId)
                try {
                  window.dispatchEvent(
                    new CustomEvent('eb:secretV2:threadKeyImported', {
                      detail: { threadId, msgId: item.msgId, prekeyId: attempt.debug.prekeyId },
                    }),
                  )
                } catch {}
                clientLog('SecretInboxPump', 'info', 'thread_key imported', {
                  threadId,
                  msgId: item.msgId,
                  kind: 'thread_key',
                  data: { prekeyId: attempt.debug.prekeyId, initiatorDeviceId: (item.headerJson as any)?.initiatorDeviceId },
                })
                // Send a lightweight receipt back to initiator device so it can stop resends.
                try {
                  const initiatorDeviceId = String((item.headerJson as any)?.initiatorDeviceId ?? attempt.debug.initiatorDeviceId ?? '').trim()
                  const fromDeviceId = myDeviceId
                  if (initiatorDeviceId && fromDeviceId) {
                    void sendSecretControl(
                      initiatorDeviceId,
                      { type: 'key_receipt', threadId, fromDeviceId, ts: Date.now() },
                      { ttlSeconds: 10 * 60 },
                    ).catch(() => {})
                  }
                } catch {}
              } else {
                ackIds.push(item.msgId)
                consumeAfterAck.push(attempt.debug.prekeyId)
              }
              continue
            }
            if (attempt.kind === 'device_link_keys') {
              // W-X4: связку (все ключи секреток!) принимаем ТОЛЬКО от своего живого устройства:
              // отправитель (по серверу) — я, initiatorDeviceId — моё неотозванное устройство,
              // initiatorIdentityKey совпадает с его зарегистрированным ключом по байтам. Раньше
              // хватало совпадения initiatorDeviceId — простого поля заголовка (id видны всем).
              const v = await verifyDeviceLinkKeys(item, attempt, lookups)
              if (!v.ok && v.retry) continue
              if (!v.ok) {
                clientLog('SecretInboxPump', 'warn', 'device_link_keys rejected', {
                  data: { msgId: item.msgId, reason: v.reason, initiatorDeviceId: (item.headerJson as any)?.initiatorDeviceId },
                })
                ackIds.push(item.msgId)
                consumeAfterAck.push(attempt.debug.prekeyId)
                continue
              }
              let importOk = false
              try {
                importSecretThreadKeys(attempt.payload?.threadKeys, { merge: true })
                importOk = true
              } catch {}
              if (secretDebugEnabled()) {
                // eslint-disable-next-line no-console
                console.log('[SecretInboxPump] key_package device_link_keys', {
                  msgId: item.msgId,
                  prekeyId: attempt.debug.prekeyId,
                  bootstrapReady,
                  opkSecretFound: attempt.debug.opkSecretFound,
                  decryptOk: attempt.debug.decryptOk,
                  importOk,
                })
              }
              try {
                storage.setItem('eb_device_link_last_success', String(Date.now()))
                window.dispatchEvent(new Event('eb:deviceLinked'))
              } catch {}
              client.invalidateQueries({ queryKey: ['conversations'] })
              if (importOk) {
                ackIds.push(item.msgId)
                consumeAfterAck.push(attempt.debug.prekeyId)
              }
              continue
            }
            // Неизвестный вид пакета: расшифровался, но применить нечего — подтверждаем.
            ackIds.push(item.msgId)
            consumeAfterAck.push(attempt.debug.prekeyId)
            continue
          }
          if (attempt && !attempt.ok && (attempt.rootCause === 'KIND_MISMATCH' || attempt.rootCause === 'JSON_ERROR' || attempt.rootCause === 'BAD_HEADER')) {
            // Пакет, который не станет годным никогда (подмена вида, мусор внутри, кривой заголовок):
            // подтверждаем сразу, а не после 20 попыток. Секрет OPK (если пакет вскрылся) снимаем.
            clientLog('SecretInboxPump', 'warn', 'key_package dropped', {
              msgId: item.msgId,
              rootCause: attempt.rootCause,
              data: { packageKind: String((item.headerJson as any)?.packageKind ?? '') },
            })
            ackIds.push(item.msgId)
            if (attempt.debug.decryptOk && attempt.debug.prekeyId) consumeAfterAck.push(attempt.debug.prekeyId)
            continue
          }
          if (attempt && !attempt.ok) {
            const threadIdMeta = String((item.headerJson as any)?.threadId ?? '').trim()
            const { count, poisoned } = bumpAttempt(item.msgId, {
              rootCause: attempt.rootCause,
              prekeyId: attempt.debug.prekeyId,
            })
            setLastRootCause(attempt.rootCause, {
              msgId: item.msgId,
              prekeyId: attempt.debug.prekeyId,
              count,
            })
            clientLog('SecretInboxPump', 'warn', 'key_package decrypt failed', {
              msgId: item.msgId,
              kind: String((item.headerJson as any)?.packageKind ?? ''),
              rootCause: attempt.rootCause,
              threadId: threadIdMeta || undefined,
              data: { prekeyId: attempt.debug.prekeyId, count, poisoned },
            })
            try {
              window.dispatchEvent(
                new CustomEvent('eb:secretV2:keyPackageFailed', {
                  detail: {
                    msgId: item.msgId,
                    threadId: threadIdMeta || null,
                    rootCause: attempt.rootCause,
                    prekeyId: attempt.debug.prekeyId ?? null,
                    poisoned,
                    count,
                  },
                }),
              )
            } catch {}
            if (secretDebugEnabled()) {
              // eslint-disable-next-line no-console
              console.warn('[SecretInboxPump] key_package decrypt failed', {
                msgId: item.msgId,
                rootCause: attempt.rootCause,
                prekeyId: attempt.debug.prekeyId,
                bootstrapReady,
                opkSecretFound: attempt.debug.opkSecretFound,
                decryptOk: attempt.debug.decryptOk,
                attemptCount: count,
                poisoned,
              })
            }
            if (attempt.rootCause === 'OPK_SECRET_MISS') {
              // Self-heal: ensure we have fresh OPKs on the server so creator can resend a key package.
              const now = Date.now()
              if (now - lastSelfHealAtRef.current > 30_000) {
                lastSelfHealAtRef.current = now
                try {
                  void forcePublishPrekeys({ reason: 'opk_secret_miss', count: 50, force: true }).catch(() => {})
                } catch {}
              }
            }
            // Ask the initiator to resend (control msg) after a few failed decrypt attempts.
            if ((attempt.rootCause === 'OPK_SECRET_MISS' || attempt.rootCause === 'DECRYPT_FAIL') && count === 3) {
              try {
                const initiatorDeviceId = String((item.headerJson as any)?.initiatorDeviceId ?? attempt.debug.initiatorDeviceId ?? '').trim()
                const threadIdMeta = String((item.headerJson as any)?.threadId ?? '').trim()
                const requesterDeviceId = myDeviceId
                if (initiatorDeviceId && threadIdMeta && requesterDeviceId) {
                  clientLog('SecretInboxPump', 'info', 'sending key_request to initiator', {
                    threadId: threadIdMeta,
                    rootCause: attempt.rootCause,
                    data: { initiatorDeviceId, requesterDeviceId },
                  })
                  void sendSecretControl(
                    initiatorDeviceId,
                    { type: 'key_request', threadId: threadIdMeta, requesterDeviceId, fromDeviceId: requesterDeviceId, ts: Date.now(), reasonCode: attempt.rootCause },
                    { ttlSeconds: 10 * 60 },
                  ).catch(() => {})
                }
              } catch {}
            }
            if (poisoned) {
              // Prevent head-of-line blocking: acknowledge poisoned items so newer messages can flow.
              ackIds.push(item.msgId)
              try {
                window.dispatchEvent(
                  new CustomEvent('eb:secretPoisonedInbox', {
                    detail: { msgId: item.msgId, rootCause: attempt.rootCause, threadId: threadIdMeta || null },
                  }),
                )
              } catch {}
            }
            continue
          }
          if (isKeyPackage) {
            // Do NOT ack key packages we couldn't decrypt yet (bootstrap timing / missing prekey secret),
            // otherwise we'd drop the only chance to import the thread key.
            if (secretDebugEnabled()) {
              // eslint-disable-next-line no-console
              console.warn('[SecretInboxPump] key package not decrypted yet; keeping in inbox', {
                msgId: item.msgId,
                initiatorDeviceId: (header as any)?.initiatorDeviceId,
                prekeyId: (header as any)?.prekeyId,
              })
            }
            try {
              const threadIdMeta = String((header as any)?.threadId ?? '').trim()
              if (threadIdMeta) {
                window.dispatchEvent(
                  new CustomEvent('eb:secretV2:keyPackageSeen', {
                    detail: { msgId: item.msgId, threadId: threadIdMeta, prekeyId: (header as any)?.prekeyId ?? null },
                  }),
                )
              }
            } catch {}
            continue
          }

          // Secret thread message
          const threadId = item.threadId ? String(item.threadId).trim() : ''
          if (!threadId) {
            // X2: конверт без треда и непонятного вида (self_check, direct, будущие kind) раньше
            // оставался во входящих без ack — 50 таких навсегда закрывали голову списка.
            ackIds.push(item.msgId)
            continue
          }
          ackIds.push(item.msgId)

          // ЕДИНЫЙ трансформ с историей: он знает про contentType='attachment'
          // (иначе получатель видел сырой JSON-дескриптор, а эхо отправителя
          // перетиралось текстовой строкой — ревью).
          const msgObj = transformSecretHistoryItemToMessage(threadId, {
            msgId: item.msgId,
            createdAt: item.createdAt,
            senderUserId: item.senderUserId,
            headerJson: header,
            ciphertext: item.ciphertext,
            contentType: (item as any).contentType ?? 'text',
            schemaVersion: (item as any).schemaVersion ?? 1,
          })

          client.setQueryData(['messages', threadId], (old: any) => {
            const existing = Array.isArray(old) ? old : []
            const byId = new Map<string, any>()
            for (const m of [...existing, msgObj]) {
              if (m && m.id) byId.set(m.id, m)
            }
            return [...byId.values()].sort(
              (a: any, b: any) => new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime(),
            )
          })

          // Keep conversation tiles fresh (unread/etc).
          client.invalidateQueries({ queryKey: ['conversations'] })
        }

        // Ack after processing (best-effort). W-X9: секреты OPK обработанных пакетов снимаем только
        // после успешного ack — не дошёл ack, пакет придёт снова и снова вскроется.
        if (ackIds.length) {
          const toConsume = Array.from(new Set(consumeAfterAck.filter(Boolean)))
          void api
            .post('/secret/inbox/ack', { msgIds: ackIds })
            .then(() => {
              for (const prekeyId of toConsume) {
                try {
                  consumePrekeySecret(prekeyId)
                } catch {}
              }
            })
            .catch(() => {})
        }
      } catch (err: any) {
        if (isBootstrapRepairableError(err)) {
          const now = Date.now()
          if (now - lastBootstrapRepairAtRef.current > 60_000) {
            lastBootstrapRepairAtRef.current = now
            void ensureDeviceBootstrap({ forceRegister: true, skipReserveCheck: true }).catch(() => {})
          }
        }
        if (secretDebugEnabled()) {
          // eslint-disable-next-line no-console
          console.warn('[SecretInboxPump] pullOnce failed', {
            status: err?.response?.status,
            message: String(err?.response?.data?.message ?? err?.message ?? ''),
          })
        }
      } finally {
        pullingRef.current = false
        if (pendingPullRef.current && mounted) {
          pendingPullRef.current = false
          // Run the trailing pull queued by a notify that arrived mid-flight.
          window.setTimeout(() => { void pullOnce() }, 0)
        }
      }
    }

    pullNowFn = pullOnce
    try {
      if (typeof window !== 'undefined') {
        ;(window as any).__ebSecretInboxPullNow = pullOnce
      }
    } catch {}

    // Periodic pull (offline-friendly)
    const t = window.setInterval(() => {
      void pullOnce()
    }, 3500)

    // Faster wake-up on realtime notify
    const onNotify = (payload?: any) => {
      void pullOnce()
      // The user-room fallback notify carries the threadId — refetch that thread's history
      // right away so delivery never waits for the 15 s poll even when the device-room
      // inbox path is broken for this session.
      const tid = String(payload?.threadId ?? '').trim()
      if (tid) {
        try {
          client.invalidateQueries({ queryKey: ['messages', tid] })
        } catch {}
      }
    }
    if (!socket.connected) {
      connectSocket()
    }
    socket.on('secret:notify', onNotify as any)

    // Initial pull
    void pullOnce()

    return () => {
      mounted = false
      window.clearInterval(t)
      socket.off('secret:notify', onNotify as any)
      try {
        if (typeof window !== 'undefined' && (window as any).__ebSecretInboxPullNow === pullNowFn) {
          delete (window as any).__ebSecretInboxPullNow
        }
      } catch {}
    }
  }, [client])

  return null
}

