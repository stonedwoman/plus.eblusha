import { ExternalE2EEKeyProvider, type Room, type RoomOptions } from 'livekit-client'
import { api } from './api'

type E2eeKeyResponse = { key: string }

export async function fetchE2eeKey(callId: string): Promise<string> {
  const resp = await api.get<E2eeKeyResponse>(`/calls/${callId}/e2ee-key`)
  const key = String(resp.data?.key ?? '').trim()
  if (!key) {
    throw new Error('Missing E2EE key')
  }
  return key
}

function base64ToBytes(base64: string): Uint8Array {
  const b64 = String(base64 ?? '').trim()
  if (!b64) return new Uint8Array()

  // Browser path
  if (typeof atob === 'function') {
    const bin = atob(b64)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    return bytes
  }

  // Node/Electron (fallback)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const B: any = (globalThis as any).Buffer
  if (B && typeof B.from === 'function') {
    return new Uint8Array(B.from(b64, 'base64'))
  }

  throw new Error('Base64 decode is not supported in this environment')
}

export async function createE2eeRoomOptions(keyBase64: string): Promise<{
  options: RoomOptions
  keyProvider: ExternalE2EEKeyProvider
  worker: Worker
}> {
  const raw = base64ToBytes(keyBase64)
  if (raw.length !== 32) {
    throw new Error(`Invalid E2EE key length: expected 32 bytes, got ${raw.length}`)
  }

  const keyProvider = new ExternalE2EEKeyProvider()
  // Ensure we always pass a plain ArrayBuffer (not SharedArrayBuffer) to the SDK.
  const keyBuf = new ArrayBuffer(raw.byteLength)
  new Uint8Array(keyBuf).set(raw)
  await keyProvider.setKey(keyBuf)

  // LiveKit E2EE worker (Vite-friendly).
  const worker = new Worker(new URL('livekit-client/e2ee-worker', import.meta.url), { type: 'module' })

  const options: RoomOptions = {
    encryption: {
      keyProvider,
      worker,
    },
  }

  return { options, keyProvider, worker }
}

export async function enableE2ee(room: Room): Promise<void> {
  // Room must be created with RoomOptions.encryption for this to work.
  await room.setE2EEEnabled(true)
}

