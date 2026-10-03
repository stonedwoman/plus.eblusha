/**
 * Миниатюра свёрнутого звонка.
 *
 * Свёрнутый звонок раньше исчезал вовсе — оставалась строчка в шапке того чата. Теперь
 * поверх приложения живёт плитка 16:9, как у обычного видео: в ней тот, кто говорит
 * прямо сейчас (его камера, а без камеры — аватар), таймер, замочек и управление.
 * Плитку можно бросить где угодно; рядом с углом она прилипает к нему (магнит), у самого
 * края прячется в «язычок». Место запоминается.
 *
 * Компонент рендерится ВНУТРИ комнаты LiveKit (нужны её хуки), а в DOM уезжает порталом
 * в body — чтобы не зависеть от скрытого контейнера оверлея.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { useConnectionState, useLocalParticipant, useParticipants, useRoomContext, useSpeakingParticipants, useTracks } from '@livekit/components-react'
import { ConnectionState, Track, type Participant } from 'livekit-client'
import { Maximize2, Mic, MicOff, PhoneOff, Video, VideoOff, ChevronRight } from 'lucide-react'
import { Avatar } from './Avatar'
import { CallSecurityMark } from './CallSecurityMark'
import { callSecurityOf } from './callSecurity'
import './callMini.css'

const STORE_KEY = 'eb.call.mini'
/** Радиус магнита у угла, px. */
const SNAP_PX = 72
/** Не закрывать шапку приложения и композер. */
const MARGIN = 16
const TOP_GUARD = 72
const BOTTOM_GUARD = 80
/** Говорящий сменяется не мгновенно: короткое «угу» не должно дёргать плитку. */
const SPEAKER_HOLD_MS = 500

type Placement =
  | { kind: 'corner'; corner: 0 | 1 | 2 | 3 }
  | { kind: 'free'; fx: number; fy: number }
  | { kind: 'tongue'; side: 'left' | 'right'; y: number }

type Props = {
  visible: boolean
  isGroup: boolean
  /** Шифрование звонка 1:1 подтверждено. Подпись честная: «Шифрование через сервер» (callSecurity.ts). */
  encrypted: boolean
  /** Когда разговор начался — для таймера. */
  connectedAt: number | null
  /** Аватар участника по его identity / имени. */
  resolveAvatar: (participant: Participant) => string | null
  /** Откуда прилететь при сворачивании (прямоугольник панели звонка). */
  flyFrom: DOMRect | null
  onExpand: (fromRect: DOMRect | null) => void
  onHangUp: () => void
}

/**
 * Стартовый кадр полёта из панели звонка не должен выглядеть «полноэкранным слоем»:
 * ПК-оболочка (Electron) считает fixed-элемент размером ≥70 % окна таким слоем и
 * растягивает его на всю ширину — и плитка застревала огромной. Поэтому прямоугольник,
 * откуда прилетаем, ужимаем до 60 % окна вокруг его же центра.
 */
function capFlyRect(r: DOMRect): DOMRect {
  const maxW = window.innerWidth * 0.6
  const maxH = window.innerHeight * 0.6
  const k = Math.min(1, maxW / Math.max(1, r.width), maxH / Math.max(1, r.height))
  if (k >= 1) return r
  const w = r.width * k
  const h = r.height * k
  return new DOMRect(r.left + (r.width - w) / 2, r.top + (r.height - h) / 2, w, h)
}

function loadPlacement(): Placement {
  try {
    const raw = window.localStorage.getItem(STORE_KEY)
    if (raw) {
      const p = JSON.parse(raw) as Placement
      if (p && (p.kind === 'corner' || p.kind === 'free' || p.kind === 'tongue')) return p
    }
  } catch {
    // приватный режим — начнём с угла
  }
  return { kind: 'corner', corner: 1 }
}

function savePlacement(p: Placement) {
  try {
    window.localStorage.setItem(STORE_KEY, JSON.stringify(p))
  } catch {
    // не сохранилось — не страшно
  }
}

function participantUserId(p: Participant): string {
  try {
    const meta = p.metadata ? JSON.parse(p.metadata) : null
    if (meta?.userId) return String(meta.userId)
  } catch {
    // метаданные не наши
  }
  return p.identity.split('#')[0]
}

function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(s / 60)
  const sec = s % 60
  return `${m}:${sec < 10 ? '0' : ''}${sec}`
}

/** Видео дорожки в своём элементе: LiveKit разрешает дорожке несколько элементов. */
function TrackVideo({ track, className }: { track: Track | undefined; className?: string }) {
  const ref = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el || !track) return
    track.attach(el)
    return () => {
      track.detach(el)
    }
  }, [track])
  return <video ref={ref} className={className} autoPlay playsInline muted />
}

export function CallMini({ visible, isGroup, encrypted, connectedAt, resolveAvatar, flyFrom, onExpand, onHangUp }: Props) {
  const room = useRoomContext()
  const participants = useParticipants()
  const speakers = useSpeakingParticipants()
  const { localParticipant, isMicrophoneEnabled, isCameraEnabled } = useLocalParticipant()
  const connectionState = useConnectionState()
  const tracks = useTracks([Track.Source.Camera, Track.Source.ScreenShare], { onlySubscribed: true })
  const security = callSecurityOf(isGroup, encrypted)

  // ── кто в плитке: говорящий, с задержкой смены; без говорящих — последний показанный ──
  const remote = useMemo(() => participants.filter((p) => !p.isLocal), [participants])
  const remoteKey = remote.map((p) => p.identity).join('|')
  const [shownId, setShownId] = useState<string | null>(null)
  useEffect(() => {
    if (shownId && remote.some((p) => p.identity === shownId)) return
    setShownId(remote[0]?.identity ?? null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remoteKey])
  const speakingRemote = speakers.find((p) => !p.isLocal)?.identity ?? null
  useEffect(() => {
    if (!speakingRemote || speakingRemote === shownId) return
    const timer = setTimeout(() => setShownId(speakingRemote), SPEAKER_HOLD_MS)
    return () => clearTimeout(timer)
  }, [speakingRemote, shownId])
  const shown = remote.find((p) => p.identity === shownId) ?? remote[0] ?? null
  const shownSpeaking = !!shown && speakers.some((p) => p.identity === shown.identity)
  const shownTrack = useMemo(() => {
    if (!shown) return undefined
    const mine = tracks.filter((t) => t.participant.identity === shown.identity && t.publication?.track)
    // Показ экрана важнее лица: если человек что-то показывает, в плитке — это.
    return (mine.find((t) => t.source === Track.Source.ScreenShare) ?? mine.find((t) => t.source === Track.Source.Camera))?.publication?.track
  }, [tracks, shown])
  const localTrack = useMemo(() => {
    if (!isCameraEnabled) return undefined
    return tracks.find((t) => t.participant.isLocal && t.source === Track.Source.Camera)?.publication?.track
  }, [tracks, isCameraEnabled])
  const avatarUrl = shown ? resolveAvatar(shown) : null
  const shownName = shown?.name || (shown ? shown.identity.split('#')[0] : '') || 'Собеседник'
  const reconnecting = connectionState === ConnectionState.Reconnecting || connectionState === ConnectionState.SignalReconnecting

  // ── таймер ──
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!visible) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [visible])

  // ── размещение ──
  const rootRef = useRef<HTMLDivElement>(null)
  const [placement, setPlacement] = useState<Placement>(loadPlacement)
  const [pos, setPos] = useState<{ x: number; y: number }>({ x: -9999, y: -9999 })
  const [animate, setAnimate] = useState(false)
  const [magnet, setMagnet] = useState<{ x: number; y: number } | null>(null)
  // Текущая точка тянем в ref: pointerup может прийти раньше, чем React перерисует pos.
  const dragRef = useRef<{ sx: number; sy: number; ox: number; oy: number; x: number; y: number; moved: boolean } | null>(null)

  const size = useCallback(() => {
    const el = rootRef.current
    return { w: el?.offsetWidth || 320, h: el?.offsetHeight || 180 }
  }, [])
  const corners = useCallback(() => {
    const { w, h } = size()
    const W = window.innerWidth
    const H = window.innerHeight
    return [
      { x: MARGIN, y: TOP_GUARD + MARGIN },
      { x: W - w - MARGIN, y: TOP_GUARD + MARGIN },
      { x: MARGIN, y: H - h - BOTTOM_GUARD },
      { x: W - w - MARGIN, y: H - h - BOTTOM_GUARD },
    ]
  }, [size])
  const nearestCorner = useCallback(
    (x: number, y: number): 0 | 1 | 2 | 3 => {
      const cs = corners()
      let best = 0
      let bd = Infinity
      cs.forEach((c, i) => {
        const d = (c.x - x) ** 2 + (c.y - y) ** 2
        if (d < bd) {
          bd = d
          best = i
        }
      })
      return best as 0 | 1 | 2 | 3
    },
    [corners],
  )
  const clampFree = useCallback(
    (x: number, y: number) => {
      const { w, h } = size()
      return {
        x: Math.min(Math.max(x, 0), Math.max(0, window.innerWidth - w)),
        y: Math.min(Math.max(y, TOP_GUARD), Math.max(TOP_GUARD, window.innerHeight - h)),
      }
    },
    [size],
  )
  /** Положение по записанному размещению — при ресайзе окна остаётся «на том же месте». */
  const resolve = useCallback(
    (p: Placement) => {
      if (p.kind === 'corner') return corners()[p.corner]
      if (p.kind === 'free') {
        const { w, h } = size()
        return clampFree(p.fx * Math.max(0, window.innerWidth - w), TOP_GUARD + p.fy * Math.max(0, window.innerHeight - h - TOP_GUARD))
      }
      return null
    },
    [corners, size, clampFree],
  )
  const commit = useCallback(
    (p: Placement, withAnimation: boolean) => {
      setPlacement(p)
      savePlacement(p)
      const at = resolve(p)
      if (at) {
        setAnimate(withAnimation)
        setPos(at)
      }
    },
    [resolve],
  )
  const toFree = useCallback(
    (x: number, y: number) => {
      const c = clampFree(x, y)
      const { w, h } = size()
      commit({ kind: 'free', fx: c.x / Math.max(1, window.innerWidth - w), fy: (c.y - TOP_GUARD) / Math.max(1, window.innerHeight - h - TOP_GUARD) }, true)
    },
    [clampFree, size, commit],
  )

  // Появление: прилетаем из панели звонка (если известно, откуда) на своё место.
  const [entering, setEntering] = useState<DOMRect | null>(null)
  useEffect(() => {
    if (!visible) return
    if (placement.kind === 'tongue') return
    const at = resolve(placement)
    if (!at) return
    if (flyFrom) {
      setEntering(capFlyRect(flyFrom))
      setAnimate(false)
      setPos(at)
      const raf = requestAnimationFrame(() => requestAnimationFrame(() => { setEntering(null); setAnimate(true) }))
      return () => cancelAnimationFrame(raf)
    }
    setAnimate(false)
    setPos(at)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible])

  useEffect(() => {
    if (!visible) return
    const onResize = () => {
      const at = resolve(placement)
      if (at) {
        setAnimate(false)
        setPos(at)
      }
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [visible, placement, resolve])

  // ── перетаскивание: любое место, кроме кнопок; магнит у угла; язычок у края ──
  const onPointerDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('button') || e.button !== 0) return
    dragRef.current = { sx: e.clientX, sy: e.clientY, ox: pos.x, oy: pos.y, x: pos.x, y: pos.y, moved: false }
    try {
      rootRef.current?.setPointerCapture(e.pointerId)
    } catch {
      // старый браузер — потащим и без захвата
    }
    setAnimate(false)
  }
  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current
    if (!d) return
    const dx = e.clientX - d.sx
    const dy = e.clientY - d.sy
    if (!d.moved && Math.hypot(dx, dy) < 4) return
    d.moved = true
    const { w, h } = size()
    const x = Math.min(Math.max(d.ox + dx, -w * 0.6), window.innerWidth - w * 0.4)
    const y = Math.min(Math.max(d.oy + dy, TOP_GUARD), window.innerHeight - h - BOTTOM_GUARD + h * 0.5)
    d.x = x
    d.y = y
    setPos({ x, y })
    const c = corners()[nearestCorner(x, y)]
    setMagnet(Math.hypot(c.x - x, c.y - y) <= SNAP_PX ? c : null)
  }
  const onPointerUp = () => {
    const d = dragRef.current
    if (!d) return
    dragRef.current = null
    setMagnet(null)
    if (!d.moved) return
    const { w } = size()
    const { x, y } = d
    if (x < -w * 0.25) return commit({ kind: 'tongue', side: 'left', y }, false)
    if (x + w > window.innerWidth + w * 0.25) return commit({ kind: 'tongue', side: 'right', y }, false)
    const i = nearestCorner(x, y)
    const c = corners()[i]
    if (Math.hypot(c.x - x, c.y - y) <= SNAP_PX) commit({ kind: 'corner', corner: i }, true)
    else toFree(x, y)
  }
  const toCorner = () => {
    const order: Array<0 | 1 | 2 | 3> = [0, 1, 3, 2]
    if (placement.kind === 'corner') commit({ kind: 'corner', corner: order[(order.indexOf(placement.corner) + 1) % 4] }, true)
    else commit({ kind: 'corner', corner: nearestCorner(pos.x, pos.y) }, true)
  }
  const leaveTongue = () => {
    if (placement.kind !== 'tongue') return
    const side = placement.side
    const upper = placement.y < window.innerHeight / 2
    const corner: 0 | 1 | 2 | 3 = side === 'left' ? (upper ? 0 : 2) : upper ? 1 : 3
    const { w } = size()
    const c = corners()[corner]
    setAnimate(false)
    setPos({ x: side === 'left' ? -w : window.innerWidth, y: c.y })
    requestAnimationFrame(() => commit({ kind: 'corner', corner }, true))
  }

  const expand = useCallback(() => onExpand(rootRef.current?.getBoundingClientRect() ?? null), [onExpand])

  // ── горячие клавиши, пока свёрнуто ──
  useEffect(() => {
    if (!visible) return
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey || !e.shiftKey) return
      const k = e.key.toLowerCase()
      if (k === 'e' || k === 'у') {
        e.preventDefault()
        expand()
      } else if (k === 'm' || k === 'ь') {
        e.preventDefault()
        void localParticipant.setMicrophoneEnabled(!isMicrophoneEnabled).catch(() => {})
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [visible, expand, localParticipant, isMicrophoneEnabled])

  if (!visible || typeof document === 'undefined') return null
  if (!room) return null

  const elapsed = connectedAt ? formatElapsed(now - connectedAt) : null

  if (placement.kind === 'tongue') {
    const th = 48
    const ty = Math.min(Math.max(placement.y, TOP_GUARD + MARGIN), window.innerHeight - th - BOTTOM_GUARD)
    return createPortal(
      <button
        type="button"
        className={`eb-mini-tongue is-${placement.side}${shownSpeaking ? ' is-speaking' : ''}${reconnecting ? ' is-reconnecting' : ''}`}
        style={{ top: ty }}
        onClick={leaveTongue}
        aria-label="Показать миниатюру звонка"
        title="Показать миниатюру звонка"
      >
        <span className="eb-mini-tongue__av">
          <Avatar name={shownName} id={shown ? participantUserId(shown) : shownName} size={32} avatarUrl={avatarUrl} />
        </span>
        {elapsed && <b>{elapsed}</b>}
        <ChevronRight size={14} />
      </button>,
      document.body,
    )
  }

  const enterStyle: CSSProperties = entering
    ? { transform: `translate(${entering.left}px, ${entering.top}px) scale(${entering.width / size().w}, ${entering.height / size().h})`, opacity: 0.4 }
    : { transform: `translate(${pos.x}px, ${pos.y}px)` }

  return createPortal(
    <>
      {magnet && <div className="eb-mini-magnet" style={{ transform: `translate(${magnet.x}px, ${magnet.y}px)` }} aria-hidden="true" />}
      <div
        ref={rootRef}
        className={`eb-mini${animate ? ' is-snapping' : ''}${dragRef.current ? ' is-dragging' : ''}${shownSpeaking ? ' is-speaking' : ''}${reconnecting ? ' is-reconnecting' : ''}${shownTrack ? ' has-video' : ''}`}
        style={enterStyle}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={(e) => {
          if (!(e.target as HTMLElement).closest('button')) expand()
        }}
        role="region"
        aria-label="Свёрнутый звонок"
      >
        <div className="eb-mini__face">
          {shownTrack ? (
            <TrackVideo track={shownTrack} className="eb-mini__video" />
          ) : shown ? (
            <span className={`eb-mini__big${shownSpeaking ? ' is-speaking' : ''}`}>
              <Avatar name={shownName} id={participantUserId(shown)} size={76} avatarUrl={avatarUrl} />
            </span>
          ) : (
            <span className="eb-mini__empty">{isGroup ? 'Пока никого' : 'Ждём собеседника'}</span>
          )}
        </div>
        {localTrack && <TrackVideo track={localTrack} className="eb-mini__local" />}
        <div className="eb-mini__top">
          <span className="eb-mini__tag" title={shownName}>
            {security && <CallSecurityMark security={security} />}
            <span className="eb-mini__name">{shownName}</span>
            {shownSpeaking && <span className="eb-mini__say">говорит</span>}
          </span>
          <span className="eb-mini__grow" />
          <button type="button" className="eb-mini__btn" onClick={toCorner} aria-label="В угол" title="В ближайший угол; повторно — следующий угол">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 21h18" /><path d="M21 3v18" /><rect x="11" y="11" width="8" height="8" rx="1.5" /></svg>
          </button>
          <button type="button" className="eb-mini__btn is-amber" onClick={expand} aria-label="Развернуть звонок" title="Развернуть (двойной клик, Ctrl+Shift+E)">
            <Maximize2 size={14} />
          </button>
        </div>
        <div className="eb-mini__bottom">
          {reconnecting ? <span className="eb-mini__time is-danger">Переподключение…</span> : elapsed && <span className="eb-mini__time">{elapsed}</span>}
          <span className="eb-mini__grow" />
          <button
            type="button"
            className={`eb-mini__btn${isMicrophoneEnabled ? '' : ' is-off'}`}
            onClick={() => void localParticipant.setMicrophoneEnabled(!isMicrophoneEnabled).catch(() => {})}
            aria-label={isMicrophoneEnabled ? 'Выключить микрофон' : 'Включить микрофон'}
            title="Микрофон (Ctrl+Shift+M)"
          >
            {isMicrophoneEnabled ? <Mic size={14} /> : <MicOff size={14} />}
          </button>
          <button
            type="button"
            className={`eb-mini__btn${isCameraEnabled ? '' : ' is-off'}`}
            onClick={() => void localParticipant.setCameraEnabled(!isCameraEnabled).catch(() => {})}
            aria-label={isCameraEnabled ? 'Выключить камеру' : 'Включить камеру'}
            title="Камера"
          >
            {isCameraEnabled ? <Video size={14} /> : <VideoOff size={14} />}
          </button>
          <button type="button" className="eb-mini__btn is-danger" onClick={onHangUp} aria-label={isGroup ? 'Выйти из звонка' : 'Завершить звонок'} title={isGroup ? 'Выйти из звонка' : 'Завершить'}>
            <PhoneOff size={14} />
          </button>
        </div>
      </div>
    </>,
    document.body,
  )
}
