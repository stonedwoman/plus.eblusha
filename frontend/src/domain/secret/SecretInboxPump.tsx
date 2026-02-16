import { useEffect, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { api } from '../../utils/api'
import { socket, connectSocket } from '../../utils/socket'
import { ensureDeviceBootstrap } from '../device/deviceManager'
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
        await (bootstrapReadyRef.current ?? Promise.resolve(null))

        const resp = await api.get('/secret/inbox/pull', { params: { limit: 200 } })
        const items = (resp.data?.messages ?? []) as InboxItem[]
        if (!items.length) return

        const ackIds: string[] = []

        for (const item of items) {
          if (!item?.msgId) continue
          const header = item.headerJson ?? {}
          const isKeyPackage = header && typeof header === 'object' && String((header as any).kind ?? '') === 'key_package'

          // Key packages (device-link / thread-key share) arrive via direct inbox (threadId null).
          const maybePkg = tryDecryptIncomingKeyPackage(item)
          if (maybePkg?.kind === 'thread_key') {
            const threadId = String(maybePkg.payload?.threadId ?? '').trim()
            const key = String(maybePkg.payload?.key ?? '').trim()
            if (threadId && key) {
              setSecretThreadKey(threadId, key)
              // Refetch history on next render; keep it cheap.
              client.invalidateQueries({ queryKey: ['messages', threadId] })
            }
            ackIds.push(item.msgId)
            continue
          }
          if (maybePkg?.kind === 'device_link_keys') {
            try {
              importSecretThreadKeys(maybePkg.payload?.threadKeys, { merge: true })
            } catch {}
            try {
              localStorage.setItem('eb_device_link_last_success', String(Date.now()))
              window.dispatchEvent(new Event('eb:deviceLinked'))
            } catch {}
            client.invalidateQueries({ queryKey: ['conversations'] })
            ackIds.push(item.msgId)
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
      } catch {
        // ignore transient failures
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

