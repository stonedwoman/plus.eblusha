import { useMemo, useState, useEffect, useRef } from 'react'
import { convertToProxyUrl } from '../../utils/media'
import { Gamepad2 } from 'lucide-react'

type Props = {
  name: string
  size?: number
  id?: string
  presence?: 'ONLINE' | 'AWAY' | 'BACKGROUND' | 'OFFLINE' | 'IN_CALL' | 'PLAYING'
  inCall?: boolean
  avatarUrl?: string | null
}

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

export function Avatar({ name, size = 40, id = name, presence, inCall, avatarUrl }: Props) {
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

  const avatarIdentityUrl = useMemo(() => {
    // We only want to re-load the avatar image when the underlying identity changes.
    // In practice, avatarUrl can be a presigned URL whose query params change often,
    // which causes flicker if we treat it as a new image each time.
    if (!resolvedAvatarUrl || isEmoji) return resolvedAvatarUrl ?? null
    try {
      const u = new URL(
        resolvedAvatarUrl,
        typeof window !== 'undefined' ? window.location.origin : 'http://localhost',
      )
      // For our proxy endpoint, treat only the pathname as identity (ignore volatile query params).
      if (u.pathname.startsWith('/api/files/')) return u.pathname
      // For other URLs, keep full string.
      return resolvedAvatarUrl
    } catch {
      // Best-effort: strip query/hash for proxy path.
      if (resolvedAvatarUrl.startsWith('/api/files/')) return resolvedAvatarUrl.split('?')[0].split('#')[0]
      return resolvedAvatarUrl
    }
  }, [resolvedAvatarUrl, isEmoji])
  
  const presenceColor = useMemo(() => {
    if (!presence) return null
    switch (presence) {
      case 'ONLINE':
        return '#22c55e'
      case 'BACKGROUND':
        return '#facc15'
      case 'AWAY':
        return '#f59e0b'
      case 'PLAYING':
        return null
      default:
        return '#9ca3af'
    }
  }, [presence])
  
  // Reset error state and retry count when avatar identity changes (not on every volatile URL change)
  useEffect(() => {
    setImageError(false)
    setRetryCount(0)
    setCurrentImageUrl(null)
    if (retryTimeoutRef.current) {
      clearTimeout(retryTimeoutRef.current)
      retryTimeoutRef.current = null
    }
  }, [avatarIdentityUrl])
  
  // Update current image URL when resolved URL changes
  useEffect(() => {
    if (resolvedAvatarUrl && !isEmoji) {
      // Avoid reloading when only volatile query params changed for the same identity.
      if (!currentImageUrl) {
        setCurrentImageUrl(resolvedAvatarUrl)
        return
      }
      const currentIdentity = (() => {
        try {
          const u = new URL(
            currentImageUrl,
            typeof window !== 'undefined' ? window.location.origin : 'http://localhost',
          )
          if (u.pathname.startsWith('/api/files/')) return u.pathname
          return currentImageUrl
        } catch {
          if (currentImageUrl.startsWith('/api/files/')) return currentImageUrl.split('?')[0].split('#')[0]
          return currentImageUrl
        }
      })()
      if (avatarIdentityUrl && currentIdentity !== avatarIdentityUrl) {
        setCurrentImageUrl(resolvedAvatarUrl)
      }
    }
  }, [resolvedAvatarUrl, isEmoji, avatarIdentityUrl, currentImageUrl])
  
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
            // resolvedAvatarUrl can be a relative proxy URL like "/api/files/...".
            // new URL(relative) throws, so always provide a base in the browser.
            const url = new URL(
              resolvedAvatarUrl,
              typeof window !== 'undefined' ? window.location.origin : undefined,
            )
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
      {(() => {
        const showPlaying = presence === 'PLAYING'
        const showInCall = !!inCall || presence === 'IN_CALL'
        const dotSize = Math.max(8, Math.floor(size * 0.28))
        if (!showPlaying && !showInCall && !presenceColor) return null

        // If user is playing, render a gamepad badge.
        // If also in call, keep badge background as usual but make the gamepad red
        // (so we don't change the dot background logic and still signal both states).
        if (showPlaying) {
          const bg = 'var(--surface-100)'
          const fg = showInCall ? '#ef4444' : '#22c55e'
          const title = showInCall ? 'Играет и в звонке' : 'Играет'
          return (
            <span
              title={title}
              style={{
                position: 'absolute',
                right: -2,
                bottom: -2,
                width: 17,
                height: 17,
                borderRadius: 999,
                boxShadow: '0 0 0 2px var(--surface-200)',
                background: bg,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Gamepad2 width={17} height={17} color={fg} />
            </span>
          )
        }

        // In-call only badge (red dot)
        if (showInCall) {
          return (
            <span
              title="В звонке"
              style={{
                position: 'absolute',
                right: -2,
                bottom: -2,
                width: dotSize,
                height: dotSize,
                borderRadius: '50%',
                boxShadow: '0 0 0 2px var(--surface-200)',
                background: '#ef4444',
              }}
            />
          )
        }

        return (
          <span
            style={{
              position: 'absolute',
              right: -2,
              bottom: -2,
              width: dotSize,
              height: dotSize,
              borderRadius: '50%',
              boxShadow: '0 0 0 2px var(--surface-200)',
              background: presenceColor ?? undefined,
            }}
          />
        )
      })()}
    </div>
  )
}



