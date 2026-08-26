import { useMemo, useState, useEffect, useRef, useLayoutEffect } from 'react'
import { convertToProxyUrl } from '../../utils/media'
import { Gamepad2, Globe, Monitor, Smartphone } from 'lucide-react'
import {
  presenceDeviceTitleRu,
  presenceStatusColor,
  usePresenceDevice,
} from '../../domain/store/presenceDeviceStore'

type Props = {
  name: string
  size?: number
  id?: string
  presence?: 'ONLINE' | 'AWAY' | 'BACKGROUND' | 'OFFLINE' | 'IN_CALL' | 'PLAYING'
  inCall?: boolean
  avatarUrl?: string | null
  /** Opens the user card. stopPropagation is applied so host tiles don't also fire. */
  onClick?: () => void
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

function initialsFromName(name: string): string {
  const s = (name || '').trim()
  if (!s) return '?'
  const parts = s.split(/\s+/).filter(Boolean)
  if (parts.length >= 2) {
    const first = parts[0].charAt(0).toUpperCase()
    const last = parts[parts.length - 1].charAt(0).toUpperCase()
    return first + last
  }
  return s.charAt(0).toUpperCase()
}

export function Avatar({ name, size = 40, id = name, presence, inCall, avatarUrl, onClick }: Props) {
  const bg = colorFromId(id)
  const initial = initialsFromName(name)
  const isEmoji = !!avatarUrl?.startsWith('emoji:')
  const emoji = isEmoji ? avatarUrl!.slice('emoji:'.length) : null
  const [imageError, setImageError] = useState(false)
  // С какого устройства человек в сети (телефон / ПК / браузер). null → показываем точку, как раньше.
  const presenceDevice = usePresenceDevice(id)
  const [retryCount, setRetryCount] = useState(0)
  const [currentImageUrl, setCurrentImageUrl] = useState<string | null>(null)
  const retryTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  
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

  const avatarSrcBase = useMemo(() => {
    // Important: for our proxy endpoint, the query string may come from a presigned URL and
    // can change frequently. The proxy does not need those params to locate the object key,
    // and keeping them prevents browser caching (different URL => cache miss).
    if (!resolvedAvatarUrl || isEmoji) return resolvedAvatarUrl ?? null
    try {
      const u = new URL(
        resolvedAvatarUrl,
        typeof window !== 'undefined' ? window.location.origin : 'http://localhost',
      )
      // For our proxy endpoint, always use only pathname as the stable src.
      if (u.pathname.startsWith('/api/files/')) return u.pathname
      // For other URLs, keep full string (query may be meaningful).
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
    if (retryTimeoutRef.current) {
      clearTimeout(retryTimeoutRef.current)
      retryTimeoutRef.current = null
    }
  }, [avatarSrcBase])

  // Sync image src before paint to avoid placeholder flash on re-mounts.
  useLayoutEffect(() => {
    if (isEmoji) return
    if (!avatarSrcBase) {
      if (currentImageUrl !== null) setCurrentImageUrl(null)
      return
    }
    if (currentImageUrl !== avatarSrcBase) {
      setCurrentImageUrl(avatarSrcBase)
    }
  }, [avatarSrcBase, isEmoji, currentImageUrl])
  
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
              // For proxy urls, base path is enough; we add our retry params ourselves.
              avatarSrcBase || resolvedAvatarUrl,
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
      onClick={onClick ? (e) => { e.stopPropagation(); onClick() } : undefined}
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
        cursor: onClick ? 'pointer' : undefined,
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
        <span style={{ fontSize: Math.floor(size * 0.48) }}>{initial}</span>
      )}
      {(() => {
        const showPlaying = presence === 'PLAYING'
        const showInCall = !!inCall || presence === 'IN_CALL'
        const dotSize = Math.max(8, Math.floor(size * 0.28))
        if (!showPlaying && !showInCall && !presenceColor) return null

        // Плашка значка растёт вместе с аватаром и сидит ВПЛОТНУЮ к нему: вынос наружу
        // делал вид, будто значок отклеился, а фиксированные 17px терялись на больших
        // аватарах. Угол квадрата, описанного вокруг круга, и так лежит на его кромке.
        const badgeSize = Math.max(15, Math.min(24, Math.round(size * 0.41)))
        // Значок ставим так, чтобы его юго-восточная точка легла ровно в угол квадрата,
        // описанного вокруг аватара. Значок круглый, а «прижать к углу» его рамку мало:
        // у круга до угла рамки не достаёт r*(1-1/√2) ≈ 0.146 диаметра — этот зазор и
        // читался как «значок утоплен». Историческое -2 у точки 12px — ровно эта формула.
        const cornerInset = (d: number) => -Math.round(d * 0.146)
        const dotInset = cornerInset(dotSize)
        const badgeInset = cornerInset(badgeSize)

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
                right: badgeInset,
                bottom: badgeInset,
                width: badgeSize,
                height: badgeSize,
                borderRadius: 999,
                boxShadow: '0 0 0 2px var(--surface-200)',
                background: bg,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Gamepad2 width={badgeSize} height={badgeSize} color={fg} />
            </span>
          )
        }

        // Device badge: same 17x17 slot as the gamepad, glyph tinted with the status colour.
        // Shown only when the device is known AND the user is not offline; otherwise we fall
        // through to the historical coloured dot.
        const deviceStatus = showInCall ? 'IN_CALL' : presence ?? null
        const deviceKnownAndOnline = !!presenceDevice && !!deviceStatus && deviceStatus !== 'OFFLINE'
        if (deviceKnownAndOnline) {
          const DeviceIcon =
            presenceDevice === 'mobile' ? Smartphone : presenceDevice === 'desktop' ? Monitor : Globe
          const fg = presenceStatusColor(deviceStatus)
          const title = presenceDeviceTitleRu(deviceStatus, presenceDevice) ?? undefined
          return (
            <span
              title={title}
              style={{
                position: 'absolute',
                right: badgeInset,
                bottom: badgeInset,
                width: badgeSize,
                height: badgeSize,
                borderRadius: 999,
                boxShadow: '0 0 0 2px var(--surface-200)',
                background: 'var(--surface-100)',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <DeviceIcon width={badgeSize - 3} height={badgeSize - 3} color={fg} strokeWidth={1.9} />
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
                right: dotInset,
                bottom: dotInset,
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
              right: dotInset,
              bottom: dotInset,
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



