import {
  applyIncomingThreadKey,
  getSecretThreadKey,
  hasSecretThreadKey,
  type SecretThreadKeyRecord,
} from '../../secret/secretThreadKeyStore'

export function hasThreadKey(threadId: string): boolean {
  return hasSecretThreadKey(threadId)
}

export function getThreadKey(threadId: string): SecretThreadKeyRecord | null {
  return getSecretThreadKey(threadId)
}

/**
 * Импорт ключа треда. W-H01: без молчаливой перезаписи — при другом ключе прежний остаётся
 * для расшифровки истории (applyIncomingThreadKey). Проверка отправителя — на стороне вызывающего.
 */
export function importThreadKey(threadId: string, keyBase64: string) {
  applyIncomingThreadKey(threadId, keyBase64)
}
