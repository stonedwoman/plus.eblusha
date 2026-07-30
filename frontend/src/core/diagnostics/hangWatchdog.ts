import { api } from '../api'
import { useAppStore } from '../../domain/store/appStore'

/**
 * Hang watchdog — diagnostics for the "UI freezes / very slow after restoring the window" reports
 * (RESULT_CODE_HUNG and long main-thread stalls), especially after a long backgrounded session.
 *
 * Detectors (all report to POST /api/debug/client-logs, tag "hangWatchdog"; per-kind throttled):
 *   - long-animation-frame (LoAF) — the money shot: for any frame blocked >3s it reports the actual
 *     SCRIPTS that ran (sourceFunctionName + sourceURL + char position + duration + invoker). Names the
 *     culprit function, no server header required (unlike JS Self-Profiling, which CF/Caddy strip here).
 *   - longtask — sums blocking time in 5s windows; reports count + max single task + coarse attribution.
 *     Reliable arbiter of "real block" (fires) vs "throttle artifact" (does not).
 *   - main-thread heartbeat — 1s interval; a large gap while VISIBLE is annotated with how many longtasks
 *     occurred during the gap, so a throttle artifact (gap, zero longtasks) is distinguishable from a real
 *     block (gap + longtask activity).
 *   - worker dead-man's-switch — a Blob worker fires if the main thread stops pinging >6s while visible;
 *     the only detector that survives a TRUE synchronous freeze.
 *
 * Always on (rare + throttled). Kill switch: localStorage.setItem('eb_hang_watch','0').
 * Server ingestion gated by DEBUG_CLIENT_LOGS; if disabled the POST 404s → silent no-op.
 */

let started = false

function killed(): boolean {
  try {
    return typeof window === 'undefined' || window.localStorage.getItem('eb_hang_watch') === '0'
  } catch {
    return false
  }
}

function overlayCount(): number | null {
  try { return document.querySelectorAll('.call-container').length } catch { return null }
}

function context() {
  let sinceCallEndedMs: number | null = null
  try {
    const t = (window as any).__ebLastCallEndedAt as number | undefined
    if (typeof t === 'number') sinceCallEndedMs = Date.now() - t
  } catch {}
  let heapMb: number | undefined
  try {
    const m = (performance as any).memory
    if (m && typeof m.usedJSHeapSize === 'number') heapMb = Math.round(m.usedJSHeapSize / 1e6)
  } catch {}
  return {
    route: (() => { try { return window.location.pathname } catch { return '' } })(),
    sinceCallEndedMs,
    heapMb,
    callOverlays: overlayCount(),
    ua: (() => { try { return navigator.userAgent.slice(0, 80) } catch { return '' } })(),
  }
}

const lastReportByKind: Record<string, number> = {}
function report(kind: string, data: Record<string, unknown>) {
  const now = Date.now()
  if (now - (lastReportByKind[kind] || 0) < 20_000) return // throttle PER KIND (not globally)
  lastReportByKind[kind] = now
  const events = [{ ts: now, level: 'error' as const, tag: 'hangWatchdog', kind, rootCause: 'UI_HANG', data: { kind, ...data, ...context() } }]
  api.post('/debug/client-logs', { events }).catch(() => {})
}

// Rolling record of recent long tasks so the heartbeat can tell a real stall from a throttle gap.
type LT = { t: number; dur: number }
const recentLongtasks: LT[] = []

function apiOrigin(): string {
  try {
    const base = String((api as any)?.defaults?.baseURL || '/api').replace(/\/$/, '')
    if (/^https?:\/\//i.test(base)) return base
    return window.location.origin + (base.startsWith('/') ? base : '/' + base)
  } catch {
    return window.location.origin + '/api'
  }
}

const WORKER_SRC = `
let last = null; let alarmed = false;
self.onmessage = function (e) { const m = e.data; if (m && m.type === 'ping') { last = m; alarmed = false; } };
setInterval(function () {
  if (!last || alarmed || !last.visible || !last.endpoint || !last.token) return;
  const gap = Date.now() - last.t;
  if (gap > 6000) {
    alarmed = true;
    try {
      fetch(last.endpoint, { method: 'POST', keepalive: true,
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + last.token },
        body: JSON.stringify({ events: [{ ts: Date.now(), level: 'error', tag: 'hangWatchdog', kind: 'main-thread-dead',
          rootCause: 'UI_HANG', data: { gapMs: gap, route: last.route, sinceCallEndedMs: last.sinceCallEndedMs, heapMb: last.heapMb } }] })
      }).catch(function () {});
    } catch (err) {}
  }
}, 2000);
`

function startWorkerDeadMansSwitch() {
  try {
    const blob = new Blob([WORKER_SRC], { type: 'application/javascript' })
    const worker = new Worker(URL.createObjectURL(blob))
    const endpoint = apiOrigin() + '/debug/client-logs'
    return () => {
      const c = context()
      try {
        worker.postMessage({
          type: 'ping',
          t: Date.now(),
          visible: (() => { try { return document.visibilityState === 'visible' } catch { return true } })(),
          endpoint,
          token: (() => { try { return useAppStore.getState().session?.accessToken || '' } catch { return '' } })(),
          route: c.route,
          sinceCallEndedMs: c.sinceCallEndedMs,
          heapMb: c.heapMb,
        })
      } catch {}
    }
  } catch {
    return () => {}
  }
}

export function startHangWatchdog() {
  if (started || typeof window === 'undefined' || killed()) return
  started = true

  const pingWorker = startWorkerDeadMansSwitch()

  // (1) Long Animation Frames — names the actual culprit scripts. Chrome 123+.
  try {
    const supported = (PerformanceObserver as any).supportedEntryTypes || []
    if (supported.indexOf('long-animation-frame') !== -1) {
      const lo = new PerformanceObserver((list) => {
        for (const e of list.getEntries() as any[]) {
          if (!e || e.duration < 3000) continue
          let visible = true
          try { visible = document.visibilityState === 'visible' } catch {}
          if (!visible) continue
          const allScripts = (e.scripts || []) as any[]
          // ВАЖНО: раньше в отчёт шли только 6 САМЫХ ДОЛГИХ скриптов, и по ним ошибочно
          // считали «сумму» — из-за чего казалось, что время ушло мимо JS. Теперь пишем
          // и полное количество, и суммарную длительность, и границы фаз кадра, чтобы
          // однозначно делить время на «скрипты» и «стили+раскладка».
          const sumScriptMs = Math.round(allScripts.reduce((s, x) => s + (x.duration || 0), 0))
          const scripts = allScripts
            .map((s: any) => ({
              fn: String(s.sourceFunctionName || s.invoker || '').slice(0, 90),
              url: (String(s.sourceURL || '').split('/').pop() || '').slice(0, 70),
              pos: s.sourceCharPosition,
              durMs: Math.round(s.duration || 0),
              invoker: String(s.invoker || '').slice(0, 90),
              invokerType: String(s.invokerType || '').slice(0, 30),
            }))
            .sort((a: any, b: any) => b.durMs - a.durMs)
            .slice(0, 6)
          // Фазы кадра (LoAF): styleAndLayoutStart - renderStart = чистое время стилей/раскладки.
          const renderStart = Math.round((e as any).renderStart || 0)
          const styleAndLayoutStart = Math.round((e as any).styleAndLayoutStart || 0)
          const startTime = Math.round(e.startTime || 0)
          const styleAndLayoutMs =
            renderStart && styleAndLayoutStart ? Math.round(e.startTime + e.duration - (e as any).styleAndLayoutStart) : null
          // Сколько оверлеев звонка живо одновременно: >1 означает утечку (не завершённый звонок).
          let callContainers: number | null = null
          let domNodes: number | null = null
          try { callContainers = document.querySelectorAll('.call-container').length } catch {}
          try { domNodes = document.getElementsByTagName('*').length } catch {}
          report('loaf', {
            durationMs: Math.round(e.duration),
            blockingMs: Math.round(e.blockingDuration || 0),
            scriptCount: allScripts.length,
            sumScriptMs,
            renderDelayMs: renderStart ? Math.round((e as any).renderStart - e.startTime) : null,
            styleAndLayoutMs,
            startTime,
            callContainers,
            domNodes,
            scripts,
          })
        }
      })
      lo.observe({ entryTypes: ['long-animation-frame'] } as any)
    }
  } catch {}

  // (2) Long tasks — reliable duration + coarse attribution; also feeds recentLongtasks.
  try {
    if (typeof PerformanceObserver !== 'undefined') {
      let windowStart = performance.now()
      let winBlocked = 0
      let winCount = 0
      let winMax = 0
      let winMaxName = ''
      let winAttr: Record<string, number> = {}
      const po = new PerformanceObserver((list) => {
        const now = performance.now()
        for (const e of list.getEntries()) {
          const dur = e.duration
          const a = (e as any).attribution && (e as any).attribution[0]
          const attr = (a && a.containerType) || 'window'
          recentLongtasks.push({ t: now, dur })
          winBlocked += dur
          winCount++
          if (dur > winMax) { winMax = dur; winMaxName = (a && (a.containerName || a.containerSrc)) || attr }
          winAttr[attr] = (winAttr[attr] || 0) + 1
        }
        const cutoff = now - 30_000
        while (recentLongtasks.length && recentLongtasks[0].t < cutoff) recentLongtasks.shift()
        if (now - windowStart >= 5000) {
          let visible = true
          try { visible = document.visibilityState === 'visible' } catch {}
          if (visible && winBlocked > 3000) {
            report('longtask-storm', {
              blockedMs: Math.round(winBlocked),
              count: winCount,
              maxTaskMs: Math.round(winMax),
              maxTaskName: String(winMaxName).slice(0, 80),
              windowMs: Math.round(now - windowStart),
              attribution: winAttr,
            })
          }
          windowStart = now; winBlocked = 0; winCount = 0; winMax = 0; winMaxName = ''; winAttr = {}
        }
      })
      po.observe({ entryTypes: ['longtask'] })
    }
  } catch {}

  // (3) Heartbeat + worker ping (same 1s tick). Annotates a big gap with longtask activity so a
  //     throttle artifact (gap, zero longtasks) is distinguishable from a real block.
  let last = performance.now()
  window.setInterval(() => {
    const now = performance.now()
    const gap = now - last - 1000
    const prev = last
    last = now
    pingWorker()
    let visible = true
    try { visible = document.visibilityState === 'visible' } catch {}
    if (visible && gap > 3000) {
      const inGap = recentLongtasks.filter((l) => l.t > prev && l.t <= now)
      const ltMs = inGap.reduce((s, l) => s + l.dur, 0)
      // Сообщаем ТОЛЬКО если в разрыве были длинные задачи. Разрыв без них — это
      // троттлинг фоновой вкладки (интервал 1с усыпляется до ~1/мин), а не подвисание:
      // без этого условия каждая фоновая вкладка слала бы «ошибку» раз в минуту.
      if (inGap.length === 0) return
      report('main-stall', {
        gapMs: Math.round(gap),
        longtasksInGap: inGap.length,
        longtaskMsInGap: Math.round(ltMs),
      })
    }
  }, 1000)
}
