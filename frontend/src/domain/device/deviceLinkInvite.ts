export type DeviceLinkInvite = {
  token: string
  code: string
  createdAt: number
  expiresAt: number
}

const KEY = 'eb_device_link_invite_v1'
const TTL_MS = 5 * 60_000
const CODE_DIGITS = 8

function now() {
  return Date.now()
}

function randHex(nBytes: number): string {
  const b = new Uint8Array(nBytes)
  crypto.getRandomValues(b)
  return Array.from(b)
    .map((x) => x.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase()
}

function randToken(): string {
  // url-safe, human-unfriendly (intended for QR), not a secret after sharing.
  return `${randHex(16)}${randHex(16)}`
}

function randDigits(n: number): string {
  const len = Math.max(1, Math.floor(n || CODE_DIGITS))
  const bytes = new Uint8Array(len)
  crypto.getRandomValues(bytes)
  let out = ''
  for (let i = 0; i < bytes.length; i += 1) out += String(bytes[i] % 10)
  return out
}

function normalizeDigits(value: string): string {
  return String(value ?? '')
    .replace(/[^\d]/g, '')
    .slice(0, CODE_DIGITS)
}

export function getDeviceLinkInvite(): DeviceLinkInvite | null {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return null
    const p = JSON.parse(raw) as any
    const token = typeof p?.token === 'string' ? p.token.trim() : ''
    const codeRaw = typeof p?.code === 'string' ? p.code.trim() : ''
    const code = normalizeDigits(codeRaw)
    const createdAt = typeof p?.createdAt === 'number' ? p.createdAt : 0
    const expiresAt = typeof p?.expiresAt === 'number' ? p.expiresAt : 0
    if (!token || !code || !expiresAt) return null
    if (code.length !== CODE_DIGITS) return null
    if (now() > expiresAt) return null
    return { token, code, createdAt, expiresAt }
  } catch {
    return null
  }
}

export function createDeviceLinkInvite(): DeviceLinkInvite {
  const invite: DeviceLinkInvite = {
    token: randToken(),
    code: randDigits(CODE_DIGITS),
    createdAt: now(),
    expiresAt: now() + TTL_MS,
  }
  try {
    localStorage.setItem(KEY, JSON.stringify(invite))
  } catch {}
  return invite
}

export function clearDeviceLinkInvite() {
  try {
    localStorage.removeItem(KEY)
  } catch {}
}

export function deviceLinkQrPayload(token: string): string {
  return `EBLUSHA_ADD_DEVICE:${String(token ?? '').trim()}`
}

export function parseDeviceLinkQrPayload(raw: string): string | null {
  const s = String(raw ?? '').trim()
  if (!s) return null
  if (!s.includes('EBLUSHA_ADD_DEVICE:')) return null
  const token = s.split('EBLUSHA_ADD_DEVICE:')[1]?.trim()
  return token ? token : null
}

export function inviteMatches(invite: DeviceLinkInvite, tokenOrCode: string): boolean {
  const raw = String(tokenOrCode ?? '').trim()
  const v = raw.toUpperCase()
  if (!v) return false
  const digits = normalizeDigits(raw)
  if (digits && digits.length === CODE_DIGITS && digits === invite.code) return true
  return v === invite.token.toUpperCase()
}

