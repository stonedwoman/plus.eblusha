import axios from 'axios'
import nacl from 'tweetnacl'
import { api } from '../../utils/api'
import { getDefaultStorageAdapter } from '../../core/storage'
import { wipeLocalDeviceData } from './deviceWipe'

const DEVICE_INFO_KEY = 'eb_device_info_v1'
const DEVICE_SECRET_KEY = 'eb_device_secret_v1'
const DEFAULT_PREKEY_BATCH = 50
const MIN_SERVER_PREKEY_RESERVE = 20
// Потолок неизрасходованных OPK на устройство на СЕРВЕРЕ (devices.ts MAX_UNCONSUMED_PREKEYS_PER_DEVICE).
// Лишнее сервер и так не примет (insertedKeyIds), это лишь чтобы не генерировать впустую.
const SERVER_MAX_UNCONSUMED_PREKEYS = 250
// H04: секрет OPK, который сервер давно выдал (claim) и по которому пакет так и не пришёл, —
// мусор: пакеты живут во входящих ≤ 7 суток. Чистим старше 14 суток вне окна «свежих».
const STALE_PREKEY_SECRET_MS = 14 * 24 * 60 * 60_000
const PREKEY_PRUNE_SLACK = 50
const SERVER_STATE_CACHE_MS = 30_000
// Keep this low: missing OPKs blocks key delivery. We still guard with rate limiting server-side.
const PREKEY_PUBLISH_COOLDOWN_MS = 5_000
const DEVICE_REGISTER_SYNC_TTL_MS = 10 * 60_000
const storage = getDefaultStorageAdapter()

type StoredDeviceInfo = {
  deviceId: string
  name: string
  platform?: string | null
  publicKey: string
  registeredAt: number
}

type StoredDeviceSecrets = {
  deviceId: string
  identitySecret: string
  prekeys: Record<string, string>
  /** Когда сгенерирован секрет OPK (мс) — для чистки устаревших (H04). Старые записи без поля. */
  prekeyCreatedAt?: Record<string, number>
}

type GeneratedPrekey = {
  keyId: string
  publicKey: string
  secretKey: string
}

export type DeviceBootstrapResult = {
  deviceId: string
  publicKey: string
  name?: string
  platform?: string | null
}

let bootstrapPromise: Promise<DeviceBootstrapResult | null> | null = null
let lastForcePublishAt = 0
let lastSuccessfulRegisterAt = 0

type EnsureDeviceBootstrapOptions = {
  forceRegister?: boolean
  skipReserveCheck?: boolean
}

function secretDebugEnabled(): boolean {
  try {
    if (typeof window === 'undefined') return false
    const q = String(window.location?.search ?? '')
    if (q.includes('SECRET_DEBUG=1')) return true
    return storage.getItem('eb_secret_debug') === '1'
  } catch {
    return false
  }
}

function isDeviceBelongsToAnotherUserConflict(err: unknown): boolean {
  if (!axios.isAxiosError(err)) return false
  if (err.response?.status !== 409) return false
  const msg = String((err.response?.data as any)?.message ?? err.message ?? '').toLowerCase()
  return msg.includes('another user') || msg.includes('друг') || msg.includes('чуж')
}

/**
 * X5: сервер сообщает, что ЭТОТ id отозван (публикация OPK — 409 «Device is revoked»; после S5 —
 * регистрация 409/410 DEVICE_REVOKED). Такой id нельзя «оживлять» перерегистрацией.
 */
export function isDeviceRevokedError(err: unknown): boolean {
  if (!axios.isAxiosError(err)) return false
  const status = err.response?.status
  if (status !== 409 && status !== 410) return false
  const data = (err.response?.data as any) ?? {}
  const code = String(data?.code ?? '').toUpperCase()
  const msg = String(data?.message ?? err.message ?? '').toLowerCase()
  return code === 'DEVICE_REVOKED' || msg.includes('revoked')
}

type ServerDeviceState = { found: boolean; revoked: boolean; availablePrekeys: number | null }
let serverStateCache: { deviceId: string; at: number; state: ServerDeviceState } | null = null

/** Как сервер видит это устройство (GET /devices — свои устройства, вместе с отозванными). */
async function fetchServerDeviceState(deviceId: string, opts?: { fresh?: boolean }): Promise<ServerDeviceState> {
  const id = String(deviceId ?? '').trim()
  const now = Date.now()
  if (!opts?.fresh && serverStateCache && serverStateCache.deviceId === id && now - serverStateCache.at < SERVER_STATE_CACHE_MS) {
    return serverStateCache.state
  }
  const resp = await api.get('/devices')
  const row = ((resp.data?.devices ?? []) as any[]).find((d) => String(d?.id ?? '').trim() === id)
  const state: ServerDeviceState = {
    found: !!row,
    revoked: !!row?.revokedAt,
    availablePrekeys: row && typeof row.availablePrekeys === 'number' ? row.availablePrekeys : null,
  }
  serverStateCache = { deviceId: id, at: now, state }
  return state
}

/**
 * W-X5: устройство отозвано (владелец сделал это в «Устройствах» или это украденный телефон).
 * Ключи секреток и само устройство стираем, НОВЫЙ id заведётся при следующем входе; отозванный
 * id больше не перерегистрируем (раньше register молча снимал отзыв — «воскрешение», X5).
 * Выход из сессии делает utils/socket.ts по событию eb:device:revoked — как при device:revoked.
 */
function handleLocalDeviceRevoked(source: string) {
  try {
    console.warn('[deviceManager] this device is revoked on the server — wiping local keys', { source })
  } catch {}
  serverStateCache = null
  lastSuccessfulRegisterAt = 0
  wipeLocalDeviceData()
  try {
    if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('eb:device:revoked', { detail: { source } }))
  } catch {}
}

function isDeviceMissingError(err: unknown): boolean {
  if (!axios.isAxiosError(err)) return false
  if (err.response?.status !== 404) return false
  const msg = String((err.response?.data as any)?.message ?? err.message ?? '').toLowerCase()
  return msg.includes('device not found') || msg.includes('device not available')
}

function getLocallyBootstrappedDeviceId(): string | null {
  const info = loadDeviceInfo()
  const secrets = loadDeviceSecrets()
  if (!info || !secrets) return null
  if (info.deviceId !== secrets.deviceId) return null
  return info.deviceId
}

function countStoredPrekeys(deviceId: string): number {
  const secrets = loadDeviceSecrets()
  if (!secrets || secrets.deviceId !== deviceId) return 0
  return Object.keys(secrets.prekeys).length
}

function appendStoredPrekeys(deviceId: string, prekeys: GeneratedPrekey[]) {
  if (!prekeys.length) return
  const secrets = loadDeviceSecrets()
  if (!secrets || secrets.deviceId !== deviceId) return
  const now = Date.now()
  const createdAt = { ...(secrets.prekeyCreatedAt ?? {}) }
  for (const pk of prekeys) {
    secrets.prekeys[pk.keyId] = pk.secretKey
    createdAt[pk.keyId] = now
  }
  secrets.prekeyCreatedAt = createdAt
  saveDeviceSecrets(secrets)
}

/**
 * H04: чистка секретов OPK, которые уже никогда не понадобятся. Сервер раздаёт OPK от старых к
 * новым (ORDER BY createdAt ASC), значит неизрасходованные на сервере — это самые свежие
 * `serverAvailable` штук. Всё, что старше этого окна (+запас) И старше 14 суток (пакет по такому
 * OPK давно истёк бы во входящих), удаляем.
 *
 * «Свежесть» — ПОРЯДОК ВСТАВКИ в карту секретов (новые OPK всегда дописываются в конец, ключи —
 * UUID, так что JSON сохраняет порядок), а НЕ prekeyCreatedAt: у записей до этой правки даты нет,
 * при первой чистке они все получают одну и ту же отметку «сейчас» — позже, чем у уже датированных,
 * — и сортировка по дате ставила бы самые СТАРЫЕ легаси-секреты в окно, а через 14 суток удаляла бы
 * самые НОВЫЕ, то есть как раз те, чьи OPK сервер ещё не раздал. Дата нужна только для порога
 * «старше 14 суток»: легаси-записи чистятся не раньше чем через 14 суток после первой отметки.
 */
function pruneStalePrekeySecrets(deviceId: string, serverAvailable: number) {
  const secrets = loadDeviceSecrets()
  if (!secrets || secrets.deviceId !== deviceId) return
  const now = Date.now()
  const createdAt = { ...(secrets.prekeyCreatedAt ?? {}) }
  let changed = false
  for (const keyId of Object.keys(secrets.prekeys)) {
    if (typeof createdAt[keyId] !== 'number') {
      createdAt[keyId] = now
      changed = true
    }
  }
  for (const keyId of Object.keys(createdAt)) {
    if (!secrets.prekeys[keyId]) {
      delete createdAt[keyId]
      changed = true
    }
  }
  const newestFirst = Object.keys(secrets.prekeys).reverse()
  const keepWindow = Math.max(0, Math.floor(serverAvailable)) + PREKEY_PRUNE_SLACK
  for (let i = keepWindow; i < newestFirst.length; i += 1) {
    const keyId = newestFirst[i]!
    if (now - (createdAt[keyId] ?? now) > STALE_PREKEY_SECRET_MS) {
      delete secrets.prekeys[keyId]
      delete createdAt[keyId]
      changed = true
    }
  }
  if (changed) {
    secrets.prekeyCreatedAt = createdAt
    saveDeviceSecrets(secrets)
  }
}

function dropStoredPrekeys(deviceId: string, keyIds: string[]) {
  if (!keyIds.length) return
  const secrets = loadDeviceSecrets()
  if (!secrets || secrets.deviceId !== deviceId) return
  let changed = false
  for (const keyId of keyIds) {
    if (!keyId || !secrets.prekeys[keyId]) continue
    delete secrets.prekeys[keyId]
    changed = true
  }
  if (changed) saveDeviceSecrets(secrets)
}

function filterAcceptedPrekeys(prekeys: GeneratedPrekey[], insertedKeyIds: unknown): GeneratedPrekey[] {
  if (!Array.isArray(insertedKeyIds)) return prekeys
  const accepted = new Set(insertedKeyIds.filter((keyId): keyId is string => typeof keyId === 'string' && !!keyId))
  return prekeys.filter((pk) => accepted.has(pk.keyId))
}

async function publishPrekeysBatch(deviceId: string, count: number, opts?: { reason?: string }) {
  const id = String(deviceId ?? '').trim()
  if (!id) return
  const n = Math.max(1, Math.min(200, Math.floor(count || DEFAULT_PREKEY_BATCH)))
  const secrets = loadDeviceSecrets()
  if (!secrets || secrets.deviceId !== id) return

  const prekeys = generatePrekeys(n)
  appendStoredPrekeys(id, prekeys)

  try {
    const response = await api.post<{ insertedKeyIds?: string[] }>(`/devices/${id}/prekeys`, {
      prekeys: prekeys.map((pk) => ({ keyId: pk.keyId, publicKey: pk.publicKey })),
    })
    const acceptedPrekeys = filterAcceptedPrekeys(prekeys, response.data?.insertedKeyIds)
    const acceptedKeyIds = new Set(acceptedPrekeys.map((pk) => pk.keyId))
    const skippedKeyIds = prekeys.filter((pk) => !acceptedKeyIds.has(pk.keyId)).map((pk) => pk.keyId)
    if (skippedKeyIds.length) {
      dropStoredPrekeys(id, skippedKeyIds)
    }

    if (secretDebugEnabled()) {
      // eslint-disable-next-line no-console
      console.log('[deviceManager] published prekeys', {
        deviceId: id,
        published: acceptedPrekeys.length,
        skipped: skippedKeyIds.length,
        reason: opts?.reason ?? null,
      })
    }
  } catch (error) {
    // For explicit server-side failures we know nothing was accepted, so rollback optimistic secrets.
    if (axios.isAxiosError(error) && error.response) {
      dropStoredPrekeys(id, prekeys.map((pk) => pk.keyId))
    }
    throw error
  }
}

/**
 * H04: сколько OPK публиковать. Раньше считалось по ЛОКАЛЬНЫМ секретам: секреты OPK, которые
 * сервер уже раздал (а пакет не пришёл), копились, и при 200 локальных публикация вставала
 * навсегда (потолок 200), хотя на сервере OPK не осталось, — отсюда шторм prekeys_needed.
 * Теперь меряем по счётчику СЕРВЕРА (GET /devices → availablePrekeys) и чистим устаревшие секреты.
 * Возвращает null, если устройство отозвано (публиковать нельзя).
 */
async function computePrekeyPublishCount(deviceId: string, requestedCount: number, force: boolean): Promise<number | null> {
  const boundedRequested = Math.max(1, Math.min(200, Math.floor(requestedCount || DEFAULT_PREKEY_BATCH)))
  let state: ServerDeviceState | null = null
  try {
    state = await fetchServerDeviceState(deviceId, { fresh: force })
  } catch {
    state = null
  }
  if (state?.revoked) return null
  if (state?.found && typeof state.availablePrekeys === 'number') {
    pruneStalePrekeySecrets(deviceId, state.availablePrekeys)
    if (!force && state.availablePrekeys >= MIN_SERVER_PREKEY_RESERVE) return 0
    const room = Math.max(0, SERVER_MAX_UNCONSUMED_PREKEYS - state.availablePrekeys)
    return Math.min(boundedRequested, room)
  }
  // Сервер не ответил — по локальной оценке, но без «вечного» потолка.
  if (!force && countStoredPrekeys(deviceId) >= MIN_SERVER_PREKEY_RESERVE) return 0
  return boundedRequested
}

async function publishPrekeysWithRecovery(deviceId: string, count: number, opts?: { reason?: string }) {
  if (count <= 0) return
  try {
    await publishPrekeysBatch(deviceId, count, { reason: opts?.reason })
  } catch (error) {
    if (isDeviceRevokedError(error)) {
      handleLocalDeviceRevoked('prekey_publish')
      return
    }
    if (!isDeviceMissingError(error)) throw error
    const boot = await ensureDeviceBootstrap({ forceRegister: true, skipReserveCheck: true })
    const retryDeviceId = String(boot?.deviceId ?? '').trim()
    if (!retryDeviceId) throw error
    await publishPrekeysBatch(retryDeviceId, count, {
      reason: opts?.reason ? `${opts.reason}_after_register` : 'after_register',
    })
  }
}

export async function forcePublishPrekeys(opts?: { count?: number; reason?: string; force?: boolean }) {
  const now = Date.now()
  const force = !!opts?.force
  if (!force && now - lastForcePublishAt < PREKEY_PUBLISH_COOLDOWN_MS) return
  let deviceId = getLocallyBootstrappedDeviceId()
  if (!deviceId) {
    const boot = await ensureDeviceBootstrap({ skipReserveCheck: true })
    deviceId = String(boot?.deviceId ?? '').trim() || null
  }
  if (!deviceId) return
  const publishCount = await computePrekeyPublishCount(deviceId, opts?.count ?? DEFAULT_PREKEY_BATCH, force)
  if (publishCount === null) {
    handleLocalDeviceRevoked('prekey_publish_check')
    return
  }
  if (publishCount <= 0) return
  await publishPrekeysWithRecovery(deviceId, publishCount, { reason: opts?.reason })
  // Only advance cooldown after a successful publish.
  lastForcePublishAt = Date.now()
}

async function maybeEnsureLocalPrekeyReserve(deviceId: string) {
  try {
    if (Date.now() - lastForcePublishAt < PREKEY_PUBLISH_COOLDOWN_MS) return
    const publishCount = await computePrekeyPublishCount(deviceId, DEFAULT_PREKEY_BATCH, false)
    if (publishCount === null) {
      handleLocalDeviceRevoked('prekey_reserve_check')
      return
    }
    if (publishCount <= 0) return
    await publishPrekeysWithRecovery(deviceId, publishCount, { reason: 'reserve_low' })
    lastForcePublishAt = Date.now()
    if (secretDebugEnabled()) {
      // eslint-disable-next-line no-console
      console.log('[deviceManager] replenished prekeys', {
        deviceId,
        published: publishCount,
        previousAvailable: countStoredPrekeys(deviceId),
      })
    }
  } catch (err) {
    if (secretDebugEnabled()) {
      // eslint-disable-next-line no-console
      console.warn('[deviceManager] prekey replenish failed', err)
    }
  }
}

export function ensureDeviceBootstrap(opts: EnsureDeviceBootstrapOptions = {}): Promise<DeviceBootstrapResult | null> {
  if (bootstrapPromise) return bootstrapPromise
  bootstrapPromise = (async () => {
    try {
      let storedInfo = loadDeviceInfo()
      let storedSecret = loadDeviceSecrets()

      if (storedInfo && storedSecret && storedInfo.deviceId === storedSecret.deviceId) {
        const desiredName = detectDeviceName()
        const desiredPlatform = detectPlatform()
        if (storedInfo.name !== desiredName || storedInfo.platform !== desiredPlatform) {
          saveDeviceInfo({
            ...storedInfo,
            name: desiredName,
            platform: desiredPlatform,
          })
          storedInfo = {
            ...storedInfo,
            name: desiredName,
            platform: desiredPlatform,
          }
        }
        try {
          const shouldSyncRegistration =
            !!opts.forceRegister ||
            !lastSuccessfulRegisterAt ||
            Date.now() - lastSuccessfulRegisterAt >= DEVICE_REGISTER_SYNC_TTL_MS
          if (shouldSyncRegistration) {
            // W-X5: отозванный id НЕ перерегистрируем (register снимал отзыв — «воскрешение»).
            // Различаем «отозван» и «id не признан» (восстановление БД, смена id после refresh —
            // самолечение перерегистрацией сохраняется): спрашиваем сервер о СВОЁМ устройстве.
            let serverState: ServerDeviceState | null = null
            try {
              serverState = await fetchServerDeviceState(storedInfo.deviceId, { fresh: true })
            } catch {
              serverState = null // сеть — действуем как раньше
            }
            if (serverState?.revoked) {
              handleLocalDeviceRevoked('register_sync')
              return null
            }
            // Re-register only when forced or on a coarse TTL so we can self-heal after DB restores
            // without hammering the backend on every publish/poll loop.
            await api.post('/devices/register', {
              deviceId: storedInfo.deviceId,
              name: storedInfo.name,
              platform: storedInfo.platform,
              publicKey: storedInfo.publicKey,
            })
            lastSuccessfulRegisterAt = Date.now()
          }
        } catch (metadataError) {
          // CRITICAL: If this stored deviceId belongs to another user (e.g. browser reused localStorage across accounts),
          // we must wipe local device material and bootstrap a fresh device.
          if (isDeviceBelongsToAnotherUserConflict(metadataError)) {
            console.warn('[deviceManager] stored device belongs to another user; re-bootstrapping this device')
            clearStoredDevice()
            storedInfo = null
            storedSecret = null
          } else if (isDeviceRevokedError(metadataError)) {
            // После серверного S5 регистрация отозванного id отвечает 409/410 — не зацикливаемся.
            handleLocalDeviceRevoked('register_rejected')
            return null
          } else {
            console.warn('Device metadata sync failed:', metadataError)
          }
        }

        if (storedInfo && storedSecret && storedInfo.deviceId === storedSecret.deviceId) {
          if (!opts.skipReserveCheck) {
            // Best-effort: keep some local OPKs ready, without calling /devices on every bootstrap.
            void maybeEnsureLocalPrekeyReserve(storedInfo.deviceId)
          }
          return {
            deviceId: storedInfo.deviceId,
            publicKey: storedInfo.publicKey,
            name: storedInfo.name,
            platform: storedInfo.platform,
          }
        }
      }

      // Fresh bootstrap: generate new deviceId + identity + OPKs, and publish them.
      // If we still hit a 409 (deviceId belongs to another user), retry with a new deviceId.
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const deviceId = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`
        const identityPair = nacl.box.keyPair()
        const identityPublic = toBase64(identityPair.publicKey)
        const identitySecret = toBase64(identityPair.secretKey)
        const prekeys = generatePrekeys(DEFAULT_PREKEY_BATCH)

        const payload = {
          deviceId,
          name: detectDeviceName(),
          platform: detectPlatform(),
          publicKey: identityPublic,
          prekeys: prekeys.map((pk) => ({ keyId: pk.keyId, publicKey: pk.publicKey })),
        }

        let registerResponse: { data?: { insertedKeyIds?: string[] } } | null = null
        try {
          registerResponse = await api.post<{ insertedKeyIds?: string[] }>('/devices/register', payload)
        } catch (registerError) {
          if (isDeviceBelongsToAnotherUserConflict(registerError)) {
            console.warn('[deviceManager] deviceId conflict (belongs to another user), retrying', { attempt })
            continue
          }
          throw registerError
        }

        const acceptedPrekeys = filterAcceptedPrekeys(prekeys, registerResponse?.data?.insertedKeyIds)
        saveDeviceInfo({
          deviceId,
          name: payload.name,
          platform: payload.platform,
          publicKey: identityPublic,
          registeredAt: Date.now(),
        })
        saveDeviceSecrets({
          deviceId,
          identitySecret,
          prekeys: acceptedPrekeys.reduce<Record<string, string>>((acc, pk) => {
            acc[pk.keyId] = pk.secretKey
            return acc
          }, {}),
        })
        lastSuccessfulRegisterAt = Date.now()

        return { deviceId, publicKey: identityPublic, name: payload.name, platform: payload.platform ?? undefined }
      }

      throw new Error('DEVICE_REGISTER_CONFLICT')
    } catch (error) {
      console.error('Device bootstrap failed:', error)
      return null
    } finally {
      bootstrapPromise = null
    }
  })()
  return bootstrapPromise
}

export function getStoredDeviceInfo(): DeviceBootstrapResult | null {
  const info = loadDeviceInfo()
  if (!info) return null
  return {
    deviceId: info.deviceId,
    publicKey: info.publicKey,
    name: info.name,
    platform: info.platform ?? undefined,
  }
}

export function getIdentityKeyPair(): { publicKey: string; secretKey: string } | null {
  const info = loadDeviceInfo()
  const secrets = loadDeviceSecrets()
  if (!info || !secrets) return null
  if (info.deviceId !== secrets.deviceId) return null
  return {
    publicKey: info.publicKey,
    secretKey: secrets.identitySecret,
  }
}

function clearStoredDevice() {
  try {
    storage.removeItem(DEVICE_INFO_KEY)
    storage.removeItem(DEVICE_SECRET_KEY)
  } catch {}
}

export async function rebootstrapDevice(): Promise<DeviceBootstrapResult | null> {
  clearStoredDevice()
  return ensureDeviceBootstrap()
}

export function getPrekeySecret(keyId: string): string | null {
  const secrets = loadDeviceSecrets()
  if (!secrets || !secrets.prekeys[keyId]) {
    return null
  }
  return secrets.prekeys[keyId]
}

export function consumePrekeySecret(keyId: string): string | null {
  const secrets = loadDeviceSecrets()
  if (!secrets || !secrets.prekeys[keyId]) return null
  const secret = secrets.prekeys[keyId]
  delete secrets.prekeys[keyId]
  saveDeviceSecrets(secrets)
  return secret
}

function loadDeviceInfo(): StoredDeviceInfo | null {
  try {
    const raw = storage.getItem(DEVICE_INFO_KEY)
    if (!raw) return null
    return JSON.parse(raw) as StoredDeviceInfo
  } catch {
    return null
  }
}

function saveDeviceInfo(info: StoredDeviceInfo) {
  try {
    storage.setItem(DEVICE_INFO_KEY, JSON.stringify(info))
  } catch {}
}

function loadDeviceSecrets(): StoredDeviceSecrets | null {
  try {
    const raw = storage.getItem(DEVICE_SECRET_KEY)
    if (!raw) return null
    return JSON.parse(raw) as StoredDeviceSecrets
  } catch {
    return null
  }
}

function saveDeviceSecrets(data: StoredDeviceSecrets) {
  try {
    storage.setItem(DEVICE_SECRET_KEY, JSON.stringify(data))
  } catch {}
}

function generatePrekeys(count: number): GeneratedPrekey[] {
  const list: GeneratedPrekey[] = []
  for (let i = 0; i < count; i += 1) {
    const pair = nacl.box.keyPair()
    const keyId = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${i}-${Math.random().toString(36).slice(2)}`
    list.push({
      keyId,
      publicKey: toBase64(pair.publicKey),
      secretKey: toBase64(pair.secretKey),
    })
  }
  return list
}

export function isElectron(): boolean {
  try {
    if (typeof navigator !== 'undefined' && /Electron/i.test(navigator.userAgent || '')) return true
    if (typeof (window as any)?.process?.versions?.electron === 'string') return true
    return false
  } catch {
    return false
  }
}

function detectDeviceName(): string {
  try {
    if (isElectron()) return 'Еблуша для ПК'
    const userAgentData = (navigator as any).userAgentData
    if (userAgentData && Array.isArray(userAgentData.brands)) {
      const preferredBrand = userAgentData.brands.find(
        (entry: { brand: string }) => entry?.brand && !/not.*brand/i.test(entry.brand) && !/generic/i.test(entry.brand),
      )
      if (preferredBrand?.brand) {
        return `${preferredBrand.brand} (${detectPlatformLabel()})`
      }
    }
    const ua = navigator.userAgent || ''
    if (/iPhone/i.test(ua)) return 'iPhone'
    if (/iPad/i.test(ua)) return 'iPad'
    if (/Android/i.test(ua)) return 'Android'
    if (/Macintosh/i.test(ua)) return 'Mac'
    if (/Windows/i.test(ua)) return 'Windows'
    const platform = detectPlatformLabel()
    if (platform !== 'Web') {
      return platform
    }
    return 'Браузер'
  } catch {
    return 'Браузер'
  }
}

function detectPlatform(): string {
  try {
    if (isElectron()) return 'Еблуша для ПК'
    const uaPlatform = (navigator as any).userAgentData?.platform
    return (uaPlatform || navigator.platform || 'web').toString()
  } catch {
    return 'web'
  }
}

function detectPlatformLabel(): string {
  const platform = detectPlatform().toLowerCase()
  if (platform.includes('mac')) return 'Mac'
  if (platform.includes('win')) return 'Windows'
  if (platform.includes('iphone')) return 'iPhone'
  if (platform.includes('ipad')) return 'iPad'
  if (platform.includes('android')) return 'Android'
  if (platform.includes('linux')) return 'Linux'
  return 'Web'
}

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  const len = bytes.byteLength
  for (let i = 0; i < len; i += 1) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}

