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

export function convertToProxyUrl(url: string | null | undefined): string | null {
  return url ?? null
}


