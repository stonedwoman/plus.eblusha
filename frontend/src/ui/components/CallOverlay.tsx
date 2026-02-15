import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

declare global {
  interface Window {
    __eblushaEnumeratePatched?: boolean
  }
}

if (typeof window !== 'undefined' && typeof navigator !== 'undefined' && navigator.mediaDevices && !window.__eblushaEnumeratePatched) {
  const originalEnumerate = navigator.mediaDevices.enumerateDevices.bind(navigator.mediaDevices)
  navigator.mediaDevices.enumerateDevices = async () => {
    const devices = await originalEnumerate()
    const ua = navigator.userAgent || ''
    const isIOS = /iP(ad|hone|od)/i.test(ua)
    if (!isIOS) return devices

    const fronts: MediaDeviceInfo[] = []
    const backs: MediaDeviceInfo[] = []
    const others: MediaDeviceInfo[] = []

    const classify = (label: string, id: string) => {
      const lowered = label.toLowerCase()
      if (/(front|перед|selfie|true depth|ultra wide front)/.test(lowered)) return 'front'
      if (/(back|rear|зад|tele|wide|камера на задней панели|камера на задней|задняя)/.test(lowered) || /(back|rear)/.test(id.toLowerCase())) return 'back'
      return 'other'
    }

    devices.forEach((d) => {
      if (d.kind !== 'videoinput') {
        others.push(d)
        return
      }
      const category = classify(d.label || '', d.deviceId || '')
      if (category === 'front') fronts.push(d)
      else if (category === 'back') backs.push(d)
      else backs.push(d) // treat unknown as back to keep at least one rear option
    })

    const result: MediaDeviceInfo[] = []
    if (fronts.length > 0) result.push(fronts[0])
    if (backs.length > 0) result.push(backs[0])
    if (result.length === 0 && devices.some((d) => d.kind === 'videoinput')) {
      // fallback: keep first video device if nothing classified
      const firstVideo = devices.find((d) => d.kind === 'videoinput')
      if (firstVideo) result.push(firstVideo)
    }
    // keep all non video devices
    others.forEach((d) => {
      if (d.kind !== 'videoinput') result.push(d)
    })

    return result
  }
  window.__eblushaEnumeratePatched = true
}
import { createPortal } from 'react-dom'
import { LiveKitRoom, VideoConference, MediaDeviceSelect, useConnectionState, useLocalParticipant, useRoomContext } from '@livekit/components-react'
import '@livekit/components-styles'
import { X } from 'lucide-react'
import { convertToProxyUrl } from '../../utils/media'
import { api } from '../../utils/api'
import { joinCallRoom, requestCallStatuses, leaveCallRoom } from '../../utils/socket'
import { useAppStore } from '../../domain/store/appStore'
import { ConnectionState, LogLevel, Room, RoomEvent, setLogLevel, Track, RemoteAudioTrack } from 'livekit-client'
import { createE2eeRoomOptions, enableE2ee, fetchE2eeKey } from '../../utils/e2ee'

function readEnvBool(v: unknown): boolean {
  const raw = String(v ?? '').trim().toLowerCase()
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on'
}

function describeE2eeSetupError(err: unknown): string {
  const status = (err as any)?.response?.status as number | undefined
  if (status === 403) return 'Нет доступа к ключу E2EE для этого звонка.'
  if (status === 404) return 'Не удалось получить ключ E2EE для этого звонка. Попробуйте начать звонок заново.'

  const msg = err instanceof Error ? err.message : String(err ?? '')
  const lower = msg.toLowerCase()
  if (
    lower.includes('unsupported') ||
    lower.includes('not supported') ||
    lower.includes('deviceunsupported') ||
    lower.includes('secure context')
  ) {
    return 'Этот браузер/окружение не поддерживает E2EE.'
  }

  return 'Не удалось включить E2EE для звонка. Попробуйте обновить страницу или использовать другой браузер.'
}

// Silence LiveKit internal info/debug logs (e.g. "publishing track") in production.
// Keep warnings/errors; you can still debug via localStorage flags.
try {
  setLogLevel(LogLevel.warn)
} catch {
  // ignore
}

type Props = {
  open: boolean
  conversationId: string | null
  onClose: (options?: { manual?: boolean }) => void
  onMinimize?: () => void
  minimized?: boolean
  initialVideo?: boolean
  initialAudio?: boolean
  peerAvatarUrl?: string | null
  avatarsByName?: Record<string, string | null>
  avatarsById?: Record<string, string | null>
  localUserId?: string | null
  isGroup?: boolean
}

const LK_SETTINGS_KEYS = {
  aec: 'eb.lk.webrtc.aec',
  ns: 'eb.lk.webrtc.ns',
  agc: 'eb.lk.webrtc.agc',
} as const

function readStoredBool(key: string, fallback: boolean): boolean {
  if (typeof window === 'undefined') return fallback
  try {
    const raw = window.localStorage.getItem(key)
    if (raw === null) return fallback
    return raw === '1' || raw === 'true'
  } catch {
    return fallback
  }
}

function writeStoredBool(key: string, value: boolean) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(key, value ? '1' : '0')
  } catch {
    // ignore
  }
}

function isDebugFlagEnabled(storageKey: string, queryKey: string): boolean {
  if (typeof window === 'undefined') return false
  try {
    const qs = new URLSearchParams(window.location.search)
    const q = qs.get(queryKey)
    if (q === '1' || q === 'true') return true
    const raw = window.localStorage.getItem(storageKey)
    return raw === '1' || raw === 'true'
  } catch {
    return false
  }
}

function ToggleRow({
  label,
  description,
  checked,
  onChange,
  disabled = false,
  rightHint,
}: {
  label: string
  description?: string
  checked: boolean
  onChange: (next: boolean) => void
  disabled?: boolean
  rightHint?: string
}) {
  return (
    <div className="eb-toggle-row">
      <div className="eb-toggle-text">
        <div className="eb-toggle-label">{label}</div>
        {description ? <div className="eb-toggle-desc">{description}</div> : null}
      </div>
      <div className="eb-toggle-right">
        {rightHint ? <div className="eb-toggle-hint">{rightHint}</div> : null}
        <label className={`eb-switch ${disabled ? 'is-disabled' : ''}`}>
          <input
            type="checkbox"
            checked={checked}
            disabled={disabled}
            onChange={(e) => onChange(e.target.checked)}
          />
          <span className="eb-switch-track" aria-hidden="true" />
        </label>
      </div>
    </div>
  )
}

function ConnectionStatusBadge() {
  const state = useConnectionState()
  let label = 'Подключено'
  if (state === ConnectionState.Connecting) label = 'Подключение…'
  else if (state === ConnectionState.Reconnecting) label = 'Переподключение…'
  else if (state === ConnectionState.Disconnected) label = 'Отключено'

  return (
    <div
      className="eb-conn-badge"
      style={{
        position: 'absolute',
        top: 10,
        left: 10,
        zIndex: 20,
        padding: '6px 10px',
        borderRadius: 999,
        background: 'rgba(0,0,0,0.45)',
        border: '1px solid rgba(255,255,255,0.12)',
        fontSize: 12,
        color: '#fff',
        backdropFilter: 'blur(6px)',
      }}
    >
      {label}
    </div>
  )
}

// Component to set default microphone device on connection
function DefaultMicrophoneSetter() {
  const room = useRoomContext()
  const { isMicrophoneEnabled } = useLocalParticipant()
  const hasSetDefaultRef = useRef(false)

  useEffect(() => {
    if (!room) return
    if (hasSetDefaultRef.current) return
    if (!isMicrophoneEnabled) return

    // Set default microphone device on first connection
    hasSetDefaultRef.current = true
    room.localParticipant
      .setMicrophoneEnabled(true, {
        deviceId: 'default',
      })
      .catch((e) => console.warn('[DefaultMicrophoneSetter] Failed to set default microphone', e))
  }, [room, isMicrophoneEnabled])

  return null
}

// Component to replace connection quality indicators with ping display
function PingDisplayUpdater({ localUserId }: { localUserId: string | null }) {
  const room = useRoomContext()
  const { localParticipant, microphoneTrack, cameraTrack } = useLocalParticipant()
  const [localRtt, setLocalRtt] = useState<number | null>(null)
  const localRttRef = useRef<number | null>(null)
  const [localPlayoutMs, setLocalPlayoutMs] = useState<number | null>(null)
  const localPlayoutMsRef = useRef<number | null>(null)
  const scheduleUpdateRef = useRef<null | (() => void)>(null)
  // Each participant broadcasts their own RTT-to-server; for remote tiles we show (remote RTT + our RTT).
  const remoteServerRttByKeyRef = useRef<Map<string, number>>(new Map())
  const remotePlayoutMsByKeyRef = useRef<Map<string, number>>(new Map())
  const lastStatsAtRef = useRef<number>(0)
  const noRttLoggedRef = useRef(false)
  const waitingLoggedRef = useRef(false)
  const lastSignalPingAtRef = useRef<number>(0)
  const lastSentRef = useRef<{ at: number; rtt: number | null }>({ at: 0, rtt: null })
  const [pingDebug, setPingDebug] = useState<boolean>(() => isDebugFlagEnabled('lk-debug-ping', 'lkDebugPing'))
  const pingDbgStateRef = useRef<{ at: number; lastLocalRtt: number | null; lastSignalRtt: number | null }>({
    at: 0,
    lastLocalRtt: null,
    lastSignalRtt: null,
  })

  const dbg = (...args: any[]) => {
    if (!pingDebug) return
    // eslint-disable-next-line no-console
    console.log('[Ping]', ...args)
  }

  // Allow enabling/disabling ping debug live (without reload).
  useEffect(() => {
    const id = window.setInterval(() => {
      const next = isDebugFlagEnabled('lk-debug-ping', 'lkDebugPing')
      setPingDebug((prev) => (prev === next ? prev : next))
    }, 1000)
    return () => window.clearInterval(id)
  }, [])

  // Always emit a single line when ping debug becomes enabled so you can confirm it's active.
  useEffect(() => {
    if (!pingDebug) return
    dbg('debug enabled', {
      localStorage: (() => {
        try {
          return window.localStorage.getItem('lk-debug-ping')
        } catch {
          return '(unavailable)'
        }
      })(),
      query: (() => {
        try {
          return new URLSearchParams(window.location.search).get('lkDebugPing')
        } catch {
          return '(unavailable)'
        }
      })(),
      localIdentity: localParticipant?.identity ?? null,
    })
    try {
      const resources = performance?.getEntriesByType?.('resource') as PerformanceResourceTiming[] | undefined
      const callOverlayAsset = resources?.map((r) => r.name).find((n) => n.includes('/assets/CallOverlay-')) ?? null
      if (callOverlayAsset) dbg('asset', callOverlayAsset)
    } catch {
      // ignore
    }
  }, [pingDebug, localParticipant?.identity])

  // Keep latest receiver playout delay in a ref for the publisher loop.
  useEffect(() => {
    localPlayoutMsRef.current = localPlayoutMs
    scheduleUpdateRef.current?.()
    if (pingDebug) dbg('localPlayoutMs state', localPlayoutMs)
  }, [localPlayoutMs])

  // Measure receiver jitter-buffer delay (approx "how long until I hear remote audio" on this client).
  // We broadcast this so others can estimate one-way voice delay to us: (RTT_me + RTT_them)/2 + playoutDelay_me.
  useEffect(() => {
    if (!room) return

    const extractPlayoutMsFromStats = (stats: RTCStatsReport): number | null => {
      let best: number | null = null
      try {
        stats.forEach((r: any) => {
          if (r?.type !== 'inbound-rtp') return
          const kind = (r?.kind || r?.mediaType || '').toString().toLowerCase()
          if (kind && kind !== 'audio') return

          // Candidate 1: target delay (seconds) — this is closest to "current playout buffering" when available.
          const target = typeof r?.jitterBufferTargetDelay === 'number' ? r.jitterBufferTargetDelay : null
          if (typeof target === 'number' && Number.isFinite(target) && target > 0) {
            const ms = target * 1000
            if (Number.isFinite(ms) && ms > 0 && ms < 5000) {
              best = best === null ? ms : Math.max(best, ms)
            }
          }

          // Candidate 2: average delay = jitterBufferDelay / jitterBufferEmittedCount (seconds).
          // NOTE: in some browsers the emitted count can be very small/buggy, which makes this ratio grow unbounded.
          // We therefore require a minimum count and clamp to a sane range.
          const delay = typeof r?.jitterBufferDelay === 'number' ? r.jitterBufferDelay : null
          const count = typeof r?.jitterBufferEmittedCount === 'number' ? r.jitterBufferEmittedCount : null
          if (
            typeof delay === 'number' &&
            typeof count === 'number' &&
            Number.isFinite(delay) &&
            Number.isFinite(count) &&
            delay > 0 &&
            count >= 50
          ) {
            const ms = (delay / count) * 1000
            if (Number.isFinite(ms) && ms > 0 && ms < 5000) {
              best = best === null ? ms : Math.max(best, ms)
            }
          }
        })
      } catch {
        // ignore
      }
      return best
    }

    let stopped = false
    const sample = async () => {
      try {
        const engine = (room as any).engine
        const subscriber = engine?.pcManager?.subscriber
        if (subscriber?.getStats) {
          const stats: RTCStatsReport = await subscriber.getStats()
          const ms = extractPlayoutMsFromStats(stats)
          if (!stopped) setLocalPlayoutMs(ms)
          if (pingDebug) dbg('playout sample', { ms })
          return
        }
      } catch (e) {
        if (pingDebug) dbg('playout sample failed', e)
      }
      if (!stopped) setLocalPlayoutMs(null)
    }

    const id = window.setInterval(sample, 2000)
    void sample()
    return () => {
      stopped = true
      window.clearInterval(id)
    }
  }, [room, pingDebug])

  const isLocalTile = (tile: HTMLElement): boolean => {
    // LiveKit natively exposes this attribute on participant tiles.
    const v = tile.getAttribute('data-lk-local-participant')
    if (v === 'true') return true
    // Some browsers/React may serialize booleans differently.
    return (tile as any).dataset?.lkLocalParticipant === 'true'
  }

  const getTileParticipantName = (tile: HTMLElement): string | null => {
    // ParticipantName sets data-lk-participant-name on its <span>.
    const el =
      (tile.querySelector('[data-lk-participant-name]') as HTMLElement | null) ||
      (tile.querySelector('.lk-participant-name') as HTMLElement | null)
    const attr = el?.getAttribute('data-lk-participant-name')
    const text = (attr && attr.trim()) || (el?.textContent?.trim() ?? '')
    if (!text) return null
    // Normalize screenshare tiles: LiveKit renders "<Name>'s screen" as ParticipantName children.
    // We want to map that back to the participant name.
    return text
      .replace(/[\u2019']/g, "'")
      .replace(/'s\s+screen$/i, '')
      .trim()
  }

  // Get local RTT periodically
  useEffect(() => {
    if (!room || !localParticipant) return

    const extractRttMsFromStats = (stats: RTCStatsReport): number | null => {
      try {
        let bestSeconds: number | null = null

        const rttSecondsFromCandidatePair = (pair: any): number | null => {
          const s: number | null =
            (typeof pair?.currentRoundTripTime === 'number' ? pair.currentRoundTripTime : null) ??
            (typeof pair?.roundTripTime === 'number' ? pair.roundTripTime : null) ??
            (typeof pair?.totalRoundTripTime === 'number' &&
            Number.isFinite(pair.totalRoundTripTime) &&
            pair.totalRoundTripTime > 0 &&
            typeof pair?.responsesReceived === 'number' &&
            Number.isFinite(pair.responsesReceived) &&
            pair.responsesReceived > 0
              ? pair.totalRoundTripTime / pair.responsesReceived
              : null)
          if (typeof s !== 'number' || !Number.isFinite(s) || s <= 0) return null
          return s
        }

        let selectedPairId: string | null = null
        let selectedPair: any | null = null

        stats.forEach((report: any) => {
          if (report?.type === 'transport' && report.selectedCandidatePairId) {
            selectedPairId = String(report.selectedCandidatePairId)
          }
        })

        if (selectedPairId) {
          // RTCStatsReport.get is not supported in all browsers; fallback to scanning by id.
          selectedPair =
            (stats as any).get?.(selectedPairId) ??
            (() => {
              let found: any | null = null
              stats.forEach((r: any) => {
                if (found) return
                if (r?.id === selectedPairId) found = r
              })
              return found
            })() ??
            null
        }

        // Fallback: find any selected/succeeded candidate-pair
        if (!selectedPair) {
          stats.forEach((report: any) => {
            if (selectedPair) return
            if (
              report?.type === 'candidate-pair' &&
              // Chrome: selected=true; Safari: nominated=true; spec: state='succeeded'
              (report.selected || report.nominated || report.state === 'succeeded')
            ) {
              selectedPair = report
            }
          })
        }

        const pairSeconds: number | null =
          selectedPair ? rttSecondsFromCandidatePair(selectedPair) : null

        if (typeof pairSeconds === 'number' && Number.isFinite(pairSeconds) && pairSeconds > 0) {
          bestSeconds = pairSeconds
        }

        // Additionally scan all candidate-pairs; some browsers don't mark selectedPair reliably, or selected pair has 0 RTT.
        stats.forEach((report: any) => {
          if (report?.type !== 'candidate-pair') return
          if (!(report.selected || report.nominated || report.state === 'succeeded')) return
          const s = rttSecondsFromCandidatePair(report)
          if (typeof s !== 'number') return
          if (bestSeconds === null || s < bestSeconds) bestSeconds = s
        })

        // Many browsers expose RTT in remote-inbound-rtp stats (seconds)
        stats.forEach((report: any) => {
          if (report?.type !== 'remote-inbound-rtp') return
          const s =
            (typeof report?.roundTripTime === 'number' ? report.roundTripTime : null) ??
            (typeof report?.totalRoundTripTime === 'number' &&
            Number.isFinite(report.totalRoundTripTime) &&
            report.totalRoundTripTime > 0 &&
            typeof report?.roundTripTimeMeasurements === 'number' &&
            Number.isFinite(report.roundTripTimeMeasurements) &&
            report.roundTripTimeMeasurements > 0
              ? report.totalRoundTripTime / report.roundTripTimeMeasurements
              : null)
          if (typeof s !== 'number' || !Number.isFinite(s) || s <= 0) return
          if (bestSeconds === null || s < bestSeconds) bestSeconds = s
        })

        // Some browsers expose RTT directly on outbound-rtp (e.g. audio) as roundTripTime (seconds)
        stats.forEach((report: any) => {
          const s = typeof report?.roundTripTime === 'number' ? report.roundTripTime : null
          if (typeof s !== 'number' || !Number.isFinite(s) || s <= 0) return
          if (bestSeconds === null || s < bestSeconds) bestSeconds = s
        })

        if (typeof bestSeconds === 'number' && Number.isFinite(bestSeconds) && bestSeconds > 0) {
          return bestSeconds * 1000
        }
      } catch {
        // ignore
      }
      return null
    }

    const updateRtt = async () => {
      try {
        // Prefer LiveKit SignalClient RTT (ms). Much cheaper than polling pc.getStats() and stable enough.
        const engine = (room as any).engine
        const rtt = engine?.client?.rtt
        // If server didn't provide ping config, rtt may stay 0. We can trigger LiveKit's native signaling ping ourselves.
        if ((!rtt || rtt <= 0) && typeof engine?.client?.sendPing === 'function') {
          const now = Date.now()
          if (now - lastSignalPingAtRef.current > 5000) {
            lastSignalPingAtRef.current = now
            try {
              await engine.client.sendPing()
              if (pingDebug) dbg('signal sendPing() called')
            } catch (e) {
              if (pingDebug) dbg('signal sendPing() failed', e)
            }
          }
        }
        if (pingDebug) {
          const now = Date.now()
          const s = pingDbgStateRef.current
          if ((typeof rtt === 'number' ? rtt : null) !== s.lastSignalRtt && now - s.at > 750) {
            pingDbgStateRef.current = { ...s, at: now, lastSignalRtt: typeof rtt === 'number' ? rtt : null }
            dbg('signal rtt', { rtt, hasEngine: !!engine, localIdentity: localParticipant.identity })
          }
        }
        if (typeof rtt === 'number' && Number.isFinite(rtt) && rtt > 0) {
          setLocalRtt(rtt)
          if (pingDebug) dbg('local rtt set', { ms: Math.round(rtt), source: 'engine.client.rtt' })
          return
        }

        // Native LiveKit track sender stats (often more reliable than parsing candidate-pairs ourselves).
        // LocalAudioTrack.getSenderStats() returns roundTripTime (seconds) in some browsers.
        const micLocalTrack = (microphoneTrack as any)?.track
        if (micLocalTrack && typeof micLocalTrack.getSenderStats === 'function') {
          try {
            const s = await micLocalTrack.getSenderStats()
            const sec = typeof s?.roundTripTime === 'number' ? s.roundTripTime : null
            if (typeof sec === 'number' && Number.isFinite(sec) && sec > 0) {
              const ms = sec * 1000
              setLocalRtt(ms)
              if (pingDebug) dbg('local rtt set', { ms: Math.round(ms), source: 'LocalAudioTrack.getSenderStats().roundTripTime' })
              return
            }
          } catch (e) {
            if (pingDebug) dbg('mic getSenderStats failed', e)
          }
        }

        const camLocalTrack = (cameraTrack as any)?.track
        if (camLocalTrack && typeof camLocalTrack.getSenderStats === 'function') {
          try {
            const arr = await camLocalTrack.getSenderStats()
            const list = Array.isArray(arr) ? arr : []
            const best = list
              .map((x: any) => (typeof x?.roundTripTime === 'number' ? x.roundTripTime : null))
              .filter((x: any) => typeof x === 'number' && Number.isFinite(x) && x > 0) as number[]
            if (best.length > 0) {
              const sec = Math.min(...best)
              const ms = sec * 1000
              setLocalRtt(ms)
              if (pingDebug) dbg('local rtt set', { ms: Math.round(ms), source: 'LocalVideoTrack.getSenderStats()[].roundTripTime' })
              return
            }
          } catch (e) {
            if (pingDebug) dbg('camera getSenderStats failed', e)
          }
        }

        // Fallback: read RTT from WebRTC stats if signal RTT isn't available (some deployments disable ping/pong)
        const now = Date.now()
        if (now - lastStatsAtRef.current < 3000) return

        const publisher = engine?.pcManager?.publisher
        const subscriber = engine?.pcManager?.subscriber
        const transports = [publisher, subscriber].filter(Boolean)
        const trackCandidates: any[] = [
          // prefer mic (most stable RTT stats)
          (microphoneTrack as any)?.track,
          (cameraTrack as any)?.track,
        ].filter(Boolean)

        // Only rate-limit once we actually have transports to query.
        if (transports.length > 0 || trackCandidates.length > 0) {
          lastStatsAtRef.current = now
        } else {
          if (pingDebug && !waitingLoggedRef.current) {
            waitingLoggedRef.current = true
            dbg('waiting for transports/tracks', {
              publisher: !!publisher,
              subscriber: !!subscriber,
              trackCandidates: trackCandidates.length,
            })
          }
          return
        }

        for (const t of transports as any[]) {
          if (!t?.getStats) continue
          const stats: RTCStatsReport = await t.getStats()
          const rttMs = extractRttMsFromStats(stats)
          if (typeof rttMs === 'number' && Number.isFinite(rttMs) && rttMs > 0) {
            setLocalRtt(rttMs)
            if (pingDebug) dbg('local rtt set', { ms: Math.round(rttMs), source: 'pcTransport.getStats()' })
            return
          }
        }

        // Fallback #2: per-track sender stats (works in cases where PCTransport stats don't expose RTT)
        for (const tr of trackCandidates) {
          if (!tr?.getRTCStatsReport) continue
          const stats: RTCStatsReport | undefined = await tr.getRTCStatsReport()
          if (!stats) continue
          const rttMs = extractRttMsFromStats(stats)
          if (typeof rttMs === 'number' && Number.isFinite(rttMs) && rttMs > 0) {
            setLocalRtt(rttMs)
            if (pingDebug) dbg('local rtt set', { ms: Math.round(rttMs), source: 'MediaStreamTrack.getRTCStatsReport()' })
            return
          }
        }

        // One-time debug to help diagnose production browsers where stats are missing
        if (!noRttLoggedRef.current) {
          noRttLoggedRef.current = true
          if (pingDebug) {
            dbg('could not compute local rtt', {
              signalRtt: rtt,
              transports: transports.length,
              trackCandidates: trackCandidates.length,
              localIdentity: localParticipant.identity,
            })
          }
        }
      } catch (e) {
        if (pingDebug) dbg('updateRtt error', e)
      }
    }

    const interval = setInterval(() => void updateRtt(), 1500)
    // Kick twice: once immediately, once shortly after transport creation
    void updateRtt()
    const t = setTimeout(() => void updateRtt(), 2500)

    return () => {
      clearInterval(interval)
      clearTimeout(t)
    }
  }, [room, localParticipant, microphoneTrack?.trackSid, cameraTrack?.trackSid])

  // Broadcast our server RTT and receive others (topic: eb.ping)
  useEffect(() => {
    if (!room) return
    if (!localParticipant) return

    const encoder = new TextEncoder()
    const sendMyRtt = async () => {
      try {
        const rtt = localRttRef.current
        if (typeof rtt !== 'number' || !Number.isFinite(rtt) || rtt <= 0) {
          if (pingDebug) dbg('skip publish eb.ping (no local rtt yet)', { localRtt: rtt })
          return
        }

        const now = Date.now()
        const last = lastSentRef.current
        // throttle: at most once per 2s, and only if it changed noticeably
        const changedEnough = last.rtt === null || Math.abs(last.rtt - rtt) >= 2
        const due = now - last.at >= 2000
        if (!due && !changedEnough) return
        lastSentRef.current = { at: now, rtt }

        const playout = localPlayoutMsRef.current
        const payload = {
          t: 'eb.ping',
          v: 2,
          rtt: Math.round(rtt),
          // receiver-side playout/jitter-buffer delay (ms), used to estimate one-way voice delay to this participant
          playoutMs: typeof playout === 'number' && Number.isFinite(playout) && playout >= 0 ? Math.round(playout) : 0,
          ts: now,
        }
        await localParticipant.publishData(encoder.encode(JSON.stringify(payload)), {
          reliable: false,
          topic: 'eb.ping',
        })
        if (pingDebug) dbg('publish eb.ping ok', payload)
      } catch (e) {
        if (pingDebug) dbg('publish eb.ping failed', e)
        // Keep this warning only while debug is enabled to avoid console noise in production.
        if (pingDebug && !(window as any).__ebPingPublishWarned) {
          ;(window as any).__ebPingPublishWarned = true
          console.warn('[Ping] Failed to publish eb.ping (data channel). Check LiveKit token grant canPublishData=true.')
        }
      }
    }

    const decoder = new TextDecoder()
    const onData = (payload: Uint8Array, participant: any, _kind: any, topic?: string) => {
      // Some LiveKit versions/paths may not populate the "topic" argument consistently.
      // If topic is present and not ours, ignore early; otherwise fall back to message type in JSON.
      if (topic && topic !== 'eb.ping') return
      const senderIdentity = participant?.identity as string | undefined
      if (!senderIdentity) return
      if (localParticipant && senderIdentity === localParticipant.identity) return
      try {
        const msg = JSON.parse(decoder.decode(payload))
        if (!msg || msg.t !== 'eb.ping') return
        const rtt = Number(msg.rtt)
        if (!Number.isFinite(rtt) || rtt <= 0) return
        const playoutMs = Number(msg.playoutMs)
        const playout = Number.isFinite(playoutMs) && playoutMs >= 0 ? playoutMs : 0
        const senderName = typeof participant?.name === 'string' && participant.name ? participant.name : null
        const prev = remoteServerRttByKeyRef.current.get(senderIdentity)
        remoteServerRttByKeyRef.current.set(senderIdentity, rtt)
        if (senderName) remoteServerRttByKeyRef.current.set(senderName, rtt)
        remotePlayoutMsByKeyRef.current.set(senderIdentity, playout)
        if (senderName) remotePlayoutMsByKeyRef.current.set(senderName, playout)
        // Also store by metadata displayName/userId if present (our app sets JSON metadata).
        const metaRaw = typeof participant?.metadata === 'string' ? participant.metadata : null
        if (metaRaw) {
          try {
            const meta = JSON.parse(metaRaw)
            if (meta?.displayName) remoteServerRttByKeyRef.current.set(String(meta.displayName), rtt)
            if (meta?.userId) remoteServerRttByKeyRef.current.set(String(meta.userId), rtt)
            if (meta?.displayName) remotePlayoutMsByKeyRef.current.set(String(meta.displayName), playout)
            if (meta?.userId) remotePlayoutMsByKeyRef.current.set(String(meta.userId), playout)
          } catch {
            // ignore
          }
        }
        if (pingDebug && (prev === undefined || Math.abs(prev - rtt) >= 2)) {
          dbg('recv eb.ping', { from: senderIdentity, name: senderName, rtt, playoutMs: playout, ts: msg.ts, topic: topic ?? null })
        }
        scheduleUpdateRef.current?.()
      } catch {
        // ignore
      }
    }

    room.on(RoomEvent.DataReceived, onData)

    const interval = setInterval(() => void sendMyRtt(), 2000)
    void sendMyRtt()

    return () => {
      clearInterval(interval)
      room.off(RoomEvent.DataReceived, onData)
    }
  }, [room, localParticipant, pingDebug])

  // Keep latest RTT in a ref so DOM updater doesn't need to re-subscribe on every RTT change.
  useEffect(() => {
    localRttRef.current = localRtt
    scheduleUpdateRef.current?.()
    if (pingDebug) dbg('localRtt state', localRtt)
  }, [localRtt])

  // Update DOM to show ping instead of connection quality (debounced + scoped to call container to avoid observer loops)
  useEffect(() => {
    if (!room) return

    const container = document.querySelector('.call-container') as HTMLElement | null
    if (!container) return

    const computeText = (isLocal: boolean) => {
      const rtt = localRttRef.current
      if (typeof rtt !== 'number' || !Number.isFinite(rtt) || rtt <= 0) return '—'
      if (isLocal) return `${Math.round(rtt)}\u00A0мс`
      // For remote: show remote RTT + our RTT (both to server). This approximates end-to-end RTT via SFU.
      return '—'
    }

    const updatePingDisplay = () => {
      // Target only LiveKit quality indicator element inside participant metadata
      const indicators = container.querySelectorAll('.lk-participant-metadata-item[data-lk-quality]')
      if (pingDebug) dbg('dom scan', { indicators: indicators.length })
      indicators.forEach((indicator) => {
        const tile = indicator.closest('.lk-participant-tile, [data-participant]') as HTMLElement | null
        if (!tile) return

        const isLocal = isLocalTile(tile)
        const participantName = getTileParticipantName(tile)

        if (!indicator.classList.contains('eb-ping-display')) {
          indicator.classList.add('eb-ping-display')
        }

        let textEl = indicator.querySelector('.eb-ping-text') as HTMLSpanElement | null
        if (!textEl) {
          textEl = document.createElement('span')
          textEl.className = 'eb-ping-text'
          indicator.appendChild(textEl)
        }

        let pingMs: number | null = null
        let next = computeText(isLocal)
        if (!isLocal) {
          const remote =
            (participantName ? remoteServerRttByKeyRef.current.get(participantName) : undefined) ??
            undefined
          const remotePlayout =
            (participantName ? remotePlayoutMsByKeyRef.current.get(participantName) : undefined) ??
            0
          const mine = localRttRef.current
          if (typeof remote === 'number' && Number.isFinite(remote) && remote > 0 && typeof mine === 'number' && mine > 0) {
            // Approximate one-way "voice delay":
            // network one-way ≈ (RTT_me_to_SFU/2 + RTT_peer_to_SFU/2)
            // + receiver-side playout/jitter-buffer delay at the peer.
            pingMs = Math.round((remote + mine) / 2 + (typeof remotePlayout === 'number' && Number.isFinite(remotePlayout) && remotePlayout >= 0 ? remotePlayout : 0))
            next = `${pingMs}\u00A0мс`
          }
        } else {
          const mine = localRttRef.current
          if (typeof mine === 'number' && Number.isFinite(mine) && mine > 0) {
            pingMs = Math.round(mine)
            next = `${pingMs}\u00A0мс`
          }
        }
        const hasPingValue = typeof pingMs === 'number' && Number.isFinite(pingMs) && pingMs > 0
        indicator.classList.toggle('eb-ping-has-value', hasPingValue)
        if (typeof pingMs === 'number' && Number.isFinite(pingMs) && pingMs > 0) {
          const level = pingMs <= 200 ? 'good' : pingMs <= 500 ? 'warn' : 'bad'
          indicator.setAttribute('data-eb-ping-level', level)
        } else {
          indicator.removeAttribute('data-eb-ping-level')
        }

        // Keep DOM writes minimal; CSS controls whether text/icon are visible.
        const nextText = hasPingValue ? next : ''
        if (textEl.textContent !== nextText) {
          textEl.textContent = nextText
          if (pingDebug) {
            const mine = localRttRef.current
            const remote = participantName ? remoteServerRttByKeyRef.current.get(participantName) : undefined
            dbg('dom set', { name: participantName, isLocal, text: nextText, mine, remote })
          }
        }
      })
    }

    let pending = false
    const schedule = () => {
      if (pending) return
      pending = true
      requestAnimationFrame(() => {
        pending = false
        updatePingDisplay()
      })
    }
    scheduleUpdateRef.current = schedule

    const mo = new MutationObserver(() => schedule())
    mo.observe(container, { childList: true, subtree: true })

    // Initial paint
    schedule()

    return () => {
      if (scheduleUpdateRef.current === schedule) scheduleUpdateRef.current = null
      mo.disconnect()
    }
  }, [room, localParticipant, localUserId, pingDebug])

  return null
}

function ParticipantVolumeUpdater() {
  const room = useRoomContext()
  const audioCtxRef = useRef<AudioContext | null>(null)
  const settingsByKeyRef = useRef<Map<string, { volume: number; muted: boolean; lastNonZeroPct: number }>>(new Map())
  const lastUserGestureAtRef = useRef<number>(0)
  // Track whether WebAudio routing is enabled for a given track.
  // If AudioContext is set AFTER elements were attached, the HTMLAudio path stays active,
  // which causes double playback unless we mute the attached elements manually.
  const webAudioStateRef = useRef<WeakMap<RemoteAudioTrack, { ctx: AudioContext; enabled: boolean }>>(new WeakMap())
  const wheelAccByKeyRef = useRef<Map<string, number>>(new Map())

  const isLocalTile = (tile: HTMLElement): boolean => {
    const v = tile.getAttribute('data-lk-local-participant')
    if (v === 'true') return true
    return (tile as any).dataset?.lkLocalParticipant === 'true'
  }

  const getTileParticipantName = (tile: HTMLElement): string | null => {
    const el =
      (tile.querySelector('[data-lk-participant-name]') as HTMLElement | null) ||
      (tile.querySelector('.lk-participant-name') as HTMLElement | null)
    const attr = el?.getAttribute('data-lk-participant-name')
    const text = (attr && attr.trim()) || (el?.textContent?.trim() ?? '')
    if (!text) return null
    return text
      .replace(/[\u2019']/g, "'")
      .replace(/'s\s+screen$/i, '')
      .trim()
  }

  const extractTileUserId = (tile: HTMLElement): string | null => {
    // Try explicit attrs first (if app adds them)
    const direct =
      tile.getAttribute('data-lk-participant-identity') ||
      tile.getAttribute('data-participant-identity') ||
      tile.getAttribute('data-user-id') ||
      (tile as any).dataset?.lkParticipantIdentity ||
      ''
    const directTrim = String(direct || '').trim()
    if (directTrim) return directTrim

    // Try metadata JSON (our app often injects it for avatar mapping)
    const metaAttr =
      tile.getAttribute('data-lk-participant-metadata') ||
      (tile.dataset ? (tile.dataset as any).lkParticipantMetadata : '') ||
      ''
    if (metaAttr) {
      try {
        const parsed = JSON.parse(metaAttr)
        if (parsed?.userId) return String(parsed.userId).trim()
      } catch {
        // ignore
      }
    }
    return null
  }

  const getTileKey = (tile: HTMLElement): { key: string; userId: string | null; name: string | null } | null => {
    const userId = extractTileUserId(tile)
    const name = getTileParticipantName(tile)
    const key = userId || name
    if (!key) return null
    return { key, userId, name }
  }

  const getSettings = (key: string) => {
    const map = settingsByKeyRef.current
    const existing = map.get(key)
    if (existing) return existing
    const init = { volume: 1, muted: false, lastNonZeroPct: 100 }
    map.set(key, init)
    return init
  }

  const ensureAudioContextFromGesture = async () => {
    lastUserGestureAtRef.current = Date.now()
    if (audioCtxRef.current) {
      try {
        if (audioCtxRef.current.state !== 'running') {
          await audioCtxRef.current.resume()
        }
      } catch {
        // ignore
      }
      return audioCtxRef.current
    }
    try {
      // Create only from a user gesture; keep default audio path untouched otherwise.
      const ctx = new (window.AudioContext || (window as any).webkitAudioContext)()
      audioCtxRef.current = ctx
      try {
        if (ctx.state !== 'running') await ctx.resume()
      } catch {
        // ignore
      }
      return ctx
    } catch {
      return null
    }
  }

  const parseParticipantMeta = (p: any): { userId?: string; displayName?: string } | null => {
    const raw = p?.metadata
    if (!raw || typeof raw !== 'string') return null
    try {
      const parsed = JSON.parse(raw)
      if (!parsed || typeof parsed !== 'object') return null
      const userId = parsed.userId ? String(parsed.userId) : undefined
      const displayName = parsed.displayName ? String(parsed.displayName) : undefined
      return { userId, displayName }
    } catch {
      return null
    }
  }

  const resolveParticipant = (info: { key: string; userId: string | null; name: string | null }) => {
    if (!room) return null
    // 1) direct identity match
    const direct =
      (info.userId ? room.remoteParticipants.get(info.userId) : null) ||
      room.remoteParticipants.get(info.key) ||
      null
    if (direct) return direct

    const wantName = (info.name || '').trim()
    const wantKey = (info.key || '').trim()
    const wantUser = (info.userId || '').trim()

    // 2) scan by participant.name / identity / metadata.displayName/userId
    for (const p of room.remoteParticipants.values()) {
      try {
        if (wantUser && String(p.identity) === wantUser) return p
        if (wantKey && String(p.identity) === wantKey) return p
        if (wantName && String((p as any).name || '').trim() === wantName) return p
        const meta = parseParticipantMeta(p)
        if (wantUser && meta?.userId && meta.userId === wantUser) return p
        if (wantName && meta?.displayName && meta.displayName.trim() === wantName) return p
      } catch {
        // ignore
      }
    }
    return null
  }

  const applyToKey = async (
    keyInfo: { key: string; userId: string | null; name: string | null },
    fromGesture: boolean,
  ) => {
    if (!room) return
    const { key } = keyInfo
    const participant = resolveParticipant(keyInfo)
    if (!participant) return

    const settings = getSettings(key)
    const effective = settings.muted ? 0 : settings.volume

    // Only create/use AudioContext when amplification > 1 is needed, and only from a user gesture.
    const needsAmp = effective > 1
    const ctx = audioCtxRef.current || (needsAmp && fromGesture ? await ensureAudioContextFromGesture() : null)

    // Iterate all audio publications (mic + screen share audio).
    const pubs: any[] = []
    try {
      const trackPubs = (participant as any).trackPublications
      if (trackPubs?.values) {
        for (const pub of trackPubs.values()) pubs.push(pub)
      }
    } catch {
      // ignore
    }

    for (const pub of pubs) {
      if (pub?.kind !== Track.Kind.Audio) continue
      // Mute should be "direct": disable receiving this publication for this client.
      if (typeof pub?.setEnabled === 'function') {
        try {
          pub.setEnabled(!settings.muted && effective > 0)
        } catch {
          // ignore
        }
      }
      const tr = pub?.track
      if (!(tr instanceof RemoteAudioTrack)) continue

      const prev = webAudioStateRef.current.get(tr)
      if (needsAmp && ctx) {
        // Enable WebAudio routing once per track (so >100% works) but don't keep re-wiring.
        if (!prev || prev.ctx !== ctx || !prev.enabled) {
          tr.setAudioContext(ctx)
          webAudioStateRef.current.set(tr, { ctx, enabled: true })
        }
        // If AudioContext was set after attach, mute attached elements to avoid double playback.
        try {
          tr.attachedElements.forEach((el) => {
            try {
              el.volume = 0
              el.muted = true
            } catch {
              // ignore
            }
          })
        } catch {
          // ignore
        }
      } else {
        // No amplification needed: restore default element path if WebAudio was enabled.
        if (prev?.enabled) {
          try {
            tr.setAudioContext(undefined)
          } catch {
            // ignore
          }
          webAudioStateRef.current.set(tr, { ctx: prev.ctx, enabled: false })
        }
        // Ensure element playback is unmuted unless explicitly muted.
        try {
          const shouldMuteEl = settings.muted || effective <= 0
          tr.attachedElements.forEach((el) => {
            try {
              el.muted = shouldMuteEl
            } catch {
              // ignore
            }
          })
        } catch {
          // ignore
        }
      }

      // Clamp for safety.
      // Element path expects 0..1; WebAudio gain can go >1.
      const vol = settings.muted ? 0 : Math.max(0, Math.min(needsAmp ? 1.5 : 1, effective))
      tr.setVolume(vol)
    }
  }

  // Keep volumes applied when tracks subscribe later (or reattach).
  useEffect(() => {
    if (!room) return
    const onTrackSubscribed = (track: any, pub: any, participant: any) => {
      try {
        const id = String(participant?.identity || '')
        const name = String(participant?.name || '')
        const key = id || name
        if (!key) return
        if ((participant as any)?.isLocal) return
        if (settingsByKeyRef.current.has(key) && track?.kind === Track.Kind.Audio) {
          void applyToKey({ key, userId: id || null, name: name || null }, false)
        }
      } catch {
        // ignore
      }
    }
    room.on(RoomEvent.TrackSubscribed as any, onTrackSubscribed as any)
    return () => {
      room.off(RoomEvent.TrackSubscribed as any, onTrackSubscribed as any)
    }
  }, [room])

  const MAX = 150
  const NORMAL = 100
  // Must match SVG circle radius below (eb-vol-ring-svg)
  const R = 105
  const C = 2 * Math.PI * R

  const clampPct = (pct: number) => Math.max(0, Math.min(MAX, Math.round(pct)))

  const pctFromSettings = (s: { volume: number; muted: boolean }) => clampPct(s.muted ? 0 : s.volume * 100)

  const setArc = (circle: SVGCircleElement, start: number, length: number) => {
    const rest = Math.max(0, C - length)
    circle.style.strokeDasharray = `${length} ${rest}`
    circle.style.strokeDashoffset = `-${start}`
    circle.style.opacity = length > 0 ? '1' : '0'
  }

  const renderRing = (ring: HTMLElement, pct: number, muted: boolean) => {
    const safeCircle = (ring as any).__ebRingSafe as SVGCircleElement | undefined
    const overCircle = (ring as any).__ebRingOver as SVGCircleElement | undefined
    const thumb = (ring as any).__ebRingThumb as SVGCircleElement | undefined
    const label = (ring as any).__ebRingLabel as HTMLElement | undefined
    const valEl = (ring as any).__ebRingVal as HTMLElement | undefined
    const muteBtn = (ring as any).__ebRingMuteBtn as HTMLButtonElement | undefined
    if (!safeCircle || !overCircle) return

    const volume = clampPct(pct)
    const safeRatio = Math.min(volume, NORMAL) / MAX
    const overRatio = Math.max(volume - NORMAL, 0) / MAX
    const safeLen = C * safeRatio
    const overLen = C * overRatio

    setArc(safeCircle, 0, safeLen)
    setArc(overCircle, safeLen, overLen)

    if (thumb) {
      const t = volume / MAX
      // NOTE: SVG is rotated -90deg, so keep the math "start at +X" and let the SVG rotation move it to the top.
      const a = t * (Math.PI * 2)
      const cx = 110 + R * Math.cos(a)
      const cy = 110 + R * Math.sin(a)
      thumb.setAttribute('cx', `${cx}`)
      thumb.setAttribute('cy', `${cy}`)
      thumb.style.opacity = '1'
    }
    if (valEl) valEl.textContent = `${volume}%`
    else if (label) label.textContent = `${volume}%`
    if (muteBtn) muteBtn.textContent = muted || volume === 0 ? 'Вернуть' : 'Заглушить'

    ring.setAttribute('data-eb-over', volume > NORMAL ? 'true' : 'false')
    ring.setAttribute('data-eb-muted', muted || volume === 0 ? 'true' : 'false')
  }

  const pctFromPointer = (e: PointerEvent, svg: SVGSVGElement) => {
    const rect = svg.getBoundingClientRect()
    const cx = rect.left + rect.width / 2
    const cy = rect.top + rect.height / 2
    const dx = e.clientX - cx
    const dy = e.clientY - cy
    let deg = (Math.atan2(dy, dx) * 180) / Math.PI // -180..180, 0 at +x
    // User expectation: 0% at top; our SVG is rotated -90deg, so keep 0% at top in screen space.
    deg = (deg + 90 + 360) % 360 // 0 at top
    const ratio = deg / 360
    return clampPct(ratio * MAX)
  }

  // Inject volume ring UI into participant tiles (around injected avatars).
  useEffect(() => {
    if (!room) return
    const root = document.body
    if (!root) return

    const applyDom = () => {
      try {
        const tiles = root.querySelectorAll('.call-container .lk-participant-tile') as NodeListOf<HTMLElement>
        tiles.forEach((tile) => {
          if (isLocalTile(tile)) return
          const keyInfo = getTileKey(tile)
          if (!keyInfo) return
          tile.setAttribute('data-eb-remote', 'true')

          const resolved = resolveParticipant(keyInfo)
          const stableKey = resolved ? String(resolved.identity) : keyInfo.key
          const resolvedMeta = resolved ? parseParticipantMeta(resolved) : null
          const displayName = resolvedMeta?.displayName || (keyInfo.name || null)
          const stableInfo = { key: stableKey, userId: stableKey, name: displayName }
          tile.setAttribute('data-eb-vol-key', stableKey)

          // If this tile currently has ACTIVE video, do NOT show volume UI (video layer stacks above and looks bad).
          // IMPORTANT: when camera is turned off, LiveKit may keep <video> in DOM but mark tile as video-muted.
          const isVideoMuted =
            tile.getAttribute('data-video-muted') === 'true' ||
            tile.getAttribute('data-lk-video-muted') === 'true' ||
            (tile as any).dataset?.videoMuted === 'true' ||
            (tile as any).dataset?.lkVideoMuted === 'true'
          const videoEl =
            (tile.querySelector('video.lk-participant-media-video') as HTMLVideoElement | null) ||
            (tile.querySelector('video') as HTMLVideoElement | null)
          const hasActiveVideo = !!(!isVideoMuted && videoEl && videoEl.offsetWidth > 0 && videoEl.offsetHeight > 0)
          if (hasActiveVideo) {
            tile.querySelectorAll('.eb-vol-ring').forEach((el) => el.remove())
            return
          }

          const placeholder = tile.querySelector('.lk-participant-placeholder') as HTMLElement | null
          if (!placeholder) return

          // Ensure positioning context
          if (!tile.style.position) tile.style.position = 'relative'

          let ring = tile.querySelector('.eb-vol-ring') as HTMLElement | null
          if (!ring) {
            ring = document.createElement('div')
            ring.className = 'eb-vol-ring'
            ring.setAttribute('data-eb-vol-key', stableKey)
            ring.innerHTML = `
              <svg class="eb-vol-ring-svg" width="220" height="220" viewBox="0 0 220 220" aria-hidden="true" style="transform: rotate(-90deg)">
                <circle class="bg" cx="110" cy="110" r="105" />
                <circle class="safe" cx="110" cy="110" r="105" />
                <circle class="over" cx="110" cy="110" r="105" />
                <circle class="thumb" cx="110" cy="5" r="7" />
                <circle class="hit" cx="110" cy="110" r="105" />
              </svg>
              <div class="center" aria-hidden="true">
                <div class="label"><span class="prefix">громкость: </span><span class="val">100%</span></div>
                <div class="actions">
                  <button type="button" class="btn mute">Заглушить</button>
                  <button type="button" class="btn reset">100%</button>
                </div>
              </div>
            `
            tile.appendChild(ring)
          } else {
            ring.setAttribute('data-eb-vol-key', stableKey)
          }

          // Show/hide is unified with LiveKit spotlight button rules via CSS (hover/focus).

          // Cache SVG refs for fast updates
          if (!(ring as any).__ebRingInit) {
            ;(ring as any).__ebRingInit = true
            const svg = ring.querySelector('svg.eb-vol-ring-svg') as SVGSVGElement | null
            const safe = ring.querySelector('circle.safe') as SVGCircleElement | null
            const over = ring.querySelector('circle.over') as SVGCircleElement | null
            const thumb = ring.querySelector('circle.thumb') as SVGCircleElement | null
            const hit = ring.querySelector('circle.hit') as SVGCircleElement | null
            const label = ring.querySelector('.label') as HTMLElement | null
            const valEl = ring.querySelector('.label .val') as HTMLElement | null
            const muteBtn = ring.querySelector('button.btn.mute') as HTMLButtonElement | null
            const resetBtn = ring.querySelector('button.btn.reset') as HTMLButtonElement | null
            ;(ring as any).__ebRingSvg = svg
            ;(ring as any).__ebRingSafe = safe
            ;(ring as any).__ebRingOver = over
            ;(ring as any).__ebRingThumb = thumb
            ;(ring as any).__ebRingHit = hit
            ;(ring as any).__ebRingLabel = label
            ;(ring as any).__ebRingVal = valEl
            ;(ring as any).__ebRingMuteBtn = muteBtn
            ;(ring as any).__ebRingResetBtn = resetBtn
          }

          const updateFromSettings = () => {
            const s = getSettings(stableKey)
            const pct = pctFromSettings(s)
            if (pct > 0) s.lastNonZeroPct = pct
            renderRing(ring!, pct, !!s.muted)
          }

          // Position ring just OUTSIDE the avatar (tight halo): compute center from placeholder, size from avatar image.
          try {
            const tileRect = tile.getBoundingClientRect()
            // LiveKit tiles can be scaled via CSS transforms; convert screen px -> local px.
            const tileWLocal = (tile as HTMLElement).offsetWidth || tileRect.width || 1
            const tileHLocal = (tile as HTMLElement).offsetHeight || tileRect.height || 1
            const scaleX = tileRect.width ? tileRect.width / tileWLocal : 1
            const scaleY = tileRect.height ? tileRect.height / tileHLocal : 1
            const phRect = placeholder.getBoundingClientRect()
            const img = placeholder.querySelector('img.eb-ph') as HTMLImageElement | null
            const imgRect = img?.getBoundingClientRect()
            const avatarDScreen = imgRect && imgRect.width > 10 ? imgRect.width : phRect.width * 0.8
            const scaleAvg = (scaleX + scaleY) / 2 || 1
            const avatarD = avatarDScreen / scaleAvg
            const cxScreen =
              imgRect && imgRect.width > 10
                ? imgRect.left - tileRect.left + imgRect.width / 2
                : phRect.left - tileRect.left + phRect.width / 2
            const cyScreen =
              imgRect && imgRect.height > 10
                ? imgRect.top - tileRect.top + imgRect.height / 2
                : phRect.top - tileRect.top + phRect.height / 2
            // Absolute positioning origin is the padding box; compensate border (clientLeft/Top) in LOCAL units.
            const cx = cxScreen / scaleX - (tile as HTMLElement).clientLeft
            const cy = cyScreen / scaleY - (tile as HTMLElement).clientTop

            // Inner edge of the stroke should touch the avatar edge (gap=0) WITHOUT overlapping the avatar.
            // SVG stroke scales with the element, so compute size using viewBox geometry:
            // viewBox 0..220, path radius=105, stroke-width=10 => inner edge radius = 105 - 10/2 = 100 (in viewBox units).
            const VIEW = 220
            const PATH_R = 105
            const STROKE = 10
            const INNER_R = PATH_R - STROKE / 2 // 100
            const gap = 0 // requested: 0px padding
            const avatarR = avatarD / 2
            const ringD = (VIEW * (avatarR + gap)) / INNER_R
            const maxD = Math.min(
              Math.min((tile as HTMLElement).clientWidth || tileWLocal, (tile as HTMLElement).clientHeight || tileHLocal) - 6,
              ringD,
            )
            const finalD = Math.max(56, maxD)

            // Compact UI for small tiles (spotlight sidebar, grids, etc.)
            if (finalD < 150) ring.setAttribute('data-eb-compact', 'true')
            else ring.removeAttribute('data-eb-compact')

            ring.style.width = `${finalD}px`
            ring.style.height = `${finalD}px`
            ring.style.left = `${cx}px`
            ring.style.top = `${cy}px`
            ring.style.transform = 'translate(-50%, -50%)'
          } catch {
            // ignore
          }

          const setPct = (nextPct: number, fromGesture: boolean) => {
            let pct = clampPct(nextPct)
            const keyNow = String(ring?.getAttribute('data-eb-vol-key') || stableKey).trim()
            if (!keyNow) return

            // Prevent wrap-around: when dragging near the seam, don't jump 150->0 or 0->150.
            const last = typeof (ring as any).__ebLastPct === 'number' ? (ring as any).__ebLastPct : pct
            if ((ring as any).__ebDragging) {
              const diff = pct - last
              if (Math.abs(diff) > MAX / 2) {
                pct = last > MAX / 2 ? MAX : 0
              }
            }
            ;(ring as any).__ebLastPct = pct

            const s = getSettings(keyNow)
            if (pct === 0) {
              s.muted = true
              s.volume = 0
            } else {
              s.muted = false
              s.lastNonZeroPct = pct
              s.volume = pct / 100
            }
            renderRing(ring!, pct, !!s.muted)
            void applyToKey({ key: keyNow, userId: keyNow, name: null }, fromGesture)
          }

          // Bind interaction once per ring
          if (!(ring as any).__ebRingBound) {
            ;(ring as any).__ebRingBound = true
            const svg = (ring as any).__ebRingSvg as SVGSVGElement | null
            const hit = (ring as any).__ebRingHit as SVGCircleElement | null
            const muteBtn = (ring as any).__ebRingMuteBtn as HTMLButtonElement | null
            const resetBtn = (ring as any).__ebRingResetBtn as HTMLButtonElement | null
            if (svg && hit) {
              hit.addEventListener('pointerdown', (e: any) => {
                e.preventDefault()
                e.stopPropagation()
                lastUserGestureAtRef.current = Date.now()
                ;(ring as any).__ebDragging = true
                try {
                  const keyNow = String(ring?.getAttribute('data-eb-vol-key') || '').trim()
                  if (keyNow) {
                    ;(ring as any).__ebLastPct = pctFromSettings(getSettings(keyNow))
                  }
                } catch {
                  // ignore
                }
                try {
                  ;(hit as any).setPointerCapture?.(e.pointerId)
                } catch {
                  // ignore
                }
                const pct = pctFromPointer(e as PointerEvent, svg)
                setPct(pct, true)
              })
              hit.addEventListener('pointermove', (e: any) => {
                if (!(ring as any).__ebDragging) return
                e.preventDefault()
                e.stopPropagation()
                const pct = pctFromPointer(e as PointerEvent, svg)
                setPct(pct, true)
              })
              const endDrag = (e: any) => {
                if ((ring as any).__ebDragging) {
                  ;(ring as any).__ebDragging = false
                }
                try {
                  ;(hit as any).releasePointerCapture?.(e.pointerId)
                } catch {
                  // ignore
                }
              }
              hit.addEventListener('pointerup', endDrag)
              hit.addEventListener('pointercancel', endDrag)
            }

            const onMuteClick = (e: Event) => {
              e.preventDefault()
              e.stopPropagation()
              const keyNow = String(ring?.getAttribute('data-eb-vol-key') || '').trim()
              if (!keyNow) return
              const s = getSettings(keyNow)
              const curPct = pctFromSettings(s)
              if (s.muted || curPct === 0) {
                // restore last non-zero volume
                const restore = clampPct(s.lastNonZeroPct || 100)
                s.muted = false
                s.lastNonZeroPct = Math.max(1, restore)
                s.volume = s.lastNonZeroPct / 100
              } else {
                // mute and remember current as lastNonZero
                if (curPct > 0) s.lastNonZeroPct = curPct
                s.muted = true
                s.volume = 0
              }
              const pct = pctFromSettings(s)
              ;(ring as any).__ebLastPct = pct
              renderRing(ring!, pct, !!s.muted)
              void applyToKey({ key: keyNow, userId: keyNow, name: null }, true)
            }
            const onResetClick = (e: Event) => {
              e.preventDefault()
              e.stopPropagation()
              const keyNow = String(ring?.getAttribute('data-eb-vol-key') || '').trim()
              if (!keyNow) return
              const s = getSettings(keyNow)
              s.muted = false
              s.lastNonZeroPct = 100
              s.volume = 1
              const pct = pctFromSettings(s)
              ;(ring as any).__ebLastPct = pct
              renderRing(ring!, pct, !!s.muted)
              void applyToKey({ key: keyNow, userId: keyNow, name: null }, true)
            }
            muteBtn?.addEventListener('click', onMuteClick)
            resetBtn?.addEventListener('click', onResetClick)
          }

          // No per-device tap toggles: visibility is unified with the LiveKit spotlight button.

          // Wheel support: change remote participant volume while hovering their tile
          if (!(tile as any).__ebVolWheelBound) {
            ;(tile as any).__ebVolWheelBound = true
            tile.addEventListener(
              'wheel',
              (e: WheelEvent) => {
                // Only when cursor is over this tile (wheel event target is inside the tile)
                e.preventDefault()
                e.stopPropagation()
                const keyNow = String((tile as HTMLElement).getAttribute('data-eb-vol-key') || '').trim()
                if (!keyNow) return
                const s = getSettings(keyNow)
                const cur = pctFromSettings(s)
                // Normalize high-resolution wheels/trackpads: accumulate delta and apply 1–2% per "notch".
                const deltaPx =
                  (e.deltaMode === 1 ? e.deltaY * 40 : e.deltaMode === 2 ? e.deltaY * (window.innerHeight || 800) : e.deltaY) || 0
                const accMap = wheelAccByKeyRef.current
                const prevAcc = accMap.get(keyNow) || 0
                const nextAcc = prevAcc + deltaPx
                accMap.set(keyNow, nextAcc)

                const threshold = 100 // typical mouse notch ~= 100px
                const steps = Math.trunc(Math.abs(nextAcc) / threshold)
                if (steps <= 0) return

                // Reduce accumulator by the consumed steps
                const consumed = steps * threshold * Math.sign(nextAcc)
                accMap.set(keyNow, nextAcc - consumed)

                const stepPct = e.shiftKey ? 2 : 1
                const dir = nextAcc < 0 ? 1 : -1 // wheel up (negative delta) => louder
                setPct(cur + dir * steps * stepPct, true)
              },
              { passive: false } as any,
            )
          }

          // Initial sync/apply once (no gesture).
          updateFromSettings()
          void applyToKey(stableInfo, false)
        })
      } catch {
        // ignore
      }
    }

    // Debounce to avoid running too often on busy DOM trees.
    let pending = false
    const schedule = () => {
      if (pending) return
      pending = true
      requestAnimationFrame(() => {
        pending = false
        applyDom()
      })
    }

    const mo = new MutationObserver(() => schedule())
    mo.observe(root, { childList: true, subtree: true })
    applyDom()

    return () => {
      mo.disconnect()
    }
  }, [room])

  return null
}

function CallSettings() {
  const room = useRoomContext()
  const { isMicrophoneEnabled, microphoneTrack } = useLocalParticipant()

  const [aec, setAec] = useState<boolean>(() => readStoredBool(LK_SETTINGS_KEYS.aec, true))
  const [ns, setNs] = useState<boolean>(() => readStoredBool(LK_SETTINGS_KEYS.ns, true))
  const [agc, setAgc] = useState<boolean>(() => readStoredBool(LK_SETTINGS_KEYS.agc, true))

  // Apply WebRTC constraints by restarting the mic track with AudioCaptureOptions.
  const lastAppliedRef = useRef<string>('')
  useEffect(() => {
    if (!room) return
    if (!isMicrophoneEnabled) return
    const key = `${aec}|${ns}|${agc}|${microphoneTrack?.trackSid ?? ''}`
    if (lastAppliedRef.current === key) return
    lastAppliedRef.current = key
    room.localParticipant
      .setMicrophoneEnabled(true, {
        echoCancellation: aec,
        noiseSuppression: ns,
        autoGainControl: agc,
      })
      .catch((e) => console.warn('[CallSettings] Failed to apply mic capture options', e))
  }, [room, isMicrophoneEnabled, aec, ns, agc, microphoneTrack?.trackSid])

  // Clean device labels: remove device codes like "(0bda:0567)" or "(10d6:4801)" and wrap text in span for animation
  // Also filter out duplicate devices with "Оборудование -" or "По умолчанию -" prefixes
  useEffect(() => {
    const cleanup = () => {
      // First pass: remove duplicate devices with "Оборудование -" or "По умолчанию -" prefixes
      const listItems = document.querySelectorAll('.call-container .lk-settings-menu-modal .lk-media-device-select li')
      const devicesToRemove: HTMLElement[] = []
      const deviceNames = new Map<string, HTMLElement[]>() // Map: normalized name -> list items
      
      listItems.forEach((li) => {
        const btn = li.querySelector('.lk-button')
        if (!btn) return
        const rawText = btn.textContent || ''
        // Check if it has prefix
        const hasPrefix = /^(Оборудование\s*-\s*|По\s+умолчанию\s*-\s*)/i.test(rawText)
        // Normalize name (remove prefix and codes for comparison)
        let normalized = rawText.replace(/^(Оборудование\s*-\s*|По\s+умолчанию\s*-\s*)/i, '').trim()
        normalized = normalized.replace(/\s*\([0-9a-fA-F]{4}:[0-9a-fA-F]{0,4}\)?\s*/g, '').trim()
        
        if (!deviceNames.has(normalized)) {
          deviceNames.set(normalized, [])
        }
        deviceNames.get(normalized)!.push(li as HTMLElement)
        
        // Mark for removal if it has prefix
        if (hasPrefix) {
          devicesToRemove.push(li as HTMLElement)
        }
      })
      
      // Remove devices with prefixes (keep only versions without prefixes)
      devicesToRemove.forEach((li) => {
        li.remove()
      })
      
      // Second pass: clean remaining device labels
      const buttons = document.querySelectorAll('.call-container .lk-settings-menu-modal .lk-media-device-select li > .lk-button')
      buttons.forEach((btn) => {
        // Find text node or existing span
        const textNode = Array.from(btn.childNodes).find((n) => n.nodeType === Node.TEXT_NODE) as Text | undefined
        let span = btn.querySelector('span.eb-device-label') as HTMLSpanElement | null
        
        if (textNode && !span) {
          // Wrap text in span if not already wrapped
          const text = textNode.textContent || ''
          span = document.createElement('span')
          span.className = 'eb-device-label'
          span.textContent = text
          btn.replaceChild(span, textNode)
        }
        
        if (span) {
          let text = span.textContent || ''
          // Remove prefixes "Оборудование - " and "По умолчанию - " to avoid duplicates
          text = text.replace(/^(Оборудование\s*-\s*|По\s+умолчанию\s*-\s*)/i, '').trim()
          // Remove device codes: patterns like "(0bda:0567)", "(10d6:4801)", "(08bb:2902)" etc.
          // Also remove incomplete codes like "(0bda:(" at the end
          text = text.replace(/\s*\([0-9a-fA-F]{4}:[0-9a-fA-F]{0,4}\)?\s*/g, '').trim()
          // Remove trailing incomplete codes like "(0bda:("
          text = text.replace(/\s*\([0-9a-fA-F]{4}:\s*$/, '').trim()
          if (text !== span.textContent) {
            span.textContent = text
          }
          
          // Check if text overflows and mark for animation (animation will be enabled on hover via CSS)
          // Need to measure after text update, so use a small delay
          setTimeout(() => {
            const btnRect = btn.getBoundingClientRect()
            const spanRect = span.getBoundingClientRect()
            const padding = 24 // 12px left + 12px right
            const availableWidth = btnRect.width - padding
            if (spanRect.width > availableWidth) {
              // Mark as overflowing and calculate scroll distance to show full text
              const scrollDistance = spanRect.width - availableWidth
              span.setAttribute('data-overflows', 'true')
              span.style.setProperty('--eb-device-scroll-distance', `${-scrollDistance}px`)
            } else {
              // Remove overflow marker
              span.removeAttribute('data-overflows')
              span.style.removeProperty('--eb-device-scroll-distance')
            }
          }, 10)
        }
      })
    }
    // Run immediately and also observe changes
    cleanup()
    const mo = new MutationObserver(() => {
      // Small delay to let DOM settle
      setTimeout(cleanup, 50)
    })
    const container = document.querySelector('.call-container .lk-settings-menu-modal')
    if (container) {
      mo.observe(container, { childList: true, subtree: true, characterData: true })
      return () => mo.disconnect()
    }
  }, [])

  return (
    <div className="eb-call-settings" style={{ width: '100%' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          marginBottom: 12,
        }}
      >
        <div style={{ fontSize: 18, fontWeight: 600 }}>Настройки</div>
        <button
          type="button"
          className="btn btn-icon btn-ghost"
          aria-label="Закрыть настройки"
          title="Закрыть настройки"
          onClick={(e) => {
            e.preventDefault()
            e.stopPropagation()
            // Close settings via LiveKit's native SettingsMenuToggle (it uses `.lk-settings-toggle`)
            const toggle = document.querySelector('.call-container .lk-settings-toggle') as HTMLButtonElement | null
            if (toggle) {
              toggle.click()
              return
            }
            // Fallback: hide the modal if the toggle button isn't found (should be rare)
            const modal = document.querySelector('.call-container .lk-settings-menu-modal') as HTMLElement | null
            if (modal) modal.style.display = 'none'
          }}
          style={{ padding: 8 }}
        >
          <X size={18} />
        </button>
      </div>

      <div className="eb-settings-section">
        <div className="eb-section-title">Обработка микрофона</div>
        <ToggleRow
          label="WebRTC: AEC (анти-эхо)"
          description="Эхо‑подавление на уровне браузера (лучше включать почти всегда)."
          checked={aec}
          onChange={(v) => {
            setAec(v)
            writeStoredBool(LK_SETTINGS_KEYS.aec, v)
          }}
        />
        <ToggleRow
          label="WebRTC: NS (шумоподавление)"
          description="Шумоподавление на уровне браузера."
          checked={ns}
          onChange={(v) => {
            setNs(v)
            writeStoredBool(LK_SETTINGS_KEYS.ns, v)
          }}
        />
        <ToggleRow
          label="WebRTC: AGC (автогейн)"
          description="Автоматическая регулировка усиления микрофона."
          checked={agc}
          onChange={(v) => {
            setAgc(v)
            writeStoredBool(LK_SETTINGS_KEYS.agc, v)
          }}
        />
        <div className="eb-settings-note">
          Изменения AEC/NS/AGC применяются перезапуском микрофона и могут дать короткий “пик” при переключении.
        </div>
      </div>

      <div
        className="eb-settings-grid"
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
          gap: 16,
          alignItems: 'start',
          marginBottom: 12,
        }}
      >
        <div className="eb-device-col" style={{ minWidth: 0 }}>
          <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 8 }}>Микрофон</div>
          <MediaDeviceSelect kind="audioinput" requestPermissions />
        </div>
        <div className="eb-device-col" style={{ minWidth: 0 }}>
          <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 8 }}>Камера</div>
          <MediaDeviceSelect kind="videoinput" requestPermissions />
        </div>
        <div className="eb-device-col" style={{ minWidth: 0 }}>
          <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 8 }}>Вывод звука</div>
          <MediaDeviceSelect kind="audiooutput" requestPermissions />
          <div style={{ fontSize: 11, opacity: 0.65, marginTop: 6 }}>
            На Safari/iOS переключение устройства вывода может быть недоступно.
          </div>
        </div>
      </div>
      <div style={{ fontSize: 12, opacity: 0.8 }}>
        Выберите устройства ввода. Закрыть это окно можно кнопкой «Настройки» внизу.
      </div>
    </div>
  )
}

export function CallOverlay({ open, conversationId, onClose, onMinimize, minimized = false, initialVideo = false, initialAudio = true, peerAvatarUrl = null, avatarsByName = {}, avatarsById = {}, localUserId = null, isGroup = false }: Props) {
  const [token, setToken] = useState<string | null>(null)
  const [serverUrl, setServerUrl] = useState<string | null>(null)
  const [muted, setMuted] = useState(!initialAudio)
  const [camera, setCamera] = useState(!!initialVideo)
  const [isDesktop, setIsDesktop] = useState<boolean>(() => (typeof window !== 'undefined' ? window.innerWidth > 768 : true))
  const [wasConnected, setWasConnected] = useState(false)
  const me = useAppStore((s) => s.session?.user)

  const e2ee1to1FlagEnabled = useMemo(() => readEnvBool((import.meta as any).env?.VITE_E2EE_1TO1), [])
  const shouldUseE2ee = !isGroup && e2ee1to1FlagEnabled
  const e2eeRoomRef = useRef<Room | null>(null)
  const e2eeWorkerRef = useRef<Worker | null>(null)
  const e2eeEnableStartedRef = useRef(false)
  const [e2eeRoom, setE2eeRoom] = useState<Room | null>(null)
  const [e2eeError, setE2eeError] = useState<string | null>(null)
  const [e2eePreparing, setE2eePreparing] = useState(false)
  const [e2eeEnabled, setE2eeEnabled] = useState(false)

  const closingRef = useRef(false)
  const manualCloseRef = useRef(false)
  const myAvatar = useMemo(() => me?.avatarUrl ?? null, [me?.avatarUrl])
  const resolveAvatarUrl = useCallback((url: string | null | undefined) => {
    if (!url) return null
    if (url.startsWith('data:') || url.startsWith('blob:')) return url
    if (typeof window === 'undefined') return url
    const proxied = convertToProxyUrl(url)
    if (proxied && proxied !== url) return proxied
    if (url.startsWith('/') || url.startsWith('http://') || url.startsWith('https://')) return url
    try {
      const current = window.location
      const resolved = new URL(url, current.origin)
      if (resolved.host === current.host && resolved.protocol !== current.protocol) {
        resolved.protocol = current.protocol
      }
      return resolved.toString()
    } catch {
      return url
    }
  }, [])
  const handleClose = useCallback((options?: { manual?: boolean }) => {
    // Позволяем повторные вызовы, чтобы не зависать в состоянии закрытия.
    // Дополнительные вызовы idempotent, но обеспечивают выход из оверлея,
    // даже если первый вызов был прерван.
    if (!closingRef.current) {
      closingRef.current = true
    }
    if (options?.manual) {
      manualCloseRef.current = true
    }
    if (conversationId && isGroup) {
      try {
        leaveCallRoom(conversationId)
      } catch (err) {
        console.error('Error leaving call room:', err)
      }
      try {
        requestCallStatuses([conversationId])
      } catch (err) {
        console.error('Error requesting call status update:', err)
      }
    }
    const effectiveOptions = manualCloseRef.current ? { ...(options ?? {}), manual: true } : options
    onClose(effectiveOptions)
  }, [conversationId, isGroup, onClose])

  const cleanupE2eeResources = useCallback(() => {
    try {
      e2eeRoomRef.current?.disconnect()
    } catch {
      // ignore
    }
    e2eeRoomRef.current = null
    try {
      e2eeWorkerRef.current?.terminate()
    } catch {
      // ignore
    }
    e2eeWorkerRef.current = null
    e2eeEnableStartedRef.current = false
    setE2eeRoom(null)
    setE2eeEnabled(false)
  }, [])
  const videoContainCss = `
    /* Force videos to fit tile without cropping on all layouts */
    .call-container video { object-fit: contain !important; object-position: center !important; background: #000 !important; }
    .call-container .lk-participant-tile video,
    .call-container .lk-participant-media video,
    .call-container .lk-video-tile video,
    .call-container .lk-stage video,
    .call-container .lk-grid-stage video { object-fit: contain !important; object-position: center !important; background: #000 !important; }

    /* Focus layout: some browsers/layouts end up placing the <video> element at the top (auto height).
       Make the media area a flex box and center the video element itself. */
    .call-container .lk-participant-tile .lk-participant-media{
      display:flex !important;
      align-items:center !important;
      justify-content:center !important;
      min-height:0 !important;
      flex: 1 1 auto !important;
    }
    .call-container .lk-participant-tile .lk-participant-media-video,
    .call-container .lk-participant-tile video.lk-participant-media-video,
    .call-container .lk-participant-tile .lk-participant-media video{
      width: 100% !important;
      height: auto !important;
      max-height: 100% !important;
      object-fit: contain !important;
      object-position: center !important;
      background: #000 !important;
      display:block !important;
    }
    
    /* Ensure placeholder stays circular and doesn't stretch */
    .call-container .lk-participant-placeholder {
      aspect-ratio: 1 !important;
      border-radius: 50% !important;
      margin: auto !important;
      align-self: center !important;
      flex-shrink: 0 !important;
      /* IMPORTANT: don't override LiveKit's absolute positioning here; it can break video layout */
    }
    
    /* Light semi-transparent border for participant tiles */
    .call-container .lk-participant-tile {
      background: #000 !important;
      border: 1px solid rgba(255, 255, 255, 0.12) !important;
      border-radius: 8px !important;
      overflow: hidden !important;
    }

    /* When a tile is stretched tall (focus layout) but its media element is auto-height,
       the media ends up top-aligned. Center the flex column ONLY for tiles that currently show video. */
    .call-container .lk-participant-tile[data-eb-has-video="true"]{
      justify-content: center !important;
    }
    
    /* Hide chat entry point in the control bar (we expose device selection via Settings and also via button group menus) */
    .call-container .lk-control-bar .lk-chat-toggle { display: none !important; }

    /* Mobile: make the LiveKit UI feel native fullscreen and fix control button height mismatch */
    @media (max-width: 768px){
      /* iOS safe area: keep controls above home indicator */
      .call-container .lk-control-bar{
        padding-bottom: calc(.75rem + env(safe-area-inset-bottom, 0px)) !important;
      }
      /* Unify button heights (Settings + Leave were shorter than button-groups on mobile) */
      .call-container .lk-control-bar button,
      .call-container .lk-control-bar .lk-button,
      .call-container .lk-control-bar .lk-disconnect-button,
      .call-container .lk-control-bar .lk-settings-toggle{
        min-height: 44px !important;
        padding-top: .75rem !important;
        padding-bottom: .75rem !important;
        align-items: center !important;
      }
    }

    /* Settings toggles */
    .call-container .eb-settings-section { margin-bottom: 16px; }
    .call-container .eb-section-title { font-size: 12px; color: rgba(255,255,255,0.72); margin-bottom: 10px; }
    .call-container .eb-toggle-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 10px 12px;
      border: 1px solid rgba(255,255,255,0.08);
      background: rgba(0,0,0,0.18);
      border-radius: 12px;
      margin-bottom: 10px;
    }
    .call-container .eb-toggle-text { min-width: 0; }
    .call-container .eb-toggle-label { font-size: 13px; font-weight: 600; color: rgba(255,255,255,0.92); }
    .call-container .eb-toggle-desc { font-size: 11px; color: rgba(255,255,255,0.62); margin-top: 4px; line-height: 1.25; }
    .call-container .eb-toggle-right { display: flex; align-items: center; gap: 10px; flex-shrink: 0; }
    .call-container .eb-toggle-hint { font-size: 11px; color: rgba(255,255,255,0.55); max-width: 120px; text-align: right; }
    .call-container .eb-settings-note { font-size: 11px; color: rgba(255,255,255,0.55); margin-top: 6px; }

    .call-container .eb-switch { position: relative; display: inline-flex; align-items: center; }
    .call-container .eb-switch input { position: absolute; opacity: 0; width: 1px; height: 1px; }
    .call-container .eb-switch-track {
      width: 44px;
      height: 24px;
      border-radius: 999px;
      background: rgba(255,255,255,0.14);
      border: 1px solid rgba(255,255,255,0.14);
      position: relative;
      transition: background 120ms ease, border-color 120ms ease;
    }
    .call-container .eb-switch-track::after {
      content: '';
      position: absolute;
      top: 2px;
      left: 2px;
      width: 20px;
      height: 20px;
      border-radius: 999px;
      background: rgba(255,255,255,0.92);
      transition: transform 120ms ease;
    }
    .call-container .eb-switch input:checked + .eb-switch-track {
      background: rgba(217,119,6,0.55);
      border-color: rgba(217,119,6,0.55);
    }
    .call-container .eb-switch input:checked + .eb-switch-track::after { transform: translateX(20px); }
    .call-container .eb-switch.is-disabled { opacity: 0.55; pointer-events: none; }

    /* Settings modal: keep layout contained and prevent long device labels from breaking columns */
    .call-container .lk-settings-menu-modal {
      width: min(980px, calc(100vw - 32px)) !important;
      max-width: min(980px, calc(100vw - 32px)) !important;
      max-height: min(80vh, 760px) !important;
      min-height: unset !important;
      padding: 20px !important;
      background: var(--surface-200) !important;
      border: 1px solid var(--surface-border) !important;
      border-radius: 16px !important;
      overflow: hidden !important;
      box-shadow: var(--shadow-sharp) !important;
      /* Enable vertical scrolling on mobile */
      overflow-y: auto !important;
      -webkit-overflow-scrolling: touch !important;
      /* Ensure modal stays above our overlay chrome */
      z-index: 2000 !important;
    }
    
    /* Ensure settings content can scroll on mobile */
    @media (max-width: 768px) {
      .call-container .lk-settings-menu-modal {
        max-height: min(90vh, 600px) !important;
        padding: 16px !important;
      }
    }

    .call-container .lk-settings-menu-modal .eb-settings-grid {
      min-width: 0 !important;
    }

    .call-container .lk-settings-menu-modal .eb-device-col {
      min-width: 0 !important;
    }

    /* LiveKit uses white-space: nowrap for buttons globally; override inside settings to avoid overflow */
    .call-container .lk-settings-menu-modal .lk-media-device-select {
      width: 100% !important;
      max-width: 100% !important;
      overflow: hidden !important;
    }

    .call-container .lk-settings-menu-modal .lk-media-device-select li > .lk-button {
      width: 100% !important;
      max-width: 100% !important;
      min-width: 0 !important;
      justify-content: flex-start !important;
      white-space: nowrap !important;
      overflow: hidden !important;
      padding-left: 12px !important;
      padding-right: 12px !important;
      position: relative !important;
      text-overflow: ellipsis !important;
    }

    /* Smooth scrolling animation for long device names - only on hover and only if overflowing */
    @keyframes eb-device-scroll {
      0%, 100% {
        transform: translateX(0);
      }
      15% {
        transform: translateX(0);
      }
      42.5% {
        transform: translateX(var(--eb-device-scroll-distance, -100px));
      }
      57.5% {
        transform: translateX(var(--eb-device-scroll-distance, -100px));
      }
      85% {
        transform: translateX(0);
      }
    }

    .call-container .lk-settings-menu-modal .lk-media-device-select li > .lk-button {
      display: flex !important;
      align-items: center !important;
    }

    .call-container .lk-settings-menu-modal .lk-media-device-select li > .lk-button > span.eb-device-label {
      display: inline-block !important;
      white-space: nowrap !important;
      overflow: hidden !important;
      text-overflow: ellipsis !important;
      max-width: 100% !important;
    }

    /* Enable smooth scrolling animation only on hover and only if text overflows */
    .call-container .lk-settings-menu-modal .lk-media-device-select li > .lk-button:hover > span.eb-device-label[data-overflows="true"] {
      overflow: visible !important;
      text-overflow: clip !important;
      max-width: none !important;
      animation: eb-device-scroll 6s ease-in-out infinite !important;
    }

    .call-container .lk-settings-menu-modal .lk-media-device-select li > .lk-button * {
      min-width: 0 !important;
    }

    /* Override LiveKit's blue accent color for selected devices with eblusha brand color */
    .call-container .lk-settings-menu-modal .lk-media-device-select [data-lk-active="true"] > .lk-button {
      color: #fff !important;
      background-color: var(--brand, #d97706) !important;
    }
    .call-container .lk-settings-menu-modal .lk-media-device-select [data-lk-active="true"] > .lk-button:hover {
      background-color: var(--brand-600, #e38b0a) !important;
    }

    /* Ping display: always keep value on one line */
    .call-container .eb-ping-display .eb-ping-text { font-size: 11px; opacity: 0.85; white-space: nowrap; }

    /* LiveKit hides connection quality until hover; keep it always visible so ping is always visible */
    .call-container .lk-participant-tile .lk-connection-quality {
      opacity: 1 !important;
      transition-delay: 0s !important;
    }

    /* When we have a ping value, fully replace the quality icon with text */
    .call-container .lk-connection-quality.eb-ping-display { width: auto !important; min-width: 1.5rem; }
    .call-container .eb-ping-display.eb-ping-has-value svg { display: none !important; }
    .call-container .eb-ping-display.eb-ping-has-value .eb-ping-text { display: inline !important; }
    .call-container .eb-ping-display:not(.eb-ping-has-value) .eb-ping-text { display: none !important; }

    /* Ping severity colors */
    .call-container .eb-ping-display[data-eb-ping-level="good"] .eb-ping-text { color: #22c55e; } /* green */
    .call-container .eb-ping-display[data-eb-ping-level="warn"] .eb-ping-text { color: #fbbf24; } /* yellow */
    .call-container .eb-ping-display[data-eb-ping-level="bad"] .eb-ping-text { color: #ef4444; }  /* red */

    /* Avoid metadata overflow (ping text should not leave tile) */
    .call-container .lk-participant-metadata { box-sizing: border-box; max-width: 100%; }
    .call-container .lk-connection-quality.eb-ping-display { max-width: 72px; overflow: hidden; }
    .call-container .eb-ping-display .eb-ping-text {
      display: inline-block;
      max-width: 72px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    /* Per-participant volume: modern volume ring around avatar (0..150%, red after 100) */
    .call-container .eb-vol-ring{
      position:absolute;
      display:block;
      pointer-events:none;
      opacity:0;
      transition: opacity 520ms cubic-bezier(.2,.8,.2,1);
      transition-delay: 200ms;
      touch-action:none;
      -webkit-tap-highlight-color: transparent;
      user-select:none;
      z-index: 6;
    }
    /* Match LiveKit spotlight button rules: appears on hover/focus */
    .call-container .lk-participant-tile:hover .eb-vol-ring,
    .call-container .lk-participant-tile:focus-within .eb-vol-ring{
      opacity:1;
      pointer-events:auto;
      transition-delay: 0ms;
    }
    .call-container .eb-vol-ring-svg{
      width:100%;
      height:100%;
      display:block;
    }
    .call-container .eb-vol-ring-svg circle{
      fill:none;
      stroke-width:10;
    }
    .call-container .eb-vol-ring-svg .bg{
      stroke: rgba(255,255,255,0.12);
    }
    .call-container .eb-vol-ring-svg .safe{
      stroke:#d97706;
      stroke-linecap:round;
      opacity:0;
    }
    .call-container .eb-vol-ring-svg .over{
      stroke:#ef4444;
      stroke-linecap:round;
      opacity:0;
    }
    .call-container .eb-vol-ring-svg .thumb{
      fill: rgba(255,255,255,.92);
      stroke: rgba(0,0,0,.25);
      stroke-width:1;
      filter: drop-shadow(0 8px 18px rgba(0,0,0,.35));
      opacity:0;
    }
    .call-container .lk-participant-tile:hover .eb-vol-ring-svg .thumb,
    .call-container .lk-participant-tile:focus-within .eb-vol-ring-svg .thumb{ opacity:1; }
    .call-container .eb-vol-ring-svg .hit{
      stroke: transparent;
      stroke-width: 28;
      pointer-events: stroke;
    }
    .call-container .eb-vol-ring .label{
      display:flex;
      align-items:center;
      justify-content:center;
      font-size: 18px;
      line-height: 22px;
      font-weight: 650;
      font-variant-numeric: tabular-nums;
      padding: 8px 12px;
      border-radius: 999px;
      background: #040303a1;
      border: 1px solid rgba(255,255,255,.10);
      color: rgba(255,255,255,.92);
    }
    /* Mobile: don't show "громкость:" prefix */
    @media (hover: none){
      .call-container .eb-vol-ring .label .prefix{ display:none; }
    }
    .call-container .eb-vol-ring .center{
      position:absolute;
      left:50%;
      top:50%;
      transform: translate(-50%, -50%);
      display:flex;
      flex-direction:column;
      align-items:center;
      gap:6px;
      opacity:0;
      transition: opacity 520ms cubic-bezier(.2,.8,.2,1), transform 520ms cubic-bezier(.2,.8,.2,1);
      transform: translate(-50%, -50%) scale(.985);
      pointer-events:none;
    }
    .call-container .lk-participant-tile:hover .eb-vol-ring .center,
    .call-container .lk-participant-tile:focus-within .eb-vol-ring .center{
      opacity: 1;
      pointer-events: auto;
      transform: translate(-50%, -50%) scale(1);
    }
    .call-container .eb-vol-ring .actions{
      display:flex;
      gap:6px;
      pointer-events:auto;
    }
    .call-container .eb-vol-ring .actions .btn{
      border: 1px solid rgba(255,255,255,.10);
      background: #040303a1;
      color: rgba(255,255,255,.92);
      border-radius: 999px;
      padding: 7px 12px;
      font-size: 14px;
      line-height: 18px;
      cursor: pointer;
      user-select:none;
      -webkit-tap-highlight-color: transparent;
    }
    .call-container .eb-vol-ring .actions .btn:hover{
      background: #040303c1;
    }

    /* Spotlight / tiny tiles: show only mute/restore button */
    .call-container .eb-vol-ring[data-eb-compact="true"] .label{
      display:none;
    }
    .call-container .eb-vol-ring[data-eb-compact="true"] .actions .btn.reset{
      display:none;
    }
    .call-container .eb-vol-ring[data-eb-compact="true"] .actions{
      gap:0;
    }
    .call-container .eb-vol-ring[data-eb-compact="true"] .actions .btn{
      padding: 8px 14px;
      font-size: 14px;
      line-height: 18px;
    }
  `

  useEffect(() => {
    let mounted = true
    async function fetchToken() {
      if (!open || !conversationId) return
      const room = `conv-${conversationId}`
      const resp = await api.post('/livekit/token', { room, participantMetadata: { app: 'eblusha', userId: me?.id, displayName: me?.displayName ?? me?.username, avatarUrl: myAvatar } })
      if (!mounted) return
      setToken(resp.data.token)
      setServerUrl(resp.data.url)

      // Debug (safe): log whether the token includes canPublishData (required for ping exchange).
      try {
        const parts = String(resp.data.token || '').split('.')
        if (parts.length >= 2) {
          const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/')
          const json = JSON.parse(atob(base64))
          const canPublishData = !!json?.video?.canPublishData || !!json?.video?.can_publish_data
          if (isDebugFlagEnabled('lk-debug-ping', 'lkDebugPing')) {
            // eslint-disable-next-line no-console
            console.log('[Ping] LiveKit grant canPublishData:', canPublishData)
          }
        }
      } catch {
        // ignore
      }
    }
    fetchToken()
    return () => {
      mounted = false
      setToken(null)
      setServerUrl(null)
    }
  }, [open, conversationId])

  useEffect(() => {
    setE2eeEnabled(false)
    e2eeEnableStartedRef.current = false
  }, [conversationId])

  // 1:1 E2EE setup (key/provider/worker must be ready before connect).
  useEffect(() => {
    let cancelled = false
    let createdWorker: Worker | null = null
    let createdRoom: Room | null = null

    async function setup() {
      if (!open || !conversationId || !token || !serverUrl || !shouldUseE2ee) {
        setE2eePreparing(false)
        setE2eeError(null)
        cleanupE2eeResources()
        return
      }

      setE2eePreparing(true)
      setE2eeError(null)
      setE2eeEnabled(false)
      e2eeEnableStartedRef.current = false

      try {
        const keyBase64 = await fetchE2eeKey(conversationId)
        if (cancelled) return

        const { options, worker } = await createE2eeRoomOptions(keyBase64)
        createdWorker = worker

        createdRoom = new Room(options)
        if (cancelled) return

        // Replace any existing E2EE room resources.
        cleanupE2eeResources()

        e2eeRoomRef.current = createdRoom
        e2eeWorkerRef.current = createdWorker
        setE2eeRoom(createdRoom)

        createdRoom = null
        createdWorker = null
      } catch (err) {
        if (cancelled) return
        const msg = describeE2eeSetupError(err)
        setE2eeError(msg)
      } finally {
        if (!cancelled) {
          setE2eePreparing(false)
        }
        try {
          createdRoom?.disconnect()
        } catch {
          // ignore
        }
        try {
          createdWorker?.terminate()
        } catch {
          // ignore
        }
      }
    }

    setup()

    return () => {
      cancelled = true
      try {
        createdRoom?.disconnect()
      } catch {
        // ignore
      }
      try {
        createdWorker?.terminate()
      } catch {
        // ignore
      }
    }
  }, [open, conversationId, token, serverUrl, shouldUseE2ee, cleanupE2eeResources])

  // Ensure we always cleanup E2EE resources on unmount.
  useEffect(() => {
    return () => {
      cleanupE2eeResources()
    }
  }, [cleanupE2eeResources])

  const waitForLocalE2eeEnabled = useCallback((room: Room, timeoutMs: number) => {
    if (room.isE2EEEnabled) return Promise.resolve()
    return new Promise<void>((resolve, reject) => {
      let done = false
      const timer = setTimeout(() => {
        if (done) return
        done = true
        cleanup()
        reject(new Error('E2EE enable timeout'))
      }, timeoutMs)

      const onStatus = (enabled: boolean, participant: any) => {
        try {
          if (!enabled) return
          const localId = room.localParticipant.identity
          if (!localId) return
          if (participant?.identity !== localId) return
          if (done) return
          done = true
          cleanup()
          resolve()
        } catch (e) {
          if (done) return
          done = true
          cleanup()
          reject(e as any)
        }
      }

      const onError = (error: Error) => {
        if (done) return
        done = true
        cleanup()
        reject(error)
      }

      const cleanup = () => {
        clearTimeout(timer)
        room.off(RoomEvent.ParticipantEncryptionStatusChanged, onStatus as any)
        room.off(RoomEvent.EncryptionError, onError as any)
      }

      room.on(RoomEvent.ParticipantEncryptionStatusChanged, onStatus as any)
      room.on(RoomEvent.EncryptionError, onError as any)
    })
  }, [])

  const enableE2eeAndPublishAfterConnect = useCallback(() => {
    if (!shouldUseE2ee) return
    if (e2eeEnabled) return
    if (e2eeEnableStartedRef.current) return
    const room = e2eeRoomRef.current
    if (!room) return

    e2eeEnableStartedRef.current = true

    void (async () => {
      try {
        // Required order: connect → setE2EEEnabled(true) → publish.
        await enableE2ee(room)
        await waitForLocalE2eeEnabled(room, 10_000)
        setE2eeEnabled(true)

        // Only publish after E2EE is confirmed enabled.
        await Promise.all([
          room.localParticipant.setMicrophoneEnabled(!muted),
          room.localParticipant.setCameraEnabled(!!camera),
        ])
      } catch (err) {
        const msg = describeE2eeSetupError(err)
        setE2eeError(msg)
        cleanupE2eeResources()
      }
    })()
  }, [camera, cleanupE2eeResources, e2eeEnabled, muted, shouldUseE2ee, waitForLocalE2eeEnabled])

  // Guardrail: for 1:1 calls with E2EE required, never allow local encryption to silently turn off.
  useEffect(() => {
    if (!shouldUseE2ee) return
    if (!e2eeRoom) return
    const room = e2eeRoom
    const onStatus = (enabled: boolean, participant: any) => {
      try {
        const localId = room.localParticipant.identity
        if (!localId) return
        if (participant?.identity !== localId) return
        if (enabled) {
          if (!e2eeEnabled) setE2eeEnabled(true)
          return
        }
        // If E2EE was already enabled and got disabled, stop the call.
        if (e2eeEnabled) {
          setE2eeError('E2EE отключилось во время звонка. Продолжить без шифрования нельзя.')
          cleanupE2eeResources()
        }
      } catch {
        // ignore
      }
    }
    room.on(RoomEvent.ParticipantEncryptionStatusChanged, onStatus as any)
    return () => {
      room.off(RoomEvent.ParticipantEncryptionStatusChanged, onStatus as any)
    }
  }, [cleanupE2eeResources, e2eeEnabled, e2eeRoom, shouldUseE2ee])

  // Sync initial media flags on every open
  useEffect(() => {
    if (open) {
      setCamera(!!initialVideo)
      setMuted(!initialAudio)
      setWasConnected(false) // Reset connection state when opening
    }
  }, [open, initialVideo, initialAudio])

  // Lock body scroll on mobile during call
  useEffect(() => {
    if (!open) return
    const isMobile = typeof window !== 'undefined' && window.innerWidth <= 768
    if (isMobile) {
      const prevOverflow = document.body.style.overflow
      document.body.style.overflow = 'hidden'
      return () => {
        document.body.style.overflow = prevOverflow
      }
    }
  }, [open])

  useEffect(() => {
    if (!open) {
      closingRef.current = false
      manualCloseRef.current = false
    }
  }, [open])

  // track desktop/resize
  useEffect(() => {
    const onResize = () => setIsDesktop(typeof window !== 'undefined' ? window.innerWidth > 768 : true)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // Hide chat UI and localize tooltips, and add minimize button
  useEffect(() => {
    if (!open) return
    const root = document.body
    if (!root) return
    const translate = () => {
      // Собираем все элементы с aria/ title И кнопки LiveKit, чтобы русифицировать текст
      const nodes = new Set<Element>()
      document.querySelectorAll('.call-container [aria-label], .call-container [title]').forEach((el) => nodes.add(el))
      document.querySelectorAll('.call-container .lk-control-bar button, .call-container button.lk-button').forEach((el) => nodes.add(el))

      nodes.forEach((el) => {
        const a = (el as HTMLElement).getAttribute('aria-label') || (el as HTMLElement).getAttribute('title') || ''
        let ru = ''
        const s = a.toLowerCase()
        if (s.includes('microphone')) ru = a.includes('mute') ? 'Выключить микрофон' : 'Включить микрофон'
        else if (s.includes('camera')) ru = a.includes('disable') || s.includes('off') ? 'Выключить камеру' : 'Включить камеру'
        else if (s.includes('screen')) ru = s.includes('stop') ? 'Остановить показ экрана' : 'Поделиться экраном'
        else if (s.includes('flip')) ru = 'Сменить камеру'
        else if (s.includes('participants')) ru = 'Участники'
        else if (s.includes('settings')) ru = 'Настройки'
        else if (s.includes('leave') || s.includes('hang')) ru = 'Выйти'
        else if (s.includes('chat')) ru = 'Чат'
        if (ru) {
          ;(el as HTMLElement).setAttribute('aria-label', ru)
          ;(el as HTMLElement).setAttribute('title', ru)
        }

        // Русификация текстовых лейблов у кнопок: заменяем только текстовые узлы с точным совпадением
        if ((el as HTMLElement).tagName === 'BUTTON') {
          const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
          let node = walker.nextNode()
          while (node) {
            const raw = node.nodeValue || ''
            const normalized = raw.replace(/\s+/g, ' ').trim().toLowerCase()
            let translated: string | null = null
            if (normalized === 'leave') translated = 'Выйти'
            else if (normalized === 'participants') translated = 'Участники'
            else if (normalized === 'settings') translated = 'Настройки'
            else if (normalized === 'microphone') translated = 'Микрофон'
            else if (normalized === 'camera') translated = 'Камера'
            else if (normalized === 'connecting') translated = 'Подключение'
            else if (normalized === 'reconnecting') translated = 'Переподключение'
            else if (normalized === 'disconnected') translated = 'Отключено'
            else if (normalized === 'screen share' || normalized === 'share screen' || normalized === 'share-screen' || normalized === 'share-screen ') translated = 'Показ экрана'
            // fallback: contains both words
            else if (normalized.includes('share') && normalized.includes('screen')) translated = 'Показ экрана'
            if (translated) {
              node.nodeValue = translated
              // Продублируем в aria-label/title для консистентности
              ;(el as HTMLElement).setAttribute('aria-label', translated)
              ;(el as HTMLElement).setAttribute('title', translated)
            }
            node = walker.nextNode()
          }
        }
      })

      // Translate connection state toast text (it's not a button, so handle separately)
      document.querySelectorAll('.call-container .lk-toast-connection-state').forEach((toast) => {
        const walker = document.createTreeWalker(toast, NodeFilter.SHOW_TEXT)
        let node = walker.nextNode()
        while (node) {
          const raw = node.nodeValue || ''
          const normalized = raw.replace(/\s+/g, ' ').trim().toLowerCase()
          if (normalized === 'connecting') node.nodeValue = 'Подключение'
          else if (normalized === 'reconnecting') node.nodeValue = 'Переподключение'
          else if (normalized === 'disconnected') node.nodeValue = 'Отключено'
          node = walker.nextNode()
        }
      })
      // Ensure control bar and its buttons stay visible (do not hide chat here to avoid accidental removals)
      const controlBar =
        (root.querySelector('.call-container .lk-control-bar') as HTMLElement | null) ||
        (root.querySelector('.call-container [data-lk-control-bar]') as HTMLElement | null) ||
        (root.querySelector('.call-container [role="toolbar"]') as HTMLElement | null)
      
      // Add minimize button to control bar
      if (controlBar && onMinimize) {
        // Check if minimize button already exists
        let minimizeBtn = controlBar.querySelector('.eb-minimize-btn') as HTMLButtonElement | null
        if (!minimizeBtn) {
          minimizeBtn = document.createElement('button')
          minimizeBtn.className = 'eb-minimize-btn lk-button'
          minimizeBtn.setAttribute('aria-label', 'Свернуть')
          minimizeBtn.setAttribute('title', 'Свернуть')
          minimizeBtn.setAttribute('type', 'button')
          // Custom minimize icon with text label - matching LiveKit button structure
          minimizeBtn.innerHTML = `
            <span style="display: flex; align-items: center; gap: 8px;">
              <svg fill="currentColor" stroke="currentColor" width="30px" height="30px" version="1.1" viewBox="144 144 512 512" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" transform="matrix(6.123233995736766e-17,1,-1,6.123233995736766e-17,0,0)">
                <g id="IconSvg_bgCarrier" stroke-width="0"></g>
                <g id="IconSvg_tracerCarrier" stroke-linecap="round" stroke-linejoin="round" stroke="#CCCCCC"></g>
                <g id="IconSvg_iconCarrier">
                  <path d="m546.94 400v125.95-0.003906c0 5.5703-2.2109 10.91-6.1484 14.844-3.9336 3.9375-9.2734 6.1484-14.844 6.1484h-251.9c-5.5664 0-10.906-2.2109-14.844-6.1484-3.9375-3.9336-6.1484-9.2734-6.1484-14.844v-251.9c0-5.5664 2.2109-10.906 6.1484-14.844s9.2773-6.1484 14.844-6.1484h125.95c7.5 0 14.43 4 18.18 10.496 3.75 6.4961 3.75 14.496 0 20.992-3.75 6.4961-10.68 10.496-18.18 10.496h-104.96v209.92h209.92v-104.96c0-7.5 4.0039-14.43 10.496-18.18 6.4961-3.75 14.5-3.75 20.992 0 6.4961 3.75 10.496 10.68 10.496 18.18z"></path>
                  <path fill="#d97706" stroke="#d97706" d="m567.93 253.05c0.019531-2.457-0.48047-4.8906-1.4688-7.1367-1.0117-2.043-2.2812-3.9492-3.7773-5.668l-1.6797-1.2578v-0.003907 c-1.2461-1.2812-2.7461-2.2812-4.4102-2.9375h-1.8906 0.003907c-2.2812-1.8594-4.9297-3.2188-7.7695-3.9883h-62.977 c-7.4961 0-14.43 4-18.18 10.496-3.7461 6.4961-3.7461 14.496 0 20.992 3.75 6.4961 10.684 10.496 18.18 10.496h12.387 l-111.26 111.05c-3.9727 3.9414-6.2109 9.3086-6.2109 14.906s2.2383 10.961 6.2109 14.902c3.9414 3.9727 9.3086 6.2109 14.906 6.2109s10.961-2.2383 14.902-6.2109l111.05-111.26v12.387c0 7.5 4.0039 14.43 10.496 18.18 6.4961 3.75 14.5 3.75 20.992 0 6.4961-3.75 10.496-10.68 10.496-18.18z"></path>
                </g>
              </svg>
              <span style="font-size: 14px;">Свернуть</span>
            </span>
          `
          // Bind minimize handler using capture phase to avoid LiveKit / parent interception.
          if (!(minimizeBtn as any).__ebMinBound) {
            ;(minimizeBtn as any).__ebMinBound = true
            const handler = (evt: Event) => {
            evt.preventDefault()
            evt.stopPropagation()
            try {
              onMinimize?.()
            } catch (err) {
              console.error('Minimize click error', err)
            }
          }
            ;(minimizeBtn as any).__ebMinHandler = handler
            minimizeBtn.addEventListener('click', handler, true)
            minimizeBtn.addEventListener('pointerup', handler, true)
            minimizeBtn.addEventListener('touchend', handler, true)
            minimizeBtn.addEventListener('keydown', (e: any) => {
              if (e?.key !== 'Enter' && e?.key !== ' ') return
              handler(e)
            })
          }
          minimizeBtn.style.pointerEvents = 'auto'
          minimizeBtn.disabled = false
          
          // Insert before leave button (or at the end if not found)
          // Ищем кнопку "Выйти" максимально надежно (у LiveKit есть стабильный класс lk-disconnect-button)
          let leaveBtn =
            (controlBar.querySelector('button.lk-disconnect-button') as HTMLElement | null) ||
            (controlBar.querySelector(
              '[aria-label*="Выйти" i], [title*="Выйти" i], [aria-label*="leave" i], [title*="leave" i]'
            ) as HTMLElement | null)
          
          if (leaveBtn && leaveBtn.parentNode) {
            if (!(leaveBtn as any).__ebLeaveBound) {
              const handler = (evt: Event) => {
                // Устанавливаем флаг ДО того, как LiveKit обработает клик
                manualCloseRef.current = true
                // Не предотвращаем дефолтное поведение - пусть LiveKit обработает отключение
                // handleClose будет вызван через onDisconnected с manual: true
              }
              // Используем capture phase, чтобы установить флаг до обработки LiveKit
              leaveBtn.addEventListener('click', handler, true)
              ;(leaveBtn as any).__ebLeaveBound = handler
            }
            leaveBtn.parentNode.insertBefore(minimizeBtn, leaveBtn)
          } else {
            controlBar.appendChild(minimizeBtn)
          }
        }

        // Обновляем расположение и подпись в зависимости от режима (desktop/mobile)
        if (minimizeBtn) {
          const iconSvg = `
            <svg fill="currentColor" stroke="currentColor" width="30px" height="30px" version="1.1" viewBox="144 144 512 512" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" transform="matrix(6.123233995736766e-17,1,-1,6.123233995736766e-17,0,0)">
              <g id="IconSvg_bgCarrier" stroke-width="0"></g>
              <g id="IconSvg_tracerCarrier" stroke-linecap="round" stroke-linejoin="round" stroke="#CCCCCC"></g>
              <g id="IconSvg_iconCarrier">
                <path d="m546.94 400v125.95-0.003906c0 5.5703-2.2109 10.91-6.1484 14.844-3.9336 3.9375-9.2734 6.1484-14.844 6.1484h-251.9c-5.5664 0-10.906-2.2109-14.844-6.1484-3.9375-3.9336-6.1484-9.2734-6.1484-14.844v-251.9c0-5.5664 2.2109-10.906 6.1484-14.844s9.2773-6.1484 14.844-6.1484h125.95c7.5 0 14.43 4 18.18 10.496 3.75 6.4961 3.75 14.496 0 20.992-3.75 6.4961-10.68 10.496-18.18 10.496h-104.96v209.92h209.92v-104.96c0-7.5 4.0039-14.43 10.496-18.18 6.4961-3.75 14.5-3.75 20.992 0 6.4961-3.75 10.496-10.68 10.496-18.18z"></path>
                <path fill="#d97706" stroke="#d97706" d="m567.93 253.05c0.019531-2.457-0.48047-4.8906-1.4688-7.1367-1.0117-2.043-2.2812-3.9492-3.7773-5.668l-1.6797-1.2578v-0.003907 c-1.2461-1.2812-2.7461-2.2812-4.4102-2.9375h-1.8906 0.003907c-2.2812-1.8594-4.9297-3.2188-7.7695-3.9883h-62.977 c-7.4961 0-14.43 4-18.18 10.496-3.7461 6.4961-3.7461 14.496 0 20.992 3.75 6.4961 10.684 10.496 18.18 10.496h12.387 l-111.26 111.05c-3.9727 3.9414-6.2109 9.3086-6.2109 14.906s2.2383 10.961 6.2109 14.902c3.9414 3.9727 9.3086 6.2109 14.906 6.2109s10.961-2.2383 14.902-6.2109l111.05-111.26v12.387c0 7.5 4.0039 14.43 10.496 18.18 6.4961 3.75 14.5 3.75 20.992 0 6.4961-3.75 10.496-10.68 10.496-18.18z"></path>
              </g>
            </svg>`
          const desktopLabel = `
            <span style="display: flex; align-items: center; gap: 8px;">
              <span style="font-size: 14px; font-family: inherit; font-weight: 500; line-height: 20px;">Свернуть</span>
              ${iconSvg}
            </span>`
          minimizeBtn.innerHTML = isDesktop ? desktopLabel : iconSvg
          // Выравниваем высоту под другие кнопки панели
          minimizeBtn.style.height = '44px'
          minimizeBtn.style.minHeight = '44px'
          minimizeBtn.style.padding = '0 12px'
          minimizeBtn.style.display = 'flex'
          minimizeBtn.style.alignItems = 'center'
          minimizeBtn.style.justifyContent = 'flex-start'
          minimizeBtn.style.fontFamily = 'inherit'
          minimizeBtn.style.fontSize = '14px'
          minimizeBtn.style.fontWeight = '500'
          minimizeBtn.style.lineHeight = '20px'
          // Keep handler bound (don't overwrite via onclick).
          minimizeBtn.style.pointerEvents = 'auto'
          minimizeBtn.disabled = false
          minimizeBtn.style.marginLeft = 'auto'
          // Перемещаем в конец панели, чтобы была справа
          if (minimizeBtn.parentElement === controlBar && controlBar.lastElementChild !== minimizeBtn) {
            controlBar.appendChild(minimizeBtn)
          }
        }
      }
    }
    // Без дебаунса наблюдатель может зациклиться на собственных изменениях, что ведет к подвисанию страницы.
    let pending = false
    const scheduleTranslate = () => {
      if (pending) return
      pending = true
      requestAnimationFrame(() => {
        pending = false
        translate()
      })
    }

    const mo = new MutationObserver(() => scheduleTranslate())
    mo.observe(root, { childList: true, subtree: true, attributes: true })
    translate()
    return () => {
      mo.disconnect()
      // Cleanup: удаляем обработчики с кнопки "Выйти" при размонтировании
      const leaveBtn =
        (root.querySelector('.call-container .lk-control-bar button.lk-disconnect-button') as HTMLElement | null) ||
        (root.querySelector(
          '.call-container .lk-control-bar [aria-label*="Выйти" i], .call-container .lk-control-bar [title*="Выйти" i], .call-container .lk-control-bar [aria-label*="leave" i], .call-container .lk-control-bar [title*="leave" i]'
        ) as HTMLElement | null)
      if (leaveBtn && (leaveBtn as any).__ebLeaveBound) {
        leaveBtn.removeEventListener('click', (leaveBtn as any).__ebLeaveBound, true)
        delete (leaveBtn as any).__ebLeaveBound
      }
    }
  }, [open, onMinimize, handleClose, isDesktop])

  // Add "(мы)" label to local participant name in tiles
  useEffect(() => {
    if (!open) return
    const root = document.body
    if (!root) return
    const localIdRef = localUserId || null

    const updateLocalParticipantName = () => {
      const tiles = root.querySelectorAll('.call-container .lk-participant-tile, .call-container [data-participant]') as NodeListOf<HTMLElement>
      tiles.forEach((tile) => {
        // Проверяем, является ли это локальным участником
        const isLocalByAttr = tile.getAttribute('data-lk-local-participant') === 'true' || (tile as any).dataset?.lkLocalParticipant === 'true'
        
        // Также проверяем по identity для совместимости
        let identity = tile.getAttribute('data-lk-participant-identity') || ''
        if (!identity) {
          const idEl = tile.querySelector('[data-lk-participant-identity]') as HTMLElement | null
          if (idEl) identity = idEl.getAttribute('data-lk-participant-identity') || ''
        }
        const identityMatchesLocal = !!(identity && localIdRef && identity === localIdRef)
        const isLocal = isLocalByAttr || identityMatchesLocal

        if (!isLocal) return

        // Находим элемент с именем
        const nameEl = tile.querySelector('.lk-participant-name, [data-lk-participant-name]') as HTMLElement | null
        if (!nameEl) return

        const currentText = nameEl.textContent || ''
        // Убираем старое "(мы)", если оно есть
        const nameWithoutWe = currentText.replace(/\s*\(мы\)\s*$/, '').trim()
        if (!nameWithoutWe) return // Пропускаем, если имени нет
        
        const expectedText = `${nameWithoutWe} (мы)`
        // Обновляем только если текст отличается
        if (currentText !== expectedText) {
          nameEl.textContent = expectedText
          // Также обновляем data-атрибут для консистентности
          if (nameEl.hasAttribute('data-lk-participant-name')) {
            nameEl.setAttribute('data-lk-participant-name', expectedText)
          }
        }
      })
    }

    // Запускаем сразу и при изменениях DOM
    updateLocalParticipantName()
    const mo = new MutationObserver(() => {
      // Небольшая задержка, чтобы дать LiveKit обновить имена
      setTimeout(updateLocalParticipantName, 50)
    })
    mo.observe(root, { childList: true, subtree: true, characterData: true })
    return () => mo.disconnect()
  }, [open, localUserId])

  // Inject avatars into participant placeholders using names
  useEffect(() => {
    if (!open) return
    const root = document.body
    if (!root) return
    // freeze props into locals to avoid any temporal dead zone/minifier aliasing issues
    const byNameRef = avatarsByName || {}
    const byIdRef = avatarsById || {}
    const localIdRef = localUserId || null
    const myAvatarRef = myAvatar || null
    const peerAvatarRef = peerAvatarUrl || null
    const avatarsDebug = isDebugFlagEnabled('lk-debug-avatars', 'lkDebugAvatars')
    const colorFromId = (id: string) => {
      let hash = 0
      for (let i = 0; i < id.length; i++) hash = id.charCodeAt(i) + ((hash << 5) - hash)
      const hue = Math.abs(hash) % 360
      return `hsl(${hue} 70% 45%)`
    }
    const buildLetterDataUrl = (label: string, id: string) => {
      const bg = colorFromId(id || label || 'x')
      const letter = (label || '?').trim().charAt(0).toUpperCase()
      const svg = `<?xml version="1.0" encoding="UTF-8"?><svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 256 256\"><defs/><rect width=\"256\" height=\"256\" rx=\"128\" fill=\"${bg}\"/><text x=\"50%\" y=\"54%\" dominant-baseline=\"middle\" text-anchor=\"middle\" font-size=\"140\" font-family=\"Inter, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif\" fill=\"#ffffff\">${letter}</text></svg>`
      return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`
    }
    const apply = () => {
      const tiles = root.querySelectorAll('.call-container .lk-participant-tile, .call-container [data-participant]') as NodeListOf<HTMLElement>
      tiles.forEach((tile) => {
        const nameEl = tile.querySelector('.lk-participant-name, [data-lk-participant-name]') as HTMLElement | null
        const placeholder = tile.querySelector('.lk-participant-placeholder') as HTMLElement | null
        if (!placeholder) return

        // If video is visible in this tile, DO NOT touch placeholder layout (it can cause video to stick to top).
        const v =
          (tile.querySelector('video.lk-participant-media-video') as HTMLVideoElement | null) ||
          (tile.querySelector('video') as HTMLVideoElement | null)
        const isVideoMuted =
          tile.getAttribute('data-video-muted') === 'true' ||
          tile.getAttribute('data-lk-video-muted') === 'true' ||
          (tile as any).dataset?.videoMuted === 'true' ||
          (tile as any).dataset?.lkVideoMuted === 'true'
        const hasActiveVideo = !!(!isVideoMuted && v && v.offsetWidth > 0 && v.offsetHeight > 0)
        tile.setAttribute('data-eb-has-video', hasActiveVideo ? 'true' : 'false')
        if (hasActiveVideo) {
          // Clean up any injected avatar when video is active.
          placeholder.querySelectorAll('img.eb-ph').forEach((img) => img.remove())
          // Restore placeholder to LiveKit defaults as much as possible.
          placeholder.style.position = ''
          ;(placeholder.style as any).inset = ''
          placeholder.style.left = ''
          placeholder.style.top = ''
          placeholder.style.right = ''
          placeholder.style.bottom = ''
          placeholder.style.transform = ''
          placeholder.style.width = ''
          placeholder.style.height = ''
          placeholder.style.maxWidth = ''
          placeholder.style.maxHeight = ''
          placeholder.style.minWidth = ''
          placeholder.style.minHeight = ''
          placeholder.style.margin = ''
          return
        }
        // identity lookup preferred (must compute before using as a fallback for name)
        // Проверяем несколько мест, где может быть identity
        let identity = ''
        
        // Собираем все data-атрибуты для отладки
        const allDataAttrs: Record<string, string> = {}
        for (let i = 0; i < tile.attributes.length; i++) {
          const attr = tile.attributes[i]
          if (attr.name.startsWith('data-')) {
            allDataAttrs[attr.name] = attr.value
          }
        }
        
        // 1. Проверяем data-lk-participant-identity на самом элементе
        const idAttrOnTile = tile.getAttribute('data-lk-participant-identity')
        if (idAttrOnTile) {
          identity = idAttrOnTile.trim()
        }
        
        // 2. Ищем в дочерних элементах
        if (!identity) {
          const idAttrEl = tile.querySelector('[data-lk-participant-identity]') as HTMLElement | null
          if (idAttrEl) {
            identity = (idAttrEl.getAttribute('data-lk-participant-identity') || '').trim()
          }
        }
        
        // 3. Проверяем dataset напрямую
        if (!identity) {
          const datasetId = (tile.dataset as any)?.lkParticipantIdentity || (tile as any).dataset?.lkParticipantIdentity
          if (datasetId) {
            identity = String(datasetId).trim()
          }
        }
        
        // 4. Проверяем другие возможные варианты атрибутов
        if (!identity) {
          const altAttrs = ['data-participant-identity', 'data-identity', 'data-participant-id', 'data-user-id']
          for (const attrName of altAttrs) {
            const val = tile.getAttribute(attrName)
            if (val) {
              identity = val.trim()
              break
            }
          }
        }
        
        // 5. Извлекаем метаданные
        const metadataAttr = tile.getAttribute('data-lk-participant-metadata') || (tile.dataset ? tile.dataset.lkParticipantMetadata : '') || ''
        let participantMeta: Record<string, any> | null = null
        if (metadataAttr) {
          try {
            participantMeta = JSON.parse(metadataAttr)
          } catch {
            participantMeta = null
          }
        }
        // 6. Извлекаем identity из метаданных (приоритет метаданных)
        if (participantMeta?.userId) {
          identity = String(participantMeta.userId).trim()
        }
        
        // 7. Если identity все еще пустой, логируем только один раз (не для каждого обновления)
        // Логирование отключено для уменьшения шума, включаем только при необходимости
        // if (!identity) {
        //   console.log('[CallOverlay] Identity not found in tile, all data attributes:', allDataAttrs, 'metadata:', participantMeta, 'tile classes:', tile.className)
        // }
        let name = (nameEl?.textContent || nameEl?.getAttribute('data-lk-participant-name') || '').trim()
        // Убираем "(мы)" из имени для корректного поиска аватара в словаре
        const originalName = name.replace(/\s*\(мы\)\s*$/, '').trim()
        if (!name && participantMeta?.displayName) {
          name = String(participantMeta.displayName).trim()
        }
        if (!name) {
          const meta = tile.querySelector('.lk-participant-metadata') as HTMLElement | null
          if (meta?.textContent?.trim()) name = meta.textContent.trim()
        }
        if (!name) name = identity || ''
        
        // Определяем локального участника СТРОГО: только если identity точно совпадает с localUserId
        // Это критически важно, чтобы не показывать мой аватар для других участников
        const identityMatchesLocal = !!(identity && localIdRef && identity === localIdRef)
        const isLocal = identityMatchesLocal
        
        // Сначала пытаемся найти аватар по identity (самый надежный способ)
        const idUrl = identity ? (byIdRef[identity] ?? null) : null
        
        // Затем по оригинальному имени без "(мы)" (case-insensitive)
        const nameForLookup = originalName || name.replace(/\s*\(мы\)\s*$/, '').trim()
        const key = Object.keys(byNameRef).find((k) => k.toLowerCase() === nameForLookup.toLowerCase())
        const url = key ? byNameRef[key] : null
        
        // Используем мой аватар ТОЛЬКО если это точно локальный участник (identity совпадает)
        // И только если не нашли аватар по identity или имени
        const myUrl = myAvatarRef
        // peerAvatarUrl используется только для 1:1 звонков, но мы не можем точно определить,
        // что это именно тот участник, поэтому не используем его как общий fallback
        // Приоритет: idUrl > url > (для локального: myUrl) > fallbackUrl (генерация с буквой)
        let finalUrl = idUrl ?? url ?? (isLocal ? (myUrl || (localIdRef ? byIdRef[localIdRef] ?? null : null)) : null)
        finalUrl = resolveAvatarUrl(finalUrl)
        const fallbackUrl = buildLetterDataUrl(nameForLookup || identity || 'U', identity || nameForLookup || 'U')
        
        if (avatarsDebug && !finalUrl && (identity || name)) {
          const nameKeys = Object.keys(byNameRef)
          const nameMatch = name ? nameKeys.find((k) => k.toLowerCase() === name.toLowerCase()) : null
          // eslint-disable-next-line no-console
          console.log('[Avatars] Avatar not found:', {
            identity: identity || '(empty)',
            name: name || '(empty)',
            isLocal,
            localIdRef: localIdRef || '(empty)',
            byIdHasIdentity: identity ? identity in byIdRef : false,
            byNameHasName: !!nameMatch,
            nameMatch: nameMatch || '(no match)',
            participantMeta: participantMeta ? { userId: participantMeta.userId, displayName: participantMeta.displayName } : null,
          })
        }
        
        // Create or update img
        let img = placeholder.querySelector('img.eb-ph') as HTMLImageElement | null
        if (!img) {
          img = document.createElement('img')
          img.className = 'eb-ph'
          placeholder.appendChild(img)
        }
        const failedUrl = img.dataset.ebFailedUrl || ''
        const desiredUrl = finalUrl && finalUrl !== failedUrl ? finalUrl : fallbackUrl
        const removeLiveKitSvg = () => {
          // Remove LiveKit default SVG placeholders, but keep our own overlay SVGs (e.g. volume ring)
          placeholder.querySelectorAll('svg:not(.eb-vol-ring-svg)').forEach((svg) => svg.remove())
          placeholder
            .querySelectorAll('svg:not(.eb-vol-ring-svg)')
            .forEach((svg) => ((svg as SVGElement).style.display = 'none'))
        }
        // Обработчик ошибок загрузки - если аватар не загрузился, запоминаем и показываем fallback
        img.dataset.ebAvatarUrl = desiredUrl
        img.dataset.ebFallback = fallbackUrl
        img.onload = () => {
          img.dataset.ebLoaded = '1'
          removeLiveKitSvg()
        }
        img.onerror = () => {
          const failedSrc = img?.dataset?.ebAvatarUrl || ''
          if (failedSrc && failedSrc !== fallbackUrl) {
            img.dataset.ebFailedUrl = failedSrc
          }
          img.dataset.ebLoaded = ''
          if (avatarsDebug) {
            // eslint-disable-next-line no-console
            console.log('[Avatars] Avatar image failed to load, using fallback:', img?.getAttribute('src') || '')
          }
          if (failedSrc && failedSrc !== fallbackUrl && img && img.getAttribute('src') !== fallbackUrl) {
            img.src = fallbackUrl
          }
        }
        // Обновляем src только если он изменился, чтобы избежать лишних перезагрузок
        if (img.getAttribute('src') !== desiredUrl) {
          img.src = desiredUrl
        }
        if (img.complete && img.naturalWidth > 0) {
          img.dataset.ebLoaded = '1'
          removeLiveKitSvg()
        }
        // Calculate size based on smaller dimension of tile to ensure circle
        const tileRect = tile.getBoundingClientRect()
        const tileMinDimension = Math.min(tileRect.width, tileRect.height)
        // Use 95% of the smaller dimension for placeholder
        const placeholderSize = Math.floor(tileMinDimension * 0.95)
        
        // Set placeholder size to ensure it's always circular.
        // Keep it OUT of layout flow (do not affect video tiles): absolute centered circle.
        placeholder.style.position = 'absolute'
        ;(placeholder.style as any).inset = 'auto'
        placeholder.style.left = '50%'
        placeholder.style.top = '50%'
        placeholder.style.right = 'auto'
        placeholder.style.bottom = 'auto'
        placeholder.style.transform = 'translate(-50%, -50%)'
        placeholder.style.width = `${placeholderSize}px`
        placeholder.style.height = `${placeholderSize}px`
        placeholder.style.maxWidth = `${placeholderSize}px`
        placeholder.style.maxHeight = `${placeholderSize}px`
        placeholder.style.minWidth = `${placeholderSize}px`
        placeholder.style.minHeight = `${placeholderSize}px`
        placeholder.style.flexShrink = '0'
        ;(placeholder.style as any).display = 'flex'
        placeholder.style.alignItems = 'center'
        placeholder.style.justifyContent = 'center'
        placeholder.style.background = 'transparent'
        placeholder.style.backgroundImage = 'none'
        placeholder.style.color = 'transparent'
        placeholder.style.fontSize = '0'
        placeholder.style.overflow = 'hidden'
        placeholder.style.margin = '0'
        // keep placeholder circular - always use smaller dimension
        placeholder.style.borderRadius = '50%'
        placeholder.style.aspectRatio = '1'
        
        img.alt = name
        // Fit avatar INSIDE the volume ring and keep it circular
        img.style.aspectRatio = '1' // Ensure square shape
        img.style.width = '80%'
        img.style.height = '80%'
        img.style.maxWidth = '80%'
        img.style.maxHeight = '80%'
        img.style.objectFit = 'cover'
        img.style.borderRadius = '50%'
        img.style.display = 'block'
        img.style.margin = 'auto'
        Array.from(placeholder.childNodes).forEach((n) => {
          if (n.nodeType === Node.TEXT_NODE) {
            (n as any).textContent = ''
          }
        })
        
      })
    }
    const mo = new MutationObserver(apply)
    mo.observe(root, { childList: true, subtree: true })
    apply()
    return () => mo.disconnect()
  }, [open, avatarsByName, avatarsById, localUserId, myAvatar])

  if (!open || !conversationId || !token || !serverUrl) return null

  const overlay = (
    <div
      className="call-overlay"
      onClick={(e) => {
        // Prevent taps/clicks from bubbling to the underlying app on mobile (can cause call state to reset)
        e.stopPropagation()
      }}
      onTouchStart={(e) => {
        // Same as onClick; important for iOS/Safari where touch events may trigger global handlers
        e.stopPropagation()
      }}
      style={{
      position: 'fixed',
      inset: 0,
      background: minimized ? 'transparent' : 'rgba(10,12,16,0.55)',
      backdropFilter: minimized ? 'none' : 'blur(4px) saturate(110%)',
      // On mobile, avoid flex centering edge-cases (some WebViews ignore stretch/viewport units combos).
      // Use block layout + explicit 100vh/100dvh sizing on the inner container.
      display: minimized ? 'none' : (isDesktop ? 'flex' : 'block'),
      alignItems: isDesktop ? 'center' : undefined,
      justifyContent: isDesktop ? 'center' : undefined,
      zIndex: 1000,
      pointerEvents: minimized ? 'none' : 'auto',
      }}
    >
      <div data-lk-theme="default" style={{ 
        width: minimized ? 0 : (isDesktop ? '90vw' : '100vw'),
        height: minimized ? 0 : (isDesktop ? '80vh' : '100vh'),
        minHeight: minimized ? 0 : (isDesktop ? undefined : '100dvh'),
        maxWidth: minimized ? 0 : (isDesktop ? 1200 : '100vw'),
        background: 'var(--surface-200)', 
        borderRadius: isDesktop ? 16 : 0, 
        overflow: minimized ? 'hidden' : 'hidden', 
        position: 'relative', 
        border: isDesktop ? '1px solid var(--surface-border)' : 'none',
        boxShadow: minimized ? 'none' : (isDesktop ? 'var(--shadow-sharp)' : 'none'),
        opacity: minimized ? 0 : 1,
        visibility: minimized ? 'hidden' : 'visible',
      }} className="call-container">
        <style>{videoContainCss}</style>
        {shouldUseE2ee ? (
          e2eeError ? (
            <div
              style={{
                width: '100%',
                height: '100%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: 24,
              }}
            >
              <div style={{ maxWidth: 560 }}>
                <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 8 }}>Защищённый звонок недоступен</div>
                <div style={{ opacity: 0.85, marginBottom: 16 }}>{e2eeError}</div>
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                  <button type="button" className="btn btn-primary" onClick={() => handleClose({ manual: true })}>
                    Закрыть
                  </button>
                </div>
              </div>
            </div>
          ) : !e2eeRoom ? (
            <div
              style={{
                width: '100%',
                height: '100%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: 24,
              }}
            >
              <div style={{ maxWidth: 560 }}>
                <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 8 }}>Включаем защищённый звонок…</div>
                <div style={{ opacity: 0.85, marginBottom: 16 }}>
                  Подготавливаем шифрование (E2EE). Это может занять пару секунд.
                </div>
                <button type="button" className="btn btn-secondary" onClick={() => handleClose({ manual: true })}>
                  Отмена
                </button>
              </div>
            </div>
          ) : (
            <LiveKitRoom
              room={e2eeRoom}
              serverUrl={serverUrl}
              token={token}
              connect
              // IMPORTANT: never publish tracks before E2EE is enabled.
              video={e2eeEnabled ? camera : false}
              audio={e2eeEnabled ? !muted : false}
              onEncryptionError={(_error) => {
                setE2eeError('Не удалось продолжить звонок: ошибка E2EE. Попробуйте начать звонок заново.')
                cleanupE2eeResources()
              }}
              onConnected={() => {
                setWasConnected(true)
                enableE2eeAndPublishAfterConnect()
              }}
              onDisconnected={(reason) => {
                if (isDebugFlagEnabled('lk-debug-call', 'lkDebugCall')) {
                  // eslint-disable-next-line no-console
                  console.log('[CallOverlay] onDisconnected:', reason, 'wasConnected:', wasConnected, 'isGroup:', isGroup, 'minimized:', minimized)
                }
                const hadConnection = wasConnected
                setWasConnected(false)
                const manual = reason === 1 || manualCloseRef.current
                // Если оверлей минимизирован, не закрываем его при отключении - это может быть временное отключение
                if (minimized) {
                  return
                }
                // Для 1:1 звонков закрываем только при явном ручном закрытии
                // Временные отключения обрабатываются через call:ended событие с сервера
                if (manual) {
                  handleClose({ manual: true })
                } else {
                  // If we were connected and got disconnected while E2EE is required, keep overlay open;
                  // reconnect logic will run inside LiveKit.
                  if (hadConnection) return
                }
              }}
            >
              {!e2eeEnabled ? (
                <div
                  style={{
                    width: '100%',
                    height: '100%',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    padding: 24,
                  }}
                >
                  <div style={{ maxWidth: 560 }}>
                    <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 8 }}>Подключаемся и включаем E2EE…</div>
                    <div style={{ opacity: 0.85, marginBottom: 16 }}>
                      Сначала подключаемся к комнате, затем включаем шифрование и только после этого публикуем микрофон/камеру.
                    </div>
                    <button type="button" className="btn btn-secondary" onClick={() => handleClose({ manual: true })}>
                      Отмена
                    </button>
                  </div>
                </div>
              ) : (
                <div style={{ width: '100%', height: '100%' }}>
                  <ConnectionStatusBadge />
                  <DefaultMicrophoneSetter />
                  <PingDisplayUpdater localUserId={localUserId} />
                  <ParticipantVolumeUpdater />
                  <VideoConference SettingsComponent={CallSettings} />
                </div>
              )}
            </LiveKitRoom>
          )
        ) : (
          <LiveKitRoom
            serverUrl={serverUrl}
            token={token}
            connect
            video={camera}
            audio={!muted}
            onConnected={() => {
              setWasConnected(true)
              try {
                if (conversationId && isGroup) {
                  if (isDebugFlagEnabled('lk-debug-call', 'lkDebugCall')) {
                    // eslint-disable-next-line no-console
                    console.log('[CallOverlay] joinCallRoom emit', { conversationId, video: initialVideo })
                  }
                  joinCallRoom(conversationId, initialVideo)
                  requestCallStatuses([conversationId])
                }
              } catch (err) {
                console.error('Error joining call room:', err)
              }
            }}
            onDisconnected={(reason) => {
              if (isDebugFlagEnabled('lk-debug-call', 'lkDebugCall')) {
                // eslint-disable-next-line no-console
                console.log('[CallOverlay] onDisconnected:', reason, 'wasConnected:', wasConnected, 'isGroup:', isGroup, 'minimized:', minimized)
              }
              const hadConnection = wasConnected
              setWasConnected(false)
              const manual = reason === 1 || manualCloseRef.current
              // Если оверлей минимизирован, не закрываем его при отключении - это может быть временное отключение
              if (minimized) {
                return
              }
              // Для 1:1 звонков закрываем только при ручном закрытии (когда пользователь нажал "Leave")
              // Для временных отключений полагаемся на события с сервера (call:ended)
              if (isGroup) {
                // Для групповых звонков НЕ закрываем оверлей на не-ручных отключениях:
                // на мобильных/при смене устройств возможны краткие дисконнекты.
                // Закрываем только при явном "Выйти" / ручном закрытии.
                if (hadConnection && manual) {
                  handleClose({ manual: true })
                }
              } else {
                // Для 1:1 звонков закрываем только при явном ручном закрытии
                // Временные отключения обрабатываются через call:ended событие с сервера
                if (manual) {
                  handleClose({ manual: true })
                }
                // Если не было подключения и это не ручное закрытие, не закрываем
                // (может быть ошибка подключения, но звонок еще активен на сервере)
              }
            }}
          >
            <div style={{ width: '100%', height: '100%' }}>
              <ConnectionStatusBadge />
              <DefaultMicrophoneSetter />
              <PingDisplayUpdater localUserId={localUserId} />
              <ParticipantVolumeUpdater />
              <VideoConference SettingsComponent={CallSettings} />
            </div>
          </LiveKitRoom>
        )}
        {/* avatar overlay removed; avatars are injected into placeholders */}
      </div>
    </div>
  )

  return createPortal(overlay, document.body)
}



