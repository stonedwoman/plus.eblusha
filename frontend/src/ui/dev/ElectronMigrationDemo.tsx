/**
 * Dev-стенд баннера «Переезжайте на новую Еблушу». Только dev-сборка: /__dev/electron-migration —
 * в production маршрута нет.
 *
 * Всё подставное, кроме сторов приложения. Подставной Electron ведёт себя как настоящий
 * (desktop/src/main.ts + preload.ts):
 *   • window.native — settingsGetState / openSettings (+ settingsCheckUpdate, который баннер звать
 *     НЕ должен — счётчик на виду), те же формы ответов, что в main.ts;
 *   • «!» шестерёнки: main шлёт updater:badge только при СМЕНЕ; preload на каждой странице начинает
 *     с false и через 1,2 с выставляет своё последнее значение; при запуске Electron проверяет ленту
 *     через 1,5 с;
 *   • «Перезагрузить страницу» — sessionStorage остаётся, «!» сброшен; «Перезапустить Electron» —
 *     sessionStorage пуст;
 *   • UA-CH platformVersion — Windows 11 или Windows 10 1803.
 * Память «Позже» и sessionStorage — свои (в памяти), часы можно сдвинуть. «Идёт звонок» и «Новый сеанс»
 * включаются в НАСТОЯЩИХ сторах (callStore, systemUiStore). «Запросы в друзья» — с той же меткой
 * data-eb-contacts-bar, что в ChatsPage; «окно» — как карточка пользователя (z 95, затемнение).
 * Ни одного сетевого запроса стенд не делает.
 *
 * Для снимков: ?s=<сценарий>&w=<ширина> — открыть сразу нужное; снимать #eb-mig-demo-shot.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { ElectronMigrationBanner, type ElectronMigrationState } from '../components/ElectronMigrationBanner'
import {
  ELECTRON_MIGRATION_SESSION_KEY,
  ELECTRON_MIGRATION_SNOOZE_DAYS,
  ELECTRON_MIGRATION_SNOOZE_KEY,
  compareVersions,
  detectMigrationHost,
  isMigrationOffer,
  isWindowsTooOldForNative,
  readSnooze,
  type ElectronUpdateBridge,
  type MigrationEnv,
  type MigrationStorage,
} from '../components/electronMigration'
import { useCallStore } from '../../domain/store/callStore'
import { useSystemUiStore } from '../../domain/store/systemUiStore'

const UA = {
  win: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) eblusha-plus-desktop/0.7.5 Chrome/124.0.6367.243 Electron/30.5.1 Safari/537.36',
  mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) eblusha-plus-desktop/0.7.5 Chrome/124.0.6367.243 Electron/30.5.1 Safari/537.36',
  browser: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
} as const
const PLATFORM: Record<keyof typeof UA, string> = { win: 'Win32', mac: 'MacIntel', browser: 'Win32' }

type UpdateStatus = 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'error'

/** Что «знает» подставной Electron. */
type MockElectron = {
  current: string
  /** Версия из ленты; null — ничего новее нет. */
  latest: string | null
  status: UpdateStatus
  /** Вызов моста бросает (сломанный IPC). */
  ipcFails: boolean
  /** Лента уже проверена в этом запуске (до первой проверки — «обновления нет»). */
  checked: boolean
}

type Scenario = {
  id: string
  title: string
  os: keyof typeof UA
  bridge: 'full' | 'check-only' | 'none'
  electron: Omit<MockElectron, 'checked'>
  /** 'restart' — Electron только что запущен (sessionStorage пуст); 'reload' — страницу перезагрузили. */
  start: 'restart' | 'reload'
  /** UA-CH platformVersion: 15.0.0 — Windows 11, 6.0.0 — Windows 10 1803. */
  platformVersion?: string
  snoozed?: boolean
  inCall?: boolean
  newSession?: boolean
  contactsBar?: boolean
  modal?: boolean
}

const E = (patch: Partial<MockElectron>): Omit<MockElectron, 'checked'> => ({
  current: '0.7.5',
  latest: null,
  status: 'idle',
  ipcFails: false,
  ...patch,
})
const OFFER = E({ latest: '2.0.0', status: 'available' })

const SCENARIOS: Scenario[] = [
  { id: 'browser', title: 'Браузер, нет Electron', os: 'browser', bridge: 'none', electron: E({}), start: 'restart' },
  { id: 'mac', title: 'Electron на Mac (лента дала бы 2.0.0)', os: 'mac', bridge: 'full', electron: OFFER, start: 'restart' },
  { id: 'no-bridge', title: 'Electron без window.native', os: 'win', bridge: 'none', electron: OFFER, start: 'restart' },
  { id: 'check-only', title: 'Мост без settingsGetState', os: 'win', bridge: 'check-only', electron: OFFER, start: 'restart' },
  { id: 'old-win', title: 'Windows 10 1803 + 2.0.0', os: 'win', bridge: 'full', electron: OFFER, start: 'restart', platformVersion: '6.0.0' },
  { id: 'none', title: 'Запуск, обновления нет', os: 'win', bridge: 'full', electron: E({}), start: 'restart' },
  { id: 'none-reload', title: 'Перезагрузка, обновления нет', os: 'win', bridge: 'full', electron: E({}), start: 'reload' },
  { id: '076', title: 'Запуск, обновление 0.7.6', os: 'win', bridge: 'full', electron: E({ latest: '0.7.6', status: 'available' }), start: 'restart' },
  { id: '200', title: 'Запуск, Electron нашёл 2.0.0', os: 'win', bridge: 'full', electron: OFFER, start: 'restart' },
  { id: '200-dl', title: '2.0.0 уже скачана', os: 'win', bridge: 'full', electron: E({ latest: '2.0.0', status: 'downloaded' }), start: 'reload' },
  { id: '200-reload', title: '2.0.0, страницу перезагрузили', os: 'win', bridge: 'full', electron: OFFER, start: 'reload' },
  { id: '200-later', title: '2.0.0, нажато «Позже»', os: 'win', bridge: 'full', electron: OFFER, start: 'reload', snoozed: true },
  { id: '200-call', title: '2.0.0 во время звонка', os: 'win', bridge: 'full', electron: OFFER, start: 'reload', inCall: true },
  { id: '200-session', title: '2.0.0 + «Новый сеанс»', os: 'win', bridge: 'full', electron: OFFER, start: 'reload', newSession: true },
  { id: '200-contacts', title: '2.0.0 + «Запросы в друзья»', os: 'win', bridge: 'full', electron: OFFER, start: 'reload', contactsBar: true },
  { id: '200-modal', title: '2.0.0 + открыто окно', os: 'win', bridge: 'full', electron: OFFER, start: 'reload', modal: true },
  { id: 'error', title: 'Проверка ленты с ошибкой', os: 'win', bridge: 'full', electron: E({ latest: '2.0.0', status: 'error' }), start: 'restart' },
  { id: 'ipc', title: 'Мост бросает исключение', os: 'win', bridge: 'full', electron: E({ latest: '2.0.0', status: 'available', ipcFails: true }), start: 'restart' },
  { id: 'same', title: 'Установлена та же 2.0.0', os: 'win', bridge: 'full', electron: E({ current: '2.0.0', latest: '2.0.0', status: 'idle' }), start: 'restart' },
]

const WIDTHS = [
  { label: 'ПК 1180', w: 1180 },
  { label: 'Окно 860', w: 860 },
  { label: 'Узко 600', w: 600 },
  { label: '380', w: 380 },
]

const DAY = 24 * 60 * 60 * 1000

function updateUi(e: MockElectron) {
  // Как updateUiState в main.ts: available только при версии новее установленной и без ошибки.
  const newer = e.checked && !!e.latest && (compareVersions(e.latest, e.current) ?? 0) > 0
  const available = newer && e.status !== 'error' && e.status !== 'idle'
  return {
    status: e.checked ? e.status : ('idle' as UpdateStatus),
    latestVersion: e.checked ? (e.latest ?? e.current) : e.current,
    available,
    downloaded: available && e.status === 'downloaded',
  }
}

function createMemStorage(): MigrationStorage & { get: (k: string) => string | null; clear: () => void } {
  const map = new Map<string, string>()
  return {
    getItem: (k) => (map.has(k) ? (map.get(k) as string) : null),
    setItem: (k, v) => void map.set(k, String(v)),
    removeItem: (k) => void map.delete(k),
    get: (k) => map.get(k) ?? null,
    clear: () => map.clear(),
  }
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

function initialFromUrl() {
  try {
    const q = new URLSearchParams(window.location.search)
    const s = q.get('s')
    const w = Number(q.get('w'))
    return {
      scenario: s && SCENARIOS.some((x) => x.id === s) ? s : '200',
      width: Number.isFinite(w) && w >= 320 ? w : WIDTHS[0].w,
    }
  } catch {
    return { scenario: '200', width: WIDTHS[0].w }
  }
}

export default function ElectronMigrationDemo() {
  const init = useMemo(initialFromUrl, [])
  const [scenarioId, setScenarioId] = useState(init.scenario)
  const [width, setWidth] = useState(init.width)
  const [runKey, setRunKey] = useState(0)
  const [log, setLog] = useState<string[]>([])
  const [bannerState, setBannerState] = useState<ElectronMigrationState | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [wentToSettings, setWentToSettings] = useState(false)
  const [contactsBar, setContactsBar] = useState(false)
  const [modal, setModal] = useState(false)
  const [domShown, setDomShown] = useState(false)
  const [, setTick] = useState(0)
  const scenario = SCENARIOS.find((s) => s.id === scenarioId) ?? SCENARIOS[0]

  const electronRef = useRef<MockElectron>({ ...scenario.electron, checked: false })
  /** Что main последним отправил в updater:badge (lastUpdateBadgeVisible). */
  const mainSentRef = useRef<boolean | null>(null)
  /** Последнее, что получил preload ЭТОЙ страницы (lastGearBadgeVisible). */
  const preloadLastRef = useRef(false)
  /** window.__eblushaSettingsGearBadgeVisible. */
  const badgeRef = useRef<boolean | null>(null)
  const offsetRef = useRef(0)
  const startedRef = useRef(Date.now())
  const callsRef = useRef({ getState: 0, checkUpdate: 0 })
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([])
  const frameRef = useRef<HTMLDivElement | null>(null)
  const local = useMemo(() => createMemStorage(), [])
  const session = useMemo(() => createMemStorage(), [])

  const inCall = useCallStore((s) => Boolean(s.overlayConvId || s.activeConvId))
  const newSession = useSystemUiStore((s) => Boolean(s.newSessionPopup))

  const push = useCallback((line: string) => {
    const t = ((Date.now() - startedRef.current) / 1000).toFixed(1)
    setLog((l) => [...l.slice(-80), `+${t} с  ${line}`])
  }, [])
  const later = (ms: number, f: () => void) => {
    timersRef.current.push(setTimeout(f, ms))
  }
  const clearTimers = () => {
    for (const t of timersRef.current) clearTimeout(t)
    timersRef.current = []
  }

  const setCall = (on: boolean) => {
    useCallStore.setState(on ? { overlayConvId: 'demo-call', activeConvId: 'demo-call' } : { overlayConvId: null, activeConvId: null })
  }
  const setNewSession = (on: boolean) => {
    const st = useSystemUiStore.getState()
    if (on && !st.newSessionPopup) void st.requestNewSessionPopup({ deviceId: 'demo-device', deviceName: 'iPhone', platform: 'ios' })
    if (!on && st.newSessionPopup) st.resolveNewSessionPopup('dismiss')
  }

  /** main: broadcastUpdateBadge — шлёт только при смене. */
  const mainBroadcast = useCallback(
    (why: string) => {
      const visible = updateUi(electronRef.current).available
      if (mainSentRef.current === visible) return
      mainSentRef.current = visible
      preloadLastRef.current = visible
      badgeRef.current = visible
      push(`main → updater:badge ${visible} (${why})`)
      setTick((t) => t + 1)
    },
    [push],
  )

  /** Новая страница в том же окне: preload начинает с false и через 1,2 с выставляет его. */
  const newPage = useCallback(() => {
    badgeRef.current = null
    preloadLastRef.current = false
    setWentToSettings(false)
    setSettingsOpen(false)
    setRunKey((k) => k + 1)
    later(1200, () => {
      badgeRef.current = preloadLastRef.current
      setTick((t) => t + 1)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const restartElectron = useCallback(() => {
    clearTimers()
    session.clear()
    mainSentRef.current = null
    electronRef.current = { ...electronRef.current, checked: false }
    push('Electron запущен заново (sessionStorage пуст)')
    newPage()
    later(300, () => mainBroadcast('did-finish-load'))
    later(1500, () => {
      electronRef.current = { ...electronRef.current, checked: true }
      push(`Electron проверил ленту: ${electronRef.current.latest ?? 'новее нет'}`)
      mainBroadcast('проверка ленты')
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mainBroadcast, newPage, push, session])

  const reloadPage = useCallback(() => {
    clearTimers()
    push('страница перезагружена (sessionStorage остался, «!» сброшен)')
    newPage()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newPage, push])

  // Новый прогон сценария.
  const start = useCallback(
    (sc: Scenario) => {
      clearTimers()
      startedRef.current = Date.now()
      callsRef.current = { getState: 0, checkUpdate: 0 }
      offsetRef.current = 0
      local.clear()
      session.clear()
      if (sc.snoozed) local.setItem(ELECTRON_MIGRATION_SNOOZE_KEY, JSON.stringify({ until: Date.now() + DAY, count: 1 }))
      setCall(!!sc.inCall)
      setNewSession(!!sc.newSession)
      setContactsBar(!!sc.contactsBar)
      setModal(!!sc.modal)
      setLog([`сценарий «${sc.title}»`])
      electronRef.current = { ...sc.electron, checked: true }
      if (sc.start === 'reload') {
        // Прежняя страница этого запуска уже всё видела: main отправил «!», баннер записал в sessionStorage.
        const visible = updateUi(electronRef.current).available
        mainSentRef.current = visible
        session.setItem(ELECTRON_MIGRATION_SESSION_KEY, visible ? 'yes' : 'no')
        reloadPage()
      } else {
        restartElectron()
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [local, session, reloadPage, restartElectron],
  )

  useEffect(() => {
    start(scenario)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scenarioId])

  // Уход со стенда — звонок и «Новый сеанс» в сторах не оставляем.
  useEffect(
    () => () => {
      clearTimers()
      setCall(false)
      setNewSession(false)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )

  // Подставной window.native: те же методы и формы ответов, что у preload.ts/main.ts.
  const native = useMemo<ElectronUpdateBridge | null>(() => {
    if (scenario.bridge === 'none') return null
    const getState = async () => {
      callsRef.current.getState += 1
      await delay(120)
      const e = electronRef.current
      if (e.ipcFails) {
        push('settingsGetState() → исключение')
        throw new Error('ipc failed')
      }
      const update = updateUi(e)
      push(`settingsGetState() → update: ${update.status}, available=${update.available}, latest=${update.latestVersion}`)
      return {
        currentVersion: e.current,
        latestVersion: update.available ? e.latest : e.current,
        serverLatestVersion: update.latestVersion,
        notificationsEnabled: true,
        showGameEnabled: false,
        autostartEnabled: true,
        serverRoute: 'direct',
        prodUrl: 'https://eblusha.org',
        update,
        releaseNotesVersion: update.available ? e.latest : null,
        releaseNotes: null,
      }
    }
    const checkUpdate = async () => {
      callsRef.current.checkUpdate += 1
      push('settingsCheckUpdate() — ЭТОГО БЫТЬ НЕ ДОЛЖНО')
      const update = updateUi(electronRef.current)
      return { available: update.available, version: update.available ? electronRef.current.latest : null, downloaded: update.downloaded, update }
    }
    const bridge = {
      ...(scenario.bridge === 'full' ? { settingsGetState: getState } : {}),
      settingsCheckUpdate: checkUpdate,
      openSettings: async () => {
        push('openSettings() → Electron открыл свои настройки')
        setWentToSettings(true)
        setSettingsOpen(true)
      },
    }
    return bridge as ElectronUpdateBridge
    // runKey: новый объект моста на каждую «страницу»
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scenario, runKey, push])

  const env = useMemo<MigrationEnv>(
    () => ({
      native,
      userAgent: UA[scenario.os],
      platform: PLATFORM[scenario.os],
      storage: local,
      session,
      now: () => Date.now() + offsetRef.current,
      readBadge: () => badgeRef.current,
      platformVersion: async () => scenario.platformVersion ?? '15.0.0',
      firstAskDelayMs: 600,
    }),
    [native, scenario, local, session],
  )

  // Electron «меняет мнение»: состояние подставного Electron и «!», как шлёт updater:badge.
  const setElectron = (patch: Partial<MockElectron>, label: string) => {
    electronRef.current = { ...electronRef.current, checked: true, ...patch }
    push(`Electron: ${label}`)
    mainBroadcast(label)
    setTick((t) => t + 1)
  }

  // Виден ли баннер НА САМОМ ДЕЛЕ (его прячет и CSS: «Запросы в друзья»).
  useEffect(() => {
    const t = setInterval(() => {
      const dock = frameRef.current?.querySelector('.eb-mig-dock') as HTMLElement | null
      const shown = !!dock && getComputedStyle(dock).display !== 'none'
      setDomShown((v) => (v === shown ? v : shown))
      setTick((x) => x + 1)
    }, 250)
    return () => clearInterval(t)
  }, [])

  const host = detectMigrationHost(env)
  const tooOld = isWindowsTooOldForNative(scenario.platformVersion ?? null)
  const ui = updateUi(electronRef.current)
  const electronOffer =
    !electronRef.current.ipcFails &&
    isMigrationOffer({ available: ui.available, latestVersion: ui.latestVersion, currentVersion: electronRef.current.current, status: ui.status, downloaded: ui.downloaded })
  const snoozeNow = readSnooze(local, env.now())
  const expected =
    host === 'electron-windows' && !tooOld && electronOffer && snoozeNow.until === null && !inCall && !newSession && !wentToSettings && !contactsBar
  const actual = domShown
  const shell = scenario.os === 'win' && host !== 'browser'
  const narrow = width < 700
  const sessionFlag = session.get(ELECTRON_MIGRATION_SESSION_KEY)
  const ok = expected === actual && callsRef.current.checkUpdate === 0

  return (
    <div style={{ minHeight: '100vh', background: '#070b11', color: '#eef3ff', padding: 20, fontFamily: 'inherit', fontSize: 13 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
        {SCENARIOS.map((sc) => (
          <button key={sc.id} type="button" data-scenario={sc.id} onClick={() => (sc.id === scenarioId ? start(sc) : setScenarioId(sc.id))} style={btn(sc.id === scenarioId)}>
            {sc.title}
          </button>
        ))}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10, alignItems: 'center' }}>
        <span style={{ color: '#8a96ab' }}>Electron:</span>
        <button type="button" data-act="found-200" style={btn(false)} onClick={() => setElectron({ latest: '2.0.0', status: 'available' }, 'нашёл 2.0.0')}>нашёл 2.0.0</button>
        <button type="button" data-act="found-076" style={btn(false)} onClick={() => setElectron({ latest: '0.7.6', status: 'available' }, 'нашёл 0.7.6')}>нашёл 0.7.6</button>
        <button type="button" data-act="rollback" style={btn(false)} onClick={() => setElectron({ latest: null, status: 'idle' }, 'лента откатилась')}>лента откатилась</button>
        <button type="button" data-act="downloaded" style={btn(false)} onClick={() => setElectron({ status: 'downloaded' }, 'скачал')}>скачал</button>
        <button type="button" data-act="error" style={btn(false)} onClick={() => setElectron({ status: 'error' }, 'ошибка проверки')}>ошибка проверки</button>
        <span style={{ width: 8 }} />
        <button type="button" data-act="reload" style={btn(false)} onClick={reloadPage}>перезагрузить страницу</button>
        <button type="button" data-act="restart" style={btn(false)} onClick={restartElectron}>перезапустить Electron</button>
        <button
          type="button"
          data-act="clock"
          style={btn(false)}
          onClick={() => {
            const until = readSnooze(local, env.now()).until
            const jump = until ? until - env.now() + 60_000 : DAY
            offsetRef.current += jump
            push(`часы +${(jump / DAY).toFixed(1)} дн.`)
            reloadPage()
          }}
        >
          часы: до конца «Позже»
        </button>
        <button type="button" data-act="unsnooze" style={btn(false)} onClick={() => { local.clear(); push('«Позже» сброшено'); reloadPage() }}>
          сбросить «Позже»
        </button>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginBottom: 10, alignItems: 'center' }}>
        <label style={lbl}>
          <input type="checkbox" data-act="call" checked={inCall} onChange={(e) => setCall(e.target.checked)} /> идёт звонок
        </label>
        <label style={lbl}>
          <input type="checkbox" data-act="session" checked={newSession} onChange={(e) => setNewSession(e.target.checked)} /> плашка «Новый сеанс»
        </label>
        <label style={lbl}>
          <input type="checkbox" data-act="contacts" checked={contactsBar} onChange={(e) => setContactsBar(e.target.checked)} /> «Запросы в друзья»
        </label>
        <label style={lbl}>
          <input type="checkbox" data-act="modal" checked={modal} onChange={(e) => setModal(e.target.checked)} /> открыто окно (карточка)
        </label>
        <span style={{ width: 8 }} />
        {WIDTHS.map((w) => (
          <button key={w.w} type="button" data-width={w.w} onClick={() => setWidth(w.w)} style={btn(width === w.w)}>
            {w.label}
          </button>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <div id="eb-mig-demo-shot" style={{ display: 'flex', flexDirection: 'column', gap: 8, width, maxWidth: '100%' }}>
          <div id="eb-mig-demo-status" style={{ display: 'flex', flexWrap: 'wrap', gap: '2px 10px', fontSize: 12, lineHeight: 1.45 }}>
            <span style={{ color: ok ? '#64ddaa' : '#ff8a8a', fontWeight: 700 }}>
              {ok ? '✓' : '✗'} баннер {actual ? 'показан' : 'скрыт'}
              {actual && modal ? ' (под окном)' : ''} · ожидается: {expected ? 'показан' : 'скрыт'}
            </span>
            <span style={{ color: '#c9d4e5' }}>{scenario.title}</span>
            <span style={{ color: '#8a96ab' }}>
              getState: {callsRef.current.getState} · checkUpdate: {callsRef.current.checkUpdate} · «!» = {String(badgeRef.current)} · session = {sessionFlag ?? '—'} · «Позже»:{' '}
              {snoozeNow.until ? `${snoozeNow.count}-й, до ${new Date(snoozeNow.until).toLocaleDateString()}` : snoozeNow.count ? `${snoozeNow.count} раз, срок вышел` : '—'}
            </span>
          </div>
          <div
            ref={frameRef}
            id="eb-mig-demo-frame"
            style={
              {
                position: 'relative',
                width: '100%',
                height: 720,
                borderRadius: 12,
                overflow: 'hidden',
                border: '1px solid #2a2f3a',
                background: '#0f1217',
                // transform делает рамку «окном» для position: fixed внутри — баннер прижмётся к её верху.
                transform: 'translateZ(0)',
                '--eb-header-h': shell ? '30px' : '0px',
              } as CSSProperties
            }
          >
            {shell ? <FakeShellHeader /> : null}
            <FakeApp top={shell ? 30 : 0} narrow={narrow} />
            {contactsBar ? <FakeContactsBar top={shell ? 24 : 0} narrow={narrow} /> : null}
            <ElectronMigrationBanner key={runKey} env={env} onStateChange={setBannerState} />
            {modal ? <FakeUserCard top={shell ? 30 : 0} onClose={() => setModal(false)} /> : null}
            {settingsOpen ? (
              <FakeSettings
                top={shell ? 30 : 0}
                electron={electronRef.current}
                onDownload={() => setElectron({ status: 'downloaded' }, 'скачал (из настроек)')}
                onClose={() => setSettingsOpen(false)}
              />
            ) : null}
          </div>
        </div>
        <pre
          id="eb-mig-demo-log"
          style={{ flex: '1 1 300px', minWidth: 280, maxHeight: 760, overflow: 'auto', margin: 0, padding: 12, borderRadius: 12, background: '#0b1018', border: '1px solid #1d2532', color: '#aabcd5', fontSize: 12, lineHeight: 1.5, whiteSpace: 'pre-wrap' }}
        >
          {`«Позже»: ${ELECTRON_MIGRATION_SNOOZE_DAYS.join(' → ')} дн. · состояние хука: ${bannerState ? `host=${bannerState.host}, visible=${bannerState.visible}, osTooOld=${bannerState.osTooOld}` : '—'}\n\n`}
          {log.join('\n')}
        </pre>
      </div>
    </div>
  )
}

/** 30-пиксельная шапка окна ПК-оболочки (её рисует preload на Windows; она выше всего). */
function FakeShellHeader() {
  return (
    <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 30, background: '#0f1217', zIndex: 3000, display: 'flex', justifyContent: 'flex-end', borderBottom: '1px solid #171b22' }}>
      {['—', '▢', '✕'].map((g) => (
        <span key={g} style={{ width: 44, display: 'grid', placeItems: 'center', color: '#8a8f98', fontSize: 11 }}>
          {g}
        </span>
      ))}
    </div>
  )
}

/** Условное приложение под баннером: список бесед и открытая беседа (шапка с кнопками звонка). */
function FakeApp(props: { top: number; narrow: boolean }) {
  const rows = ['Катя', 'Козёл Ебаный', 'Работа', 'Мама', 'Икра', 'Вася', 'Коллеги']
  return (
    <div style={{ position: 'absolute', inset: `${props.top}px 0 0 0`, display: 'flex', background: '#0f1217' }}>
      <aside style={{ width: props.narrow ? '100%' : 300, borderRight: '1px solid #232731', padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div className="logo" style={{ fontSize: 30, alignSelf: 'center', margin: '6px 0 10px' }}>
          <span>Е</span>
          <span className="b">Б</span>
          <span>луша</span>
        </div>
        {rows.map((r) => (
          <div key={r} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: 8, borderRadius: 12, background: '#1b1f27' }}>
            <span style={{ width: 34, height: 34, borderRadius: 999, background: '#2b303a' }} />
            <span style={{ color: '#f1f3f6' }}>{r}</span>
          </div>
        ))}
      </aside>
      {props.narrow ? null : (
        <main style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
          <header style={{ height: 56, borderBottom: '1px solid #232731', display: 'flex', alignItems: 'center', padding: '0 16px', color: '#f1f3f6', fontWeight: 700, gap: 8 }}>
            <span style={{ flex: 1 }}>Катя</span>
            {['☎', '▶'].map((g) => (
              <span key={g} style={{ width: 34, height: 34, borderRadius: 999, background: '#232731', display: 'grid', placeItems: 'center', color: '#9aa0a8' }}>
                {g}
              </span>
            ))}
          </header>
          <div style={{ flex: 1, padding: 16, display: 'flex', flexDirection: 'column', gap: 8, justifyContent: 'flex-end' }}>
            {['Привет!', 'Ну что, переезжаем?', 'Давай вечером созвонимся'].map((t, i) => (
              <div key={t} style={{ alignSelf: i % 2 ? 'flex-end' : 'flex-start', background: i % 2 ? '#b45309' : '#232731', color: '#f1f3f6', padding: '8px 12px', borderRadius: 14 }}>
                {t}
              </div>
            ))}
          </div>
          <footer style={{ height: 56, borderTop: '1px solid #232731', display: 'flex', alignItems: 'center', padding: '0 16px', color: '#6b7280' }}>Сообщение…</footer>
        </main>
      )}
    </div>
  )
}

/** Плашка «Запросы в друзья» — как в ChatsPage (fixed сверху по центру, z 214, та же метка). */
function FakeContactsBar(props: { top: number; narrow: boolean }) {
  return (
    <div data-eb-contacts-bar="" style={{ position: 'fixed', top: 0, left: 0, right: 0, zIndex: 214, marginTop: props.top, display: 'flex', justifyContent: 'center' }}>
      <div
        style={{
          width: props.narrow ? '100%' : 'auto',
          maxWidth: props.narrow ? '100%' : 480,
          borderRadius: props.narrow ? 0 : '0 0 12px 12px',
          padding: '12px 14px',
          background: 'linear-gradient(180deg, #232731, #1b1f27)',
          border: '1px solid #313643',
          boxShadow: '0 10px 30px rgba(0,0,0,0.4)',
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
          color: '#f1f3f6',
        }}
      >
        <div style={{ fontWeight: 900, fontSize: 14 }}>Запросы в друзья (1)</div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <span style={{ width: 32, height: 32, borderRadius: 999, background: '#2b303a' }} />
          <span style={{ flex: 1 }}>Вася</span>
          <span style={{ ...btn(true), padding: '6px 12px' }}>Принять</span>
          <span style={{ ...btn(false), padding: '6px 12px' }}>Отклонить</span>
        </div>
      </div>
    </div>
  )
}

/** Окно поверх приложения — как карточка пользователя в ChatModals (fixed, затемнение, z 95). */
function FakeUserCard(props: { top: number; onClose: () => void }) {
  return (
    <div
      onClick={props.onClose}
      style={{ position: 'absolute', inset: `${props.top}px 0 0 0`, background: 'rgba(10,12,16,0.55)', backdropFilter: 'blur(4px) saturate(110%)', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', zIndex: 95, padding: '16px 12px' }}
    >
      <div onClick={(e) => e.stopPropagation()} style={{ position: 'relative', width: 340, maxWidth: '100%', borderRadius: 16, background: '#1b1f27', border: '1px solid #313643', padding: 18, display: 'flex', flexDirection: 'column', gap: 12, color: '#f1f3f6' }}>
        <button type="button" onClick={props.onClose} aria-label="Закрыть" style={{ position: 'absolute', top: 10, right: 10, width: 30, height: 30, borderRadius: 999, border: '1px solid #3b414f', background: '#232731', color: '#f1f3f6', cursor: 'pointer' }}>
          ✕
        </button>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <span style={{ width: 56, height: 56, borderRadius: 999, background: '#2b303a' }} />
          <div>
            <div style={{ fontWeight: 800, fontSize: 17 }}>Катя</div>
            <div style={{ color: '#9aa0a8', fontSize: 12 }}>в сети</div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <span style={{ ...btn(true), padding: '8px 14px' }}>Написать</span>
          <span style={{ ...btn(false), padding: '8px 14px' }}>Позвонить</span>
        </div>
      </div>
    </div>
  )
}

/** Условные настройки Electron (overlay/settings.html) — чтобы видеть, что «Перейти» их открывает. */
function FakeSettings(props: { top: number; electron: MockElectron; onDownload: () => void; onClose: () => void }) {
  const ui = updateUi(props.electron)
  return (
    <div style={{ position: 'absolute', inset: `${props.top}px 0 0 0`, background: 'rgba(10,12,16,0.62)', display: 'grid', placeItems: 'center', zIndex: 2000 }}>
      <div style={{ width: 360, maxWidth: '92%', borderRadius: 14, background: '#161a20', border: '1px solid #2a2f3a', padding: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ fontWeight: 800, fontSize: 16 }}>Настройки приложения (Electron)</div>
        <div>Текущая версия: {props.electron.current}</div>
        <div>Актуальная версия: {ui.available ? props.electron.latest : props.electron.current}</div>
        <div style={{ color: '#9aa0a8' }}>{ui.available ? 'Доступно обновление' : 'Обновлений нет'}</div>
        <button type="button" style={btn(true)} onClick={props.onDownload} disabled={!ui.available || ui.downloaded}>
          {ui.downloaded ? 'Установить и перезапустить' : ui.available ? 'Скачать' : 'Проверить обновления'}
        </button>
        <button type="button" style={btn(false)} onClick={props.onClose}>
          Закрыть настройки
        </button>
      </div>
    </div>
  )
}

const lbl: CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12 }

function btn(active: boolean): CSSProperties {
  return {
    padding: '6px 10px',
    borderRadius: 8,
    border: `1px solid ${active ? '#d97706' : '#2a3342'}`,
    background: active ? 'rgba(217,119,6,0.18)' : '#111823',
    color: '#eef3ff',
    fontSize: 12,
    cursor: 'pointer',
  }
}
