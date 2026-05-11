import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useLocalParticipant, useRoomContext } from '@livekit/components-react'
import { X } from 'lucide-react'
import { installScreenShareAudioGuard } from '../../utils/screenShareAudio'

installScreenShareAudioGuard()

// Storage keys (per-browser preferences)
const STORAGE_KEYS = {
  resolution: 'eb.lk.screenShare.resolution',
  fps: 'eb.lk.screenShare.fps',
  audio: 'eb.lk.screenShare.audio',
} as const

export type ResolutionKey = '480p' | '720p' | '1080p' | '1440p' | '4k' | 'source'
export type FpsValue = 5 | 15 | 30 | 60

type ResolutionPreset = {
  label: string
  hint: string
  width: number
  height: number
} | {
  label: string
  hint: string
  width: null
  height: null
}

const RESOLUTION_PRESETS: Record<ResolutionKey, ResolutionPreset> = {
  '480p': { label: '480p', hint: '854 × 480', width: 854, height: 480 },
  '720p': { label: '720p', hint: '1280 × 720', width: 1280, height: 720 },
  '1080p': { label: '1080p', hint: '1920 × 1080', width: 1920, height: 1080 },
  '1440p': { label: '1440p', hint: '2560 × 1440', width: 2560, height: 1440 },
  '4k': { label: '4K', hint: '3840 × 2160', width: 3840, height: 2160 },
  'source': { label: 'Исходное', hint: 'без понижения', width: null, height: null },
}

const FPS_OPTIONS: FpsValue[] = [5, 15, 30, 60]

const DEFAULT_RESOLUTION: ResolutionKey = '1080p'
const DEFAULT_FPS: FpsValue = 30
const DEFAULT_AUDIO = false

function readStored(key: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback
  try {
    const raw = window.localStorage.getItem(key)
    return raw ?? fallback
  } catch {
    return fallback
  }
}

function writeStored(key: string, value: string) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(key, value)
  } catch {
    // ignore
  }
}

function readResolution(): ResolutionKey {
  const raw = readStored(STORAGE_KEYS.resolution, DEFAULT_RESOLUTION) as ResolutionKey
  return (raw in RESOLUTION_PRESETS ? raw : DEFAULT_RESOLUTION) as ResolutionKey
}

function readFps(): FpsValue {
  const raw = Number(readStored(STORAGE_KEYS.fps, String(DEFAULT_FPS)))
  return (FPS_OPTIONS.includes(raw as FpsValue) ? (raw as FpsValue) : DEFAULT_FPS)
}

function readAudio(): boolean {
  const raw = readStored(STORAGE_KEYS.audio, DEFAULT_AUDIO ? '1' : '0')
  return raw === '1' || raw === 'true'
}

// Approximate per-codec bitrates (bits per second) tuned for screen content.
// Discord uses similar tiers; we pick generous middle values that work well
// for both motion (gameplay) and detail (text/IDE) content.
function computeMaxBitrate(key: ResolutionKey, fps: FpsValue): number {
  const base: Record<ResolutionKey, number> = {
    '480p': 1_200_000,
    '720p': 2_500_000,
    '1080p': 5_000_000,
    '1440p': 9_000_000,
    '4k': 15_000_000,
    'source': 6_000_000,
  }
  const fpsMultiplier = fps >= 60 ? 1.7 : fps >= 30 ? 1.0 : fps >= 15 ? 0.7 : 0.45
  return Math.round(base[key] * fpsMultiplier)
}

function formatBitrate(bps: number): string {
  if (bps >= 1_000_000) return `${(bps / 1_000_000).toFixed(1)} Мбит/с`
  return `${Math.round(bps / 1000)} кбит/с`
}

type DialogProps = {
  open: boolean
  initialResolution: ResolutionKey
  initialFps: FpsValue
  initialAudio: boolean
  onCancel: () => void
  onConfirm: (settings: { resolution: ResolutionKey; fps: FpsValue; audio: boolean }) => void
}

function ScreenShareSettingsDialog({
  open,
  initialResolution,
  initialFps,
  initialAudio,
  onCancel,
  onConfirm,
}: DialogProps) {
  const [resolution, setResolution] = useState<ResolutionKey>(initialResolution)
  const [fps, setFps] = useState<FpsValue>(initialFps)
  const [audio, setAudio] = useState<boolean>(initialAudio)

  // Re-sync when the dialog re-opens (e.g. user changed defaults via another device).
  useEffect(() => {
    if (!open) return
    setResolution(initialResolution)
    setFps(initialFps)
    setAudio(initialAudio)
  }, [open, initialResolution, initialFps, initialAudio])

  // Close on Esc
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onCancel()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, onCancel])

  if (!open || typeof document === 'undefined') return null

  const bitrate = computeMaxBitrate(resolution, fps)

  const node = (
    <div
      className="eb-share-modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Параметры показа экрана"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel()
      }}
    >
      <div className="eb-share-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="eb-share-modal-header">
          <div>
            <div className="eb-share-modal-title">Параметры показа экрана</div>
            <div className="eb-share-modal-subtitle">
              Чем выше разрешение и FPS, тем больше нагрузка на сеть и CPU. Для текста хватит 720p/15.
            </div>
          </div>
          <button
            type="button"
            className="eb-share-modal-close"
            aria-label="Закрыть"
            title="Закрыть"
            onClick={(e) => {
              e.preventDefault()
              e.stopPropagation()
              onCancel()
            }}
          >
            <X size={18} />
          </button>
        </div>

        <div className="eb-share-modal-body">
          <div className="eb-share-section">
            <div className="eb-share-section-title">Разрешение</div>
            <div className="eb-share-segments" role="radiogroup" aria-label="Разрешение">
              {(Object.keys(RESOLUTION_PRESETS) as ResolutionKey[]).map((key) => {
                const preset = RESOLUTION_PRESETS[key]
                const active = key === resolution
                return (
                  <button
                    key={key}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    className={`eb-share-segment ${active ? 'is-active' : ''}`}
                    onClick={(e) => {
                      e.preventDefault()
                      e.stopPropagation()
                      setResolution(key)
                    }}
                  >
                    <span className="eb-share-segment-label">{preset.label}</span>
                    <span className="eb-share-segment-hint">{preset.hint}</span>
                  </button>
                )
              })}
            </div>
          </div>

          <div className="eb-share-section">
            <div className="eb-share-section-title">Частота кадров</div>
            <div className="eb-share-segments" role="radiogroup" aria-label="Частота кадров">
              {FPS_OPTIONS.map((value) => {
                const active = value === fps
                return (
                  <button
                    key={value}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    className={`eb-share-segment ${active ? 'is-active' : ''}`}
                    onClick={(e) => {
                      e.preventDefault()
                      e.stopPropagation()
                      setFps(value)
                    }}
                  >
                    <span className="eb-share-segment-label">{value} FPS</span>
                    <span className="eb-share-segment-hint">
                      {value <= 5 ? 'презентация' : value <= 15 ? 'текст/код' : value <= 30 ? 'видео' : 'игры'}
                    </span>
                  </button>
                )
              })}
            </div>
          </div>

          <div className="eb-share-section">
            <label className="eb-share-audio-row">
              <input
                type="checkbox"
                checked={audio}
                onChange={(e) => setAudio(e.target.checked)}
              />
              <span className="eb-share-audio-text">
                <span className="eb-share-audio-label">Захват звука</span>
                <span className="eb-share-audio-hint">
                  Передаёт звук системы / выбранного окна / вкладки. Список источников появится
                  в системном диалоге Chrome рядом с превью окон. Голоса участников звонка
                  автоматически вычитаются из захвата (Chrome 140+), но во избежание эха
                  включайте только в наушниках.
                </span>
              </span>
            </label>
          </div>

          <div className="eb-share-summary">
            Битрейт публикации: ~{formatBitrate(bitrate)}
          </div>
        </div>

        <div className="eb-share-modal-actions">
          <button
            type="button"
            className="eb-share-btn eb-share-btn-secondary"
            onClick={(e) => {
              e.preventDefault()
              e.stopPropagation()
              onCancel()
            }}
          >
            Отмена
          </button>
          <button
            type="button"
            className="eb-share-btn eb-share-btn-primary"
            onClick={(e) => {
              e.preventDefault()
              e.stopPropagation()
              onConfirm({ resolution, fps, audio })
            }}
          >
            Начать показ
          </button>
        </div>
      </div>
    </div>
  )

  return createPortal(node, document.body)
}

type ControllerProps = {
  enabled: boolean
}

/**
 * Intercepts clicks on LiveKit's screen-share button to first ask the user
 * for resolution/fps/audio preferences (Discord-style), and then publishes
 * the screen-share track with the chosen capture + encoding options.
 *
 * If a screen share is already active, clicking the button passes through
 * normally and stops the share.
 */
export function ScreenShareSettingsController({ enabled }: ControllerProps) {
  const room = useRoomContext()
  const { localParticipant, isScreenShareEnabled } = useLocalParticipant()

  const isScreenShareEnabledRef = useRef(isScreenShareEnabled)
  useEffect(() => {
    isScreenShareEnabledRef.current = isScreenShareEnabled
  }, [isScreenShareEnabled])

  const [open, setOpen] = useState(false)
  const [resolution, setResolution] = useState<ResolutionKey>(() => readResolution())
  const [fps, setFps] = useState<FpsValue>(() => readFps())
  const [audio, setAudio] = useState<boolean>(() => readAudio())

  // Listen for clicks on LK's screen-share button and intercept "start" clicks.
  useEffect(() => {
    if (!enabled) return
    if (typeof document === 'undefined') return

    const handler = (e: Event) => {
      const target = e.target as HTMLElement | null
      if (!target) return
      // LK adds data-lk-source="screen_share" to its toggle button.
      const btn = target.closest(
        '.lk-button[data-lk-source="screen_share"], button[data-lk-source="screen_share"]'
      ) as HTMLElement | null
      if (!btn) return
      if (btn.hasAttribute('disabled')) return
      // If currently sharing, allow the default behavior (stop).
      if (isScreenShareEnabledRef.current) return
      // Capture-phase: stop the event from reaching LK's bubble-phase onClick.
      e.preventDefault()
      e.stopPropagation()
      ;(e as any).stopImmediatePropagation?.()
      setOpen(true)
    }

    // Capture-phase ensures we run before LK's React onClick (delegated to
    // the root in React 17+).
    document.addEventListener('click', handler, true)
    return () => {
      document.removeEventListener('click', handler, true)
    }
  }, [enabled])

  const handleCancel = useCallback(() => {
    setOpen(false)
  }, [])

  const handleConfirm = useCallback(
    async (settings: { resolution: ResolutionKey; fps: FpsValue; audio: boolean }) => {
      setOpen(false)
      setResolution(settings.resolution)
      setFps(settings.fps)
      setAudio(settings.audio)
      writeStored(STORAGE_KEYS.resolution, settings.resolution)
      writeStored(STORAGE_KEYS.fps, String(settings.fps))
      writeStored(STORAGE_KEYS.audio, settings.audio ? '1' : '0')

      if (!room || !localParticipant) return

      const preset = RESOLUTION_PRESETS[settings.resolution]
      const captureOptions: any = {
        audio: settings.audio,
        contentHint: settings.fps >= 30 ? 'motion' : 'detail',
      }
      if (preset.width != null && preset.height != null) {
        // LiveKit converts this into width/height/frameRate constraints for
        // getDisplayMedia (ideal on Chrome/Firefox, max on Safari).
        captureOptions.resolution = {
          width: preset.width,
          height: preset.height,
          frameRate: settings.fps,
        }
      } else {
        // "source": keep native resolution but cap the frame rate. LiveKit
        // ignores resolution.frameRate when width/height are 0, so push the
        // frameRate constraint via `video` directly.
        captureOptions.video = { frameRate: { ideal: settings.fps, max: settings.fps } }
      }

      const publishOptions: any = {
        screenShareEncoding: {
          maxBitrate: computeMaxBitrate(settings.resolution, settings.fps),
          maxFramerate: settings.fps,
          priority: 'high',
        },
      }

      try {
        await room.localParticipant.setScreenShareEnabled(true, captureOptions, publishOptions)
      } catch (err) {
        // User cancelled the browser source picker, or share failed.
        const name = (err as any)?.name as string | undefined
        if (name !== 'NotAllowedError' && name !== 'AbortError') {
          // eslint-disable-next-line no-console
          console.warn('[ScreenShareSettings] failed to start screen share', err)
        }
      }
    },
    [room, localParticipant]
  )

  const initial = useMemo(
    () => ({ resolution, fps, audio }),
    [resolution, fps, audio]
  )

  return (
    <ScreenShareSettingsDialog
      open={open}
      initialResolution={initial.resolution}
      initialFps={initial.fps}
      initialAudio={initial.audio}
      onCancel={handleCancel}
      onConfirm={handleConfirm}
    />
  )
}

export default ScreenShareSettingsController
