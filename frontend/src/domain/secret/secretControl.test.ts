import { describe, expect, it } from 'vitest'
import { isSecretControlHeader } from './secretControl'

describe('secretControl', () => {
  it('accepts key_receipt and key_request only', () => {
    expect(isSecretControlHeader({ kind: 'control', type: 'key_receipt' })).toBe(true)
    expect(isSecretControlHeader({ kind: 'control', type: 'key_request' })).toBe(true)
    expect(isSecretControlHeader({ kind: 'control', type: 'unknown' })).toBe(false)
    expect(isSecretControlHeader({ kind: 'key_package', type: 'key_receipt' })).toBe(false)
  })
})

