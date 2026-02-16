import type { KeyPackageDecryptAttempt } from './secretKeyPackages'

export type KeyPackageInboxItem = {
  msgId: string
  headerJson?: any
  ciphertext?: string
}

export type BumpAttemptFn = (msgId: string, info?: { rootCause?: string; prekeyId?: string }) => { count: number; poisoned: boolean }

export function isKeyPackageItem(item: KeyPackageInboxItem): boolean {
  const h = item?.headerJson
  return !!(h && typeof h === 'object' && String((h as any).kind ?? '') === 'key_package')
}

/**
 * Processes key_package items without head-of-line blocking.
 *
 * - Ack only after successful decrypt + apply (importOk).
 * - If decrypt fails, keep item in inbox (no ack) until it becomes "poisoned".
 * - Poisoned items are acked to unblock the inbox.
 */
export function processKeyPackageBatch(opts: {
  items: KeyPackageInboxItem[]
  decrypt: (item: KeyPackageInboxItem) => KeyPackageDecryptAttempt | null
  apply: (attempt: Extract<KeyPackageDecryptAttempt, { ok: true }>) => boolean
  bumpAttempt: BumpAttemptFn
}): { ackIds: string[] } {
  const ackIds: string[] = []
  const items = Array.isArray(opts.items) ? opts.items : []
  for (const item of items) {
    const msgId = String(item?.msgId ?? '').trim()
    if (!msgId) continue
    if (!isKeyPackageItem(item)) continue
    const attempt = opts.decrypt(item)
    if (!attempt) continue
    if (attempt.ok) {
      const importOk = !!opts.apply(attempt)
      if (importOk) ackIds.push(msgId)
      continue
    }
    const bumped = opts.bumpAttempt(msgId, { rootCause: attempt.rootCause, prekeyId: attempt.debug.prekeyId })
    if (bumped.poisoned) {
      ackIds.push(msgId)
    }
  }
  return { ackIds }
}

