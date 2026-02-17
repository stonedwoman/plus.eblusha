type ReceiptMap = Record<string, Record<string, number>>
type PendingMap = Record<string, Record<string, { lastSentAt: number; attempts: number; lastMsgId?: string }>>

const KEY = 'eb_secret_keyshare_state_v1'
const MAX_AGE_MS = 24 * 60 * 60_000

type State = {
  receipts: ReceiptMap
  pending: PendingMap
}

function load(): State {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return { receipts: {}, pending: {} }
    const parsed = JSON.parse(raw) as any
    const receipts = parsed?.receipts && typeof parsed.receipts === 'object' ? parsed.receipts : {}
    const pending = parsed?.pending && typeof parsed.pending === 'object' ? parsed.pending : {}
    return { receipts, pending }
  } catch {
    return { receipts: {}, pending: {} }
  }
}

function save(state: State) {
  try {
    localStorage.setItem(KEY, JSON.stringify(state))
  } catch {}
}

function cleanup(state: State) {
  const now = Date.now()
  for (const [threadId, byDev] of Object.entries(state.receipts || {})) {
    if (!byDev || typeof byDev !== 'object') {
      delete (state.receipts as any)[threadId]
      continue
    }
    for (const [deviceId, at] of Object.entries(byDev)) {
      if (typeof at !== 'number' || now - at > MAX_AGE_MS) delete (byDev as any)[deviceId]
    }
    if (Object.keys(byDev).length === 0) delete (state.receipts as any)[threadId]
  }
  for (const [threadId, byDev] of Object.entries(state.pending || {})) {
    if (!byDev || typeof byDev !== 'object') {
      delete (state.pending as any)[threadId]
      continue
    }
    for (const [deviceId, rec] of Object.entries(byDev as any)) {
      const recAny = rec as { lastSentAt?: number } | null
      const last = typeof recAny?.lastSentAt === 'number' ? recAny.lastSentAt : 0
      if (!last || now - last > MAX_AGE_MS) delete (byDev as any)[deviceId]
    }
    if (Object.keys(byDev).length === 0) delete (state.pending as any)[threadId]
  }
}

export function markKeyReceipt(threadId: string, fromDeviceId: string, at?: number) {
  const t = String(threadId ?? '').trim()
  const d = String(fromDeviceId ?? '').trim()
  if (!t || !d) return
  const state = load()
  cleanup(state)
  state.receipts[t] = state.receipts[t] || {}
  state.receipts[t]![d] = typeof at === 'number' ? at : Date.now()
  // Once a device has receipt, clear pending tracking for it.
  if (state.pending[t]) delete state.pending[t]![d]
  save(state)
}

export function hasKeyReceipt(threadId: string, deviceId: string): boolean {
  const t = String(threadId ?? '').trim()
  const d = String(deviceId ?? '').trim()
  if (!t || !d) return false
  const state = load()
  const v = state.receipts?.[t]?.[d]
  return typeof v === 'number' && Date.now() - v < MAX_AGE_MS
}

export function getReceiptDeviceIds(threadId: string): string[] {
  const t = String(threadId ?? '').trim()
  if (!t) return []
  const state = load()
  cleanup(state)
  const byDev = state.receipts?.[t]
  if (!byDev || typeof byDev !== 'object') return []
  return Object.keys(byDev)
    .map((d) => String(d ?? '').trim())
    .filter(Boolean)
}

export function markKeyShareSent(threadId: string, toDeviceId: string, msgId?: string) {
  const t = String(threadId ?? '').trim()
  const d = String(toDeviceId ?? '').trim()
  if (!t || !d) return
  const state = load()
  cleanup(state)
  state.pending[t] = state.pending[t] || {}
  const prev = state.pending[t]![d]
  state.pending[t]![d] = {
    lastSentAt: Date.now(),
    attempts: (prev?.attempts ?? 0) + 1,
    ...(msgId ? { lastMsgId: String(msgId) } : {}),
  }
  save(state)
}

export function getPendingAttempts(threadId: string, deviceId: string): number {
  const t = String(threadId ?? '').trim()
  const d = String(deviceId ?? '').trim()
  if (!t || !d) return 0
  const state = load()
  const a = state.pending?.[t]?.[d]?.attempts
  return typeof a === 'number' ? a : 0
}

export function filterUnackedTargets(threadId: string, deviceIds: string[]): string[] {
  const t = String(threadId ?? '').trim()
  if (!t) return []
  return (deviceIds || []).filter((id) => {
    const d = String(id ?? '').trim()
    if (!d) return false
    return !hasKeyReceipt(t, d)
  })
}

