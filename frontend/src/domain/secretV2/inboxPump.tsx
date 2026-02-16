import { useEffect } from 'react'
import { SecretInboxPump as LegacySecretInboxPump } from '../secret/SecretInboxPump'
import {
  clearThreadError,
  getAllThreadRuntime,
  markKeyPackageSeen,
  markThreadError,
  markThreadReady,
  type SecretReasonCode,
} from './state'
import { hasSecretThreadKey } from '../secret/secretThreadKeyStore'

function mapRootCauseToReason(rootCause: string | null | undefined): SecretReasonCode {
  const rc = String(rootCause ?? '').trim().toUpperCase()
  if (rc === 'OPK_SECRET_MISS' || rc === 'OPK_SECRET_MISSING') return 'OPK_SECRET_MISSING'
  if (rc === 'DECRYPT_FAIL' || rc === 'DECRYPT_FAILED') return 'DECRYPT_FAILED'
  if (rc === 'POISONED_KEY_PACKAGE') return 'POISONED_KEY_PACKAGE'
  if (rc === 'NO_PREKEYS' || rc === 'NO_PREKEYS_AVAILABLE') return 'NO_PREKEYS_AVAILABLE'
  return 'NETWORK_ERROR'
}

export function SecretV2InboxPump() {
  useEffect(() => {
    const onKeysUpdated = () => {
      const runtime = getAllThreadRuntime()
      for (const threadId of Object.keys(runtime)) {
        if (hasSecretThreadKey(threadId)) {
          clearThreadError(threadId)
          markThreadReady(threadId)
        }
      }
    }
    const onThreadKeyImported = (ev: Event) => {
      const d = (ev as CustomEvent).detail ?? {}
      const threadId = String(d?.threadId ?? '').trim()
      if (!threadId) return
      clearThreadError(threadId)
      markThreadReady(threadId)
    }
    const onKeyPackageSeen = (ev: Event) => {
      const d = (ev as CustomEvent).detail ?? {}
      const threadId = String(d?.threadId ?? '').trim()
      if (!threadId) return
      markKeyPackageSeen(threadId)
    }
    const onKeyPackageFailed = (ev: Event) => {
      const d = (ev as CustomEvent).detail ?? {}
      const threadId = String(d?.threadId ?? '').trim()
      const rootCause = String(d?.rootCause ?? '').trim()
      if (!threadId) return
      markThreadError(threadId, mapRootCauseToReason(rootCause))
    }
    const onPoisoned = (ev: Event) => {
      const d = (ev as CustomEvent).detail ?? {}
      const threadId = String(d?.threadId ?? '').trim()
      if (!threadId) return
      markThreadError(threadId, 'POISONED_KEY_PACKAGE')
    }

    window.addEventListener('eb:secretKeysUpdated', onKeysUpdated as any)
    window.addEventListener('eb:secretV2:threadKeyImported', onThreadKeyImported as any)
    window.addEventListener('eb:secretV2:keyPackageSeen', onKeyPackageSeen as any)
    window.addEventListener('eb:secretV2:keyPackageFailed', onKeyPackageFailed as any)
    window.addEventListener('eb:secretPoisonedInbox', onPoisoned as any)

    return () => {
      window.removeEventListener('eb:secretKeysUpdated', onKeysUpdated as any)
      window.removeEventListener('eb:secretV2:threadKeyImported', onThreadKeyImported as any)
      window.removeEventListener('eb:secretV2:keyPackageSeen', onKeyPackageSeen as any)
      window.removeEventListener('eb:secretV2:keyPackageFailed', onKeyPackageFailed as any)
      window.removeEventListener('eb:secretPoisonedInbox', onPoisoned as any)
    }
  }, [])

  // Reuse battle-tested inbox pump, but drive state machine through events.
  return <LegacySecretInboxPump />
}

