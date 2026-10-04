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
 * Мост Electron — `window.native` (desktop/src/preload.ts, contextBridge). Берём из него ровно два метода:
 *   settingsGetState() → { currentVersion, latestVersion, …, update: { status, latestVersion, available,
 *                          downloaded } } — без сети, состояние последней проверки ленты в Electron.
 *   openSettings()     → открыть настройки Electron (обновление — их первый блок).
 * settingsCheckUpdate() НЕ зовём никогда: это внеплановая проверка ленты, её обработчик update-available
 * сбрасывает «скачано» (вернёт «Скачать» вместо «Установить и перезапустить»), а на Windows 10 до 1809
 * она к тому же объявляет 2.0.0 доступной, хотя ставить её Electron не станет (minimumSystemVersion).
 *
 * Сигнал без вопросов — «!» на шестерёнке: preload пишет в `window.__eblushaSettingsGearBadgeVisible`
 * true/false, когда main шлёт `updater:badge` (только при СМЕНЕ «есть обновление»); после каждой
 * перезагрузки страницы preload сбрасывает его в false, хотя обновление никуда не делось.
 *
 * Спрашивать settingsGetState дорого: у кого в %APPDATA%\EblushaPlus\settings.json нет autostartEnabled
 * (галочку автозапуска в приложении ни разу не трогали), обработчик зовёт `reg query` через exec без
 * windowsHide — мелькает консоль. Поэтому вопросы — только там, где баннер и правда может появиться
 * (см. startMigrationWatcher).
 *
 * Здесь — только логика без React (признаки среды, разбор ответа, «Позже», когда спрашивать);
 * вид — `ElectronMigrationBanner.tsx`, стенд со всеми состояниями — `/__dev/electron-migration`.
 */

/** С этой версии лента Electron ведёт на установщик новой Еблуши. */
export const ELECTRON_MIGRATION_MIN_VERSION = '2.0.0'

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * «Позже» прячет баннер всё дольше: 3 дня, потом 14, потом по 30. Кто уже переехал, но оставил
 * старую (ради секретных чатов или на всякий случай), карточку раз в 3 дня видеть не должен —
 * лента продолжит предлагать старой 2.0.x, пока её не уберут.
 */
export const ELECTRON_MIGRATION_SNOOZE_DAYS: readonly number[] = [3, 14, 30]
export const ELECTRON_MIGRATION_SNOOZE_KEY = 'eb.electronMigration.snooze.v1'

/** Срок N-го «Позже» (N с 1); дальше последнего — последний. */
export function snoozeMsFor(count: number): number {
  const days = ELECTRON_MIGRATION_SNOOZE_DAYS
  const i = Math.min(Math.max(1, Math.floor(count) || 1), days.length) - 1
  return days[i] * DAY_MS
}

/**
 * Строка про секретные чаты — ОДНА, отдельно от остального текста. С 2.0.0 новая Еблуша открывает
 * их целиком (создание, приём, текст, файлы и голосовые, связывание устройств по QR), но ключи
 * чата, принятого только здесь, лежат только в этой (старой) версии: прежние секретки откроются
 * в новой после связывания устройств. Обещать сверх этого нельзя. Слова — те же, что на экране
 * переезда установщика (`MigrationTexts.Secret`) и в заметках ленты Electron (`electron-notes.txt`).
 */
export const ELECTRON_MIGRATION_SECRET_NOTE =
  'Секретные чаты в новой есть. Прежние откроются после связывания устройств по QR — до этого старую лучше оставить.'

/**
 * Тексты баннера. Должны быть правдой в обоих случаях: новой Еблуши на этом ПК ещё нет — или она
 * уже стоит рядом (переехали, а старую оставили; тогда установщик из ленты покажет «Уберём старую?»).
 * Чего не писать — migration-facts §8: числа памяти, «выйдите из старой», «отключите устройство».
 */
export const ELECTRON_MIGRATION_TEXT = {
  region: 'Переезд на новую Еблушу',
  barText: 'для ПК',
  title: 'Переезжайте на новую Еблушу',
  lead:
    'Своё приложение для Windows, без браузера внутри: меньше памяти и процессов, быстрее запуск и отклик, ' +
    'звонки с камерой до 1440p60 и показом экрана до 4K. ' +
    'Переписка и контакты хранятся на сервере — переедут сами.',
  login: 'Если новой на этом ПК ещё нет, войти придётся заново — вспомните логин и пароль.',
  go: 'Перейти на новую Еблушу',
  later: 'Позже',
  hint: 'Если новая уже стоит, установщик предложит убрать старую.',
  pillVersion: (v: string) => `Версия ${v}`,
  pillDownloaded: 'Скачана',
} as const

/** То, что баннеру нужно от `window.native` (подмножество моста preload). */
export type ElectronUpdateBridge = {
  settingsGetState?: () => Promise<unknown>
  openSettings?: () => unknown
}

export type MigrationStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

/** Всё, что баннер читает из среды. В приложении — `defaultMigrationEnv()`, на стенде — подставное. */
export type MigrationEnv = {
  native: ElectronUpdateBridge | null
  userAgent: string
  platform: string
  /** localStorage — «Позже». */
  storage: MigrationStorage | null
  /** sessionStorage — что Electron знал об обновлении в этом его запуске (живёт до закрытия окна). */
  session: MigrationStorage | null
  now: () => number
  /** `window.__eblushaSettingsGearBadgeVisible`; null — preload его ещё не выставлял. */
  readBadge: () => boolean | null
  /** UA-CH `platformVersion` (на Windows — версия UniversalApiContract); null — не узнать. Без сети. */
  platformVersion: () => Promise<string | null>
  /** Вопрос к Electron при открытии страницы (если он нужен) — через столько мс. */
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
  // Без settingsGetState не узнать, что видит Electron, а проверку ленты сами не запускаем.
  if (!n || typeof n.openSettings !== 'function' || typeof n.settingsGetState !== 'function') {
    return 'electron-no-bridge'
  }
  return 'electron-windows'
}

/**
 * Windows 10 до 1809 (сборка 17763): новая Еблуша там не запустится, и лента её не предлагает
 * (minimumSystemVersion), но ручное «Проверить обновления» в Electron всё равно покажет 2.0.0.
 * UA-CH platformVersion на Windows — версия UniversalApiContract: 1–6 = Windows 10 1507–1803,
 * 7 = 1809, 8 = 1903/1909, 10 = 2004–22H2, 13+ = Windows 11. 0.x (Windows 7/8.x, где Electron 30
 * не работает, или сбой) и пустое — не решаем, считаем годной.
 */
export function isWindowsTooOldForNative(platformVersion: string | null | undefined): boolean {
  const m = String(platformVersion ?? '').trim().match(/^(\d+)\./)
  if (!m) return false
  const major = Number(m[1])
  return major >= 1 && major < 7
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

/** Ответ Electron (settingsGetState) об обновлении. */
export type NativeUpdateAnswer = {
  available: boolean
  latestVersion: string | null
  currentVersion: string | null
  /** idle | checking | available | downloading | downloaded | error */
  status: string | null
  downloaded: boolean
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)

/** Разбор ответа settings:getState (main.ts): главное — `update` (updateUiState); без него — «нет». */
export function parseNativeUpdateAnswer(raw: unknown): NativeUpdateAnswer {
  const r = isObj(raw) ? raw : {}
  const u = isObj(r.update) ? r.update : {}
  const available = u.available === true
  return {
    available,
    latestVersion: str(u.latestVersion),
    currentVersion: str(r.currentVersion),
    status: str(u.status),
    downloaded: available && u.downloaded === true,
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

// ── «Позже» ─────────────────────────────────────────────────────────────────

/** until — до какого момента баннер отложен (null — не отложен); count — сколько раз жали «Позже». */
export type SnoozeState = { until: number | null; count: number }

export const NO_SNOOZE: SnoozeState = { until: null, count: 0 }

export function readSnooze(storage: MigrationStorage | null, now: number): SnoozeState {
  if (!storage) return { ...NO_SNOOZE }
  let raw: string | null = null
  try {
    raw = storage.getItem(ELECTRON_MIGRATION_SNOOZE_KEY)
  } catch {
    return { ...NO_SNOOZE }
  }
  if (!raw) return { ...NO_SNOOZE }
  let parsed: unknown = null
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ...NO_SNOOZE }
  }
  const p = isObj(parsed) ? parsed : {}
  const count = Number.isFinite(Number(p.count)) ? Math.max(0, Math.floor(Number(p.count))) : 0
  const until = Number(p.until)
  if (!Number.isFinite(until) || until <= now) return { until: null, count }
  // Дальше, чем на срок этого «Позже», отложить нельзя — значит, часы перевели назад: не верим.
  if (until - now > snoozeMsFor(count)) return { until: null, count }
  return { until, count }
}

/** «Позже»: следующий срок по счёту нажатий; запомнить и вернуть. */
export function writeSnooze(storage: MigrationStorage | null, now: number): SnoozeState {
  const count = readSnooze(storage, now).count + 1
  const next: SnoozeState = { until: now + snoozeMsFor(count), count }
  try {
    storage?.setItem(ELECTRON_MIGRATION_SNOOZE_KEY, JSON.stringify(next))
  } catch {
    // приватный режим/запрет хранилища — спрячем до перезагрузки страницы
  }
  return next
}

// ── Что Electron знал в этом запуске (sessionStorage) ───────────────────────

export const ELECTRON_MIGRATION_SESSION_KEY = 'eb.electronMigration.updateSeen.v1'

/** 'yes' — у Electron было обновление; 'no' — не было; null — первая страница этого запуска Electron. */
export type SessionUpdateFlag = 'yes' | 'no'

export function readSessionFlag(session: MigrationStorage | null): SessionUpdateFlag | null {
  try {
    const v = session?.getItem(ELECTRON_MIGRATION_SESSION_KEY)
    return v === 'yes' || v === 'no' ? v : null
  } catch {
    return null
  }
}

export function writeSessionFlag(session: MigrationStorage | null, v: SessionUpdateFlag): void {
  try {
    session?.setItem(ELECTRON_MIGRATION_SESSION_KEY, v)
  } catch {
    // без sessionStorage каждая страница — «первая»: ждём «!»
  }
}

// ── Когда спрашивать Electron ───────────────────────────────────────────────

export const MIGRATION_TIMING = {
  /** Как часто смотреть на «!» шестерёнки (чтение свойства окна, без IPC). */
  badgePollMs: 3000,
  /** После загорания «!» дать Electron дописать состояние. */
  badgeSettleMs: 1500,
  /** Вопросы к Electron — не чаще (защита от дребезга «!»). */
  minAskGapMs: 5000,
  /** Редкая перепроверка — только там, где «!» о следующей перемене не скажет. */
  slowReaskMs: 6 * 60 * 60_000,
} as const

export type MigrationWatcher = {
  /** «Позже» нажали или срок вышел. Пока отложено — ни одного вопроса. */
  setSnoozed: (on: boolean) => void
  stop: () => void
}

/**
 * Следит за тем, что видит Electron, и спрашивает его как можно реже:
 *  • первая страница запуска Electron (в sessionStorage пусто): НЕ спрашиваем — ждём «!». Electron
 *    проверит ленту через 1,5 с после старта и, найдя обновление, зажжёт «!» (main шлёт updater:badge);
 *  • загорелся «!» → один вопрос (обновление какое: 0.7.6 или переезд?);
 *  • «!» погас (был true) → обновления больше нет: прячем без вопроса;
 *  • перезагрузка страницы («!» сброшен preload в false, main его не повторит): один вопрос — только
 *    если в этом запуске у Electron обновление уже было ('yes' в sessionStorage);
 *  • раз в 6 ч — только там, где «!» о следующей перемене не скажет: ответа нет (сбой моста), «!» не
 *    выставлен, обновление другое (0.7.6 — «!» так и будет гореть, когда в ленте появится 2.0.0) или
 *    переезд виден, но «!» после перезагрузки сброшен (не узнаем, если ленту откатят).
 * У кого обновлений нет, вопросов нет вовсе. Windows 10 до 1809 — ни одного вопроса.
 */
export function startMigrationWatcher(
  env: MigrationEnv,
  opts: {
    snoozed: boolean
    onAnswer: (a: NativeUpdateAnswer | null) => void
    onTooOld: () => void
  },
): MigrationWatcher {
  const T = MIGRATION_TIMING
  const native = env.native
  let stopped = false
  let snoozed = opts.snoozed
  let timer: ReturnType<typeof setTimeout> | null = null
  let inFlight = false
  let askAgain = false
  let lastAskAt = Number.NEGATIVE_INFINITY
  let tooOld: Promise<boolean> | null = null
  let lastBadge = env.readBadge()

  let seen = readSessionFlag(env.session)
  const remember = (v: SessionUpdateFlag) => {
    seen = v
    writeSessionFlag(env.session, v)
  }
  // Первая страница этого запуска Electron: исходное знание — «обновления нет», пока «!» не скажет иное.
  if (seen === null) remember(lastBadge === true ? 'yes' : 'no')

  const clear = () => {
    if (timer) clearTimeout(timer)
    timer = null
  }
  const plan = (ms: number) => {
    if (stopped || snoozed) return
    clear()
    timer = setTimeout(() => {
      timer = null
      void ask()
    }, Math.max(0, ms))
  }
  const planSoon = () => plan(Math.max(T.badgeSettleMs, lastAskAt + T.minAskGapMs - env.now()))

  const stop = () => {
    stopped = true
    clear()
    clearInterval(poll)
  }

  const ask = async () => {
    if (stopped || snoozed) return
    if (inFlight) {
      askAgain = true
      return
    }
    const getState = native?.settingsGetState
    if (typeof getState !== 'function') return
    inFlight = true
    tooOld ??= env.platformVersion().then(isWindowsTooOldForNative, () => false)
    if (await tooOld) {
      inFlight = false
      if (!stopped) {
        stop()
        opts.onTooOld()
      }
      return
    }
    lastAskAt = env.now()
    let next: NativeUpdateAnswer | null = null
    try {
      next = parseNativeUpdateAnswer(await getState.call(native))
    } catch {
      next = null
    }
    inFlight = false
    if (stopped) return
    if (next) remember(next.available ? 'yes' : 'no')
    // Пока шёл вопрос, нажали «Позже»: старый ответ не нужен — по истечении спросим заново.
    if (snoozed) return
    opts.onAnswer(next)
    if (askAgain) {
      askAgain = false
      plan(T.minAskGapMs)
      return
    }
    const badge = env.readBadge()
    // «!» сам скажет о следующей перемене, если обновления нет (загорится, когда Electron его найдёт,
    // в том числе после текущей проверки 'checking') или виден переезд при горящем «!» (погаснет).
    // В остальных случаях — редкая перепроверка.
    const badgeWillTell = !!next && badge !== null && (!next.available || (badge === true && isMigrationOffer(next)))
    if (!badgeWillTell) plan(T.slowReaskMs)
  }

  const poll = setInterval(() => {
    const b = env.readBadge()
    if (b === lastBadge) return
    const prev = lastBadge
    lastBadge = b
    if (b === true) {
      remember('yes')
      planSoon()
      return
    }
    if (prev === true) {
      // Погас настоящий «!»: у Electron обновления больше нет (откат ленты, ошибка проверки).
      remember('no')
      clear()
      opts.onAnswer(null)
    }
    // null → false: исходное «нет» от preload (после перезагрузки страницы — всегда «нет»), не событие.
  }, T.badgePollMs)

  if (!snoozed && (lastBadge === true || seen === 'yes')) plan(env.firstAskDelayMs)

  return {
    setSnoozed(on: boolean) {
      if (stopped || on === snoozed) return
      snoozed = on
      if (on) {
        clear()
        return
      }
      if (env.readBadge() === true || seen === 'yes') plan(env.firstAskDelayMs)
    },
    stop,
  }
}

export function defaultMigrationEnv(): MigrationEnv {
  const w: any = typeof window !== 'undefined' ? window : null
  const nav: any = typeof navigator !== 'undefined' ? navigator : null
  const native = w && w.native && typeof w.native === 'object' ? (w.native as ElectronUpdateBridge) : null
  let storage: MigrationStorage | null = null
  let session: MigrationStorage | null = null
  try {
    storage = w?.localStorage ?? null
  } catch {
    storage = null
  }
  try {
    session = w?.sessionStorage ?? null
  } catch {
    session = null
  }
  return {
    native,
    userAgent: String(nav?.userAgent || ''),
    platform: String(nav?.userAgentData?.platform || nav?.platform || ''),
    storage,
    session,
    now: () => Date.now(),
    readBadge: () => {
      try {
        const v = w?.__eblushaSettingsGearBadgeVisible
        return typeof v === 'boolean' ? v : null
      } catch {
        return null
      }
    },
    platformVersion: async () => {
      try {
        const uad = nav?.userAgentData
        if (!uad || typeof uad.getHighEntropyValues !== 'function') return null
        const v = await uad.getHighEntropyValues(['platformVersion'])
        return typeof v?.platformVersion === 'string' ? v.platformVersion : null
      } catch {
        return null
      }
    },
    firstAskDelayMs: 4000,
  }
}
