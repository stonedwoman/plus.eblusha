import { api } from '../core/api'
import { cloudApi, setCloudCsrf, toCloudError } from './api'

/**
 * Вход в Cloud — только через существующую сессию Еблуши. Своей регистрации и
 * своих паролей у Cloud нет by design.
 *
 *   SPA (Bearer Еблуши) → POST /api/cloud/auth/authorize → одноразовый code
 *   SPA (без Bearer)    → POST /api/cloud/auth/token     → HttpOnly cloud_sid
 *
 * PKCE (S256) здесь не «для галочки»: код живёт две минуты и валиден один раз,
 * но без verifier'а перехваченный код всё равно бесполезен.
 */
const CLIENT_ID = 'eblusha-cloud-web'

export type CloudMe = {
  user: { id: string; username: string; displayName: string | null; avatarUrl: string | null }
  csrf: string
  isAdmin: boolean
  spaceCount: number
  limits: { maxFileBytes: number; trashRetentionDays: number }
  map: { tileUrl: string; attribution: string }
}

function base64url(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function randomVerifier(): string {
  const bytes = new Uint8Array(48)
  crypto.getRandomValues(bytes)
  return base64url(bytes)
}

async function challengeFor(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  return base64url(new Uint8Array(digest))
}

/** Уже есть живая сессия Cloud? */
export async function fetchCloudMe(): Promise<CloudMe | null> {
  try {
    const { data } = await cloudApi.get<CloudMe>('/me')
    setCloudCsrf(data.csrf)
    return data
  } catch (err) {
    const e = toCloudError(err)
    if (e.status === 401) return null
    throw err
  }
}

/** Полный обмен: сессия Еблуши → код → сессия Cloud. */
export async function loginToCloud(redirectUri = '/cloud'): Promise<CloudMe> {
  const verifier = randomVerifier()
  const codeChallenge = await challengeFor(verifier)

  // Этот запрос идёт обычным клиентом мессенджера — он приложит Bearer.
  const { data: authorized } = await api.post<{ code: string }>('/cloud/auth/authorize', {
    clientId: CLIENT_ID,
    redirectUri,
    codeChallenge,
    codeChallengeMethod: 'S256',
  })

  await cloudApi.post('/auth/token', {
    code: authorized.code,
    codeVerifier: verifier,
    clientId: CLIENT_ID,
  })

  const me = await fetchCloudMe()
  if (!me) throw new Error('Cloud session was not established')
  return me
}

export async function ensureCloudSession(): Promise<CloudMe> {
  const existing = await fetchCloudMe()
  if (existing) return existing
  return loginToCloud()
}

export async function logoutFromCloud(): Promise<void> {
  try {
    await cloudApi.post('/auth/logout')
  } finally {
    setCloudCsrf(null)
  }
}
