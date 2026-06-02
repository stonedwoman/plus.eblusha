import { describe, expect, it } from 'vitest'
import {
  AUDIO_SAMPLE_RATE,
  emaScore,
  metricsFromSamples,
  QUALITY_COLORS,
  qualityColor,
  receiverSample,
  scoreFromMetrics,
  senderSample,
} from './callQuality'

describe('scoreFromMetrics', () => {
  it('perfect metrics → 100', () => {
    expect(scoreFromMetrics({ lossPct: 0, jitterMs: 0, concealPct: 0 })).toBe(100)
  })

  it('jitter under the knee is free', () => {
    expect(scoreFromMetrics({ lossPct: 0, jitterMs: 15, concealPct: 0 })).toBe(100)
  })

  it('packet loss lowers the score monotonically', () => {
    const a = scoreFromMetrics({ lossPct: 1, jitterMs: 0, concealPct: 0 })
    const b = scoreFromMetrics({ lossPct: 3, jitterMs: 0, concealPct: 0 })
    const c = scoreFromMetrics({ lossPct: 6, jitterMs: 0, concealPct: 0 })
    expect(a).toBeLessThan(100)
    expect(a).toBeGreaterThan(b)
    expect(b).toBeGreaterThan(c)
  })

  it('concealment penalizes audible glitches', () => {
    expect(scoreFromMetrics({ lossPct: 0, jitterMs: 0, concealPct: 5 })).toBeLessThan(100)
  })

  it('clamps to 0 under severe degradation', () => {
    expect(scoreFromMetrics({ lossPct: 100, jitterMs: 500, concealPct: 100 })).toBe(0)
  })
})

describe('metricsFromSamples', () => {
  it('returns null without a time delta', () => {
    const s = senderSample({ packetsSent: 100, packetsLost: 0 }, 1000)
    expect(metricsFromSamples(s, { ...s, tMs: 1000 })).toBeNull()
  })

  it('returns null on a counter reset (negative delta)', () => {
    const prev = senderSample({ packetsSent: 1000, packetsLost: 10 }, 0)
    const cur = senderSample({ packetsSent: 5, packetsLost: 0 }, 1000)
    expect(metricsFromSamples(prev, cur)).toBeNull()
  })

  it('computes loss percentage over the interval', () => {
    const prev = senderSample({ packetsSent: 1000, packetsLost: 0, jitter: 0 }, 0)
    const cur = senderSample({ packetsSent: 1090, packetsLost: 10, jitter: 0.02 }, 1000)
    const m = metricsFromSamples(prev, cur)!
    expect(m.lossPct).toBeCloseTo(10) // 10 lost / (90 delivered + 10 lost)
    expect(m.jitterMs).toBeCloseTo(20)
  })

  it('counts real concealment but ignores silent (DTX) concealment', () => {
    const prev = receiverSample(
      { packetsReceived: 1000, concealedSamples: 0, silentConcealedSamples: 0, totalSamplesDuration: 0 },
      0,
    )
    // 1s of audio; 4800 concealed of which 2400 are silent → 2400 real glitch samples.
    const cur = receiverSample(
      { packetsReceived: 1050, concealedSamples: 4800, silentConcealedSamples: 2400, totalSamplesDuration: 1 },
      1000,
    )
    const m = metricsFromSamples(prev, cur)!
    expect(m.concealPct).toBeCloseTo((2400 / AUDIO_SAMPLE_RATE) * 100, 3) // ~5%
  })
})

describe('qualityColor', () => {
  it('maps extremes and midpoint onto the palette', () => {
    expect(qualityColor(0)).toBe(QUALITY_COLORS[0])
    expect(qualityColor(100)).toBe(QUALITY_COLORS[QUALITY_COLORS.length - 1])
    expect(qualityColor(50)).toBe(QUALITY_COLORS[5])
  })

  it('is non-decreasing along the ramp', () => {
    let prevIdx = -1
    for (let s = 0; s <= 100; s += 5) {
      const idx = (QUALITY_COLORS as readonly string[]).indexOf(qualityColor(s))
      expect(idx).toBeGreaterThanOrEqual(prevIdx)
      prevIdx = idx
    }
  })
})

describe('emaScore', () => {
  it('passes the first value through', () => {
    expect(emaScore(null, 80)).toBe(80)
  })
  it('moves partway toward the new value', () => {
    expect(emaScore(80, 100)).toBeCloseTo(88) // 80 + 0.4 * 20
  })
})
