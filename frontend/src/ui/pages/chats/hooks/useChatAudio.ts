import { useCallback, useRef, useState } from 'react'
import { unlockAppAudio } from '../../../../utils/audioUnlock'

export function useChatAudio() {
  const ringTimerRef = useRef<number | null>(null)
  const ringingConvIdRef = useRef<string | null>(null)
  const ringAudioRef = useRef<HTMLAudioElement | null>(null)
  const ringUnlockedRef = useRef<boolean>(false)

  // notify sound
  const notifyAudioRef = useRef<HTMLAudioElement | null>(null)
  const notifyUnlockedRef = useRef<boolean>(false)

  const [showAudioUnlock, setShowAudioUnlock] = useState(false)
  const audioUnlockingRef = useRef<boolean>(false)

  // dialing sound
  const dialingAudioRef = useRef<HTMLAudioElement | null>(null)
  const dialingToneStopRef = useRef<null | (() => void)>(null)

  // end call sound
  const endCallAudioRef = useRef<HTMLAudioElement | null>(null)

  const ensureNotifyAudio = useCallback(() => {
    if (typeof window === 'undefined') return null
    if (!notifyAudioRef.current) {
      const audio = new Audio('/notify.mp3')
      audio.preload = 'auto'
      audio.volume = 0.9
      notifyAudioRef.current = audio
    }
    return notifyAudioRef.current
  }, [])

  const ensureRingAudio = useCallback(() => {
    if (typeof window === 'undefined') return null
    if (!ringAudioRef.current) {
      const audio = new Audio('/ring.mp3')
      audio.preload = 'auto'
      audio.loop = true
      audio.volume = 0.9
      ringAudioRef.current = audio
    }
    return ringAudioRef.current
  }, [])

  const performAudioUnlock = async () => {
    if (audioUnlockingRef.current) {
      return notifyUnlockedRef.current && ringUnlockedRef.current
    }
    audioUnlockingRef.current = true
    try {
      ensureNotifyAudio()
      ensureRingAudio()
      const played = await unlockAppAudio()
      if (played) {
        notifyUnlockedRef.current = true
        ringUnlockedRef.current = true
        setShowAudioUnlock(false)
      }
    } catch {}
    audioUnlockingRef.current = false
    return notifyUnlockedRef.current && ringUnlockedRef.current
  }

  function stopRingtone() {
    try {
      ringTimerRef.current && clearTimeout(ringTimerRef.current)
      ringTimerRef.current = null
      if (ringAudioRef.current) {
        try {
          ringAudioRef.current.pause()
          ringAudioRef.current.currentTime = 0
        } catch {}
      }
      ringingConvIdRef.current = null
    } catch {}
  }

  const ensureDialingAudio = useCallback(() => {
    if (typeof window === 'undefined') return null
    if (!dialingAudioRef.current) {
      const audio = new Audio('/dialing.mp3')
      audio.preload = 'auto'
      audio.loop = true
      audio.volume = 0.7
      dialingAudioRef.current = audio
    }
    return dialingAudioRef.current
  }, [])

  function startMelodicDialingTone(): null | { stop: () => void } {
    if (typeof window === 'undefined') return null
    const AudioContextCtor = (window.AudioContext || (window as any).webkitAudioContext) as
      | (new () => AudioContext)
      | undefined
    if (!AudioContextCtor) return null

    // Create a short, pleasant 3-note "chime" motif that repeats.
    // This avoids shipping a new binary audio file and lets us control volume/cadence.
    const ctx = new AudioContextCtor()
    const master = ctx.createGain()
    master.gain.value = 0.08
    master.connect(ctx.destination)

    let stopped = false
    let timer: number | null = null
    const oscillators = new Set<OscillatorNode>()

    const scheduleOnce = () => {
      if (stopped) return
      // Ensure playback starts even if context begins suspended (common on Safari/iOS).
      void ctx.resume().catch(() => {})

      const t0 = ctx.currentTime + 0.02
      const notes: Array<{ f: number; dur: number; gapAfter: number }> = [
        { f: 523.25, dur: 0.18, gapAfter: 0.08 }, // C5
        { f: 659.25, dur: 0.22, gapAfter: 0.12 }, // E5
        { f: 783.99, dur: 0.18, gapAfter: 1.20 }, // G5, then pause
      ]

      let t = t0
      for (const n of notes) {
        const osc = ctx.createOscillator()
        const g = ctx.createGain()

        osc.type = 'sine'
        osc.frequency.setValueAtTime(n.f, t)

        // Gentle envelope to avoid clicks.
        g.gain.setValueAtTime(0, t)
        g.gain.linearRampToValueAtTime(1, t + 0.01)
        g.gain.exponentialRampToValueAtTime(0.0001, t + n.dur)

        osc.connect(g)
        g.connect(master)

        try {
          osc.start(t)
          osc.stop(t + n.dur + 0.03)
        } catch {}

        oscillators.add(osc)
        osc.onended = () => {
          oscillators.delete(osc)
          try {
            osc.disconnect()
            g.disconnect()
          } catch {}
        }

        t += n.dur + n.gapAfter
      }

      timer = window.setTimeout(scheduleOnce, Math.max(300, Math.round((t - t0) * 1000)))
    }

    scheduleOnce()

    return {
      stop: () => {
        if (stopped) return
        stopped = true
        if (timer !== null) {
          window.clearTimeout(timer)
          timer = null
        }
        for (const osc of Array.from(oscillators)) {
          try {
            osc.onended = null
            osc.stop(0)
          } catch {}
        }
        oscillators.clear()
        try {
          master.disconnect()
        } catch {}
        try {
          void ctx.close()
        } catch {}
      },
    }
  }

  function stopDialingSound() {
    try {
      if (dialingToneStopRef.current) {
        try {
          dialingToneStopRef.current()
        } catch {}
        dialingToneStopRef.current = null
      }
      if (dialingAudioRef.current) {
        try {
          dialingAudioRef.current.pause()
          dialingAudioRef.current.currentTime = 0
        } catch {}
      }
    } catch {}
  }

  function startDialingSound() {
    try {
      // Stop any previous tone/audio to avoid overlaps.
      stopDialingSound()

      // Prefer a generated "melodic" ringback. Fallback to the existing mp3 if WebAudio isn't available.
      const tone = startMelodicDialingTone()
      if (tone) {
        dialingToneStopRef.current = tone.stop
        return
      }

      const audio = ensureDialingAudio()
      if (!audio) return
      audio.currentTime = 0
      audio.loop = true
      audio.volume = 0.7
      void audio.play().catch(() => {})
    } catch (err) {
      console.error('Error starting dialing sound:', err)
    }
  }

  const ensureEndCallAudio = useCallback(() => {
    if (typeof window === 'undefined') return null
    if (!endCallAudioRef.current) {
      const audio = new Audio('/notify.mp3')
      audio.preload = 'auto'
      audio.volume = 0.6
      endCallAudioRef.current = audio
    }
    return endCallAudioRef.current
  }, [])

  function playEndCallSound() {
    try {
      const audio = ensureEndCallAudio()
      if (audio) {
        audio.currentTime = 0
        audio.volume = 0.6
        void audio.play().catch(() => {})
      }
    } catch (err) {
      console.error('Error playing end call sound:', err)
    }
  }

  const playNotifySoundIfAllowed = useCallback(() => {
    try {
      if (notifyAudioRef.current && notifyUnlockedRef.current) {
        notifyAudioRef.current.currentTime = 0
        void notifyAudioRef.current.play().catch(() => {})
      }
    } catch {}
  }, [])

  return {
    // state
    showAudioUnlock,
    setShowAudioUnlock,

    // refs (used in a few places)
    ringingConvIdRef,
    ringTimerRef,
    notifyUnlockedRef,
    ringUnlockedRef,

    // audio helpers
    ensureNotifyAudio,
    ensureRingAudio,
    performAudioUnlock,
    stopRingtone,
    startDialingSound,
    stopDialingSound,
    playEndCallSound,
    playNotifySoundIfAllowed,
  }
}

