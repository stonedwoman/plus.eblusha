import { hasSecretThreadKey } from '../secret/secretThreadKeyStore'

export type SecretThreadState = 'NO_KEY' | 'BOOTSTRAPPING_DEVICE' | 'WAITING_KEY_PACKAGE' | 'READY' | 'ERROR'

export type SecretReasonCode =
  | 'BOOTSTRAP_FAILED'
  | 'NO_PEER_DEVICES'
  | 'NO_PREKEYS_AVAILABLE'
  | 'NO_PREKEYS_PUBLISHED'
  | 'OPK_SECRET_MISSING'
  | 'DECRYPT_FAILED'
  | 'IMPORT_FAILED'
  | 'NETWORK_ERROR'
  | 'SERVER_REJECTED'
  | 'POISONED_KEY_PACKAGE'
  | 'TIMEOUT_WAITING_KEY'
  | 'NO_KEYPACKAGE'

export type SecretThreadView = {
  threadId: string
  state: SecretThreadState
  reasonCode: SecretReasonCode | null
  updatedAt: number
  waitingSince: number | null
}

type ThreadRuntime = {
  threadId: string
  waitingSince?: number
  lastKeyPackageAt?: number
  bootstrapReady?: boolean
  reasonCode?: SecretReasonCode | null
  updatedAt: number
}

type RuntimeStore = {
  version: 1
  threads: Record<string, ThreadRuntime>
}

const RUNTIME_KEY = 'eb_secret_v2_runtime_v1'
const WAIT_TIMEOUT_MS = 120_000

let cache: RuntimeStore | null = null
const listeners = new Set<() => void>()

function now() {
  return Date.now()
}

function notify() {
  for (const cb of listeners) {
    try {
      cb()
    } catch {}
  }
}

function loadStore(): RuntimeStore {
  if (cache) return cache
  try {
    const raw = localStorage.getItem(RUNTIME_KEY)
    if (!raw) {
      cache = { version: 1, threads: {} }
      return cache
    }
    const parsed = JSON.parse(raw) as RuntimeStore
    if (!parsed || typeof parsed !== 'object' || typeof parsed.threads !== 'object') {
      cache = { version: 1, threads: {} }
      return cache
    }
    cache = { version: 1, threads: parsed.threads ?? {} }
    return cache
  } catch {
    cache = { version: 1, threads: {} }
    return cache
  }
}

function saveStore(store: RuntimeStore) {
  cache = store
  try {
    localStorage.setItem(RUNTIME_KEY, JSON.stringify(store))
  } catch {}
  notify()
}

function upsert(threadId: string, patch: Partial<ThreadRuntime>) {
  const id = String(threadId ?? '').trim()
  if (!id) return
  const store = loadStore()
  const prev = store.threads[id]
  const base: ThreadRuntime = prev ? { ...prev } : { threadId: id, updatedAt: now() }
  store.threads[id] = {
    ...base,
    ...patch,
    threadId: id,
    updatedAt: now(),
  }
  saveStore(store)
}

function getRuntime(threadId: string): ThreadRuntime | null {
  const id = String(threadId ?? '').trim()
  if (!id) return null
  const store = loadStore()
  return store.threads[id] ?? null
}

export function subscribeSecretThreadState(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

export function markThreadOpened(threadId: string) {
  if (hasSecretThreadKey(threadId)) {
    upsert(threadId, { reasonCode: null, waitingSince: undefined, bootstrapReady: true })
    return
  }
  const rt = getRuntime(threadId)
  if (!rt?.waitingSince) {
    upsert(threadId, { waitingSince: now() })
  } else {
    upsert(threadId, {})
  }
}

export function markBootstrapReady(threadId: string, ready: boolean) {
  upsert(threadId, { bootstrapReady: !!ready, reasonCode: ready ? null : 'BOOTSTRAP_FAILED' })
}

export function markKeyPackageSeen(threadId: string) {
  upsert(threadId, { lastKeyPackageAt: now() })
}

export function markThreadError(threadId: string, reasonCode: SecretReasonCode) {
  upsert(threadId, { reasonCode, waitingSince: getRuntime(threadId)?.waitingSince ?? now() })
}

export function clearThreadError(threadId: string) {
  upsert(threadId, { reasonCode: null })
}

export function markThreadReady(threadId: string) {
  upsert(threadId, { reasonCode: null, waitingSince: undefined, bootstrapReady: true })
}

export function getThreadState(threadId: string): SecretThreadView {
  const id = String(threadId ?? '').trim()
  if (!id) {
    return { threadId: id, state: 'NO_KEY', reasonCode: null, updatedAt: now(), waitingSince: null }
  }
  if (hasSecretThreadKey(id)) {
    return { threadId: id, state: 'READY', reasonCode: null, updatedAt: now(), waitingSince: null }
  }
  const rt = getRuntime(id)
  const waitingSince = rt?.waitingSince ?? null
  const reasonCode = (rt?.reasonCode ?? null) as SecretReasonCode | null
  if (reasonCode) {
    return { threadId: id, state: 'ERROR', reasonCode, updatedAt: rt?.updatedAt ?? now(), waitingSince }
  }
  if (rt?.bootstrapReady === false) {
    return { threadId: id, state: 'BOOTSTRAPPING_DEVICE', reasonCode: null, updatedAt: rt.updatedAt, waitingSince }
  }
  if (waitingSince && now() - waitingSince > WAIT_TIMEOUT_MS) {
    return {
      threadId: id,
      state: 'ERROR',
      reasonCode: (rt?.lastKeyPackageAt ? 'TIMEOUT_WAITING_KEY' : 'NO_KEYPACKAGE') as SecretReasonCode,
      updatedAt: rt?.updatedAt ?? now(),
      waitingSince,
    }
  }
  if (rt) {
    return {
      threadId: id,
      state: 'WAITING_KEY_PACKAGE',
      reasonCode: null,
      updatedAt: rt.updatedAt,
      waitingSince,
    }
  }
  return { threadId: id, state: 'NO_KEY', reasonCode: null, updatedAt: now(), waitingSince: null }
}

export function getAllThreadRuntime(): Record<string, ThreadRuntime> {
  return { ...(loadStore().threads ?? {}) }
}

// Test helper
export function __resetSecretV2StateForTests() {
  cache = null
  listeners.clear()
  try {
    localStorage.removeItem(RUNTIME_KEY)
  } catch {}
}

export function __reloadSecretV2StateForTests() {
  cache = null
}

