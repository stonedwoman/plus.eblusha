import { useMemo, useState, useEffect } from 'react'

type Props = { name: string; size?: number; id?: string; presence?: 'ONLINE' | 'AWAY' | 'BACKGROUND' | 'OFFLINE' | 'IN_CALL'; avatarUrl?: string | null }

function colorFromId(id: string) {
  let hash = 0
  for (let i = 0; i < id.length; i++) hash = id.charCodeAt(i) + ((hash << 5) - hash)
  const base = Math.abs(hash)
  const hue = 24 + (base % 18) - 9 // keep within dark orange band
  const saturation = 60 + (base % 15)
  const lightness = 30 + (base % 12)
  return `hsl(${hue} ${saturation}% ${lightness}%)`
}

export function Avatar({ name, size = 40, id = name, presence, avatarUrl }: Props) {
  const bg = colorFromId(id)
  const initial = (name || '?').trim().charAt(0).toUpperCase()
  const isEmoji = !!avatarUrl?.startsWith('emoji:')
  const emoji = isEmoji ? avatarUrl!.slice('emoji:'.length) : null
  const [imageError, setImageError] = useState(false)
  const resolvedAvatarUrl = useMemo(() => {
    if (!avatarUrl || isEmoji) return avatarUrl ?? null
    if (avatarUrl.startsWith('data:')) return avatarUrl
    if (typeof window === 'undefined') return avatarUrl
    try {
      // If URL is already absolute (starts with http:// or https://), use it as-is
      if (avatarUrl.startsWith('http://') || avatarUrl.startsWith('https://')) {
        return avatarUrl
      }
      // If URL is relative, resolve it relative to current origin
      const current = window.location
      const url = new URL(avatarUrl, current.origin)
      if (url.host === current.host && url.protocol !== current.protocol) {
        url.protocol = current.protocol
      }
      return url.toString()
    } catch {
      return avatarUrl
    }
  }, [avatarUrl, isEmoji])
  const presenceColor = useMemo(() => {
    if (!presence) return null
    switch (presence) {
      case 'ONLINE':
      case 'IN_CALL':
        return '#22c55e'
      case 'BACKGROUND':
        return '#facc15'
      case 'AWAY':
        return '#f59e0b'
      default:
        return '#9ca3af'
    }
  }, [presence])
  
  // Reset error state when avatarUrl changes
  useEffect(() => {
    setImageError(false)
  }, [avatarUrl])
  
  const showImage = resolvedAvatarUrl && !isEmoji && !imageError
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        background: bg,
        color: '#fff',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontWeight: 700,
        position: 'relative',
      }}
    >
      {showImage ? (
        <img 
          src={resolvedAvatarUrl} 
          alt={name} 
          style={{ width: '100%', height: '100%', borderRadius: '50%', objectFit: 'cover', objectPosition: 'center' }}
          onError={() => setImageError(true)}
        />
      ) : isEmoji ? (
        <span style={{ fontSize: Math.floor(size * 0.6) }}>{emoji}</span>
      ) : (
        initial
      )}
      {presenceColor && (
        <span
          style={{
            position: 'absolute',
            right: -2,
            bottom: -2,
            width: Math.max(8, Math.floor(size * 0.28)),
            height: Math.max(8, Math.floor(size * 0.28)),
            borderRadius: '50%',
            boxShadow: '0 0 0 2px var(--surface-200)',
            background: presenceColor,
          }}
        />
      )}
    </div>
  )
}



