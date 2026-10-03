/**
 * Переезд со старой ПК-версии (Electron, «Eblusha Plus») на новую Еблушу для ПК (2.0).
 *
 * Как устроен переезд. Лента обновлений Electron (`/updates/latest.yml`) предлагает «версию
 * 2.0.0», файл которой — установщик новой Еблуши. Electron сам проверяет ленту (через 1,5 с после
 * старта и раз в 5 минут) и показывает обновление в СВОИХ настройках (локальная страница
 * `overlay/settings.html` в самом приложении): «Скачать» → «Установить и перезапустить» →
 * откроется установщик. Веб здесь только подсказывает, что пора, — баннер виден, когда Electron
 * САМ видит обновление ≥ 2.0.0. Ленту веб не читает и на сервер ничего не шлёт.
 *
 * Мост Electron — `window.native` (desktop/src/preload.ts, contextBridge):
 *   settingsGetState()    → { currentVersion, latestVersion, serverLatestVersion,
 *                             update: { status, latestVersion, available, downloaded }, … }
 *                           Без сети: состояние последней проверки ленты.
 *   settingsCheckUpdate() → { available, version, downloaded, update, … } — проверить сейчас.
 *                           Вне Windows и в dev-сборке: { available: false, reason: 'not_supported' }.
 *   openSettings()        → открыть настройки Electron (обновление — их первый блок).
 * И «!» на шестерёнке: preload пишет в `window.__eblushaSettingsGearBadgeVisible` true/false,
 * когда у Electron меняется «есть обновление» (сигнал `updater:badge`).
 *
 * Здесь — только чистая логика (признаки среды, разбор ответа, «Позже»); опрос и вид —
 * `ElectronMigrationBanner.tsx`, стенд со всеми состояниями — `/__dev/electron-migration`.
 */

/** С этой версии лента Electron ведёт на установщик новой Еблуши. */
export const ELECTRON_MIGRATION_MIN_VERSION = '2.0.0'

/** «Позже» прячет баннер на столько дней. */
export const ELECTRON_MIGRATION_SNOOZE_DAYS = 3
export const ELECTRON_MIGRATION_SNOOZE_MS = ELECTRON_MIGRATION_SNOOZE_DAYS * 24 * 60 * 60 * 1000
export const ELECTRON_MIGRATION_SNOOZE_KEY = 'eb.electronMigration.snoozedUntil.v1'

/**
 * Строка про секретные чаты — ОДНА, отдельно от остального текста: её поменяют, когда новая
 * Еблуша научится открывать секретные чаты. Обещать тут нельзя ничего сверх правды: новая их
 * пока не открывает, а ключи чата, принятого только здесь, есть только в этой (старой) версии.
 */
export const ELECTRON_MIGRATION_SECRET_NOTE =
  'Секретные чаты новая пока не открывает: если они есть только здесь, старую можно оставить.'

export const ELECTRON_MIGRATION_TEXT = {
  region: 'Переезд на новую Еблушу',
  barText: 'для ПК',
  title: 'Переезжайте на новую Еблушу',
  lead:
    'Своё приложение для Windows, без браузера внутри: легче и быстрее. ' +
    'Переписка, контакты и звонки живут на сервере — переедут сами.',
  login: 'Войти нужно будет заново — вспомните логин и пароль.',
  go: 'Перейти на новую Еблушу',
  later: 'Позже',
  hint: 'Откроются настройки: «Скачать», затем «Установить и перезапустить».',
  hintDownloaded: 'Уже скачана — в настройках осталось «Установить и перезапустить».',
  pillVersion: (v: string) => `Версия ${v}`,
  pillDownloaded: 'Скачана',
} as const

/** То, что баннеру нужно от `window.native` (подмножество моста preload). */
export type ElectronUpdateBridge = {
  settingsGetState?: () => Promise<unknown>
  settingsCheckUpdate?: () => Promise<unknown>
  openSettings?: () => unknown
}

export type MigrationStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

/** Всё, что баннер читает из среды. В приложении — `defaultMigrationEnv()`, на стенде — подставное. */
export type MigrationEnv = {
  native: ElectronUpdateBridge | null
  userAgent: string
  platform: string
  storage: MigrationStorage | null
  now: () => number
  /** `window.__eblushaSettingsGearBadgeVisible`; null — preload его не выставлял. */
  readBadge: () => boolean | null
  /** Первый вопрос к Electron — через столько мс после появления баннера в разметке. */
  firstAskDelayMs: number
}

export type MigrationHost =
  | 'browser'
  | 'electron-mac'
  | 'electron-other-os'
  | 'electron-no-bridge'
  | 'electron-windows'

/** Где мы: баннер возможен только в 'electron-windows'. */
export function detectMigrationHost(env: Pick<MigrationEnv, 'native' | 'userAgent' | 'platform'>): MigrationHost {
  const ua = String(env.userAgent || '')
  const platform = String(env.platform || '')
  // Тот же признак, что isElectron() в deviceManager: Electron пишет себя в userAgent.
  if (!/Electron/i.test(ua)) return 'browser'
  // Mac-клиент обновлений не проверяет вовсе (main.ts: всё — только win32), мост его не касается.
  if (/Macintosh|Mac OS X/i.test(ua) || /^mac/i.test(platform)) return 'electron-mac'
  // Установщик новой Еблуши — только для Windows.
  if (!/Windows NT/i.test(ua) && !/^win/i.test(platform)) return 'electron-other-os'
  const n = env.native
  if (!n || typeof n.openSettings !== 'function') return 'electron-no-bridge'
  if (typeof n.settingsGetState !== 'function' && typeof n.settingsCheckUpdate !== 'function') {
    return 'electron-no-bridge'
  }
  return 'electron-windows'
}

/** Как compareSemver в Electron (main.ts): первые три числа, хвост вида «-beta» не учитывается. */
export function parseVersion(v: unknown): [number, number, number] | null {
  const m = String(v ?? '').trim().match(/v?(\d+)\.(\d+)\.(\d+)/)
  if (!m) return null
  return [Number(m[1]), Number(m[2]), Number(m[3])]
}

/** >0 — a новее b, 0 — равны, <0 — старше; null — одну из версий не разобрать. */
export function compareVersions(a: unknown, b: unknown): number | null {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  if (!pa || !pb) return null
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] > pb[i] ? 1 : -1
  }
  return 0
}

/** Ответ Electron об обновлении — в одном виде для settingsGetState и settingsCheckUpdate. */
export type NativeUpdateAnswer = {
  available: boolean
  latestVersion: string | null
  currentVersion: string | null
  /** idle | checking | available | downloading | downloaded | error | not_supported */
  status: string | null
  downloaded: boolean
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)

export function parseNativeUpdateAnswer(raw: unknown): NativeUpdateAnswer {
  const r = isObj(raw) ? raw : {}
  const u = isObj(r.update) ? r.update : null
  const notSupported = r.reason === 'not_supported'
  // `update` есть в обоих ответах (updateUiState из main.ts) — он главный. Без него —
  // плоский ответ checkUpdate: { available, version }.
  const available = !notSupported && (u ? u.available === true : r.available === true)
  const latestVersion = (u ? str(u.latestVersion) : null) ?? str(r.version) ?? null
  return {
    available,
    latestVersion,
    currentVersion: str(r.currentVersion),
    status: notSupported ? 'not_supported' : (u ? str(u.status) : null),
    downloaded: available && (u ? u.downloaded === true : r.downloaded === true),
  }
}

/** Electron видит обновление, и это переезд (≥ 2.0.0 и новее установленной). */
export function isMigrationOffer(a: NativeUpdateAnswer | null | undefined): boolean {
  if (!a || !a.available || !a.latestVersion) return false
  const vsMin = compareVersions(a.latestVersion, ELECTRON_MIGRATION_MIN_VERSION)
  if (vsMin === null || vsMin < 0) return false
  if (a.currentVersion) {
    const vsCur = compareVersions(a.latestVersion, a.currentVersion)
    if (vsCur === null || vsCur <= 0) return false
  }
  return true
}

/** До какого момента баннер отложен («Позже»); null — не отложен. */
export function readSnooze(storage: MigrationStorage | null, now: number): number | null {
  if (!storage) return null
  let raw: string | null = null
  try {
    raw = storage.getItem(ELECTRON_MIGRATION_SNOOZE_KEY)
  } catch {
    return null
  }
  const until = Number(raw)
  if (!raw || !Number.isFinite(until) || until <= now) return null
  // Дальше, чем на срок «Позже», отложить нельзя — значит, часы перевели назад: не верим.
  if (until - now > ELECTRON_MIGRATION_SNOOZE_MS) return null
  return until
}

/** «Позже»: запомнить и вернуть момент, до которого баннер не показывать. */
export function writeSnooze(storage: MigrationStorage | null, now: number): number {
  const until = now + ELECTRON_MIGRATION_SNOOZE_MS
  try {
    storage?.setItem(ELECTRON_MIGRATION_SNOOZE_KEY, String(until))
  } catch {
    // приватный режим/запрет хранилища — спрячем до перезагрузки страницы
  }
  return until
}

export function defaultMigrationEnv(): MigrationEnv {
  const w: any = typeof window !== 'undefined' ? window : null
  const nav: any = typeof navigator !== 'undefined' ? navigator : null
  const native = w && w.native && typeof w.native === 'object' ? (w.native as ElectronUpdateBridge) : null
  let storage: MigrationStorage | null = null
  try {
    storage = w?.localStorage ?? null
  } catch {
    storage = null
  }
  return {
    native,
    userAgent: String(nav?.userAgent || ''),
    platform: String(nav?.userAgentData?.platform || nav?.platform || ''),
    storage,
    now: () => Date.now(),
    readBadge: () => {
      try {
        const v = w?.__eblushaSettingsGearBadgeVisible
        return typeof v === 'boolean' ? v : null
      } catch {
        return null
      }
    },
    firstAskDelayMs: 4000,
  }
}
