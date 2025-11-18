const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

export function base64ToBytes(base64: string): Uint8Array {
  if (!base64) return new Uint8Array()
  const normalized = base64.replace(/-/g, '+').replace(/_/g, '/')
  const pad = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4))
  const binary = atob(normalized + pad)
  const len = binary.length
  const bytes = new Uint8Array(len)
  for (let i = 0; i < len; i += 1) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '')
}

export function utf8ToBytes(value: string): Uint8Array {
  return textEncoder.encode(value)
}

export function bytesToUtf8(bytes: Uint8Array): string {
  return textDecoder.decode(bytes)
}


