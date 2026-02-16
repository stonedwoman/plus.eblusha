import { api } from '../../utils/api'

export type ClientLogLevel = 'debug' | 'info' | 'warn' | 'error'

function secretDebugEnabled(): boolean {
  try {
    if (typeof window === 'undefined') return false
    const q = String(window.location?.search ?? '')
    if (q.includes('SECRET_DEBUG=1')) return true
    return window.localStorage.getItem('eb_secret_debug') === '1'
  } catch {
    return false
  }
}

type ClientLogEvent = {
  ts: number
  level: ClientLogLevel
  tag: string
  threadId?: string
  msgId?: string
  kind?: string
  rootCause?: string
  data?: Record<string, unknown>
}

const queue: ClientLogEvent[] = []
let flushTimer: number | null = null
let flushing = false

function scheduleFlush() {
  if (flushTimer != null) return
  flushTimer = window.setTimeout(() => {
    flushTimer = null
    void flush().catch(() => {})
  }, 1200)
}

async function flush() {
  if (flushing) return
  if (!secretDebugEnabled()) return
  if (queue.length === 0) return
  flushing = true
  try {
    const batch = queue.splice(0, 100)
    await api.post('/debug/client-logs', { events: batch })
  } finally {
    flushing = false
    if (queue.length) scheduleFlush()
  }
}

export function clientLog(
  tag: string,
  level: ClientLogLevel,
  message: string,
  meta?: Omit<ClientLogEvent, 'ts' | 'level' | 'tag'> & { data?: Record<string, unknown> },
) {
  if (!secretDebugEnabled()) return
  try {
    // Console stays (for local debugging)
    // eslint-disable-next-line no-console
    ;(level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(`[${tag}] ${message}`, meta ?? {})
  } catch {}

  const safe: ClientLogEvent = {
    ts: Date.now(),
    level,
    tag: String(tag ?? '').slice(0, 80),
    ...(meta?.threadId ? { threadId: String(meta.threadId).slice(0, 64) } : {}),
    ...(meta?.msgId ? { msgId: String(meta.msgId).slice(0, 80) } : {}),
    ...(meta?.kind ? { kind: String(meta.kind).slice(0, 40) } : {}),
    ...(meta?.rootCause ? { rootCause: String(meta.rootCause).slice(0, 60) } : {}),
    ...(meta?.data ? { data: meta.data } : {}),
  }
  queue.push(safe)
  if (queue.length >= 20) void flush().catch(() => {})
  else scheduleFlush()
}

