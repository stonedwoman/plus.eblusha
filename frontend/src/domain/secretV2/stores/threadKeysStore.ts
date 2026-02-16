import {
  getSecretThreadKey,
  hasSecretThreadKey,
  setSecretThreadKey,
  type SecretThreadKeyRecord,
} from '../../secret/secretThreadKeyStore'

export function hasThreadKey(threadId: string): boolean {
  return hasSecretThreadKey(threadId)
}

export function getThreadKey(threadId: string): SecretThreadKeyRecord | null {
  return getSecretThreadKey(threadId)
}

export function importThreadKey(threadId: string, keyBase64: string) {
  setSecretThreadKey(threadId, keyBase64, { overwrite: true })
}

