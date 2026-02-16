import nacl from 'tweetnacl'
import { bytesToBase64, base64ToBytes } from '../../utils/base64'

const STORAGE_KEY = 'eb_secret_thread_keys_v1'

export type SecretThreadKeyRecord = {
  key: string // base64(32 bytes)
  createdAt: number
  version: number
}

type StoreShape = Record<string, SecretThreadKeyRecord>

function loadStore(): StoreShape {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as StoreShape
    if (!parsed || typeof parsed !== 'object') return {}
    return parsed
  } catch {
    return {}
  }
}

function saveStore(next: StoreShape) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  } catch {
    // ignore
  }
}

function notifyUpdated() {
  try {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new Event('eb:secretKeysUpdated'))
    }
  } catch {
    // ignore
  }
}

export function getSecretThreadKey(threadId: string): SecretThreadKeyRecord | null {
  const id = String(threadId ?? '').trim()
  if (!id) return null
  const store = loadStore()
  return store[id] ?? null
}

export function hasSecretThreadKey(threadId: string): boolean {
  return !!getSecretThreadKey(threadId)?.key
}

export function setSecretThreadKey(threadId: string, keyBase64: string, opts?: { createdAt?: number; version?: number }) {
  const id = String(threadId ?? '').trim()
  const key = String(keyBase64 ?? '').trim()
  if (!id || !key) return
  // basic validation: must decode to 32 bytes
  const bytes = base64ToBytes(key)
  if (bytes.length !== 32) return

  const store = loadStore()
  store[id] = {
    key,
    createdAt: typeof opts?.createdAt === 'number' ? opts!.createdAt : Date.now(),
    version: typeof opts?.version === 'number' ? opts!.version : 1,
  }
  saveStore(store)
  notifyUpdated()
}

export function ensureSecretThreadKey(threadId: string): SecretThreadKeyRecord {
  const existing = getSecretThreadKey(threadId)
  if (existing) return existing
  const keyBytes = nacl.randomBytes(32)
  const rec: SecretThreadKeyRecord = { key: bytesToBase64(keyBytes), createdAt: Date.now(), version: 1 }
  const store = loadStore()
  store[String(threadId)] = rec
  saveStore(store)
  notifyUpdated()
  return rec
}

export function exportSecretThreadKeys(): { version: 1; exportedAt: number; keys: StoreShape } {
  return {
    version: 1,
    exportedAt: Date.now(),
    keys: loadStore(),
  }
}

export function importSecretThreadKeys(payload: any, opts?: { merge?: boolean }) {
  const merge = opts?.merge !== false
  const keys = payload?.keys
  if (!keys || typeof keys !== 'object') return
  const incoming = keys as StoreShape
  const base = merge ? loadStore() : {}

  for (const [threadId, rec] of Object.entries(incoming)) {
    const id = String(threadId ?? '').trim()
    const key = String((rec as any)?.key ?? '').trim()
    if (!id || !key) continue
    const bytes = base64ToBytes(key)
    if (bytes.length !== 32) continue
    base[id] = {
      key,
      createdAt: typeof (rec as any)?.createdAt === 'number' ? (rec as any).createdAt : Date.now(),
      version: typeof (rec as any)?.version === 'number' ? (rec as any).version : 1,
    }
  }

  saveStore(base)
  notifyUpdated()
}

