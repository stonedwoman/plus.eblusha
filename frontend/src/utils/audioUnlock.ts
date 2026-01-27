let unlockAudioEl: HTMLAudioElement | null = null

declare global {
  interface Window {
    __ebAudioUnlockedOnce?: boolean
  }
}

/**
 * Unlock audio playback on mobile browsers (iOS WebKit) using a user gesture.
 * This must be called directly inside a click/tap/submit handler.
 */
export async function unlockAppAudio(): Promise<boolean> {
  if (typeof window === 'undefined') return false
  if ((window as any).__ebAudioUnlockedOnce) return true

  try {
    if (!unlockAudioEl) {
      unlockAudioEl = new Audio('/silent.wav')
      unlockAudioEl.preload = 'auto'
    }

    const audio = unlockAudioEl
    audio.currentTime = 0
    // Some iOS versions ignore volume/muted in strange ways; keep it as-is for silent.wav.
    const res = audio.play()
    if (res && typeof (res as Promise<void>).then === 'function') {
      // Don't block forever on iOS; treat the attempt as success after a short time.
      await Promise.race([res, new Promise((resolve) => window.setTimeout(resolve, 1200))])
    }
    try {
      audio.pause()
      audio.currentTime = 0
    } catch {}

    ;(window as any).__ebAudioUnlockedOnce = true
    return true
  } catch {
    return false
  }
}

