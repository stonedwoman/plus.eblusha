import { useEffect, useMemo, useRef, useState } from 'react'
import { Camera, Copy, Keyboard, RefreshCw, X } from 'lucide-react'
import { api } from '../../../../utils/api'
import { bytesToBase64, utf8ToBytes } from '../../../../utils/base64'
import { forcePublishPrekeys, getStoredDeviceInfo } from '../../../../domain/device/deviceManager'
import { qrDataUrlWithEbLogo } from '../../../lib/qrWithEbLogo'
import {
  clearDeviceLinkInvite,
  createDeviceLinkInvite,
  deviceLinkQrPayload,
  getDeviceLinkInvite,
  parseDeviceLinkQrPayload,
} from '../../../../domain/device/deviceLinkInvite'

function now() {
  return Date.now()
}

function controlCiphertextBase64(): string {
  return bytesToBase64(utf8ToBytes('ctrl'))
}

function randomId(): string {
  return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function formatMmSs(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000))
  const mm = String(Math.floor(s / 60)).padStart(2, '0')
  const ss = String(s % 60).padStart(2, '0')
  return `${mm}:${ss}`
}

export function DeviceLinkInline(props: {
  variant: 'invite' | 'join'
  onClose?: () => void
}) {
  const { variant } = props
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sent, setSent] = useState(false)
  const [inviteTs, setInviteTs] = useState(0)
  const [isNarrow, setIsNarrow] = useState<boolean>(() => {
    try {
      return typeof window !== 'undefined' ? window.innerWidth <= 520 : false
    } catch {
      return false
    }
  })
  useEffect(() => {
    const onResize = () => {
      try {
        setIsNarrow(window.innerWidth <= 520)
      } catch {}
    }
    try {
      window.addEventListener('resize', onResize)
    } catch {}
    return () => {
      try { window.removeEventListener('resize', onResize) } catch {}
    }
  }, [])
  const invite = useMemo(() => {
    if (variant !== 'invite') return null
    const existing = getDeviceLinkInvite()
    return existing ?? createDeviceLinkInvite()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [variant, inviteTs])
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null)
  const [tick, setTick] = useState(() => now())

  const expiresInMs = useMemo(() => {
    if (!invite?.expiresAt) return 0
    return invite.expiresAt - tick
  }, [invite?.expiresAt, tick])

  useEffect(() => {
    if (variant !== 'invite') return
    const t = window.setInterval(() => setTick(now()), 250)
    return () => window.clearInterval(t)
  }, [variant])

  useEffect(() => {
    if (variant !== 'invite') return
    let cancelled = false
    ;(async () => {
      try {
        const payload = deviceLinkQrPayload(invite!.token)
        const url = await qrDataUrlWithEbLogo(payload, { margin: 1, sizePx: 320 })
        if (!cancelled) setQrDataUrl(url)
      } catch {}
    })()
    return () => {
      cancelled = true
    }
  }, [variant, invite?.token])

  async function copyText(text: string) {
    try {
      await navigator.clipboard.writeText(text)
    } catch {}
  }

  // Join variant state
  const CODE_LEN = 8
  const [digits, setDigits] = useState<string[]>(() => Array.from({ length: CODE_LEN }).map(() => ''))
  const digitRefs = useRef<Array<HTMLInputElement | null>>([])
  const [scannerOpen, setScannerOpen] = useState(false)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const rafRef = useRef<number | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const decoderRef = useRef<null | ((video: HTMLVideoElement) => Promise<string | null>)>(null)

  function stopScanner() {
    if (rafRef.current) cancelAnimationFrame(rafRef.current)
    rafRef.current = null
    decoderRef.current = null
    const s = streamRef.current
    streamRef.current = null
    try {
      s?.getTracks()?.forEach((t) => t.stop())
    } catch {}
  }

  useEffect(() => {
    return () => stopScanner()
  }, [])

  async function startScanner() {
    setError(null)
    setSent(false)
    setScannerOpen(true)
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('Камера недоступна')
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } } as any })
      streamRef.current = stream
      if (videoRef.current) {
        videoRef.current.srcObject = stream
        try {
          // iOS requires inline playback for camera previews.
          videoRef.current.setAttribute('playsinline', 'true')
        } catch {}
        await videoRef.current.play()
      }
      const det = (window as any).BarcodeDetector ? new (window as any).BarcodeDetector({ formats: ['qr_code'] }) : null
      if (det) {
        decoderRef.current = async (video) => {
          try {
            const codes = await det.detect(video)
            const raw = codes?.[0]?.rawValue
            return raw && typeof raw === 'string' ? raw : null
          } catch {
            return null
          }
        }
      } else {
        // Fallback for iOS Chrome (no BarcodeDetector): decode from canvas via jsQR.
        const mod = await import('jsqr')
        const jsQR: any = (mod as any).default || (mod as any)
        decoderRef.current = async (video) => {
          try {
            const w = video.videoWidth
            const h = video.videoHeight
            if (!w || !h) return null
            const canvas = canvasRef.current || document.createElement('canvas')
            canvasRef.current = canvas
            canvas.width = w
            canvas.height = h
            const ctx = canvas.getContext('2d', { willReadFrequently: true } as any) as CanvasRenderingContext2D | null
            if (!ctx) return null
            ctx.drawImage(video, 0, 0, w, h)
            const imageData = ctx.getImageData(0, 0, w, h)
            const code = jsQR(imageData.data, imageData.width, imageData.height, { inversionAttempts: 'dontInvert' })
            return code?.data && typeof code.data === 'string' ? code.data : null
          } catch {
            return null
          }
        }
      }

      const tick = async () => {
        if (!videoRef.current) return
        try {
          const raw = decoderRef.current ? await decoderRef.current(videoRef.current) : null
          if (raw && typeof raw === 'string') {
            const parsed = parseDeviceLinkQrPayload(raw)
            if (parsed) {
              stopScanner()
              setScannerOpen(false)
              // Auto-send after a successful scan.
              void sendJoinRequest(parsed)
              return
            }
          }
        } catch {}
        rafRef.current = requestAnimationFrame(tick)
      }
      rafRef.current = requestAnimationFrame(tick)
    } catch (e: any) {
      setError(e?.message || 'Не удалось открыть камеру')
      stopScanner()
      setScannerOpen(false)
    }
  }

  async function sendJoinRequest(valueOverride?: string) {
    if (busy) return
    setBusy(true)
    setError(null)
    setSent(false)
    try {
      const local = getStoredDeviceInfo()
      const requesterDeviceId = String(local?.deviceId ?? '').trim()
      if (!requesterDeviceId) throw new Error('Устройство не готово')
      const valueRaw = String(valueOverride ?? digits.join('') ?? '').trim()
      if (!valueRaw) throw new Error('Введите код')
      const token = parseDeviceLinkQrPayload(valueRaw) ?? (valueRaw.length > 16 ? valueRaw : '')
      const code = !token ? valueRaw.replace(/[^\d]/g, '').slice(0, CODE_LEN) : ''
      if (!token && code.length !== CODE_LEN) throw new Error('Введите 8 цифр')

      // Ensure this new device has OPKs so trusted device can encrypt the key package to us.
      await forcePublishPrekeys({ reason: 'link_device_join', count: 200, force: true })

      const devicesResp = await api.get('/devices')
      const deviceIds = ((devicesResp.data?.devices ?? []) as any[])
        .filter((d: any) => !d?.revokedAt)
        .map((d: any) => String(d?.id ?? '').trim())
        .filter(Boolean)
        .filter((d: string) => d !== requesterDeviceId)
        .slice(0, 200)

      if (!deviceIds.length) throw new Error('Нет других устройств для привязки')

      const createdAt = new Date().toISOString()
      const ciphertext = controlCiphertextBase64()
      const messages = deviceIds.map((toDeviceId: string) => ({
        toDeviceId,
        msgId: randomId(),
        createdAt,
        ciphertext,
        ttlSeconds: 10 * 60,
        contentType: 'ref' as const,
        schemaVersion: 1,
        headerJson: {
          kind: 'link_device_join',
          v: 1,
          requesterDeviceId,
          ...(token ? { token } : {}),
          ...(code ? { code } : {}),
          ts: Date.now(),
        },
      }))

      await api.post('/secret/send', { messages }, { timeout: 15_000 })
      setSent(true)
    } catch (e: any) {
      setError(e?.response?.data?.message || e?.message || 'Не удалось отправить запрос')
    } finally {
      setBusy(false)
    }
  }

  const cardStyle: any = {
    width: 520,
    maxWidth: '96vw',
    borderRadius: 18,
    border: '1px solid var(--surface-border)',
    background: 'linear-gradient(180deg, var(--surface-200), var(--surface-100))',
    boxShadow: 'var(--shadow-medium)',
    padding: 18,
  }

  if (variant === 'invite') {
    const expired = expiresInMs <= 0
    const qrBoxSize: any = isNarrow ? 'min(86vw, 320px)' : 220
    return (
      <div style={cardStyle}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
          <div style={{ fontWeight: 900, fontSize: 16 }}>Добавить устройство</div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                clearDeviceLinkInvite()
                setQrDataUrl(null)
                setInviteTs(Date.now())
              }}
              disabled={busy}
            >
              <RefreshCw size={16} /> Обновить
            </button>
            {props.onClose ? (
              <button type="button" className="btn btn-ghost" onClick={props.onClose} disabled={busy}>
                <X size={16} />
              </button>
            ) : null}
          </div>
        </div>

        <div style={{ marginTop: 10, color: 'var(--text-muted)', fontSize: 13 }}>
          Открой Eblusha на новом устройстве → «Добавить устройство» → введи код или отсканируй QR.
        </div>

        <div style={{ display: 'flex', gap: 14, marginTop: 14, flexWrap: 'wrap', alignItems: 'stretch' }}>
          <div
            style={{
              flex: isNarrow ? '1 1 100%' : '0 0 auto',
              display: 'flex',
              flexDirection: 'column',
              alignItems: isNarrow ? 'center' : undefined,
            }}
          >
            <div
              style={{
                width: qrBoxSize,
                height: qrBoxSize,
                borderRadius: 16,
                border: '1px solid var(--surface-border)',
                background: 'rgba(0,0,0,0.18)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                overflow: 'hidden',
              }}
            >
              {qrDataUrl && !expired ? <img src={qrDataUrl} alt="QR" style={{ width: '100%', height: '100%' }} /> : <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>QR недоступен</div>}
            </div>
            <div
              style={{
                marginTop: 10,
                fontSize: 12,
                color: expired ? '#fca5a5' : 'var(--text-muted)',
                textAlign: isNarrow ? 'center' : undefined,
                width: isNarrow ? '100%' : undefined,
              }}
            >
              {expired ? 'Код истёк — нажми «Обновить»' : `Истекает через ${formatMmSs(expiresInMs)}`}
            </div>
          </div>

          <div style={{ flex: 1, minWidth: 240, display: 'flex', flexDirection: 'column', alignSelf: 'stretch' }}>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8, fontWeight: 800, letterSpacing: 0.2, flexShrink: 0 }}>
              Код
            </div>
            <div
              style={{
                borderRadius: 16,
                border: '1px solid var(--surface-border)',
                background: 'rgba(0,0,0,0.16)',
                padding: '18px 16px',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'stretch',
                justifyContent: 'space-between',
                gap: 12,
                flex: 1,
                minHeight: 0,
              }}
            >
              <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <div
                  style={{
                    fontFamily:
                      'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
                    fontWeight: 900,
                    fontSize: 'clamp(28px, 4.2vw, 48px)',
                    letterSpacing: '0.08em',
                    lineHeight: 1.1,
                    color: 'var(--text-primary)',
                    textAlign: 'center',
                    userSelect: 'text',
                    fontVariantNumeric: 'tabular-nums',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {invite?.code ?? '--------'}
                </div>
              </div>

              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => copyText(invite?.code ?? '')}
                disabled={busy || expired || !invite?.code}
                style={{
                  width: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 8,
                  padding: '12px 12px',
                  borderRadius: 14,
                  border: '1px solid rgba(255,255,255,0.10)',
                  background: 'rgba(255,255,255,0.04)',
                }}
              >
                <Copy size={16} /> Скопировать
              </button>
            </div>
            {error ? <div style={{ marginTop: 10, color: '#fca5a5', fontSize: 13 }}>{error}</div> : null}
          </div>
        </div>
      </div>
    )
  }

  // join
  const codeValue = digits.join('')
  const canAutoCommit = codeValue.length === CODE_LEN && digits.every((d) => /^\d$/.test(d))

  function setDigitAt(i: number, value: string) {
    const v = String(value ?? '').replace(/[^\d]/g, '')
    setDigits((prev) => {
      const next = [...prev]
      next[i] = v.slice(-1)
      return next
    })
  }

  function focusIdx(i: number) {
    const el = digitRefs.current[i]
    if (!el) return
    try {
      el.focus()
      el.select?.()
    } catch {}
  }

  function applyPaste(startIdx: number, text: string) {
    const only = String(text ?? '').replace(/[^\d]/g, '')
    if (!only) return
    setDigits((prev) => {
      const next = [...prev]
      for (let k = 0; k < only.length && startIdx + k < CODE_LEN; k += 1) {
        next[startIdx + k] = only[k] ?? ''
      }
      return next
    })
    const last = Math.min(CODE_LEN - 1, startIdx + only.length - 1)
    if (last >= 0) focusIdx(Math.min(CODE_LEN - 1, last + 1))
  }

  useEffect(() => {
    if (variant !== 'join') return
    if (busy || sent || error) return
    if (canAutoCommit) {
      void sendJoinRequest(codeValue)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canAutoCommit, codeValue, variant])

  return (
    <div style={cardStyle}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
        <div style={{ fontWeight: 900, fontSize: 16 }}>Добавить устройство</div>
        {props.onClose ? (
          <button type="button" className="btn btn-ghost" onClick={props.onClose} disabled={busy}>
            <X size={16} />
          </button>
        ) : null}
      </div>
      <div style={{ marginTop: 10, color: 'var(--text-muted)', fontSize: 13 }}>
        Введи 8‑значный код или отсканируй QR. После последней цифры — отправим автоматически.
      </div>

      <div style={{ marginTop: 14, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '10px 10px',
            borderRadius: 14,
            border: '1px solid var(--surface-border)',
            background: 'rgba(0,0,0,0.16)',
          }}
        >
          {digits.map((d, i) => (
            <input
              key={i}
              ref={(el) => {
                digitRefs.current[i] = el
              }}
              value={d}
              onChange={(e) => {
                const v = String(e.target.value ?? '').replace(/[^\d]/g, '')
                if (!v) {
                  setDigitAt(i, '')
                  return
                }
                setDigitAt(i, v)
                if (i < CODE_LEN - 1) focusIdx(i + 1)
              }}
              onFocus={(e) => {
                try { e.currentTarget.select() } catch {}
              }}
              onKeyDown={(e) => {
                if (e.key === 'Backspace' && !digits[i] && i > 0) {
                  e.preventDefault()
                  setDigitAt(i - 1, '')
                  focusIdx(i - 1)
                }
                if (e.key === 'ArrowLeft' && i > 0) {
                  e.preventDefault()
                  focusIdx(i - 1)
                }
                if (e.key === 'ArrowRight' && i < CODE_LEN - 1) {
                  e.preventDefault()
                  focusIdx(i + 1)
                }
              }}
              onPaste={(e) => {
                const txt = e.clipboardData?.getData('text') ?? ''
                if (txt) {
                  e.preventDefault()
                  applyPaste(i, txt)
                }
              }}
              type="tel"
              inputMode="numeric"
              pattern="[0-9]*"
              autoComplete={i === 0 ? 'one-time-code' : 'off'}
              aria-label={`Цифра ${i + 1}`}
              disabled={busy || sent}
              style={{
                width: 34,
                height: 44,
                borderRadius: 10,
                border: '1px solid rgba(255,255,255,0.08)',
                background: 'rgba(0,0,0,0.18)',
                color: 'var(--text-primary)',
                outline: 'none',
                fontSize: 18,
                fontWeight: 900,
                textAlign: 'center',
                fontFamily:
                  'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
                letterSpacing: 0.5,
                ...(i === 4 ? { marginLeft: 10 } : {}),
              }}
            />
          ))}
        </div>

        <button type="button" className="btn btn-ghost" onClick={() => void startScanner()} disabled={busy || sent}>
          <Camera size={16} /> Сканировать QR
        </button>
      </div>

      {error ? <div style={{ marginTop: 10, color: '#fca5a5', fontSize: 13 }}>{error}</div> : null}
      {!error && sent ? (
        <div style={{ marginTop: 10, color: '#86efac', fontSize: 13, fontWeight: 700 }}>
          Запрос отправлен. Ждём ключи…
        </div>
      ) : null}
      {!error && !sent && busy ? (
        <div style={{ marginTop: 10, color: 'var(--text-muted)', fontSize: 13, fontWeight: 700 }}>
          Отправляем запрос…
        </div>
      ) : null}

      {scannerOpen && (
        <div
          style={{
            marginTop: 14,
            borderRadius: 16,
            border: '1px solid var(--surface-border)',
            overflow: 'hidden',
            background: 'rgba(0,0,0,0.2)',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: 10 }}>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 700 }}>Сканирование…</div>
            <button type="button" className="btn btn-ghost" onClick={() => { stopScanner(); setScannerOpen(false) }} disabled={busy}>
              <X size={16} />
            </button>
          </div>
          <video ref={videoRef} style={{ width: '100%', height: 260, objectFit: 'cover' }} muted playsInline />
        </div>
      )}
    </div>
  )
}

