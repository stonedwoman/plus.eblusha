import { describe, expect, it } from 'vitest'
import { enqueueText, flushQueuedText, getQueuedCount } from './engine'
import { ensureSecretThreadKey } from '../secret/secretThreadKeyStore'

function installLocalStorage() {
  const m = new Map<string, string>()
  const ls = {
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
    clear: () => void m.clear(),
  }
  ;(globalThis as any).localStorage = ls
  return ls
}

describe('secretV2 engine queue', () => {
  it('flushes queued messages after key appears', async () => {
    const localStorage = installLocalStorage()
    localStorage.clear()

    const t = 'thread-q'
    enqueueText(t, 'peer-u', 'a')
    enqueueText(t, 'peer-u', 'b')
    expect(getQueuedCount(t)).toBe(2)

    const sent: string[] = []
    ensureSecretThreadKey(t)
    await flushQueuedText(t, async (item) => {
      sent.push(item.text)
    })
    expect(sent).toEqual(['a', 'b'])
    expect(getQueuedCount(t)).toBe(0)
  })
})

