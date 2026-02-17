import { useEffect, useRef } from 'react'
import { SecretInboxPump as LegacySecretInboxPump } from '../secret/SecretInboxPump'
import {
  clearThreadError,
  getAllThreadRuntime,
  getThreadState,
  hasSeenKeyPackage,
  markKeyPackageSeen,
  markThreadError,
  markThreadReady,
  subscribeSecretThreadState,
  type SecretReasonCode,
} from './state'
import { hasSecretThreadKey } from '../secret/secretThreadKeyStore'
import { forcePublishPrekeys } from '../device/deviceManager'

function mapRootCauseToReason(rootCause: string | null | undefined): SecretReasonCode {
  const rc = String(rootCause ?? '').trim().toUpperCase()
  if (rc === 'OPK_SECRET_MISS' || rc === 'OPK_SECRET_MISSING') return 'OPK_SECRET_MISSING'
  if (rc === 'DECRYPT_FAIL' || rc === 'DECRYPT_FAILED') return 'DECRYPT_FAILED'
  if (rc === 'POISONED_KEY_PACKAGE') return 'POISONED_KEY_PACKAGE'
  if (rc === 'NO_PREKEYS' || rc === 'NO_PREKEYS_AVAILABLE') return 'NO_PREKEYS_AVAILABLE'
  return 'NETWORK_ERROR'
}

export function SecretV2InboxPump() {
  const lastChanceByThreadRef = useRef<Record<string, number>>({})
  const initialPublishByThreadRef = useRef<Record<string, number>>({})
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
      // Seeing a key_package (even if decrypt fails) means "not NO_KEYPACKAGE".
      markKeyPackageSeen(threadId)
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

  // Peer hotfix: while waiting for key_package, pull inbox aggressively (2s)
  // and do a last-chance self-heal (publish OPKs + pull) before NO_KEYPACKAGE.
  useEffect(() => {
    let mounted = true
    let timer: number | null = null

    const pullNow = async () => {
      try {
        const fn = typeof window !== 'undefined' ? (window as any).__ebSecretInboxPullNow : null
        if (typeof fn === 'function') {
          await fn()
        }
      } catch {}
    }

    const hasAnyWaiting = () => {
      const runtime = getAllThreadRuntime()
      for (const threadId of Object.keys(runtime)) {
        const view = getThreadState(threadId)
        if (view.state === 'WAITING_KEY_PACKAGE' && !hasSecretThreadKey(threadId)) return true
      }
      return false
    }

    const tick = async () => {
      if (!mounted) return
      const runtime = getAllThreadRuntime()
      const now = Date.now()
      let anyWaiting = false
      for (const threadId of Object.keys(runtime)) {
        const view = getThreadState(threadId)
        if (view.state !== 'WAITING_KEY_PACKAGE') continue
        if (hasSecretThreadKey(threadId)) continue
        anyWaiting = true

        // Ensure our device has OPKs published so the creator can encrypt a key_package to us.
        // This is critical when sockets are flaky and/or the device bootstrapped without publishing.
        if (!hasSeenKeyPackage(threadId) && !initialPublishByThreadRef.current[threadId]) {
          initialPublishByThreadRef.current[threadId] = now
          try {
            await forcePublishPrekeys({ reason: 'waiting_key_package' })
          } catch {}
        }

        // Last chance: ~2s before timeout, publish OPKs and pull once more.
        const ws = view.waitingSince
        if (ws && now - ws >= 118_000 && !hasSeenKeyPackage(threadId) && !lastChanceByThreadRef.current[threadId]) {
          lastChanceByThreadRef.current[threadId] = now
          try {
            await forcePublishPrekeys({ reason: 'no_keypackage_last_chance' })
          } catch {}
          await pullNow()
        }
      }
      if (anyWaiting) {
        await pullNow()
      }
      // Stop timer once there is no waiting thread.
      if (timer != null && !hasAnyWaiting()) {
        window.clearInterval(timer)
        timer = null
      }
    }

    const ensureTimer = () => {
      if (timer != null) return
      if (!hasAnyWaiting()) return
      timer = window.setInterval(() => {
        void tick()
      }, 2000)
      void tick()
    }

    const onStateSignal = () => {
      // Start/stop based on current state.
      ensureTimer()
    }

    ensureTimer()
    const unsub = subscribeSecretThreadState(onStateSignal)
    window.addEventListener('eb:secretV2:threadKeyImported', onStateSignal as any)
    window.addEventListener('eb:secretV2:keyPackageSeen', onStateSignal as any)
    window.addEventListener('eb:secretV2:keyPackageFailed', onStateSignal as any)
    window.addEventListener('eb:secretKeysUpdated', onStateSignal as any)
    return () => {
      mounted = false
      if (timer != null) window.clearInterval(timer)
      unsub()
      window.removeEventListener('eb:secretV2:threadKeyImported', onStateSignal as any)
      window.removeEventListener('eb:secretV2:keyPackageSeen', onStateSignal as any)
      window.removeEventListener('eb:secretV2:keyPackageFailed', onStateSignal as any)
      window.removeEventListener('eb:secretKeysUpdated', onStateSignal as any)
    }
  }, [])

  // Reuse battle-tested inbox pump, but drive state machine through events.
  return <LegacySecretInboxPump />
}

