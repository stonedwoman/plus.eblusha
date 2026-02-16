import { useEffect, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { api } from '../../utils/api'
import { socket, connectSocket } from '../../utils/socket'
import { ensureDeviceBootstrap, forcePublishPrekeys } from '../device/deviceManager'
import { getSecretThreadKey, importSecretThreadKeys, setSecretThreadKey } from './secretThreadKeyStore'
import { decryptSecretThreadText } from './secretThreadCrypto'
import { tryDecryptIncomingKeyPackage } from './secretKeyPackages'

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

type InboxAttemptRec = { count: number; firstAt: number; lastAt: number; rootCause?: string; prekeyId?: string }
const ATTEMPTS_KEY = 'eb_secret_inbox_attempts_v1'
const LAST_ROOT_CAUSE_KEY = 'eb_secret_last_root_cause_v1'
const ATTEMPT_TTL_MS = 30 * 60_000
const POISON_THRESHOLD = 20

function loadAttempts(): Record<string, InboxAttemptRec> {
  try {
    const raw = localStorage.getItem(ATTEMPTS_KEY)
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
    localStorage.setItem(ATTEMPTS_KEY, JSON.stringify(next))
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
    localStorage.setItem(LAST_ROOT_CAUSE_KEY, JSON.stringify({ code, at: Date.now(), ...(details ? { details } : {}) }))
  } catch {}
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
  const bootstrapReadyRef = useRef<Promise<any> | null>(null)
  const lastSelfHealAtRef = useRef<number>(0)

  useEffect(() => {
    let mounted = true
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
      if (pullingRef.current) return
      pullingRef.current = true
      try {
        // Ensure device keys exist before we attempt to decrypt key packages.
        const bootstrapRes = await (bootstrapReadyRef.current ?? Promise.resolve(null))
        const bootstrapReady = !!bootstrapRes

        const resp = await api.get('/secret/inbox/pull', {
          params: { limit: 50 },
          // Avoid conditional caching (If-None-Match → 304) for polling endpoints.
          headers: { 'Cache-Control': 'no-cache', Pragma: 'no-cache' },
        })
        const items = (resp.data?.messages ?? []) as InboxItem[]
        if (!items.length) return

        const ackIds: string[] = []

        for (const item of items) {
          if (!item?.msgId) continue
          const header = item.headerJson ?? {}
          const isKeyPackage = header && typeof header === 'object' && String((header as any).kind ?? '') === 'key_package'

          // Key packages (device-link / thread-key share) arrive via direct inbox (threadId null).
          const attempt = isKeyPackage ? tryDecryptIncomingKeyPackage(item) : null
          if (attempt && attempt.ok) {
            if (attempt.kind === 'thread_key') {
              const threadId = String(attempt.payload?.threadId ?? '').trim()
              const key = String(attempt.payload?.key ?? '').trim()
              const importOk = !!(threadId && key)
              if (secretDebugEnabled()) {
                // eslint-disable-next-line no-console
                console.log('[SecretInboxPump] key_package thread_key', {
                  msgId: item.msgId,
                  threadId,
                  prekeyId: attempt.debug.prekeyId,
                  bootstrapReady,
                  opkSecretFound: attempt.debug.opkSecretFound,
                  decryptOk: attempt.debug.decryptOk,
                  importOk,
                })
              }
              if (importOk) {
                setSecretThreadKey(threadId, key, { overwrite: true })
                client.invalidateQueries({ queryKey: ['messages', threadId] })
                ackIds.push(item.msgId)
              }
              continue
            }
            if (attempt.kind === 'device_link_keys') {
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
                localStorage.setItem('eb_device_link_last_success', String(Date.now()))
                window.dispatchEvent(new Event('eb:deviceLinked'))
              } catch {}
              client.invalidateQueries({ queryKey: ['conversations'] })
              if (importOk) ackIds.push(item.msgId)
              continue
            }
          }
          if (attempt && !attempt.ok) {
            const { count, poisoned } = bumpAttempt(item.msgId, {
              rootCause: attempt.rootCause,
              prekeyId: attempt.debug.prekeyId,
            })
            setLastRootCause(attempt.rootCause, {
              msgId: item.msgId,
              prekeyId: attempt.debug.prekeyId,
              count,
            })
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
                  void forcePublishPrekeys({ reason: 'opk_secret_miss' }).catch(() => {})
                } catch {}
              }
            }
            if (poisoned) {
              // Prevent head-of-line blocking: acknowledge poisoned items so newer messages can flow.
              ackIds.push(item.msgId)
              try {
                window.dispatchEvent(new CustomEvent('eb:secretPoisonedInbox', { detail: { msgId: item.msgId, rootCause: attempt.rootCause } }))
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
            continue
          }

          // Secret thread message
          const threadId = item.threadId ? String(item.threadId).trim() : ''
          if (!threadId) continue
          ackIds.push(item.msgId)

          const keyRec = getSecretThreadKey(threadId)
          const nonce = typeof header?.nonce === 'string' ? header.nonce : null

          const decrypted =
            keyRec && nonce ? decryptSecretThreadText(keyRec.key, item.ciphertext, nonce) : null

          const msgObj = toMessageObject(threadId, item, decrypted)

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

        // Ack after processing (best-effort).
        if (ackIds.length) {
          void api.post('/secret/inbox/ack', { msgIds: ackIds }).catch(() => {})
        }
      } catch (err: any) {
        if (secretDebugEnabled()) {
          // eslint-disable-next-line no-console
          console.warn('[SecretInboxPump] pullOnce failed', {
            status: err?.response?.status,
            message: String(err?.response?.data?.message ?? err?.message ?? ''),
          })
        }
      } finally {
        pullingRef.current = false
      }
    }

    // Periodic pull (offline-friendly)
    const t = window.setInterval(() => {
      void pullOnce()
    }, 3500)

    // Faster wake-up on realtime notify
    const onNotify = () => {
      void pullOnce()
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
    }
  }, [client])

  return null
}

