import { useEffect, useRef } from 'react'
import { useRoomContext } from '@livekit/components-react'
import { Track } from 'livekit-client'
import {
  emaScore,
  metricsFromSamples,
  qualityColor,
  qualityLabel,
  receiverSample,
  scoreFromMetrics,
  senderSample,
  type QualitySample,
} from '../../utils/callQuality'
import { api } from '../../utils/api'

// Same pattern as the other call enhancers in this codebase: <VideoConference>
// owns the tile DOM, so we compute per-participant scores from `room` (keyed by
// identity) and inject a small SVG ring into LiveKit's connection-quality slot.

const SVG_NS = 'http://www.w3.org/2000/svg'
const RING_R = 16
const RING_C = 2 * Math.PI * RING_R // circumference in viewBox units
const SAMPLE_INTERVAL_MS = 1500

type ScoreEntry = { score: number; ping: number | null }

export function CallQualityRingUpdater() {
  const room = useRoomContext()
  const prevSampleRef = useRef<Map<string, QualitySample>>(new Map())
  const smoothedRef = useRef<Map<string, number>>(new Map())
  const scoreByIdentityRef = useRef<Map<string, ScoreEntry>>(new Map())
  const nameToIdentityRef = useRef<Map<string, string>>(new Map())
  const scheduleRef = useRef<null | (() => void)>(null)

  useEffect(() => {
    if (!room) return

    const isLocalTile = (tile: HTMLElement): boolean =>
      tile.getAttribute('data-lk-local-participant') === 'true' ||
      (tile as HTMLElement).dataset?.lkLocalParticipant === 'true'

    const getTileName = (tile: HTMLElement): string | null => {
      const el =
        (tile.querySelector('[data-lk-participant-name]') as HTMLElement | null) ||
        (tile.querySelector('.lk-participant-name') as HTMLElement | null)
      const text = (el?.getAttribute('data-lk-participant-name') || el?.textContent || '').trim()
      if (!text) return null
      return text.replace(/[’']/g, "'").replace(/'s\s+screen$/i, '').trim()
    }

    const tileIdentity = (tile: HTMLElement): string | null => {
      if (isLocalTile(tile)) return room.localParticipant?.identity ?? null
      const direct = (
        tile.getAttribute('data-lk-participant-identity') ||
        tile.getAttribute('data-participant-identity') ||
        ''
      ).trim()
      if (direct && scoreByIdentityRef.current.has(direct)) return direct
      const name = getTileName(tile)
      if (name && nameToIdentityRef.current.has(name)) return nameToIdentityRef.current.get(name)!
      return direct || null
    }

    const readSelfPing = (): number | null => {
      const rtt = (room as { engine?: { client?: { rtt?: number } } }).engine?.client?.rtt
      return typeof rtt === 'number' && Number.isFinite(rtt) && rtt > 0 ? Math.round(rtt) : null
    }

    const record = (identity: string, sample: QualitySample, ping: number | null) => {
      const prev = prevSampleRef.current.get(identity)
      prevSampleRef.current.set(identity, sample)
      if (!prev) return // need two samples to diff
      const metrics = metricsFromSamples(prev, sample)
      if (!metrics) return
      const smoothed = emaScore(smoothedRef.current.get(identity) ?? null, scoreFromMetrics(metrics))
      smoothedRef.current.set(identity, smoothed)
      scoreByIdentityRef.current.set(identity, { score: Math.round(smoothed), ping })
      reportQuality(identity, metrics, Math.round(smoothed), ping, identity === room.localParticipant?.identity, prev, sample)
    }

    // ВРЕМЕННО (разбор «робота» в звонках). Раз в 5 секунд отправляем те же цифры,
    // по которым рисуется кольцо качества. Для СВОЕГО трека потери приходят по RTCP
    // от собеседника — то есть это ровно «сколько моего голоса до него не доехало».
    // Для чужого трека concealPct показывает, сколько звука пришлось додумывать
    // подстановкой — это и есть слышимый «робот».
    const lastReportAt = new Map<string, number>()
    const reportQuality = (
      identity: string,
      metrics: { lossPct: number; jitterMs: number; concealPct: number },
      score: number,
      ping: number | null,
      isSelf: boolean,
      prev: QualitySample,
      sample: QualitySample,
    ) => {
      const now = Date.now()
      // Только проблемные замеры: качество просело, есть потери или звук достраивается.
      // Здоровый звонок телеметрию не шлёт вовсе.
      const worthReporting = score < 80 || metrics.lossPct > 1 || metrics.concealPct > 5
      if (!worthReporting) return
      // Троттл на КАЖДОГО участника: с общим счётчиком пролезал только свой микрофон,
      // а входящий звук — то, ради чего всё и затевалось — не доезжал ни разу.
      if (now - (lastReportAt.get(identity) ?? 0) < 5000) return
      lastReportAt.set(identity, now)
      const events = [{
        ts: now,
        level: 'error' as const,
        tag: 'callQuality',
        kind: isSelf ? 'uplink' : 'downlink',
        rootCause: 'CALL_AUDIO',
        data: {
          kind: isSelf ? 'uplink' : 'downlink',
          who: identity.split('#')[0].slice(-6),
          device: identity.split('#')[1]?.slice(0, 8) ?? null,
          score,
          pingMs: ping,
          // Пакетов в секунду: голос идёт кадрами по 20 мс, то есть норма ровно 50.
          // Заметно меньше — источник звука отдаёт поток с дырами, и дорисовка у
          // собеседника растёт БЕЗ всяких потерь в сети.
          pktPerSec: Number((((sample.packetsTotal - prev.packetsTotal) / Math.max(1, sample.tMs - prev.tMs)) * 1000).toFixed(1)),
          packets: sample.packetsTotal - prev.packetsTotal,
          windowMs: Math.round(sample.tMs - prev.tMs),
          lossPct: Number(metrics.lossPct.toFixed(2)),
          jitterMs: Math.round(metrics.jitterMs),
          concealPct: Number(metrics.concealPct.toFixed(2)),
          room: (room as any)?.name ?? null,
        },
      }]
      void api.post('/debug/client-logs', { events }).catch(() => {})
    }

    // Сырые поля приёмника: дорисовка звука при нулевых потерях бывает по разным
    // причинам, и различить их можно только здесь. Растяжение и сжатие говорят о разном
    // ходе часов у звуковых устройств, отброшенные пакеты — о буфере, задержка обработки
    // — о нехватке процессора (расшифровка и декодирование не успевают).
    let lastRawAt = 0
    const reportRawInbound = async (identity: string, track: { receiver?: RTCRtpReceiver }) => {
      const now = Date.now()
      if (now - lastRawAt < 5000) return
      const receiver = track?.receiver
      if (!receiver || typeof receiver.getStats !== 'function') return
      lastRawAt = now
      // Сырые счётчики нужны только когда есть на что смотреть — их собирает
      // вызывающая сторона лишь для проблемных участников.
      try {
        const report = await receiver.getStats()
        let inbound: any = null
        report.forEach((st: any) => {
          if (st.type === 'inbound-rtp' && st.kind === 'audio') inbound = st
        })
        if (!inbound) return
        const events = [{
          ts: now,
          level: 'error' as const,
          tag: 'callQuality',
          kind: 'inbound-raw',
          rootCause: 'CALL_AUDIO',
          data: {
            kind: 'inbound-raw',
            who: identity.split('#')[0].slice(-6),
            codec: inbound.mimeType ?? null,
            received: inbound.packetsReceived ?? null,
            lost: inbound.packetsLost ?? null,
            discarded: inbound.packetsDiscarded ?? null,
            fec: inbound.fecPacketsReceived ?? null,
            concealed: inbound.concealedSamples ?? null,
            silentConcealed: inbound.silentConcealedSamples ?? null,
            concealEvents: inbound.concealmentEvents ?? null,
            inserted: inbound.insertedSamplesForDeceleration ?? null,
            removed: inbound.removedSamplesForAcceleration ?? null,
            jbDelay: inbound.jitterBufferDelay ?? null,
            jbEmitted: inbound.jitterBufferEmittedCount ?? null,
            jbTarget: inbound.jitterBufferTargetDelay ?? null,
            samples: inbound.totalSamplesReceived ?? null,
            duration: inbound.totalSamplesDuration ?? null,
          },
        }]
        void api.post('/debug/client-logs', { events }).catch(() => {})
      } catch {
        // ignore
      }
    }

    let stopped = false
    const tick = async () => {
      if (stopped) return
      const tMs = performance.now()
      const live = new Set<string>()

      const local = room.localParticipant
      if (local) {
        live.add(local.identity)
        try {
          const track = local.getTrackPublication(Track.Source.Microphone)?.audioTrack as
            | { getSenderStats?: () => Promise<unknown> }
            | undefined
          if (track?.getSenderStats) record(local.identity, senderSample(await track.getSenderStats(), tMs), readSelfPing())
        } catch {
          // ignore — stats unavailable this tick
        }
      }

      for (const p of room.remoteParticipants.values()) {
        live.add(p.identity)
        if (p.name) nameToIdentityRef.current.set(p.name, p.identity)
        try {
          const meta = p.metadata ? (JSON.parse(p.metadata) as { displayName?: string }) : null
          if (meta?.displayName) nameToIdentityRef.current.set(String(meta.displayName), p.identity)
        } catch {
          // metadata isn't always JSON
        }
        try {
          const track = p.getTrackPublication(Track.Source.Microphone)?.audioTrack as
            | { getReceiverStats?: () => Promise<unknown> }
            | undefined
          if (track?.getReceiverStats) {
            record(p.identity, receiverSample(await track.getReceiverStats(), tMs), null)
            const sc = scoreByIdentityRef.current.get(p.identity)?.score
            if (sc !== undefined && sc < 80) void reportRawInbound(p.identity, track as any)
          }
        } catch {
          // ignore
        }
      }

      // Drop participants who left so stale rings don't linger.
      for (const id of scoreByIdentityRef.current.keys()) {
        if (!live.has(id)) {
          scoreByIdentityRef.current.delete(id)
          prevSampleRef.current.delete(id)
          smoothedRef.current.delete(id)
        }
      }

      scheduleRef.current?.()
    }

    const ensureRing = (indicator: Element): { arc: SVGCircleElement; text: SVGTextElement } => {
      let svg = indicator.querySelector('svg.eb-q-ring') as SVGSVGElement | null
      if (!svg) {
        svg = document.createElementNS(SVG_NS, 'svg')
        svg.classList.add('eb-q-ring')
        svg.setAttribute('viewBox', '0 0 36 36')

        const track = document.createElementNS(SVG_NS, 'circle')
        track.classList.add('eb-q-track')
        track.setAttribute('cx', '18')
        track.setAttribute('cy', '18')
        track.setAttribute('r', String(RING_R))

        const arc = document.createElementNS(SVG_NS, 'circle')
        arc.classList.add('eb-q-arc')
        arc.setAttribute('cx', '18')
        arc.setAttribute('cy', '18')
        arc.setAttribute('r', String(RING_R))
        arc.setAttribute('stroke-dasharray', String(RING_C))
        arc.setAttribute('transform', 'rotate(-90 18 18)')

        const text = document.createElementNS(SVG_NS, 'text')
        text.classList.add('eb-q-text')
        text.setAttribute('x', '18')
        text.setAttribute('y', '18')
        text.setAttribute('text-anchor', 'middle')
        text.setAttribute('dominant-baseline', 'central')

        svg.append(track, arc, text)
        indicator.appendChild(svg)
      }
      return {
        arc: svg.querySelector('.eb-q-arc') as SVGCircleElement,
        text: svg.querySelector('.eb-q-text') as SVGTextElement,
      }
    }

    const renderRings = () => {
      const container = document.querySelector('.call-container')
      if (!container) return
      container.querySelectorAll('.lk-connection-quality').forEach((indicator) => {
        const tile = indicator.closest('.lk-participant-tile, [data-participant]') as HTMLElement | null
        if (!tile) return
        const identity = tileIdentity(tile)
        const entry = identity ? scoreByIdentityRef.current.get(identity) : undefined
        const { arc, text } = ensureRing(indicator)
        indicator.classList.add('eb-q')
        if (!entry) {
          indicator.classList.remove('eb-q-has-value')
          return
        }
        const color = qualityColor(entry.score)
        arc.setAttribute('stroke', color)
        arc.setAttribute('stroke-dashoffset', String(RING_C * (1 - entry.score / 100)))
        text.setAttribute('fill', color)
        if (text.textContent !== String(entry.score)) text.textContent = String(entry.score)
        indicator.setAttribute(
          'title',
          `Качество связи: ${entry.score}/100 — ${qualityLabel(entry.score)}` +
            (entry.ping != null ? ` · пинг ${entry.ping} мс` : ''),
        )
        indicator.classList.add('eb-q-has-value')
      })
    }

    let pending = false
    const schedule = () => {
      if (pending) return
      pending = true
      requestAnimationFrame(() => {
        pending = false
        renderRings()
      })
    }
    scheduleRef.current = schedule

    const mo = new MutationObserver(() => schedule())
    const container = document.querySelector('.call-container')
    if (container) mo.observe(container, { childList: true, subtree: true })

    const interval = window.setInterval(() => void tick(), SAMPLE_INTERVAL_MS)
    void tick()

    return () => {
      stopped = true
      window.clearInterval(interval)
      mo.disconnect()
      if (scheduleRef.current === schedule) scheduleRef.current = null
    }
  }, [room])

  return null
}
