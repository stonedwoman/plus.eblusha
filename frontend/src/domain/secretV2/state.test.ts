import { describe, expect, it } from 'vitest'
import { __reloadSecretV2StateForTests, __resetSecretV2StateForTests, getThreadState, markBootstrapReady, markThreadOpened } from './state'
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

describe('secretV2 state machine', () => {
  it('transitions to READY when local thread key exists', () => {
    const localStorage = installLocalStorage()
    localStorage.clear()
    __resetSecretV2StateForTests()
    ensureSecretThreadKey('thread-ready')
    const view = getThreadState('thread-ready')
    expect(view.state).toBe('READY')
    expect(view.reasonCode).toBe(null)
  })

  it('stays waiting before timeout and goes ERROR after timeout without key package', () => {
    const localStorage = installLocalStorage()
    localStorage.clear()
    __resetSecretV2StateForTests()
    markBootstrapReady('thread-wait', true)
    markThreadOpened('thread-wait')
    let view = getThreadState('thread-wait')
    expect(view.state === 'WAITING_KEY_PACKAGE' || view.state === 'NO_KEY').toBe(true)

    // emulate old waitingSince in storage
    localStorage.setItem(
      'eb_secret_v2_runtime_v1',
      JSON.stringify({
        version: 1,
        threads: {
          'thread-wait': {
            threadId: 'thread-wait',
            waitingSince: Date.now() - 130_000,
            bootstrapReady: true,
            updatedAt: Date.now() - 130_000,
          },
        },
      }),
    )
    __reloadSecretV2StateForTests()
    view = getThreadState('thread-wait')
    expect(view.state).toBe('ERROR')
    expect(view.reasonCode === 'TIMEOUT_WAITING_KEY' || view.reasonCode === 'NO_KEYPACKAGE').toBe(true)
  })
})

