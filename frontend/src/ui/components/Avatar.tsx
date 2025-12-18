import { useMemo, useState, useEffect, useRef } from 'react'
import { convertToProxyUrl } from '../../utils/media'

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

const MAX_RETRIES = 3
const RETRY_DELAYS = [500, 1500, 3000] // delays in ms for each retry

export function Avatar({ name, size = 40, id = name, presence, avatarUrl }: Props) {
  const bg = colorFromId(id)
  const initial = (name || '?').trim().charAt(0).toUpperCase()
  const isEmoji = !!avatarUrl?.startsWith('emoji:')
  const emoji = isEmoji ? avatarUrl!.slice('emoji:'.length) : null
  const [imageError, setImageError] = useState(false)
  const [retryCount, setRetryCount] = useState(0)
  const [currentImageUrl, setCurrentImageUrl] = useState<string | null>(null)
  const retryTimeoutRef = useRef<number | null>(null)
  
  const resolvedAvatarUrl = useMemo(() => {
    if (!avatarUrl || isEmoji) return avatarUrl ?? null
    if (avatarUrl.startsWith('data:')) return avatarUrl
    if (typeof window === 'undefined') return avatarUrl
    
    // Convert S3 URLs to proxy URLs if needed
    const proxyUrl = convertToProxyUrl(avatarUrl)
    if (proxyUrl && proxyUrl !== avatarUrl) {
      return proxyUrl
    }
    
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
        return '#22c55e'
      case 'IN_CALL':
        // Red to make "in call" clearly distinguishable from regular ONLINE
        return '#ef4444'
      case 'BACKGROUND':
        return '#facc15'
      case 'AWAY':
        return '#f59e0b'
      default:
        return '#9ca3af'
    }
  }, [presence])
  
  // Reset error state and retry count when avatarUrl changes
  useEffect(() => {
    setImageError(false)
    setRetryCount(0)
    setCurrentImageUrl(null)
    if (retryTimeoutRef.current) {
      clearTimeout(retryTimeoutRef.current)
      retryTimeoutRef.current = null
    }
  }, [avatarUrl])
  
  // Update current image URL when resolved URL changes
  useEffect(() => {
    if (resolvedAvatarUrl && !isEmoji) {
      setCurrentImageUrl(resolvedAvatarUrl)
    }
  }, [resolvedAvatarUrl, isEmoji])
  
  const handleImageError = () => {
    if (retryCount < MAX_RETRIES && resolvedAvatarUrl && !isEmoji) {
      const delay = RETRY_DELAYS[retryCount] || RETRY_DELAYS[RETRY_DELAYS.length - 1]
      
      retryTimeoutRef.current = setTimeout(() => {
        try {
          // Add cache-busting parameter to force reload
          // Only add parameters if URL is valid and not a data URL
          if (resolvedAvatarUrl.startsWith('data:')) {
            // For data URLs, just retry with the same URL
            setCurrentImageUrl(resolvedAvatarUrl)
          } else {
            const url = new URL(resolvedAvatarUrl)
            url.searchParams.set('_retry', String(retryCount + 1))
            url.searchParams.set('_t', String(Date.now()))
            setCurrentImageUrl(url.toString())
          }
          setRetryCount(prev => prev + 1)
        } catch (err) {
          // If URL parsing fails, just retry with the same URL
          console.warn('[Avatar] Failed to parse URL for retry:', resolvedAvatarUrl, err)
          setCurrentImageUrl(resolvedAvatarUrl)
          setRetryCount(prev => prev + 1)
        }
      }, delay)
    } else {
      setImageError(true)
    }
  }
  
  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (retryTimeoutRef.current) {
        clearTimeout(retryTimeoutRef.current)
      }
    }
  }, [])
  
  const showImage = currentImageUrl && !isEmoji && !imageError
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
          src={currentImageUrl!} 
          alt={name} 
          style={{ width: '100%', height: '100%', borderRadius: '50%', objectFit: 'cover', objectPosition: 'center' }}
          onError={handleImageError}
          onLoad={() => {
            // Reset retry count on successful load
            if (retryCount > 0) {
              setRetryCount(0)
            }
          }}
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



