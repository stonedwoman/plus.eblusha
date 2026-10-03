/**
 * Dev-стенд экрана подключения к звонку: фиксированные состояния без настоящего
 * звонка. Доступен только в dev-сборке по адресу /__dev/call-connecting — в
 * production маршрута нет, а сам экран здесь ничем не управляет.
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { CallConnecting } from '../components/CallConnecting'
import { CallMini } from '../components/CallMini'
import { LiveKitRoom } from '@livekit/components-react'
import {
  buildConnectView,
  EMPTY_CONNECT_PROGRESS,
  usePacedConnectSignals,
  type ConnectRoute,
  type ConnectSignals,
} from '../components/callConnectView'

const DEMO_AVATAR =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f7b267"/><stop offset="1" stop-color="#c8508a"/></linearGradient></defs><rect width="96" height="96" fill="url(#g)"/><circle cx="48" cy="38" r="16" fill="#fff" opacity=".9"/><path d="M18 88c4-18 16-26 30-26s26 8 30 26z" fill="#fff" opacity=".9"/></svg>',
  )

const CF: ConnectRoute = { relayed: true, rttMs: 45, relayName: 'Cloudflare', relayHost: 'turn.cloudflare.com' }
const OWN: ConnectRoute = { relayed: true, rttMs: 98, relayName: 'Наш ретранслятор', relayHost: 'ru.eblusha.org' }
const DIRECT: ConnectRoute = { relayed: false, rttMs: 32, relayName: null, relayHost: null }

const base: ConnectSignals = {
  isGroup: false,
  encrypted: true,
  muted: false,
  hasToken: false,
  keysReady: false,
  connected: false,
  e2eeEnabled: false,
  micPublished: false,
  routeSwitching: false,
  route: EMPTY_CONNECT_PROGRESS.route,
  peer: { presence: 'absent', count: 0, name: 'Катя', id: 'demo-peer', avatarUrl: DEMO_AVATAR },
  error: null,
}

const s = (patch: Partial<ConnectSignals>): ConnectSignals => ({ ...base, ...patch })

const SCENARIOS: Array<{ id: string; title: string; signals: ConnectSignals }> = [
  { id: 'ringing', title: 'Звоним… (дозвон)', signals: s({ ringing: true, ringingSeconds: 7 }) },
  { id: 'answered', title: 'Собеседник ответил', signals: s({ ringing: false }) },
  { id: 'signaling', title: '1:1 — договариваемся', signals: s({}) },
  { id: 'keys', title: '1:1 — готовим шифрование', signals: s({ hasToken: true }) },
  { id: 'route', title: '1:1 — путь ещё неизвестен', signals: s({ hasToken: true, keysReady: true }) },
  {
    id: 'cf-e2ee',
    title: 'Cloudflare — включаем шифрование',
    signals: s({ hasToken: true, keysReady: true, connected: true, route: CF }),
  },
  {
    id: 'cf-publish',
    title: 'Cloudflare — публикуем микрофон',
    signals: s({ hasToken: true, keysReady: true, connected: true, e2eeEnabled: true, route: CF }),
  },
  {
    id: 'cf-wait',
    title: 'Cloudflare — ждём собеседника',
    signals: s({ hasToken: true, keysReady: true, connected: true, e2eeEnabled: true, micPublished: true, route: CF }),
  },
  {
    id: 'cf-joining',
    title: 'Собеседник подключается',
    signals: s({
      hasToken: true,
      keysReady: true,
      connected: true,
      e2eeEnabled: true,
      micPublished: true,
      route: CF,
      peer: { ...base.peer, presence: 'joining', count: 1 },
    }),
  },
  {
    id: 'own',
    title: 'Наш ретранслятор — публикуем микрофон',
    signals: s({ hasToken: true, keysReady: true, connected: true, e2eeEnabled: true, route: OWN }),
  },
  {
    id: 'direct',
    title: 'Прямой путь — ждём собеседника',
    signals: s({ hasToken: true, keysReady: true, connected: true, e2eeEnabled: true, micPublished: true, route: DIRECT }),
  },
  { id: 'switch', title: 'Смена маршрута', signals: s({ hasToken: true, keysReady: true, routeSwitching: true }) },
  {
    id: 'group-empty',
    title: 'Группа — пусто, без шифрования',
    signals: s({
      isGroup: true,
      encrypted: false,
      hasToken: true,
      connected: true,
      route: CF,
      peer: { presence: 'absent', count: 0, name: 'Ереванский Городовой', id: 'demo-group', avatarUrl: null },
    }),
  },
  {
    id: 'group',
    title: 'Группа — подключаем участников',
    signals: s({
      isGroup: true,
      encrypted: false,
      hasToken: true,
      connected: true,
      micPublished: true,
      route: CF,
      peer: { presence: 'joining', count: 3, name: 'Ереванский Городовой', id: 'demo-group', avatarUrl: null },
    }),
  },
  {
    id: 'muted',
    title: 'Микрофон выключен',
    signals: s({ hasToken: true, keysReady: true, connected: true, e2eeEnabled: true, muted: true, route: CF }),
  },
  {
    id: 'longname',
    title: 'Длинное имя, без аватара',
    signals: s({
      hasToken: true,
      keysReady: true,
      connected: true,
      e2eeEnabled: true,
      micPublished: true,
      route: { ...OWN, relayHost: 'very-long-relay-hostname.example-provider.net' },
      peer: { presence: 'joining', count: 1, name: 'Константин Константинопольский-Задунайский', id: 'demo-long', avatarUrl: null },
    }),
  },
  {
    id: 'mic-unavailable',
    title: 'Группа — микрофон недоступен',
    signals: s({
      isGroup: true,
      encrypted: false,
      hasToken: true,
      connected: true,
      micUnavailable: true,
      route: CF,
      peer: { presence: 'absent', count: 0, name: 'Ереванский Городовой', id: 'demo-group', avatarUrl: null },
    }),
  },
  {
    id: 'connect-error',
    title: 'Ошибка подключения к серверу',
    signals: s({
      hasToken: true,
      keysReady: true,
      error: 'Не удалось соединиться с сервером звонков. Проверьте связь и попробуйте ещё раз.',
      errorTitle: 'Не удалось подключиться',
    }),
  },
  {
    id: 'sync',
    title: 'Синхронизируемся с собеседником',
    signals: s({
      hasToken: true,
      keysReady: true,
      connected: true,
      e2eeEnabled: true,
      micPublished: true,
      route: CF,
      peer: { ...base.peer, presence: 'settling', count: 1 },
    }),
  },
  {
    id: 'error',
    title: 'Ошибка шифрования',
    signals: s({
      hasToken: true,
      error: 'Звонок не начат: без шифрования разговор один на один не идёт. Сервер не выдал ключ шифрования (ошибка 404).',
      errorTitle: 'Не удалось включить шифрование',
      errorRetry: true,
    }),
  },
  {
    id: 'done',
    title: 'Соединение установлено',
    signals: s({
      hasToken: true,
      keysReady: true,
      connected: true,
      e2eeEnabled: true,
      micPublished: true,
      route: CF,
      peer: { ...base.peer, presence: 'ready', count: 1 },
    }),
  },
]

/** Истории для «прогона»: последовательности состояний, как они бывают в жизни. */
const STORIES: Record<string, { ids: string[]; intervalMs: number }> = {
  'Обычный звонок': {
    ids: ['signaling', 'keys', 'route', 'cf-e2ee', 'cf-publish', 'cf-wait', 'cf-joining', 'done'],
    intervalMs: 1500,
  },
  'Дозвон → ответ': {
    ids: ['ringing', 'ringing', 'ringing', 'answered', 'keys', 'route', 'cf-e2ee', 'cf-publish', 'cf-wait', 'cf-joining', 'done'],
    intervalMs: 1200,
  },
  // Реальность за 120 мс на ступень: темп обязан растянуть показ примерно до 3 с.
  'Мгновенный звонок': {
    ids: ['signaling', 'keys', 'route', 'cf-e2ee', 'cf-publish', 'cf-wait', 'cf-joining', 'done'],
    intervalMs: 120,
  },
  'Смена маршрута': { ids: ['signaling', 'keys', 'route', 'switch', 'direct', 'done'], intervalMs: 1500 },
  'Ретранслятор появляется': { ids: ['route', 'cf-e2ee', 'route', 'own', 'route', 'direct'], intervalMs: 1500 },
}

const WIDTHS = [
  { label: 'ПК (760)', w: 760 },
  { label: 'Узко (600)', w: 600 },
  { label: 'Телефон (380)', w: 380 },
]

export default function CallConnectingDemo() {
  const [scenarioId, setScenarioId] = useState(SCENARIOS[2].id)
  const [width, setWidth] = useState(WIDTHS[0].w)
  const [story, setStory] = useState<string | null>(null)
  const [stepIdx, setStepIdx] = useState(0)
  const [cancelled, setCancelled] = useState<string | null>(null)
  const [paced, setPaced] = useState(true)
  const [runId, setRunId] = useState(0)
  const startedAtRef = useRef(0)
  const [settledAfterMs, setSettledAfterMs] = useState<number | null>(null)
  // Миниатюра свёрнутого звонка — в пустой комнате (без подключения): проверка перетаскивания.
  const [miniOn, setMiniOn] = useState(false)
  const [miniExpanded, setMiniExpanded] = useState(0)

  useEffect(() => {
    if (!story) return
    const { ids, intervalMs } = STORIES[story]
    setScenarioId(ids[0])
    setStepIdx(0)
    startedAtRef.current = Date.now()
    setSettledAfterMs(null)
    setRunId((r) => r + 1)
    const timer = setInterval(() => {
      setStepIdx((i) => {
        const next = i + 1
        if (next >= ids.length) {
          clearInterval(timer)
          return i
        }
        setScenarioId(ids[next])
        return next
      })
    }, intervalMs)
    return () => clearInterval(timer)
  }, [story])

  const scenario = SCENARIOS.find((sc) => sc.id === scenarioId) ?? SCENARIOS[0]
  const pacedResult = usePacedConnectSignals(scenario.signals, `${story ?? 'manual'}:${runId}`)
  const view = useMemo(
    () => buildConnectView(paced ? pacedResult.signals : scenario.signals),
    [paced, pacedResult.signals, scenario],
  )
  useEffect(() => {
    if (paced && pacedResult.settled && settledAfterMs === null && startedAtRef.current) {
      setSettledAfterMs(Date.now() - startedAtRef.current)
    }
  }, [paced, pacedResult.settled, settledAfterMs])

  return (
    <div style={{ minHeight: '100vh', background: '#070b11', color: '#eef3ff', padding: 20, fontFamily: 'inherit' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12, alignItems: 'center' }}>
        {WIDTHS.map((w) => (
          <button key={w.w} type="button" onClick={() => setWidth(w.w)} style={btn(width === w.w)}>
            {w.label}
          </button>
        ))}
        <span style={{ width: 16 }} />
        {Object.keys(STORIES).map((name) => (
          <button
            key={name}
            type="button"
            onClick={() => {
              setStory(null)
              setTimeout(() => setStory(name), 0)
            }}
            style={btn(story === name)}
          >
            ▶ {name}
          </button>
        ))}
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, marginLeft: 8 }}>
          <input type="checkbox" checked={paced} onChange={(e) => setPaced(e.target.checked)} />
          Темп как в звонке (~3 с)
        </label>
        {cancelled && <span style={{ marginLeft: 12, color: '#64ddaa' }}>Отмена нажата в «{cancelled}»</span>}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 16 }}>
        {SCENARIOS.map((sc) => (
          <button
            key={sc.id}
            type="button"
            onClick={() => {
              setStory(null)
              setScenarioId(sc.id)
            }}
            style={btn(sc.id === scenarioId)}
          >
            {sc.title}
          </button>
        ))}
      </div>
      <div
        style={{
          position: 'relative',
          width,
          maxWidth: '100%',
          height: 720,
          borderRadius: 16,
          overflow: 'hidden',
          border: '1px solid #223',
          background: '#232731',
        }}
      >
        <CallConnecting key={width} view={view} onCancel={() => setCancelled(scenario.title)} onRetry={() => setCancelled(`${scenario.title} — «Повторить»`)} ringPeriodMs={2000} />
      </div>
      <div style={{ marginTop: 14, display: 'flex', gap: 8, alignItems: 'center', fontSize: 12, color: '#aabcd5' }}>
        <button type="button" onClick={() => setMiniOn((v) => !v)} style={btn(miniOn)}>
          {miniOn ? 'Убрать миниатюру' : 'Показать миниатюру свёрнутого звонка'}
        </button>
        <span>развёрнуто раз: {miniExpanded}</span>
      </div>
      <LiveKitRoom serverUrl={undefined} token={undefined} connect={false}>
        <CallMini
          visible={miniOn}
          isGroup={false}
          encrypted
          connectedAt={miniOn ? Date.now() - 252_000 : null}
          resolveAvatar={() => null}
          flyFrom={null}
          onExpand={() => { setMiniExpanded((n) => n + 1); setMiniOn(false) }}
          onHangUp={() => setMiniOn(false)}
        />
      </LiveKitRoom>
      <div style={{ marginTop: 10, fontSize: 12, color: '#aabcd5' }}>
        {story ? `${story}: шаг ${stepIdx + 1} из ${STORIES[story].ids.length}` : scenario.title} · режим «{view.mode}» · темп:{' '}
        {!paced ? 'выкл' : settledAfterMs !== null ? `экран отпущен через ${settledAfterMs} мс` : pacedResult.settled ? 'готов' : 'идёт'}
        {view.ready ? ' · готово — в настоящем звонке экран уже растаял бы' : ''}
      </div>
    </div>
  )
}

function btn(active: boolean): CSSProperties {
  return {
    padding: '6px 10px',
    borderRadius: 8,
    border: `1px solid ${active ? '#4b7bff' : '#293a50'}`,
    background: active ? 'rgba(75,123,255,.18)' : '#14202e',
    color: active ? '#a9c1ff' : '#eef3ff',
    fontSize: 12,
    cursor: 'pointer',
  }
}
