/**
 * Dev-стенд подписей шифрования звонка (ТЗ E2EE звонков, этап 0). Только dev-сборка:
 * /__dev/call-lock — в production маршрута и чанка нет.
 *
 * Показывает настоящими компонентами всё, где звонок говорит о шифровании:
 *   - капсулы экрана подключения («Шифрование через сервер» / «Без шифрования»);
 *   - экран ошибки «Не удалось включить шифрование» с «Повторить» (сбой ключа — звонок не начат);
 *   - плашку развёрнутого звонка и значок в миниатюре свёрнутого звонка.
 * Слова «сквозное» здесь быть не должно нигде: ключ 1:1 пока выдаёт сервер.
 */
import { useMemo, useState, type CSSProperties } from 'react'
import { LiveKitRoom } from '@livekit/components-react'
import { CallConnecting } from '../components/CallConnecting'
import { CallMini } from '../components/CallMini'
import { CallSecurityMark, CallStatusPill } from '../components/CallSecurityMark'
import { buildConnectView, EMPTY_CONNECT_PROGRESS, type ConnectRoute, type ConnectSignals } from '../components/callConnectView'
import {
  CALL_SECURITY_DETAIL,
  CALL_SECURITY_LABEL,
  E2EE_SETUP_FAILED_TITLE,
  describeE2eeSetupError,
  type CallSecurity,
} from '../components/callSecurity'

const CF: ConnectRoute = { relayed: true, rttMs: 45, relayName: 'Cloudflare', relayHost: 'turn.cloudflare.com' }

const base: ConnectSignals = {
  isGroup: false,
  encrypted: true,
  muted: false,
  hasToken: true,
  keysReady: true,
  connected: true,
  e2eeEnabled: true,
  micPublished: true,
  routeSwitching: false,
  route: CF,
  peer: { presence: 'joining', count: 1, name: 'Катя', id: 'demo-peer', avatarUrl: null },
  error: null,
}
const s = (patch: Partial<ConnectSignals>): ConnectSignals => ({ ...base, ...patch })
const keyError404 = describeE2eeSetupError({ response: { status: 404 } })
const keyErrorNet = describeE2eeSetupError({ isAxiosError: true, request: {} })
const unsupported = describeE2eeSetupError(new Error('DeviceUnsupportedError: E2EE not supported'))

const SCENARIOS: Array<{ id: string; title: string; signals: ConnectSignals }> = [
  { id: 'p2p-server', title: '1:1 — шифрование через сервер', signals: s({}) },
  { id: 'p2p-enabling', title: '1:1 — включаем шифрование', signals: s({ e2eeEnabled: false, micPublished: false }) },
  {
    id: 'group-plain',
    title: 'Группа — без шифрования',
    signals: s({
      isGroup: true,
      encrypted: false,
      e2eeEnabled: false,
      peer: { presence: 'joining', count: 3, name: 'Ереванский Городовой', id: 'demo-group', avatarUrl: null },
    }),
  },
  {
    id: 'key-404',
    title: 'Сбой ключа (404) — звонок не начат',
    signals: s({ connected: false, keysReady: false, e2eeEnabled: false, error: keyError404.text, errorTitle: E2EE_SETUP_FAILED_TITLE, errorRetry: keyError404.retry }),
  },
  {
    id: 'key-net',
    title: 'Нет связи — ключ не получен',
    signals: s({ connected: false, keysReady: false, e2eeEnabled: false, error: keyErrorNet.text, errorTitle: E2EE_SETUP_FAILED_TITLE, errorRetry: keyErrorNet.retry }),
  },
  {
    id: 'unsupported',
    title: 'Браузер без шифрования — без повтора',
    signals: s({ connected: false, keysReady: false, e2eeEnabled: false, error: unsupported.text, errorTitle: E2EE_SETUP_FAILED_TITLE, errorRetry: unsupported.retry }),
  },
  {
    id: 'mid-call',
    title: 'Шифрование отключилось во время звонка',
    signals: s({ error: 'Шифрование отключилось во время звонка. Без шифрования разговор продолжать нельзя — звонок прерван.' }),
  },
]

const SECURITIES: CallSecurity[] = ['server-key', 'none']

export default function CallLockDemo() {
  const [scenarioId, setScenarioId] = useState(SCENARIOS[0]!.id)
  const [retries, setRetries] = useState(0)
  const [closed, setClosed] = useState(0)
  const [mini, setMini] = useState<'off' | 'p2p' | 'group'>('off')
  const scenario = SCENARIOS.find((sc) => sc.id === scenarioId) ?? SCENARIOS[0]!
  const view = useMemo(() => buildConnectView(scenario.signals), [scenario])

  return (
    <div style={{ minHeight: '100vh', background: '#0f1217', color: '#f1f3f6', padding: 20, fontFamily: 'inherit' }}>
      <h1 style={{ fontSize: 18, margin: '0 0 4px' }}>Подписи шифрования звонка</h1>
      <div style={{ fontSize: 12, color: '#9aa0a8', marginBottom: 16 }}>
        Этап 0: ключ звонка 1:1 выдаёт сервер — «{CALL_SECURITY_LABEL['server-key']}»; группы — «{CALL_SECURITY_LABEL.none}». Слова «сквозное» нет нигде.
      </div>

      <section style={card} data-demo="labels">
        <div style={cardTitle}>Значки и плашка развёрнутого звонка</div>
        {SECURITIES.map((sec) => (
          <div key={sec} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 14, padding: '8px 0' }}>
            <span style={{ color: sec === 'server-key' ? '#e38b0a' : '#9aa0a8', display: 'inline-flex' }}>
              <CallSecurityMark security={sec} size={16} withText />
            </span>
            <CallStatusPill label="Подключено" security={sec} />
            <span style={{ fontSize: 12, color: '#9aa0a8', flex: '1 1 260px' }}>{CALL_SECURITY_DETAIL[sec]}</span>
          </div>
        ))}
      </section>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, margin: '16px 0 12px' }}>
        {SCENARIOS.map((sc) => (
          <button key={sc.id} type="button" onClick={() => setScenarioId(sc.id)} style={btn(sc.id === scenarioId)}>
            {sc.title}
          </button>
        ))}
      </div>
      <div
        style={{ position: 'relative', width: 760, maxWidth: '100%', height: 640, borderRadius: 16, overflow: 'hidden', border: '1px solid #313643', background: '#232731' }}
        data-demo="connecting"
      >
        <CallConnecting
          key={scenario.id}
          view={view}
          onCancel={() => setClosed((n) => n + 1)}
          onRetry={() => setRetries((n) => n + 1)}
          ringPeriodMs={2000}
        />
      </div>
      <div style={{ marginTop: 8, fontSize: 12, color: '#9aa0a8' }} data-demo="counters">
        {scenario.title} · режим «{view.mode}» · «Повторить» нажато: {retries} · «Закрыть/Отменить»: {closed}
      </div>

      <div style={{ marginTop: 16, display: 'flex', gap: 8, alignItems: 'center', fontSize: 12 }}>
        <span style={{ color: '#9aa0a8' }}>Миниатюра свёрнутого звонка:</span>
        {(['off', 'p2p', 'group'] as const).map((m) => (
          <button key={m} type="button" onClick={() => setMini(m)} style={btn(mini === m)}>
            {m === 'off' ? 'Убрать' : m === 'p2p' ? '1:1 (через сервер)' : 'Группа (без шифрования)'}
          </button>
        ))}
      </div>
      <LiveKitRoom serverUrl={undefined} token={undefined} connect={false}>
        <CallMini
          visible={mini !== 'off'}
          isGroup={mini === 'group'}
          encrypted={mini === 'p2p'}
          connectedAt={mini !== 'off' ? Date.now() - 252_000 : null}
          resolveAvatar={() => null}
          flyFrom={null}
          onExpand={() => setMini('off')}
          onHangUp={() => setMini('off')}
        />
      </LiveKitRoom>
    </div>
  )
}

const card: CSSProperties = { border: '1px solid #313643', background: '#1b1f27', borderRadius: 12, padding: '10px 14px', maxWidth: 760 }
const cardTitle: CSSProperties = { fontSize: 12, color: '#9aa0a8', marginBottom: 4 }

function btn(active: boolean): CSSProperties {
  return {
    padding: '6px 10px',
    borderRadius: 8,
    border: `1px solid ${active ? '#e38b0a' : '#3b414f'}`,
    background: active ? 'rgba(227,139,10,.16)' : '#232731',
    color: active ? '#f4e8c9' : '#f1f3f6',
    fontSize: 12,
    cursor: 'pointer',
  }
}
