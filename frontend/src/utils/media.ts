export type MediaPermissionResult =
  | { ok: true }
  | { ok: false; error: DOMException | Error }

type MediaOptions = {
  audio?: boolean
  video?: boolean
}

export async function ensureMediaPermissions(options: MediaOptions = {}): Promise<MediaPermissionResult> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    return { ok: true }
  }

  const wantsAudio = options.audio !== false
  const wantsVideo = !!options.video

  if (!wantsAudio && !wantsVideo) {
    return { ok: true }
  }

  const constraints: MediaStreamConstraints = {
    audio: wantsAudio,
    video: wantsVideo,
  }

  let stream: MediaStream | null = null
  try {
    stream = await navigator.mediaDevices.getUserMedia(constraints)
    return { ok: true }
  } catch (error) {
    return { ok: false, error: (error as DOMException | Error) ?? new Error('Unknown media error') }
  } finally {
    if (stream) {
      stream.getTracks().forEach((track) => {
        try {
          track.stop()
        } catch {
          // ignore
        }
      })
    }
  }
}

/**
 * Converts S3 direct URLs to proxy URLs to avoid blocking in Russia.
 * Detects URLs like:
 * - https://eblusha-uploads.hel1.your-objectstorage.com/uploads/...
 * - https://*.your-objectstorage.com/...
 * And converts them to: /api/files/...
 */
export function convertToProxyUrl(url: string | null | undefined): string | null {
  if (!url) return null
  
  // If already a proxy URL or relative URL starting with /api/files, return as is
  if (url.startsWith('/api/files/') || url.startsWith('blob:') || url.startsWith('data:')) {
    return url
  }
  
  try {
    const urlObj = new URL(url)
    
    // Check if it's a S3 URL that needs proxying (your-objectstorage.com or similar)
    const hostname = urlObj.hostname
    // Check for any Hetzner Object Storage domain patterns
    if (hostname.includes('your-objectstorage.com') || 
        hostname.includes('eblusha-uploads') || 
        (hostname.startsWith('eblusha.') && hostname.includes('hel1'))) {
      // Extract the path after the domain
      // Example: https://eblusha.hel1.your-objectstorage.com/uploads/file.jpg
      // -> /api/files/uploads/file.jpg
      const path = urlObj.pathname
      // Remove leading slash and use as proxy path
      const proxyPath = path.startsWith('/') ? path.slice(1) : path
      return `/api/files/${proxyPath}`
    }
    
    // If it's already our API URL, return as is
    if (urlObj.pathname.startsWith('/api/files/')) {
      return urlObj.pathname
    }
    
    // For other URLs, return as is
    return url
  } catch {
    // If URL parsing fails, return as is (might be relative or malformed)
    return url
  }
}


