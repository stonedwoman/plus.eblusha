declare global {
  interface Window {
    __eblushaScreenShareAudioGuardPatched?: boolean
  }
}

type ExtendedAudioConstraints = MediaTrackConstraints & {
  // Chrome 140+: filter out audio coming from the capturing tab itself
  // (i.e. our own LiveKit conference) so remote participants don't hear
  // themselves echoed back through the captured system audio.
  // https://developer.mozilla.org/docs/Web/API/MediaTrackSettings/restrictOwnAudio
  restrictOwnAudio?: boolean
  // Chrome 105+: mute the captured source's audio out of the local speakers
  // so it isn't picked up by the microphone again. We don't enable this by
  // default because users usually want to keep hearing the sound they share.
  suppressLocalAudioPlayback?: boolean
}

type ExtendedDisplayMediaOptions = DisplayMediaStreamOptions & {
  selfBrowserSurface?: 'include' | 'exclude'
  systemAudio?: 'include' | 'exclude'
  // Chrome 141+: hint that we'd like the user to be offered window audio
  // when picking a window surface. Ignored on browsers that don't know it.
  // https://github.com/drkron/explainers/blob/main/windowAudio_Explainer.md
  windowAudio?: 'window' | 'system' | 'exclude'
}

function isDisplayAudioRequested(audio: DisplayMediaStreamOptions['audio']) {
  return audio !== undefined && audio !== false
}

/**
 * When the caller asks for screen-share audio, make sure Chrome offers the
 * widest set of safe sources: system audio for full screen captures, window
 * audio for window captures (Chrome 141+), and engages restrictOwnAudio so
 * we don't loop our own conference voices back into the shared stream.
 *
 * If the caller already chose explicit values (e.g. systemAudio: 'exclude'),
 * we respect them. If audio is not requested at all, we leave the options
 * untouched.
 */
export function getDisplayMediaOptionsForScreenShare(
  options?: DisplayMediaStreamOptions,
): DisplayMediaStreamOptions | undefined {
  if (!options || !isDisplayAudioRequested(options.audio)) return options

  const next: ExtendedDisplayMediaOptions = { ...options }

  if (next.systemAudio === undefined) next.systemAudio = 'include'
  if (next.windowAudio === undefined) next.windowAudio = 'window'

  // Promote `audio: true` to a constraints object that engages anti-echo
  // filtering of the capturing tab. Older browsers ignore the unknown key.
  if (next.audio === true) {
    const audioConstraints: ExtendedAudioConstraints = { restrictOwnAudio: true }
    next.audio = audioConstraints as unknown as MediaTrackConstraints
  } else if (typeof next.audio === 'object' && next.audio !== null) {
    const ext = next.audio as ExtendedAudioConstraints
    if (ext.restrictOwnAudio === undefined) {
      const merged: ExtendedAudioConstraints = { ...ext, restrictOwnAudio: true }
      next.audio = merged as unknown as MediaTrackConstraints
    }
  }

  return next
}

export function installScreenShareAudioGuard() {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return
  if (window.__eblushaScreenShareAudioGuardPatched) return
  if (!navigator.mediaDevices?.getDisplayMedia) return

  const originalGetDisplayMedia = navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices)

  navigator.mediaDevices.getDisplayMedia = (options?: DisplayMediaStreamOptions) => {
    return originalGetDisplayMedia(getDisplayMediaOptionsForScreenShare(options))
  }

  window.__eblushaScreenShareAudioGuardPatched = true
}

export {}
