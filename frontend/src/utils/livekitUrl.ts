export function normalizeLivekitServerUrl(value: string | null | undefined): string | null {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (!raw) return null

  const pageHref = typeof window !== 'undefined' ? window.location.href : 'http://localhost/'
  const pageSecure = typeof window !== 'undefined' && window.location.protocol === 'https:'

  try {
    const url = new URL(raw, pageHref)
    const protocol = url.protocol.toLowerCase()

    if (protocol === 'http:' || protocol === 'ws:') {
      url.protocol = pageSecure ? 'wss:' : 'ws:'
    } else if (protocol === 'https:' || protocol === 'wss:') {
      url.protocol = 'wss:'
    }

    return url.toString()
  } catch {
    if (pageSecure && raw.startsWith('ws://')) {
      return `wss://${raw.slice(5)}`
    }
    return raw
  }
}
