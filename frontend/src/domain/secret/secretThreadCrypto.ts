import nacl from 'tweetnacl'
import { base64ToBytes, bytesToBase64, bytesToUtf8, utf8ToBytes } from '../../utils/base64'

export function encryptSecretThreadText(keyBase64: string, plaintext: string): {
  ciphertextBase64: string
  nonceBase64: string
} {
  const key = base64ToBytes(keyBase64)
  if (key.length !== 32) throw new Error('Invalid secret thread key')
  const nonce = nacl.randomBytes(24)
  const plainBytes = utf8ToBytes(String(plaintext ?? ''))
  const cipher = nacl.secretbox(plainBytes, nonce, key)
  return {
    ciphertextBase64: bytesToBase64(cipher),
    nonceBase64: bytesToBase64(nonce),
  }
}

export function decryptSecretThreadText(
  keyBase64: string,
  ciphertextBase64: string,
  nonceBase64: string,
): string | null {
  const key = base64ToBytes(keyBase64)
  if (key.length !== 32) return null
  const nonce = base64ToBytes(String(nonceBase64 ?? ''))
  const cipher = base64ToBytes(String(ciphertextBase64 ?? ''))
  const plain = nacl.secretbox.open(cipher, nonce, key)
  if (!plain) return null
  return bytesToUtf8(plain)
}

