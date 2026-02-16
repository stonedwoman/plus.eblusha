import { useEffect, useMemo, useRef, useState } from 'react'
import QRCode from 'qrcode'
import { api } from '../../utils/api'
import { Copy, RefreshCw, X, Camera, Keyboard } from 'lucide-react'
import { exportSecretThreadKeys } from '../../domain/secret/secretThreadKeyStore'
import { createEncryptedKeyPackageToDevice } from '../../domain/secret/secretKeyPackages'

type Mode = 'new' | 'trusted'

function formatMmSs(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000))
  const mm = String(Math.floor(s / 60)).padStart(2, '0')
  const ss = String(s % 60).padStart(2, '0')
  return `${mm}:${ss}`
}

function computeSafetyCode(a: string, b: string): string {
  // small, human-checkable code (NOT a cryptographic guarantee)
  try {
    const input = `${a}|${b}`
    let hash = 0
    for (let i = 0; i < input.length; i += 1) hash = (hash * 31 + input.charCodeAt(i)) >>> 0
    const digits = String(hash % 1_000_000).padStart(6, '0')
    return `${digits.slice(0, 3)} ${digits.slice(3)}`
  } catch {
    return '000 000'
  }
}

export function LinkDeviceModal(props: {
  open: boolean
  onClose: () => void
  mode: Mode
}) {
  const { open, onClose, mode } = props
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // new-device state
  const [pairing, setPairing] = useState<{ token: string; code: string; expiresAt: string; newDeviceId: string } | null>(null)
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null)
  const [now, setNow] = useState<number>(() => Date.now())
  const [linked, setLinked] = useState(false)

  // trusted-device state
  const [trustedStep, setTrustedStep] = useState<'choose' | 'scan' | 'code' | 'confirm' | 'sending' | 'done'>('choose')
  const [tokenOrCode, setTokenOrCode] = useState('')
  const [resolved, setResolved] = useState<any | null>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const rafRef = useRef<number | null>(null)

  const expiresInMs = useMemo(() => {
    if (!pairing?.expiresAt) return 0
    const t = Date.parse(pairing.expiresAt)
    if (Number.isNaN(t)) return 0
    return t - now
  }, [pairing?.expiresAt, now])

  useEffect(() => {
    if (!open) return
    const t = window.setInterval(() => setNow(Date.now()), 250)
    return () => window.clearInterval(t)
  }, [open])

  useEffect(() => {
    if (!open) return
    setError(null)
    setBusy(false)
    setResolved(null)
    setTokenOrCode('')
    setTrustedStep('choose')
    if (mode === 'new') {
      setPairing(null)
      setQrDataUrl(null)
      setLinked(false)
    }
  }, [open, mode])

  useEffect(() => {
    if (!open) return
    const handler = () => setLinked(true)
    try {
      window.addEventListener('eb:deviceLinked', handler as any)
    } catch {}
    return () => {
      try { window.removeEventListener('eb:deviceLinked', handler as any) } catch {}
    }
  }, [open])

  async function startPairing() {
    setBusy(true)
    setError(null)
    try {
      const resp = await api.post('/devices/pairing/start')
      const token = String(resp.data?.token ?? '').trim()
      const code = String(resp.data?.code ?? '').trim()
      const expiresAt = String(resp.data?.expiresAt ?? '').trim()
      const newDeviceId = String(resp.data?.newDeviceId ?? '').trim()
      if (!token || !code || !expiresAt || !newDeviceId) throw new Error('Bad pairing response')
      const qrPayload = `EBLUSHA_LINK_DEVICE:${token}`
      const url = await QRCode.toDataURL(qrPayload, { margin: 1, scale: 10 })
      setPairing({ token, code, expiresAt, newDeviceId })
      setQrDataUrl(url)
    } catch (e: any) {
      setError(e?.response?.data?.message || e?.message || 'Не удалось создать код')
    } finally {
      setBusy(false)
    }
  }

  async function resolvePairing(input: string) {
    setBusy(true)
    setError(null)
    try {
      const value = String(input ?? '').trim()
      if (!value) throw new Error('Введите код или токен')
      const isToken = value.includes('.') || value.length > 16 || value.includes('_') || value.includes('-')
      const resp = await api.post('/devices/pairing/resolve', isToken ? { token: value } : { code: value })
      setResolved(resp.data)
      setTrustedStep('confirm')
    } catch (e: any) {
      setError(e?.response?.data?.message || e?.message || 'Не удалось найти запрос')
    } finally {
      setBusy(false)
    }
  }

  async function sendKeysAndConsume() {
    if (!resolved?.newDevice?.id || !resolved?.token) return
    setBusy(true)
    setError(null)
    setTrustedStep('sending')
    try {
      // Security check: if this device's identity key differs from server record, block linking.
      try {
        const raw = typeof window !== 'undefined' ? window.localStorage.getItem('eb_device_info_v1') : null
        const local = raw ? (JSON.parse(raw) as any) : null
        const localDeviceId = typeof local?.deviceId === 'string' ? local.deviceId.trim() : ''
        const localPub = typeof local?.publicKey === 'string' ? local.publicKey.trim() : ''
        if (localDeviceId && localPub) {
          const server = await api.get(`/devices/${encodeURIComponent(localDeviceId)}`)
          const serverPub = String(server.data?.device?.publicKey ?? '').trim()
          if (serverPub && serverPub !== localPub) {
            setError('⚠️ Подозрение на смену ключа: привязка заблокирована. Проверь доверенное устройство.')
            setTrustedStep('confirm')
            return
          }
        }
      } catch {}

      // Encrypt exported key material to the new device (prekeys + secretbox).
      const payload = {
        threadKeys: exportSecretThreadKeys(),
      }
      const env = await createEncryptedKeyPackageToDevice({
        toDeviceId: String(resolved.newDevice.id),
        kind: 'device_link_keys',
        payload,
        ttlSeconds: 60 * 60,
      })
      await api.post('/secret/send', { messages: [env] })
      await api.post('/devices/pairing/consume', { token: String(resolved.token) })
      setTrustedStep('done')
    } catch (e: any) {
      setError(e?.response?.data?.message || e?.message || 'Не удалось привязать устройство')
      setTrustedStep('confirm')
    } finally {
      setBusy(false)
    }
  }

  async function copyText(text: string) {
    try {
      await navigator.clipboard.writeText(text)
    } catch {}
  }

  async function startScanner() {
    setError(null)
    setTrustedStep('scan')
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('Камера недоступна')
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
      streamRef.current = stream
      if (videoRef.current) {
        videoRef.current.srcObject = stream
        await videoRef.current.play()
      }
      const det = (window as any).BarcodeDetector ? new (window as any).BarcodeDetector({ formats: ['qr_code'] }) : null
      if (!det) throw new Error('Сканер QR недоступен в этом браузере')

      const tick = async () => {
        if (!videoRef.current) return
        try {
          const codes = await det.detect(videoRef.current)
          const raw = codes?.[0]?.rawValue
          if (raw && typeof raw === 'string' && raw.includes('EBLUSHA_LINK_DEVICE:')) {
            const token = raw.split('EBLUSHA_LINK_DEVICE:')[1]?.trim()
            if (token) {
              stopScanner()
              await resolvePairing(token)
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
      setTrustedStep('code')
    }
  }

  function stopScanner() {
    if (rafRef.current) cancelAnimationFrame(rafRef.current)
    rafRef.current = null
    const s = streamRef.current
    streamRef.current = null
    try {
      s?.getTracks()?.forEach((t) => t.stop())
    } catch {}
  }

  useEffect(() => {
    return () => stopScanner()
  }, [])

  if (!open) return null

  const overlayStyle: any = {
    position: 'fixed',
    inset: 0,
    zIndex: 120,
    background: 'rgba(10,12,16,0.62)',
    backdropFilter: 'blur(8px) saturate(120%)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 16,
  }

  const cardStyle: any = {
    width: 520,
    maxWidth: '96vw',
    borderRadius: 18,
    border: '1px solid var(--surface-border)',
    background: 'linear-gradient(180deg, var(--surface-200), var(--surface-100))',
    boxShadow: 'var(--shadow-medium)',
    overflow: 'hidden',
  }

  return (
    <div style={overlayStyle} onClick={() => { if (!busy) onClose() }}>
      <div style={cardStyle} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: 16 }}>
          <div style={{ fontWeight: 800, fontSize: 16, color: 'var(--text-primary)' }}>
            {mode === 'new' ? 'Привязка устройства' : 'Привязать новое устройство'}
          </div>
          <button className="btn btn-icon btn-ghost" onClick={() => { if (!busy) onClose() }} aria-label="Закрыть">
            <X size={18} />
          </button>
        </div>

        <div style={{ padding: 16 }}>
          {mode === 'new' && (
            <>
              {!pairing && (
                <div style={{ display: 'flex', gap: 12, alignItems: 'center', justifyContent: 'space-between' }}>
                  <div style={{ color: 'var(--text-muted)', fontSize: 14, lineHeight: '18px' }}>
                    Открой Eblusha на доверенном устройстве → Настройки → Устройства → Привязать.
                  </div>
                  <button className="btn btn-primary" onClick={startPairing} disabled={busy}>
                    {busy ? 'Готовим…' : 'Показать QR'}
                  </button>
                </div>
              )}

              {pairing && (
                <div style={{ display: 'grid', gap: 14 }}>
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '1fr',
                      gap: 12,
                      padding: 16,
                      borderRadius: 16,
                      border: '1px solid var(--surface-border)',
                      background: 'rgba(255,255,255,0.02)',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                      <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>
                        Истекает через <span style={{ color: 'var(--text-primary)', fontWeight: 700 }}>{formatMmSs(expiresInMs)}</span>
                      </div>
                      <button className="btn btn-secondary" onClick={startPairing} disabled={busy}>
                        <RefreshCw size={16} /> Обновить
                      </button>
                    </div>

                    <div style={{ display: 'grid', placeItems: 'center' }}>
                      <div
                        style={{
                          padding: 16,
                          borderRadius: 18,
                          background: 'radial-gradient(closest-side, rgba(245,158,11,0.16), rgba(245,158,11,0.06), transparent)',
                          border: '1px solid rgba(245,158,11,0.25)',
                        }}
                      >
                        {qrDataUrl ? (
                          <img
                            src={qrDataUrl}
                            alt="QR для привязки устройства"
                            style={{ width: 280, height: 280, borderRadius: 12 }}
                          />
                        ) : (
                          <div style={{ width: 280, height: 280 }} />
                        )}
                      </div>
                    </div>

                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: 10,
                        padding: 12,
                        borderRadius: 14,
                        border: '1px solid var(--surface-border)',
                        background: 'rgba(0,0,0,0.10)',
                      }}
                    >
                      <div>
                        <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Код</div>
                        <div style={{ fontSize: 18, fontWeight: 900, letterSpacing: 2, color: 'var(--text-primary)' }}>
                          {pairing.code}
                        </div>
                      </div>
                      <button className="btn btn-secondary" onClick={() => copyText(pairing.code)} title="Скопировать код">
                        <Copy size={16} /> Копировать
                      </button>
                    </div>

                    <div
                      style={{
                        padding: 12,
                        borderRadius: 14,
                        border: '1px solid var(--surface-border)',
                        background: 'rgba(0,0,0,0.08)',
                        display: 'grid',
                        gap: 8,
                      }}
                    >
                      <div style={{ fontWeight: 900, color: 'var(--text-primary)' }}>
                        {linked ? 'Готово' : 'Получаем доступ…'}
                      </div>
                      <div style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: '18px' }}>
                        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                          <span style={{ width: 18, textAlign: 'center' }}>{'✓'}</span>
                          <span>Проверка устройства</span>
                        </div>
                        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                          <span style={{ width: 18, textAlign: 'center' }}>{linked ? '✓' : '•'}</span>
                          <span>Получение ключей</span>
                        </div>
                        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                          <span style={{ width: 18, textAlign: 'center' }}>{linked ? '✓' : '•'}</span>
                          <span>Синхронизация секретной истории</span>
                        </div>
                      </div>
                      {linked && (
                        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                          <button className="btn btn-primary" onClick={onClose}>Закрыть</button>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </>
          )}

          {mode === 'trusted' && (
            <>
              {trustedStep === 'choose' && (
                <div style={{ display: 'grid', gap: 10 }}>
                  <div style={{ color: 'var(--text-muted)', fontSize: 14, lineHeight: '18px' }}>
                    Сканируй QR с нового устройства или введи код вручную.
                  </div>
                  <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                    <button className="btn btn-primary" onClick={() => void startScanner()} disabled={busy}>
                      <Camera size={16} /> Сканировать QR
                    </button>
                    <button className="btn btn-secondary" onClick={() => setTrustedStep('code')} disabled={busy}>
                      <Keyboard size={16} /> Ввести код
                    </button>
                  </div>
                </div>
              )}

              {trustedStep === 'scan' && (
                <div style={{ display: 'grid', gap: 10 }}>
                  <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>Наведи камеру на QR-код.</div>
                  <div style={{ borderRadius: 16, overflow: 'hidden', border: '1px solid var(--surface-border)' }}>
                    <video ref={videoRef} style={{ width: '100%', height: 320, objectFit: 'cover', background: '#000' }} />
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                    <button className="btn btn-secondary" onClick={() => { stopScanner(); setTrustedStep('code') }}>
                      Ввести код
                    </button>
                  </div>
                </div>
              )}

              {trustedStep === 'code' && (
                <div style={{ display: 'grid', gap: 10 }}>
                  <div style={{ display: 'flex', gap: 10 }}>
                    <input
                      value={tokenOrCode}
                      onChange={(e) => setTokenOrCode(e.target.value)}
                      placeholder="Код (8–10 символов)"
                      style={{ flex: 1 }}
                    />
                    <button className="btn btn-primary" disabled={busy || !tokenOrCode.trim()} onClick={() => void resolvePairing(tokenOrCode)}>
                      Продолжить
                    </button>
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                    Если код не подходит — обнови его на новом устройстве.
                  </div>
                </div>
              )}

              {trustedStep === 'confirm' && resolved?.newDevice && (
                <div style={{ display: 'grid', gap: 12 }}>
                  <div style={{ fontWeight: 800, fontSize: 15, color: 'var(--text-primary)' }}>
                    Привязать устройство “{resolved.newDevice.name}”?
                  </div>
                  <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>
                    Safety code: <span style={{ color: 'var(--text-primary)', fontWeight: 800 }}>
                      {computeSafetyCode(String(resolved.newDevice.identityPublicKey ?? ''), String(resolved.token ?? ''))}
                    </span>
                  </div>
                  <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
                    <button className="btn btn-secondary" onClick={onClose} disabled={busy}>Отмена</button>
                    <button className="btn btn-primary" onClick={() => void sendKeysAndConsume()} disabled={busy}>
                      {busy ? 'Привязываем…' : 'Привязать'}
                    </button>
                  </div>
                </div>
              )}

              {trustedStep === 'sending' && (
                <div style={{ display: 'grid', gap: 10 }}>
                  <div style={{ fontWeight: 800, color: 'var(--text-primary)' }}>Передаём ключи…</div>
                  <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>
                    1. Проверка устройства · 2. Получение ключей · 3. Синхронизация истории
                  </div>
                  <div style={{ height: 8, borderRadius: 999, background: 'rgba(255,255,255,0.06)', overflow: 'hidden' }}>
                    <div style={{ width: '66%', height: '100%', background: 'var(--brand)', transition: 'width .2s ease' }} />
                  </div>
                </div>
              )}

              {trustedStep === 'done' && (
                <div style={{ display: 'grid', gap: 10 }}>
                  <div style={{ fontWeight: 900, color: 'var(--text-primary)' }}>Готово</div>
                  <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>Секретные чаты теперь доступны на новом устройстве.</div>
                  <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                    <button className="btn btn-primary" onClick={onClose}>Закрыть</button>
                  </div>
                </div>
              )}
            </>
          )}

          {error && (
            <div style={{ marginTop: 12, color: '#fca5a5', fontSize: 13 }}>
              {error}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

