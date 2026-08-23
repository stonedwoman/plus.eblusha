import { api } from '../core/api'
import { useAppStore } from '../domain/store/appStore'
import { cloudApi, setCloudCsrf, toCloudError } from './api'
import { cloudPath, cloudUrl, isCloudPath } from './basePath'

/**
 * Вход в Cloud — только через существующую сессию Еблуши. Своей регистрации и
 * своих паролей у Cloud нет by design.
 *
 * Работает в двух конфигурациях, и это одна и та же схема, а не две разные:
 *
 *  1. Cloud на том же origin (eblusha.org/cloud). Токен Еблуши лежит рядом,
 *     поэтому код запрашивается сразу XHR-запросом — без мигания редиректами.
 *
 *  2. Cloud на отдельном поддомене (cloud.eblusha.org). Здесь localStorage
 *     ДРУГОЙ, токена мессенджера нет и быть не может. Тогда браузер уходит на
 *     origin мессенджера за одноразовым кодом и возвращается с ним обратно:
 *
 *       cloud.eblusha.org  ──► eblusha.org/cloud-auth?code_challenge=…&state=…
 *                          ◄── cloud.eblusha.org/cloud/callback?code=…&state=…
 *                          ──► POST /api/cloud/auth/token → HttpOnly cloud_sid
 *
 * PKCE здесь работает как задумано: verifier не покидает origin Cloud, наружу
 * уходит только challenge. Перехваченный код без verifier бесполезен, а state
 * защищает сам редирект от подделки.
 */
const CLIENT_ID = 'eblusha-cloud-web'
const PKCE_STORAGE_KEY = 'eb-cloud-pkce-v1'

export type CloudMe = {
  user: { id: string; username: string; displayName: string | null; avatarUrl: string | null }
  csrf: string
  isAdmin: boolean
  spaceCount: number
  limits: { maxFileBytes: number; trashRetentionDays: number }
  map: { tileUrl: string; attribution: string }
}

type AuthConfig = { clientId: string; messengerOrigin: string; crossOrigin: boolean }

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

async function fetchAuthConfig(): Promise<AuthConfig> {
  const { data } = await cloudApi.get<AuthConfig>('/auth/config')
  return data
}

function hasMessengerSession(): boolean {
  try {
    return Boolean(useAppStore.getState().session?.accessToken)
  } catch {
    return false
  }
}

/** Быстрый путь: сессия Еблуши доступна в этом же origin. */
async function loginSameOrigin(): Promise<CloudMe> {
  const verifier = randomVerifier()
  const codeChallenge = await challengeFor(verifier)

  // Этот запрос идёт клиентом мессенджера — он приложит Bearer.
  const { data: authorized } = await api.post<{ code: string }>('/cloud/auth/authorize', {
    clientId: CLIENT_ID,
    redirectUri: cloudPath(),
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

type PkceState = { verifier: string; state: string; returnTo: string }

function stashPkce(value: PkceState): void {
  // sessionStorage, а не localStorage: verifier живёт ровно одну вкладку и одну
  // попытку входа, переживать её незачем.
  sessionStorage.setItem(PKCE_STORAGE_KEY, JSON.stringify(value))
}

function takePkce(): PkceState | null {
  const raw = sessionStorage.getItem(PKCE_STORAGE_KEY)
  sessionStorage.removeItem(PKCE_STORAGE_KEY)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as PkceState
    if (parsed.verifier && parsed.state) return parsed
  } catch {
    // мусор в хранилище — считаем, что состояния нет
  }
  return null
}

/** Уводит браузер на origin мессенджера за кодом. Не возвращается. */
async function redirectForCode(config: AuthConfig): Promise<never> {
  const verifier = randomVerifier()
  const codeChallenge = await challengeFor(verifier)
  const state = base64url(crypto.getRandomValues(new Uint8Array(24)))

  // Куда вернуть человека после входа — вместе с search и hash: в ссылке-
  // приглашении секрет лежит именно во фрагменте, и терять его нельзя.
  const returnTo = `${window.location.pathname}${window.location.search}${window.location.hash}`
  stashPkce({ verifier, state, returnTo })

  const sameOrigin = config.messengerOrigin === window.location.origin
  const redirectUri = sameOrigin ? cloudPath('/callback') : cloudUrl('/callback')

  const url = new URL('/cloud-auth', config.messengerOrigin)
  url.searchParams.set('client_id', config.clientId || CLIENT_ID)
  url.searchParams.set('redirect_uri', redirectUri)
  url.searchParams.set('state', state)
  url.searchParams.set('code_challenge', codeChallenge)
  url.searchParams.set('code_challenge_method', 'S256')

  window.location.replace(url.toString())
  // Навигация уже назначена; промис намеренно не резолвится.
  return new Promise<never>(() => {})
}

export async function ensureCloudSession(): Promise<CloudMe> {
  const existing = await fetchCloudMe()
  if (existing) return existing

  const config = await fetchAuthConfig()
  if (!config.crossOrigin && hasMessengerSession()) return loginSameOrigin()
  return redirectForCode(config)
}

/** Обработка возврата с кодом на /cloud/callback. Возвращает путь для перехода. */
export async function completeCloudCallback(search: string): Promise<{ me: CloudMe; returnTo: string }> {
  const params = new URLSearchParams(search)
  const code = params.get('code')
  const state = params.get('state')
  const stashed = takePkce()

  if (!code || !state) throw new Error('В ответе нет кода авторизации')
  if (!stashed) throw new Error('Состояние входа потеряно — попробуйте открыть Cloud заново')
  if (stashed.state !== state) throw new Error('State не совпал — вход отклонён')

  await cloudApi.post('/auth/token', {
    code,
    codeVerifier: stashed.verifier,
    clientId: CLIENT_ID,
  })

  const me = await fetchCloudMe()
  if (!me) throw new Error('Сессия Cloud не установилась')
  const safe = stashed.returnTo && isCloudPath(stashed.returnTo) ? stashed.returnTo : cloudPath()
  // Возврат на сам callback зациклил бы вход.
  return { me, returnTo: safe === cloudPath('/callback') ? cloudPath() : safe }
}

export async function logoutFromCloud(): Promise<void> {
  try {
    await cloudApi.post('/auth/logout')
  } finally {
    setCloudCsrf(null)
  }
}
