/** Forward bundle detection for consecutive forwarded messages in the chat timeline. */

const MULTI_FWD_MAX_SPAN_MS = 7 * 24 * 60 * 60 * 1000
const MULTI_FWD_GAP_MS = 25_000

function parseMessageMetadata(msg: any): Record<string, unknown> | null {
  const md = msg?.metadata
  if (md == null) return null
  if (typeof md === 'string') {
    try {
      const p = JSON.parse(md) as unknown
      return p && typeof p === 'object' && !Array.isArray(p) ? (p as Record<string, unknown>) : null
    } catch {
      return null
    }
  }
  if (typeof md === 'object' && !Array.isArray(md)) return md as Record<string, unknown>
  return null
}

function normalizeForwardFromRecord(rawFf: unknown): Record<string, unknown> | null {
  if (rawFf == null) return null
  if (typeof rawFf === 'string') {
    try {
      const p = JSON.parse(rawFf) as unknown
      return p && typeof p === 'object' ? (p as Record<string, unknown>) : null
    } catch {
      return null
    }
  }
  return typeof rawFf === 'object' ? (rawFf as Record<string, unknown>) : null
}

function directChatPeerDisplayForForwardHeader(msg: any): string {
  const md = parseMessageMetadata(msg)
  if (!md) return ''
  const root =
    (typeof md.sourceDmPeerName === 'string' && String(md.sourceDmPeerName).trim()) ||
    (typeof md.directChatPeerName === 'string' && String(md.directChatPeerName).trim()) ||
    ''
  if (root) return root
  const ff = normalizeForwardFromRecord(md.forwardFrom)
  if (ff) {
    const camel =
      typeof (ff as any).directChatPeerName === 'string' ? String((ff as any).directChatPeerName).trim() : ''
    if (camel) return camel
    const snake =
      typeof (ff as any).direct_chat_peer_name === 'string'
        ? String((ff as any).direct_chat_peer_name).trim()
        : ''
    if (snake) return snake
    const isGroupSource = !!(ff as any).isGroupSource
    if (!isGroupSource) {
      const an = typeof (ff as any).authorName === 'string' ? String((ff as any).authorName).trim() : ''
      if (an) return an
    }
  }
  return ''
}

function forwardFromAuthorKeyForBundle(m: any): string | null {
  const ff = normalizeForwardFromRecord(parseMessageMetadata(m)?.forwardFrom)
  if (!ff) return null
  const name = typeof ff.authorName === 'string' ? String(ff.authorName).trim() : ''
  if (!name) return null
  const title = typeof ff.sourceChatTitle === 'string' ? String(ff.sourceChatTitle).trim() : ''
  return `${name}|${title}`
}

export function hasForwardFromMeta(m: any): boolean {
  return forwardFromAuthorKeyForBundle(m) != null
}

function forwardSourceFingerprintForBundle(m: any): string | null {
  if (!hasForwardFromMeta(m)) return null
  const ff = normalizeForwardFromRecord(parseMessageMetadata(m)?.forwardFrom)
  if (!ff) return null
  const isGroup = !!(ff as any).isGroupSource
  const titleRaw =
    typeof (ff as any).sourceChatTitle === 'string'
      ? String((ff as any).sourceChatTitle).trim()
      : ''
  if (isGroup) {
    return `grp:${titleRaw || '«без названия»'}`
  }
  const peer = directChatPeerDisplayForForwardHeader(m)
  return `dm:p:${peer ? peer : '¦'}`
}

export function computeMultiSourceForwardBundles(fullList: any[]): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = []
  let i = 0
  const n = fullList.length
  while (i < n) {
    const m = fullList[i]
    if (m?.deletedAt || m?.type === 'SYSTEM' || !hasForwardFromMeta(m)) {
      i++
      continue
    }
    const forwarder = m.senderId
    const t0 = new Date(m.createdAt || 0).getTime()
    const fp0 = forwardSourceFingerprintForBundle(m)
    if (!fp0) {
      i++
      continue
    }
    let j = i
    while (j + 1 < n) {
      const next = fullList[j + 1]
      if (next?.deletedAt || next?.type === 'SYSTEM') break
      if (!hasForwardFromMeta(next)) break
      if (forwardSourceFingerprintForBundle(next) !== fp0) break
      if (next.senderId !== forwarder) break
      const tNext = new Date(next.createdAt || 0).getTime()
      if (tNext - t0 > MULTI_FWD_MAX_SPAN_MS) break
      const cur = fullList[j]
      if (tNext - new Date(cur.createdAt || 0).getTime() > MULTI_FWD_GAP_MS) break
      j++
    }
    out.push({ start: i, end: j })
    i = j + 1
  }
  return out
}
