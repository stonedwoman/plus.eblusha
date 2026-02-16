import { describe, expect, it } from 'vitest'
import { filterUnackedTargets, hasKeyReceipt, markKeyReceipt, markKeyShareSent, getPendingAttempts } from './secretKeyShareState'

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

describe('secretKeyShareState', () => {
  it('tracks receipts and filters unacked targets', () => {
    const localStorage = installLocalStorage()
    localStorage.clear()
    markKeyReceipt('t1', 'd1')
    expect(hasKeyReceipt('t1', 'd1')).toBe(true)
    expect(filterUnackedTargets('t1', ['d1', 'd2'])).toEqual(['d2'])
  })

  it('increments pending attempts on send', () => {
    const localStorage = installLocalStorage()
    localStorage.clear()
    markKeyShareSent('t1', 'd1', 'm1')
    markKeyShareSent('t1', 'd1', 'm2')
    expect(getPendingAttempts('t1', 'd1')).toBe(2)
  })
})

