/**
 * Dev-стенд баннера «Переезжайте на новую Еблушу». Только dev-сборка: /__dev/electron-migration —
 * в production маршрута нет.
 *
 * Всё подставное, кроме сторов приложения: window.native повторяет мост desktop/src/preload.ts
 * (settingsGetState / settingsCheckUpdate / openSettings, те же формы ответов, что в main.ts),
 * userAgent — Electron на Windows/Mac или обычный браузер, «!» на шестерёнке — флажок
 * window.__eblushaSettingsGearBadgeVisible, память «Позже» — своя (не localStorage), часы можно
 * сдвинуть. «Идёт звонок» и «Новый сеанс» включаются в НАСТОЯЩИХ сторах (callStore, systemUiStore).
 * Ни одного сетевого запроса стенд не делает.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { ElectronMigrationBanner, type ElectronMigrationState } from '../components/ElectronMigrationBanner'
import {
  ELECTRON_MIGRATION_SNOOZE_KEY,
  ELECTRON_MIGRATION_SNOOZE_MS,
  compareVersions,
  detectMigrationHost,
  isMigrationOffer,
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
}

type Scenario = {
  id: string
  title: string
  os: keyof typeof UA
  bridge: 'full' | 'check-only' | 'none'
  electron: MockElectron
  /** «!» на шестерёнке в момент загрузки страницы; по умолчанию — как есть у Electron. */
  badgeAtLoad?: boolean | null
  snoozed?: boolean
  inCall?: boolean
  newSession?: boolean
}

const E = (patch: Partial<MockElectron>): MockElectron => ({
  current: '0.7.5',
  latest: null,
  status: 'idle',
  ipcFails: false,
  ...patch,
})

const SCENARIOS: Scenario[] = [
  { id: 'browser', title: 'Браузер, нет Electron', os: 'browser', bridge: 'none', electron: E({}) },
  { id: 'mac', title: 'Electron на Mac (лента дала бы 2.0.0)', os: 'mac', bridge: 'full', electron: E({ latest: '2.0.0', status: 'available' }) },
  { id: 'no-bridge', title: 'Electron без window.native', os: 'win', bridge: 'none', electron: E({ latest: '2.0.0', status: 'available' }) },
  { id: 'none', title: 'Нет обновления (0.7.5)', os: 'win', bridge: 'full', electron: E({}) },
  { id: '076', title: 'Обновление 0.7.6', os: 'win', bridge: 'full', electron: E({ latest: '0.7.6', status: 'available' }) },
  { id: '200', title: 'Обновление 2.0.0', os: 'win', bridge: 'full', electron: E({ latest: '2.0.0', status: 'available' }) },
  { id: '200-dl', title: '2.0.0 уже скачана', os: 'win', bridge: 'full', electron: E({ latest: '2.0.0', status: 'downloaded' }) },
  {
    id: '200-reload',
    title: '2.0.0, страницу перезагрузили («!» = false)',
    os: 'win',
    bridge: 'full',
    electron: E({ latest: '2.0.0', status: 'available' }),
    badgeAtLoad: false,
  },
  { id: '200-later', title: '2.0.0, но нажато «Позже»', os: 'win', bridge: 'full', electron: E({ latest: '2.0.0', status: 'available' }), snoozed: true },
  { id: '200-call', title: '2.0.0 во время звонка', os: 'win', bridge: 'full', electron: E({ latest: '2.0.0', status: 'available' }), inCall: true },
  {
    id: '200-session',
    title: '2.0.0 + плашка «Новый сеанс»',
    os: 'win',
    bridge: 'full',
    electron: E({ latest: '2.0.0', status: 'available' }),
    newSession: true,
  },
  { id: 'error', title: 'Проверка ленты с ошибкой', os: 'win', bridge: 'full', electron: E({ latest: '2.0.0', status: 'error' }) },
  { id: 'ipc', title: 'Мост бросает исключение', os: 'win', bridge: 'full', electron: E({ latest: '2.0.0', status: 'available', ipcFails: true }) },
  { id: 'check-only', title: 'Старый мост: только settingsCheckUpdate', os: 'win', bridge: 'check-only', electron: E({ latest: '2.0.0', status: 'available' }) },
  { id: 'same', title: 'Установлена та же 2.0.0 (новее нет)', os: 'win', bridge: 'full', electron: E({ current: '2.0.0', latest: '2.0.0', status: 'idle' }) },
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
  const newer = !!e.latest && (compareVersions(e.latest, e.current) ?? 0) > 0
  const available = newer && e.status !== 'error' && e.status !== 'idle'
  return {
    status: e.status,
    latestVersion: e.latest ?? e.current,
    available,
    downloaded: available && e.status === 'downloaded',
  }
}

function createMemStorage(): MigrationStorage & { dump: () => string | null } {
  const map = new Map<string, string>()
  return {
    getItem: (k) => (map.has(k) ? (map.get(k) as string) : null),
    setItem: (k, v) => void map.set(k, String(v)),
    removeItem: (k) => void map.delete(k),
    dump: () => map.get(ELECTRON_MIGRATION_SNOOZE_KEY) ?? null,
  }
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

export default function ElectronMigrationDemo() {
  const [scenarioId, setScenarioId] = useState('200')
  const [width, setWidth] = useState(WIDTHS[0].w)
  const [runKey, setRunKey] = useState(0)
  const [log, setLog] = useState<string[]>([])
  const [bannerState, setBannerState] = useState<ElectronMigrationState | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [wentToSettings, setWentToSettings] = useState(false)
  const [tick, setTick] = useState(0)
  const scenario = SCENARIOS.find((s) => s.id === scenarioId) ?? SCENARIOS[0]

  const electronRef = useRef<MockElectron>({ ...scenario.electron })
  const badgeRef = useRef<boolean | null>(null)
  const offsetRef = useRef(0)
  const startedRef = useRef(Date.now())
  const storage = useMemo(() => createMemStorage(), [])

  const inCall = useCallStore((s) => Boolean(s.overlayConvId || s.activeConvId))
  const newSession = useSystemUiStore((s) => Boolean(s.newSessionPopup))

  const push = useCallback((line: string) => {
    const t = ((Date.now() - startedRef.current) / 1000).toFixed(1)
    setLog((l) => [...l.slice(-60), `+${t} с  ${line}`])
  }, [])

  const setCall = (on: boolean) => {
    useCallStore.setState(on ? { overlayConvId: 'demo-call', activeConvId: 'demo-call' } : { overlayConvId: null, activeConvId: null })
  }
  const setNewSession = (on: boolean) => {
    const st = useSystemUiStore.getState()
    if (on && !st.newSessionPopup) void st.requestNewSessionPopup({ deviceId: 'demo-device', deviceName: 'iPhone', platform: 'ios' })
    if (!on && st.newSessionPopup) st.resolveNewSessionPopup('dismiss')
  }

  // Новый прогон сценария: состояние Electron, «!», «Позже», звонок, «Новый сеанс».
  const start = useCallback(
    (sc: Scenario) => {
      electronRef.current = { ...sc.electron }
      const ui = updateUi(sc.electron)
      badgeRef.current = sc.badgeAtLoad !== undefined ? sc.badgeAtLoad : sc.bridge === 'none' ? null : ui.available
      offsetRef.current = 0
      startedRef.current = Date.now()
      storage.removeItem(ELECTRON_MIGRATION_SNOOZE_KEY)
      if (sc.snoozed) storage.setItem(ELECTRON_MIGRATION_SNOOZE_KEY, String(Date.now() + DAY))
      setCall(!!sc.inCall)
      setNewSession(!!sc.newSession)
      setSettingsOpen(false)
      setWentToSettings(false)
      setLog([`сценарий «${sc.title}»`])
      setRunKey((k) => k + 1)
    },
    [storage],
  )

  useEffect(() => {
    start(scenario)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scenarioId])

  // Уход со стенда — звонок и «Новый сеанс» в сторах не оставляем.
  useEffect(
    () => () => {
      setCall(false)
      setNewSession(false)
    },
    [],
  )

  // Подставной window.native: те же методы и формы ответов, что у preload.ts/main.ts.
  const native = useMemo<ElectronUpdateBridge | null>(() => {
    if (scenario.bridge === 'none') return null
    const getState = async () => {
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
        serverLatestVersion: e.latest ?? e.current,
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
      await delay(400)
      const e = electronRef.current
      if (e.ipcFails) {
        push('settingsCheckUpdate() → исключение')
        throw new Error('ipc failed')
      }
      const update = updateUi(e)
      push(`settingsCheckUpdate() → available=${update.available}, version=${update.available ? e.latest : null}`)
      return { available: update.available, version: update.available ? e.latest : null, downloaded: update.downloaded, update }
    }
    return {
      ...(scenario.bridge === 'full' ? { settingsGetState: getState } : {}),
      settingsCheckUpdate: checkUpdate,
      openSettings: async () => {
        push('openSettings() → Electron открыл свои настройки')
        setWentToSettings(true)
        setSettingsOpen(true)
      },
    }
    // runKey: новый объект моста на каждый прогон
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scenario, runKey, push])

  const env = useMemo<MigrationEnv>(
    () => ({
      native,
      userAgent: UA[scenario.os],
      platform: PLATFORM[scenario.os],
      storage,
      now: () => Date.now() + offsetRef.current,
      readBadge: () => badgeRef.current,
      firstAskDelayMs: 600,
    }),
    [native, scenario, storage],
  )

  // Electron «меняет мнение»: состояние подставного Electron и «!», как шлёт updater:badge.
  const setElectron = (patch: Partial<MockElectron>, label: string) => {
    electronRef.current = { ...electronRef.current, ...patch }
    if (badgeRef.current !== null) badgeRef.current = updateUi(electronRef.current).available
    push(`Electron: ${label}; «!» = ${String(badgeRef.current)}`)
    setTick((t) => t + 1)
  }

  const host = detectMigrationHost(env)
  const ui = updateUi(electronRef.current)
  const electronOffer =
    !electronRef.current.ipcFails &&
    isMigrationOffer({ available: ui.available, latestVersion: ui.latestVersion, currentVersion: electronRef.current.current, status: ui.status, downloaded: ui.downloaded })
  const snoozedNow = readSnooze(storage, env.now()) !== null
  const expected = host === 'electron-windows' && electronOffer && !snoozedNow && !inCall && !newSession && !wentToSettings
  const actual = bannerState?.visible ?? false
  const shell = scenario.os === 'win' && host !== 'browser'
  const narrow = width < 700
  void tick

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
        <button type="button" style={btn(false)} onClick={() => setElectron({ latest: '2.0.0', status: 'available' }, 'нашёл 2.0.0')}>нашёл 2.0.0</button>
        <button type="button" style={btn(false)} onClick={() => setElectron({ latest: '0.7.6', status: 'available' }, 'нашёл 0.7.6')}>нашёл 0.7.6</button>
        <button type="button" style={btn(false)} onClick={() => setElectron({ latest: null, status: 'idle' }, 'лента откатилась — обновления нет')}>лента откатилась</button>
        <button type="button" style={btn(false)} onClick={() => setElectron({ status: 'downloaded' }, 'скачал')}>скачал</button>
        <button type="button" style={btn(false)} onClick={() => setElectron({ status: 'error' }, 'ошибка проверки')}>ошибка проверки</button>
        <span style={{ width: 12 }} />
        <label style={lbl}>
          <input type="checkbox" checked={inCall} onChange={(e) => setCall(e.target.checked)} /> идёт звонок
        </label>
        <label style={lbl}>
          <input type="checkbox" checked={newSession} onChange={(e) => setNewSession(e.target.checked)} /> плашка «Новый сеанс»
        </label>
        <button type="button" style={btn(false)} onClick={() => { storage.removeItem(ELECTRON_MIGRATION_SNOOZE_KEY); push('«Позже» сброшено'); setRunKey((k) => k + 1) }}>
          сбросить «Позже»
        </button>
        <button
          type="button"
          style={btn(false)}
          onClick={() => {
            offsetRef.current += ELECTRON_MIGRATION_SNOOZE_MS + 60_000
            push(`часы +${Math.round(ELECTRON_MIGRATION_SNOOZE_MS / DAY)} дн. — перезагрузка страницы`)
            setWentToSettings(false)
            setRunKey((k) => k + 1)
          }}
        >
          +{Math.round(ELECTRON_MIGRATION_SNOOZE_MS / DAY)} дня
        </button>
        <button type="button" style={btn(false)} onClick={() => { setWentToSettings(false); setSettingsOpen(false); push('перезагрузка страницы'); setRunKey((k) => k + 1) }}>
          перезагрузить страницу
        </button>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12, alignItems: 'center' }}>
        {WIDTHS.map((w) => (
          <button key={w.w} type="button" onClick={() => setWidth(w.w)} style={btn(width === w.w)}>
            {w.label}
          </button>
        ))}
        <span id="eb-mig-demo-status" style={{ marginLeft: 12, color: expected === actual ? '#64ddaa' : '#ff8a8a' }}>
          {expected === actual ? '✓' : '✗'} баннер {actual ? 'показан' : 'скрыт'} (ожидается: {expected ? 'показан' : 'скрыт'})
        </span>
        <span style={{ color: '#8a96ab' }}>
          · среда: {host} · «!» = {String(badgeRef.current)} · «Позже» до: {storage.dump() ? new Date(Number(storage.dump())).toLocaleString() : '—'}
        </span>
      </div>

      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <div
          style={
            {
              position: 'relative',
              width,
              maxWidth: '100%',
              height: 640,
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
          <ElectronMigrationBanner key={runKey} env={env} onStateChange={setBannerState} />
          {settingsOpen ? (
            <FakeSettings
              top={shell ? 30 : 0}
              electron={electronRef.current}
              onDownload={() => setElectron({ status: 'downloaded' }, 'скачал (из настроек)')}
              onClose={() => setSettingsOpen(false)}
            />
          ) : null}
        </div>
        <pre
          id="eb-mig-demo-log"
          style={{ flex: '1 1 300px', minWidth: 280, maxHeight: 640, overflow: 'auto', margin: 0, padding: 12, borderRadius: 12, background: '#0b1018', border: '1px solid #1d2532', color: '#aabcd5', fontSize: 12, lineHeight: 1.5, whiteSpace: 'pre-wrap' }}
        >
          {log.join('\n')}
        </pre>
      </div>
    </div>
  )
}

/** 30-пиксельная шапка окна ПК-оболочки (её рисует preload на Windows). */
function FakeShellHeader() {
  return (
    <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 30, background: '#0f1217', zIndex: 5, display: 'flex', justifyContent: 'flex-end', borderBottom: '1px solid #171b22' }}>
      {['—', '▢', '✕'].map((g) => (
        <span key={g} style={{ width: 44, display: 'grid', placeItems: 'center', color: '#8a8f98', fontSize: 11 }}>
          {g}
        </span>
      ))}
    </div>
  )
}

/** Условное приложение под баннером: список бесед и открытая беседа. */
function FakeApp(props: { top: number; narrow: boolean }) {
  const rows = ['Катя', 'Козёл Ебаный', 'Работа', 'Мама', 'Икра', 'Вася']
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
          <header style={{ height: 56, borderBottom: '1px solid #232731', display: 'flex', alignItems: 'center', padding: '0 16px', color: '#f1f3f6', fontWeight: 700 }}>Катя</header>
          <div style={{ flex: 1, padding: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {['Привет!', 'Ну что, переезжаем?', 'Давай вечером созвонимся'].map((t, i) => (
              <div key={t} style={{ alignSelf: i % 2 ? 'flex-end' : 'flex-start', background: i % 2 ? '#b45309' : '#232731', color: '#f1f3f6', padding: '8px 12px', borderRadius: 14 }}>
                {t}
              </div>
            ))}
          </div>
        </main>
      )}
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
