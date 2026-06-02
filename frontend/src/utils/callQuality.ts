// Connection-quality index for calls.
//
// We fold several LiveKit/WebRTC audio stats into a single 0..100 score per
// participant and render it as a small ring. The score is deliberately
// "broader than ping": packet loss and audio concealment (the glitches a user
// actually hears) dominate, jitter contributes, and raw latency is NOT part of
// the headline score (ping is shown separately, on hover).
//
// Every input is sampled locally, so no cross-client exchange is needed:
//   - our own uplink   -> LocalAudioTrack.getSenderStats()
//   - each remote peer -> RemoteAudioTrack.getReceiverStats()  (our downlink)

export const AUDIO_SAMPLE_RATE = 48000

// Penalty weights — points subtracted from 100. Tunable by feel.
export const QUALITY_WEIGHTS = {
  lossK: 8, // per 1% packet loss
  lossCap: 55,
  concealK: 7, // per 1% concealed (glitch) audio
  concealCap: 40,
  jitterKneeMs: 20, // jitter below this is free
  jitterK: 0.5, // per ms above the knee
  jitterCap: 20,
} as const

// Smoothing so the displayed number doesn't twitch between 1–2s samples.
export const QUALITY_EMA_ALPHA = 0.4

export type QualitySample = {
  tMs: number
  packetsLost: number
  packetsTotal: number // packetsReceived (remote) or packetsSent (self)
  jitterMs: number
  // Audio-receiver only; 0 for our own uplink (sender stats don't expose these).
  concealedSamples: number
  silentConcealedSamples: number
  samplesDurationSec: number
}

export type QualityMetrics = {
  lossPct: number
  jitterMs: number
  concealPct: number
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

/** Normalize LiveKit AudioSenderStats (our uplink, as reported by the remote over RTCP). */
export function senderSample(stats: unknown, tMs: number): QualitySample {
  const s = stats as Record<string, unknown> | null | undefined
  return {
    tMs,
    packetsLost: num(s?.packetsLost),
    packetsTotal: num(s?.packetsSent),
    jitterMs: num(s?.jitter) * 1000,
    concealedSamples: 0,
    silentConcealedSamples: 0,
    samplesDurationSec: 0,
  }
}

/** Normalize LiveKit AudioReceiverStats (our downlink from one remote peer). */
export function receiverSample(stats: unknown, tMs: number): QualitySample {
  const s = stats as Record<string, unknown> | null | undefined
  return {
    tMs,
    packetsLost: num(s?.packetsLost),
    packetsTotal: num(s?.packetsReceived),
    jitterMs: num(s?.jitter) * 1000,
    concealedSamples: num(s?.concealedSamples),
    silentConcealedSamples: num(s?.silentConcealedSamples),
    samplesDurationSec: num(s?.totalSamplesDuration),
  }
}

/**
 * Compute interval metrics from two cumulative samples. Returns null when the
 * samples can't be compared — no time delta, or a counter reset / track restart
 * produced a negative delta (we skip that interval rather than spike).
 */
export function metricsFromSamples(prev: QualitySample, cur: QualitySample): QualityMetrics | null {
  const dt = (cur.tMs - prev.tMs) / 1000
  if (!(dt > 0)) return null

  const dLost = cur.packetsLost - prev.packetsLost
  const dPkts = cur.packetsTotal - prev.packetsTotal
  if (dLost < 0 || dPkts < 0) return null // counter reset / renegotiation
  const denom = dLost + dPkts
  const lossPct = denom > 0 ? (dLost / denom) * 100 : 0

  // Concealment = synthesized audio that papered over losses. Exclude silent
  // concealment (DTX / comfort noise) — that's normal, not an audible glitch.
  const dConceal =
    cur.concealedSamples - cur.silentConcealedSamples - (prev.concealedSamples - prev.silentConcealedSamples)
  const dDur = cur.samplesDurationSec - prev.samplesDurationSec
  const expectedSamples = AUDIO_SAMPLE_RATE * (dDur > 0 ? dDur : dt)
  const concealPct = expectedSamples > 0 ? clamp((Math.max(0, dConceal) / expectedSamples) * 100, 0, 100) : 0

  // jitter is an instantaneous, browser-smoothed gauge — take the latest.
  return { lossPct, jitterMs: cur.jitterMs, concealPct }
}

/** Map interval metrics to a 0..100 quality score (higher = better). */
export function scoreFromMetrics(m: QualityMetrics): number {
  const w = QUALITY_WEIGHTS
  const lossPenalty = Math.min(w.lossCap, Math.max(0, m.lossPct) * w.lossK)
  const concealPenalty = Math.min(w.concealCap, Math.max(0, m.concealPct) * w.concealK)
  const jitterPenalty = Math.min(w.jitterCap, Math.max(0, m.jitterMs - w.jitterKneeMs) * w.jitterK)
  return clamp(Math.round(100 - lossPenalty - concealPenalty - jitterPenalty), 0, 100)
}

// Discrete 10-step ramp: red (0) -> yellow (~50) -> green (100). Not a gradient.
export const QUALITY_COLORS = [
  '#e5484d', // 0–9    red
  '#ec5a3a', // 10–19  red-orange
  '#f06e2c', // 20–29  orange
  '#f38b21', // 30–39  amber-orange
  '#f0a81b', // 40–49  amber
  '#e8c220', // 50–59  yellow
  '#cdd02b', // 60–69  yellow-green
  '#a3cc3a', // 70–79  lime
  '#6cbf4b', // 80–89  green
  '#33a558', // 90–100 strong green
] as const

export function qualityColor(score: number): string {
  const bucket = clamp(Math.floor(clamp(score, 0, 100) / 10), 0, QUALITY_COLORS.length - 1)
  return QUALITY_COLORS[bucket]
}

export function qualityLabel(score: number): string {
  if (score >= 80) return 'отличная связь'
  if (score >= 60) return 'хорошая связь'
  if (score >= 40) return 'средняя связь'
  if (score >= 20) return 'слабая связь'
  return 'очень слабая связь'
}

/** Exponential moving average; passes the first value through unchanged. */
export function emaScore(prev: number | null, next: number): number {
  if (prev === null || !Number.isFinite(prev)) return next
  return prev + QUALITY_EMA_ALPHA * (next - prev)
}
