import { useEffect, useRef, useState } from 'react'
import { Square } from 'lucide-react'
import { convertToProxyUrl } from '../../../../utils/media'
import { getWaveform } from '../../../../utils/audioWaveform'

export function VoiceMessagePlayer({ url, duration }: { url: string; duration: number }) {
  const [playing, setPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [waveform, setWaveform] = useState<number[]>([])
  const [loadingWaveform, setLoadingWaveform] = useState(true)
  const audioRef = useRef<HTMLAudioElement | null>(null)

  // Convert to proxy URL if needed
  const proxyUrl = convertToProxyUrl(url) || url

  // Генерируем waveform при загрузке
  useEffect(() => {
    let cancelled = false
    setLoadingWaveform(true)
    getWaveform(proxyUrl, 60)
      .then((data) => {
        if (!cancelled) {
          setWaveform(data)
          setLoadingWaveform(false)
        }
      })
      .catch((err) => {
        console.error('Failed to load waveform:', err)
        if (!cancelled) {
          setLoadingWaveform(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [proxyUrl])

  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return

    const updateTime = () => setCurrentTime(audio.currentTime)
    const handleEnded = () => {
      setPlaying(false)
      setCurrentTime(0)
    }
    const handlePlay = () => setPlaying(true)
    const handlePause = () => setPlaying(false)

    audio.addEventListener('timeupdate', updateTime)
    audio.addEventListener('ended', handleEnded)
    audio.addEventListener('play', handlePlay)
    audio.addEventListener('pause', handlePause)

    return () => {
      audio.removeEventListener('timeupdate', updateTime)
      audio.removeEventListener('ended', handleEnded)
      audio.removeEventListener('play', handlePlay)
      audio.removeEventListener('pause', handlePause)
    }
  }, [])

  const togglePlay = () => {
    const audio = audioRef.current
    if (!audio) return

    if (playing) {
      audio.pause()
    } else {
      audio.play().catch((err) => {
        console.error('Failed to play audio:', err)
      })
    }
  }

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60)
    const secs = Math.floor(seconds % 60)
    return `${mins}:${secs.toString().padStart(2, '0')}`
  }

  const currentBarIndex = waveform.length > 0 ? Math.floor((currentTime / duration) * waveform.length) : 0

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', background: 'var(--surface-100)', borderRadius: 12, border: '1px solid var(--surface-border)' }}>
      <audio ref={audioRef} src={proxyUrl} preload="metadata" />
      <button
        type="button"
        onClick={togglePlay}
        style={{
          width: 40,
          height: 40,
          borderRadius: '50%',
          border: 'none',
          background: 'var(--brand)',
          color: '#fff',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: 'pointer',
          flexShrink: 0,
        }}
        aria-label={playing ? 'Пауза' : 'Воспроизвести'}
      >
        {playing ? (
          <Square size={16} fill="currentColor" />
        ) : (
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
            <path d="M5 3l8 5-8 5V3z" />
          </svg>
        )}
      </button>
      <div style={{ flex: 1, minWidth: 0 }}>
        {loadingWaveform ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, height: 24 }}>
            {Array(20).fill(0).map((_, i) => (
              <div
                key={i}
                style={{
                  width: 2,
                  height: 12,
                  background: 'var(--surface-border)',
                  borderRadius: 1,
                  animation: 'pulse 1.5s ease-in-out infinite',
                  animationDelay: `${i * 0.1}s`,
                }}
              />
            ))}
          </div>
        ) : waveform.length > 0 ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 2, height: 24, marginBottom: 4 }}>
            {waveform.map((amplitude, index) => {
              const isActive = index <= currentBarIndex
              const height = Math.max(4, (amplitude / 100) * 20)
              return (
                <div
                  key={index}
                  style={{
                    width: 2,
                    height: `${height}px`,
                    background: isActive ? 'var(--brand)' : 'var(--surface-border)',
                    borderRadius: 1,
                    transition: 'background 0.2s ease',
                    alignSelf: 'flex-end',
                  }}
                />
              )
            })}
          </div>
        ) : (
          <div style={{ height: 24, display: 'flex', alignItems: 'center', color: 'var(--text-muted)', fontSize: 12 }}>
            Загрузка...
          </div>
        )}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 4 }}>
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            {formatTime(currentTime)} / {formatTime(duration)}
          </div>
        </div>
      </div>
    </div>
  )
}

