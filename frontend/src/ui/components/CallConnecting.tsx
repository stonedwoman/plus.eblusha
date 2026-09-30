/**
 * Экран установления звонка.
 *
 * Показывает реальный путь разговора — от вас через ретранслятор к серверу и дальше к
 * собеседнику — и подсвечивает участок, который прокладывается прямо сейчас. Ниже —
 * этапы подключения, справа сверху — подтверждённые факты о соединении.
 *
 * Всё, что здесь нарисовано, приходит готовым из buildConnectView: компонент ничего не
 * решает и ничем не управляет, кроме отмены. Единственная его собственная память —
 * анимация ухода ретранслятора при смене маршрута и выбранная подсказка.
 */
import { Fragment, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { ArrowRight, Check, Clock, Cloud, Lock, Server, ShieldAlert, User, Users, Waypoints } from 'lucide-react'
import { convertToProxyUrl } from '../../utils/media'
import { useDelayedUnmount, type ConnectNode, type ConnectNodeId, type ConnectView } from './callConnectView'
import './callConnecting.css'

type Props = {
  view: ConnectView
  /** Разговор уже начался — экран растворяется, а не пропадает рывком. */
  leaving?: boolean
  onCancel?: () => void
  /** Период гудка дозвона, мс — кольца вокруг собеседника расходятся в такт ему. */
  ringPeriodMs?: number
  /** Когда гудки начались (Date.now) — чтобы кольца попали в фазу, а не стартовали с нуля. */
  ringStartedAt?: number
}

const NODE_COLOR: Record<ConnectNodeId, string> = {
  you: 'var(--call-node-self)',
  relay: 'var(--call-node-relay)',
  server: 'var(--call-node-server)',
  peer: 'var(--call-node-peer)',
}

const NODE_STATE_TITLE = { waiting: 'ждёт', active: 'подключается', ready: 'готов', ringing: 'вызываем' } as const
const STEP_STATUS_TITLE = { done: 'готово', active: 'выполняется', waiting: 'ждёт' } as const

export function CallConnecting({ view, leaving = false, onCancel, ringPeriodMs, ringStartedAt }: Props) {
  const [cancelling, setCancelling] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  // Фаза колец считается один раз при появлении: сколько гудка уже прошло к этому моменту.
  const ringStyle = useMemo(() => {
    const period = ringPeriodMs && ringPeriodMs > 0 ? ringPeriodMs : 2000
    const elapsed = ringStartedAt ? Math.max(0, Date.now() - ringStartedAt) % period : 0
    return { '--eb-ring-period': `${period}ms`, '--eb-ring-offset': `${-elapsed}ms` } as CSSProperties
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ringPeriodMs])

  const cancel = () => {
    if (cancelling || !onCancel) return
    setCancelling(true)
    onCancel()
  }

  // Ретранслятор появляется, когда путь через него подтверждён, и исчезает при смене
  // маршрута. Чтобы он не пропадал рывком, узел остаётся в разметке на время анимации.
  const relay = view.nodes.find((n) => n.id === 'relay') ?? null
  const lastRelayRef = useRef<ConnectNode | null>(null)
  if (relay) lastRelayRef.current = relay
  const relayPresence = useDelayedUnmount(!!relay, 400)
  const relayLeaving = !relay && relayPresence.mounted && !!lastRelayRef.current
  const nodes = useMemo(() => {
    if (!relayLeaving || !lastRelayRef.current) return view.nodes
    const out = [...view.nodes]
    out.splice(1, 0, lastRelayRef.current)
    return out
  }, [view.nodes, relayLeaving])

  const selectedDetail = useMemo(() => {
    if (!selected) return null
    const node = nodes.find((n) => `node:${n.id}` === selected)
    if (node) return node.detail
    const step = view.steps.find((st) => `step:${st.id}` === selected)
    return step ? step.hint : null
  }, [selected, nodes, view.steps])

  const toggle = (key: string) => setSelected((prev) => (prev === key ? null : key))

  if (view.mode === 'error' && view.error) {
    return (
      <div className={'eb-cn' + (leaving ? ' is-leaving' : '')} role="alertdialog" aria-labelledby="eb-cn-error-title">
        <div className="eb-cn__panel eb-cn__panel--error">
          <div className="eb-cn__error">
            <div className="eb-cn__error-icon" aria-hidden="true">
              <ShieldAlert />
            </div>
            <div className="eb-cn__error-title" id="eb-cn-error-title">
              {view.error.title}
            </div>
            <div className="eb-cn__error-text">{view.error.text}</div>
            <button type="button" className="eb-cn__cancel" onClick={cancel} disabled={cancelling}>
              {cancelling ? 'Закрываем…' : 'Закрыть'}
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className={'eb-cn' + (leaving ? ' is-leaving' : '')} role="dialog" aria-label="Подключение к звонку" style={ringStyle}>
      <div className="eb-cn__panel" style={{ '--steps': view.steps.length } as CSSProperties}>
        {view.facts.length > 0 && (
          <ul className="eb-cn__facts" aria-label="Сведения о соединении">
            {view.facts.map((f) => (
              <li className="eb-cn__fact" key={f.id}>
                {f.id === 'e2ee' ? <Lock /> : f.id === 'relay' ? <Waypoints /> : f.id === 'direct' ? <ArrowRight /> : <Clock />}
                <span className={f.id === 'rtt' ? 'eb-cn__num' : undefined}>{f.text}</span>
              </li>
            ))}
          </ul>
        )}

        <div className="eb-cn__head" aria-live="polite" aria-atomic="true">
          <div className="eb-cn__title" key={view.title}>
            {view.title}
          </div>
          <div className="eb-cn__subtitle" key={view.subtitle}>
            {view.subtitle}
          </div>
        </div>

        <div className="eb-cn__path">
          <Waves />
          <div className="eb-cn__row">
            {nodes.map((n, i) => {
              const prev = i > 0 ? nodes[i - 1] : null
              const key = `node:${n.id}`
              // Уходящий ретранслятор: его участок был проложен — таким и исчезает.
              const linkState = view.links.find((l) => l.to === n.id)?.state ?? 'ready'
              const isRelay = n.id === 'relay'
              const leavingCls = isRelay && relayLeaving ? ' is-leaving' : ''
              return (
                <Fragment key={n.id}>
                  {prev && (
                    <div
                      className={`eb-cn__link is-${linkState}${isRelay ? ' eb-cn__link--relay' : ''}${leavingCls}`}
                      style={{ '--from': NODE_COLOR[prev.id], '--to': NODE_COLOR[n.id] } as CSSProperties}
                      aria-hidden="true"
                    >
                      <span className="eb-cn__track">
                        <span className="eb-cn__packet" />
                      </span>
                    </div>
                  )}
                  <button
                    type="button"
                    className={`eb-cn__node is-${n.state}${selected === key ? ' is-selected' : ''}${leavingCls}`}
                    data-role={n.id}
                    aria-pressed={selected === key}
                    aria-label={`${n.label}: ${NODE_STATE_TITLE[n.state]}`}
                    title={n.detail}
                    onClick={() => toggle(key)}
                  >
                    <span className="eb-cn__disc">
                      <span className="eb-cn__halo" />
                      <span className="eb-cn__ring" />
                      <span className="eb-cn__ring eb-cn__ring--2" />
                      <span className="eb-cn__ring eb-cn__ring--3" />
                      <span className="eb-cn__arc" />
                      <span className="eb-cn__circle">
                        <NodeGlyph node={n} />
                      </span>
                    </span>
                    <span className="eb-cn__label">{n.label}</span>
                    {n.sub && (
                      <span className="eb-cn__sub" title={n.sub}>
                        {n.sub}
                      </span>
                    )}
                  </button>
                </Fragment>
              )
            })}
          </div>
        </div>

        <ol className="eb-cn__steps">
          {view.steps.map((st, i) => {
            const key = `step:${st.id}`
            return (
              <li key={st.id}>
                <button
                  type="button"
                  className={`eb-cn__step is-${st.status}${selected === key ? ' is-selected' : ''}`}
                  aria-pressed={selected === key}
                  aria-label={`Этап ${i + 1}, ${st.title}: ${STEP_STATUS_TITLE[st.status]}`}
                  title={st.hint}
                  onClick={() => toggle(key)}
                >
                  <span className="eb-cn__step-badge" aria-hidden="true">
                    {st.status === 'done' ? <Check strokeWidth={3} /> : i + 1}
                  </span>
                  <span className="eb-cn__step-title">{st.title}</span>
                </button>
              </li>
            )
          })}
        </ol>

        <div className="eb-cn__detail" aria-live="polite">
          {selectedDetail}
        </div>

        {onCancel && (
          <div className="eb-cn__actions">
            <button type="button" className="eb-cn__cancel" onClick={cancel} disabled={cancelling}>
              {cancelling ? 'Отменяем…' : 'Отменить'}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

function NodeGlyph({ node }: { node: ConnectNode }) {
  if (node.id === 'you') return <User />
  if (node.id === 'relay') return <Cloud />
  if (node.id === 'server') return <Server />
  return <NodeAvatar name={node.label} id={node.avatarId} url={node.avatarUrl} group={node.group} />
}

function colorFromId(id: string): string {
  let hash = 0
  for (let i = 0; i < id.length; i++) hash = id.charCodeAt(i) + ((hash << 5) - hash)
  const hue = Math.abs(hash) % 360
  return `hsl(${hue} 45% 38%)`
}

function initialsFromName(name: string): string {
  const parts = (name || '').trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0].charAt(0).toUpperCase()
  return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase()
}

/**
 * Аватар в узле схемы. Картинка, если она есть и грузится; иначе инициалы или значок
 * группы. Ошибка загрузки не ломает схему — просто показываем запасной вариант.
 */
function NodeAvatar({ name, id, url, group }: { name: string; id: string | null; url: string | null; group: boolean }) {
  const [failed, setFailed] = useState(false)
  const emoji = url?.startsWith('emoji:') ? url.slice('emoji:'.length) : null
  const src = useMemo(() => {
    if (!url || emoji) return null
    if (url.startsWith('data:') || url.startsWith('blob:')) return url
    const proxied = convertToProxyUrl(url)
    return proxied || url
  }, [url, emoji])
  useEffect(() => {
    setFailed(false)
  }, [src])

  if (emoji) return <span className="eb-cn__emoji">{emoji}</span>
  if (src && !failed) {
    return <img className="eb-cn__avatar" src={src} alt="" draggable={false} onError={() => setFailed(true)} />
  }
  if (group) return <Users />
  return (
    <span className="eb-cn__initials" style={{ background: colorFromId(id || name || '?') }}>
      {initialsFromName(name)}
    </span>
  )
}

/**
 * Фоновые волны за схемой. Три слоя с периодом 800 единиц, сдвиг ровно на период даёт
 * бесшовный цикл. Чисто декоративны: не реагируют ни на голос, ни на состояние.
 */
function Waves() {
  const w1 = 'M-800,116 Q-600,62 -400,116 T0,116 T400,116 T800,116 T1200,116 T1600,116'
  const w2 = 'M-800,124 Q-600,92 -400,124 T0,124 T400,124 T800,124 T1200,124 T1600,124'
  const w3 = 'M-800,104 Q-600,80 -400,104 T0,104 T400,104 T800,104 T1200,104 T1600,104'
  return (
    <svg className="eb-cn__waves" viewBox="0 0 800 200" preserveAspectRatio="none" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id="eb-cn-wave-fill" x1="0" x2="1" y1="0" y2="0">
          <stop offset="0" stopColor="#38d3b0" />
          <stop offset="0.5" stopColor="#4b7bff" />
          <stop offset="1" stopColor="#8758ff" />
        </linearGradient>
        <linearGradient id="eb-cn-wave-fade" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="#fff" stopOpacity="1" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
        <mask id="eb-cn-wave-mask">
          <rect x="-800" y="0" width="2400" height="200" fill="url(#eb-cn-wave-fade)" />
        </mask>
      </defs>
      <g className="eb-cn__wave eb-cn__wave--1" mask="url(#eb-cn-wave-mask)">
        <path d={`${w1} V200 H-800 Z`} fill="url(#eb-cn-wave-fill)" opacity="0.24" />
        <path d={w1} fill="none" stroke="url(#eb-cn-wave-fill)" strokeWidth="1.8" opacity="0.85" />
      </g>
      <g className="eb-cn__wave eb-cn__wave--2" mask="url(#eb-cn-wave-mask)">
        <path d={`${w2} V200 H-800 Z`} fill="url(#eb-cn-wave-fill)" opacity="0.18" />
        <path d={w2} fill="none" stroke="url(#eb-cn-wave-fill)" strokeWidth="1.3" opacity="0.6" />
      </g>
      <g className="eb-cn__wave eb-cn__wave--3" mask="url(#eb-cn-wave-mask)">
        <path d={w3} fill="none" stroke="url(#eb-cn-wave-fill)" strokeWidth="1" opacity="0.35" />
      </g>
    </svg>
  )
}
