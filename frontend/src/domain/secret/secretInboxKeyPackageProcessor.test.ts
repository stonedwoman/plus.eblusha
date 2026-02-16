import { describe, expect, it } from 'vitest'
import { processKeyPackageBatch } from './secretInboxKeyPackageProcessor'
import type { KeyPackageDecryptAttempt } from './secretKeyPackages'

function okAttempt(kind: string): KeyPackageDecryptAttempt {
  return {
    ok: true,
    kind,
    payload: { kind },
    debug: { prekeyId: 'pk1', opkSecretFound: true, decryptOk: true },
  }
}

function failAttempt(rootCause: any): KeyPackageDecryptAttempt {
  return {
    ok: false,
    rootCause,
    debug: { prekeyId: 'pk1', opkSecretFound: false, decryptOk: false },
  }
}

describe('processKeyPackageBatch', () => {
  it('does not ack key_package when decrypt fails', () => {
    const { ackIds } = processKeyPackageBatch({
      items: [{ msgId: 'm1', headerJson: { kind: 'key_package' } }],
      decrypt: () => failAttempt('OPK_SECRET_MISS'),
      apply: () => true,
      bumpAttempt: () => ({ count: 1, poisoned: false }),
    })
    expect(ackIds).toEqual([])
  })

  it('does not block: later key_package can be acked even if first fails', () => {
    const { ackIds } = processKeyPackageBatch({
      items: [
        { msgId: 'm1', headerJson: { kind: 'key_package' } },
        { msgId: 'm2', headerJson: { kind: 'key_package' } },
      ],
      decrypt: (item) => (item.msgId === 'm1' ? failAttempt('DECRYPT_FAIL') : okAttempt('thread_key')),
      apply: () => true,
      bumpAttempt: () => ({ count: 1, poisoned: false }),
    })
    expect(ackIds).toEqual(['m2'])
  })

  it('acks poisoned key_package to unblock inbox', () => {
    const { ackIds } = processKeyPackageBatch({
      items: [{ msgId: 'm1', headerJson: { kind: 'key_package' } }],
      decrypt: () => failAttempt('DECRYPT_FAIL'),
      apply: () => true,
      bumpAttempt: () => ({ count: 25, poisoned: true }),
    })
    expect(ackIds).toEqual(['m1'])
  })

  it('does not ack when apply/import fails even if decrypt ok', () => {
    const { ackIds } = processKeyPackageBatch({
      items: [{ msgId: 'm1', headerJson: { kind: 'key_package' } }],
      decrypt: () => okAttempt('thread_key'),
      apply: () => false,
      bumpAttempt: () => ({ count: 1, poisoned: false }),
    })
    expect(ackIds).toEqual([])
  })
})

