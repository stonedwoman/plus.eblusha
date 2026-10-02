/**
 * Экран установления звонка — в фирменном стиле Еблуши.
 *
 * Показывает реальный путь разговора — от вас через ретранслятор к серверу и дальше к
 * собеседнику — и подсвечивает участок, который прокладывается прямо сейчас. Ниже —
 * этапы подключения; в шапке панели — логотип, с кем звонок, и капсулы с
 * подтверждёнными фактами о соединении.
 *
 * Всё, что здесь нарисовано, приходит готовым из buildConnectView: компонент ничего не
 * решает и ничем не управляет, кроме отмены. Единственная его собственная память —
 * анимация ухода ретранслятора при смене маршрута, выбранная подсказка и секундомер
 * в шапке (он честный: считает от начала дозвона или от появления экрана).
 */
import { Fragment, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { ArrowRight, Check, Clock, Cloud, Lock, Phone, PhoneOff, Server, ShieldAlert, User, Users, Video, Waypoints } from 'lucide-react'
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
  /** Видеозвонок — только подпись в капсуле шапки. */
  video?: boolean
  /** Начало звонка (по серверу или дозвону) для секундомера в шапке; без него — от появления экрана. */
  startedAt?: number
}

const NODE_COLOR: Record<ConnectNodeId, string> = {
  you: 'var(--call-node-self)',
  relay: 'var(--call-node-relay)',
  server: 'var(--call-node-server)',
  peer: 'var(--call-node-peer)',
}

/** Секундомер шапки: m:ss, как в шапке чата. */
function formatClock(totalSec: number): string {
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  return `${m}:${s < 10 ? '0' : ''}${s}`
}

const NODE_STATE_TITLE = { waiting: 'ждёт', active: 'подключается', ready: 'готов', ringing: 'вызываем' } as const
const STEP_STATUS_TITLE = { done: 'готово', active: 'выполняется', waiting: 'ждёт' } as const

export function CallConnecting({ view, leaving = false, onCancel, ringPeriodMs, ringStartedAt, video = false, startedAt }: Props) {
  const [cancelling, setCancelling] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  // Фаза колец считается один раз при появлении: сколько гудка уже прошло к этому моменту.
  const ringStyle = useMemo(() => {
    const period = ringPeriodMs && ringPeriodMs > 0 ? ringPeriodMs : 2000
    const elapsed = ringStartedAt ? Math.max(0, Date.now() - ringStartedAt) % period : 0
    return { '--eb-ring-period': `${period}ms`, '--eb-ring-offset': `${-elapsed}ms` } as CSSProperties
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ringPeriodMs])

  // Секундомер в шапке: от начала звонка (сервер) или дозвона, а без них — от появления
  // экрана. Первое известное начало запоминаем: после ответа дозвон пропадает из пропсов,
  // а секундомер сбрасываться не должен.
  const mountedAtRef = useRef(Date.now())
  const sinceRef = useRef<number | null>(null)
  const knownStart = startedAt ?? ringStartedAt
  if (knownStart && sinceRef.current === null) sinceRef.current = knownStart
  const since = sinceRef.current ?? mountedAtRef.current
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(t)
  }, [])
  const elapsedSec = Math.max(0, Math.floor((now - since) / 1000))

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

  const peer = view.nodes.find((n) => n.id === 'peer') ?? null
  const ringing = peer?.state === 'ringing'
  const barText = peer ? (peer.group ? `Групповой звонок · ${peer.label}` : `Звонок · ${peer.label}`) : 'Звонок'

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
      <div className={'eb-cn' + (leaving ? ' is-leaving' : '')} role="alert" aria-labelledby="eb-cn-error-title">
        <div className="eb-cn__panel eb-cn__panel--error">
          <div className="eb-cn__bar">
            <Brand />
            <div className="eb-cn__bar-text">{barText}</div>
          </div>
          <div className="eb-cn__body">
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
      </div>
    )
  }

  return (
    <div className={'eb-cn' + (leaving ? ' is-leaving' : '') + (ringing ? ' is-ringing' : '')} role="region" aria-label="Подключение к звонку" style={ringStyle}>
      <div className="eb-cn__panel" style={{ '--steps': view.steps.length } as CSSProperties}>
        <div className="eb-cn__bar">
          <Brand />
          <div className="eb-cn__bar-text">{barText}</div>
          <ul className="eb-cn__pills" aria-label="Сведения о соединении">
            <li className="eb-cn__pill">
              {video ? <Video /> : <Phone />}
              <span className="eb-cn__pill-muted">{video ? 'Видеозвонок' : 'Аудиозвонок'}</span>
              <span className="eb-cn__num">{formatClock(elapsedSec)}</span>
            </li>
            {view.facts.map((f) => (
              <li className="eb-cn__pill" key={f.id}>
                {f.id === 'e2ee' ? <Lock /> : f.id === 'relay' ? <Waypoints /> : f.id === 'direct' ? <ArrowRight /> : <Clock />}
                <span className={f.id === 'rtt' ? 'eb-cn__num' : undefined}>{f.text}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="eb-cn__body">
          <div className="eb-cn__head" aria-live="polite" aria-atomic="true">
            <div className="eb-cn__title" key={view.title}>
              {view.title}
            </div>
            <div className="eb-cn__subtitle" key={view.subtitle}>
              <span>{view.subtitle}</span>
              {ringing && (
                <span className="eb-cn__tone" aria-hidden="true">
                  <span />
                  <span />
                  <span />
                </span>
              )}
            </div>
          </div>

          <div className="eb-cn__path">
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

          <ol className="eb-cn__steps" lang="ru">
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
              {ringing ? (
                <button type="button" className="eb-cn__cancel eb-cn__cancel--hangup" onClick={cancel} disabled={cancelling}>
                  <PhoneOff aria-hidden="true" />
                  <span>{cancelling ? 'Сбрасываем…' : 'Сбросить'}</span>
                </button>
              ) : (
                <button type="button" className="eb-cn__cancel" onClick={cancel} disabled={cancelling}>
                  {cancelling ? 'Отменяем…' : 'Отменить'}
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/** Логотип «ЕБлуша» с фирменной переворачивающейся большой «Б» — как в шапке приложения. */
function Brand() {
  return (
    <span className="eb-cn__brand" role="img" aria-label="Еблуша">
      <span aria-hidden="true">Е</span>
      <span className="eb-cn__b" aria-hidden="true">
        Б
      </span>
      <span aria-hidden="true">луша</span>
    </span>
  )
}

function NodeGlyph({ node }: { node: ConnectNode }) {
  if (node.id === 'you') return <User />
  if (node.id === 'relay') return <Cloud />
  if (node.id === 'server') return <Server />
  return <NodeAvatar name={node.label} url={node.avatarUrl} group={node.group} />
}

function initialsFromName(name: string): string {
  const parts = (name || '').trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0].charAt(0).toUpperCase()
  return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase()
}

/**
 * Аватар в узле схемы. Картинка, если она есть и грузится; иначе инициалы на фирменном
 * янтаре или значок группы. Ошибка загрузки не ломает схему — просто показываем
 * запасной вариант.
 */
function NodeAvatar({ name, url, group }: { name: string; url: string | null; group: boolean }) {
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
  return <span className="eb-cn__initials">{initialsFromName(name)}</span>
}
