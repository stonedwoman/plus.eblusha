type AttemptRecord = { count: number; firstAt: number; lastAt: number; rootCause?: string; prekeyId?: string }

const KEY = 'eb_secret_inbox_attempts_v1'

export function getAttemptRecord(msgId: string): AttemptRecord | null {
  const id = String(msgId ?? '').trim()
  if (!id) return null
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Record<string, AttemptRecord>
    const rec = parsed?.[id]
    if (!rec || typeof rec.count !== 'number') return null
    return rec
  } catch {
    return null
  }
}

export function getAttemptCount(msgId: string): number {
  return getAttemptRecord(msgId)?.count ?? 0
}

