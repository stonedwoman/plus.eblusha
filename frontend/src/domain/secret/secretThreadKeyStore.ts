import nacl from 'tweetnacl'
import { bytesToBase64, base64ToBytes } from '../../utils/base64'
import { getDefaultStorageAdapter } from '../../core/storage'

const STORAGE_KEY = 'eb_secret_thread_keys_v1'
const storage = getDefaultStorageAdapter()
/** Сколько прежних ключей треда держим для расшифровки старых сообщений. */
const MAX_PREV_KEYS = 8

export type SecretThreadKeyRecord = {
  key: string // base64(32 bytes)
  createdAt: number
  version: number
  /**
   * Прежние ключи треда (W-H01): после смены ключа старые сообщения шифрованы старым ключом —
   * им только РАСШИФРОВЫВАЕМ, новые шифруем текущим `key`. Раньше входящий ключ молча
   * перезаписывал текущий, и вся предыдущая история становилась нечитаемой.
   */
  prev?: Array<{ key: string; until: number }>
}

type StoreShape = Record<string, SecretThreadKeyRecord>

function loadStore(): StoreShape {
  try {
    const raw = storage.getItem(STORAGE_KEY)
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
    storage.setItem(STORAGE_KEY, JSON.stringify(next))
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

function isValidKey(keyBase64: string): boolean {
  try {
    return base64ToBytes(keyBase64).length === 32
  } catch {
    return false
  }
}

/**
 * Один и тот же ключ разные клиенты кодируют по-разному (веб — base64url без «=», Android/iOS —
 * обычный base64), поэтому сравниваем БАЙТЫ, а не строки: иначе повторная доставка того же
 * ключа выглядела бы как «смена ключа».
 */
export function sameThreadKey(a: string, b: string): boolean {
  if (a === b) return true
  try {
    const x = base64ToBytes(a)
    const y = base64ToBytes(b)
    if (x.length !== y.length || x.length === 0) return false
    let diff = 0
    for (let i = 0; i < x.length; i += 1) diff |= x[i]! ^ y[i]!
    return diff === 0
  } catch {
    return false
  }
}

function withPrev(rec: SecretThreadKeyRecord, oldKey: string, now: number): SecretThreadKeyRecord['prev'] {
  const list = (rec.prev ?? []).filter((p) => p && p.key && !sameThreadKey(p.key, oldKey) && !sameThreadKey(p.key, rec.key))
  return [{ key: oldKey, until: now }, ...list].slice(0, MAX_PREV_KEYS)
}

function hasPrev(rec: SecretThreadKeyRecord, key: string): boolean {
  return (rec.prev ?? []).some((p) => !!p?.key && sameThreadKey(p.key, key))
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

/** Ключи для РАСШИФРОВКИ: текущий первым, затем прежние (новые сообщения шифруются только текущим). */
export function getSecretThreadKeyCandidates(threadId: string): string[] {
  const rec = getSecretThreadKey(threadId)
  if (!rec?.key) return []
  const out = [rec.key]
  for (const p of rec.prev ?? []) {
    if (p?.key && !out.some((k) => sameThreadKey(k, p.key))) out.push(p.key)
  }
  return out
}

export function setSecretThreadKey(
  threadId: string,
  keyBase64: string,
  opts?: { createdAt?: number; version?: number; overwrite?: boolean },
) {
  const id = String(threadId ?? '').trim()
  const key = String(keyBase64 ?? '').trim()
  if (!id || !key) return
  // basic validation: must decode to 32 bytes
  if (!isValidKey(key)) return

  const store = loadStore()
  const existing = store[id]?.key ? String(store[id]!.key) : ''
  if (existing && !sameThreadKey(existing, key) && !opts?.overwrite) {
    // Never clobber an existing key implicitly: that would break decryption for already stored ciphertexts.
    try {
      // eslint-disable-next-line no-console
      console.warn('[secretThreadKeyStore] refusing to overwrite existing thread key', { threadId: id })
    } catch {}
    return
  }
  const now = Date.now()
  const prevRec = store[id]
  store[id] = {
    key,
    createdAt: typeof opts?.createdAt === 'number' ? opts!.createdAt : (prevRec?.createdAt ?? now),
    version: typeof opts?.version === 'number' ? opts!.version : (prevRec?.version ?? 1),
    // Даже явная перезапись не теряет прежний ключ: он остаётся для расшифровки истории.
    ...(prevRec && existing && !sameThreadKey(existing, key)
      ? { prev: withPrev(prevRec, existing, now) }
      : prevRec?.prev
        ? { prev: prevRec.prev }
        : {}),
  }
  saveStore(store)
  notifyUpdated()
}

export type IncomingThreadKeyResult = 'set' | 'same' | 'rotated' | 'invalid'

/**
 * Импорт ключа треда, пришедшего от ПРОВЕРЕННОГО участника (W-H01; решение владельца: смена
 * ключа — автоматически, но только от проверенного участника — проверки в secretInboxGuards).
 *   - ключа нет → ставим;
 *   - тот же ключ → ничего;
 *   - другой ключ → новый становится текущим, прежний уходит в `prev` (история остаётся
 *     читаемой), вызывающий обязан сообщить о смене (лог + уведомление), а не делать это молча.
 */
export function applyIncomingThreadKey(threadId: string, keyBase64: string): IncomingThreadKeyResult {
  const id = String(threadId ?? '').trim()
  const key = String(keyBase64 ?? '').trim()
  if (!id || !key || !isValidKey(key)) return 'invalid'
  const store = loadStore()
  const rec = store[id]
  const now = Date.now()
  if (!rec?.key) {
    store[id] = { key, createdAt: now, version: 1 }
    saveStore(store)
    notifyUpdated()
    return 'set'
  }
  if (sameThreadKey(rec.key, key)) return 'same'
  store[id] = {
    key,
    createdAt: now,
    version: (typeof rec.version === 'number' ? rec.version : 1) + 1,
    prev: withPrev(rec, rec.key, now),
  }
  saveStore(store)
  notifyUpdated()
  return 'rotated'
}

/** Добавить ключ только для расшифровки (конфликт при связывании устройств) — текущий не меняется. */
export function addAlternateThreadKey(threadId: string, keyBase64: string): boolean {
  const id = String(threadId ?? '').trim()
  const key = String(keyBase64 ?? '').trim()
  if (!id || !key || !isValidKey(key)) return false
  const store = loadStore()
  const rec = store[id]
  if (!rec?.key || sameThreadKey(rec.key, key)) return false
  if (hasPrev(rec, key)) return false
  store[id] = { ...rec, prev: [{ key, until: Date.now() }, ...(rec.prev ?? [])].slice(0, MAX_PREV_KEYS) }
  saveStore(store)
  notifyUpdated()
  return true
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
  // Формат на проводе прежний ({key, createdAt, version}): связывание читают и Android/iOS.
  const keys: StoreShape = {}
  for (const [id, rec] of Object.entries(loadStore())) {
    if (!rec?.key) continue
    keys[id] = { key: rec.key, createdAt: rec.createdAt, version: rec.version }
  }
  return {
    version: 1,
    exportedAt: Date.now(),
    keys,
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
    if (!isValidKey(key)) continue
    const existing = base[id]?.key ? String(base[id]!.key) : ''
    if (existing && !sameThreadKey(existing, key)) {
      // Конфликт: текущий ключ не трогаем (иначе уже лежащая история перестанет вскрываться),
      // а пришедший сохраняем как запасной — им, возможно, зашифрованы сообщения с того устройства.
      const cur = base[id]!
      if (!hasPrev(cur, key)) {
        base[id] = { ...cur, prev: [{ key, until: Date.now() }, ...(cur.prev ?? [])].slice(0, MAX_PREV_KEYS) }
      }
      continue
    }
    base[id] = {
      key,
      createdAt: typeof (rec as any)?.createdAt === 'number' ? (rec as any).createdAt : (base[id]?.createdAt ?? Date.now()),
      version: typeof (rec as any)?.version === 'number' ? (rec as any).version : (base[id]?.version ?? 1),
      ...(base[id]?.prev ? { prev: base[id]!.prev } : {}),
    }
  }

  saveStore(base)
  notifyUpdated()
}
