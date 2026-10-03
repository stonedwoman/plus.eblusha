import { beforeEach, describe, expect, it } from 'vitest'
import nacl from 'tweetnacl'
import { base64ToBytes, bytesToBase64 } from '../../utils/base64'
import {
  applyIncomingThreadKey,
  exportSecretThreadKeys,
  getSecretThreadKey,
  getSecretThreadKeyCandidates,
  importSecretThreadKeys,
  setSecretThreadKey,
} from './secretThreadKeyStore'
import { decryptSecretThreadTextAnyKey, encryptSecretThreadText } from './secretThreadCrypto'

function installLocalStorage() {
  const m = new Map<string, string>()
  ;(globalThis as any).localStorage = {
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
    clear: () => void m.clear(),
  }
}
const newKey = () => bytesToBase64(nacl.randomBytes(32))
const asStdBase64 = (k: string) => btoa(String.fromCharCode(...base64ToBytes(k)))

describe('W-H01: смена ключа треда без молчаливой перезаписи', () => {
  beforeEach(() => installLocalStorage())

  it('новый ключ от участника становится текущим, прежний остаётся для расшифровки истории', () => {
    const t = 'thr-rot'
    const k1 = newKey()
    const k2 = newKey()
    expect(applyIncomingThreadKey(t, k1)).toBe('set')
    const old = encryptSecretThreadText(k1, 'старое сообщение')
    expect(applyIncomingThreadKey(t, k2)).toBe('rotated')
    expect(getSecretThreadKey(t)?.key).toBe(k2)
    expect(getSecretThreadKeyCandidates(t)).toEqual([k2, k1])
    expect(decryptSecretThreadTextAnyKey(getSecretThreadKeyCandidates(t), old.ciphertextBase64, old.nonceBase64)).toBe('старое сообщение')
    const fresh = encryptSecretThreadText(getSecretThreadKey(t)!.key, 'новое')
    expect(decryptSecretThreadTextAnyKey(getSecretThreadKeyCandidates(t), fresh.ciphertextBase64, fresh.nonceBase64)).toBe('новое')
  })

  it('тот же ключ в другой кодировке (base64 вместо base64url) — не «смена»', () => {
    const t = 'thr-same'
    const k = newKey()
    applyIncomingThreadKey(t, k)
    expect(applyIncomingThreadKey(t, asStdBase64(k))).toBe('same')
    expect(getSecretThreadKeyCandidates(t)).toEqual([k])
  })

  it('ключ не 32 байта не импортируется', () => {
    expect(applyIncomingThreadKey('thr-bad', bytesToBase64(nacl.randomBytes(16)))).toBe('invalid')
    expect(getSecretThreadKey('thr-bad')).toBeNull()
  })

  it('без overwrite чужой ключ текущий не заменяет; с overwrite — прежний сохраняется в prev', () => {
    const t = 'thr-set'
    const k1 = newKey()
    const k2 = newKey()
    setSecretThreadKey(t, k1)
    setSecretThreadKey(t, k2)
    expect(getSecretThreadKey(t)?.key).toBe(k1)
    setSecretThreadKey(t, k2, { overwrite: true })
    expect(getSecretThreadKeyCandidates(t)).toEqual([k2, k1])
  })

  it('связывание: при конфликте текущий ключ не меняется, пришедший — запасной; экспорт в прежнем формате', () => {
    const t = 'thr-link'
    const mine = newKey()
    const theirs = newKey()
    applyIncomingThreadKey(t, mine)
    importSecretThreadKeys({ keys: { [t]: { key: theirs, createdAt: 1, version: 1 }, 'thr-new': { key: theirs, createdAt: 1, version: 1 } } })
    expect(getSecretThreadKey(t)?.key).toBe(mine)
    expect(getSecretThreadKeyCandidates(t)).toEqual([mine, theirs])
    expect(getSecretThreadKey('thr-new')?.key).toBe(theirs)
    const exported = exportSecretThreadKeys()
    expect(Object.keys(exported.keys[t]!).sort()).toEqual(['createdAt', 'key', 'version'])
  })
})
