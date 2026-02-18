import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { useSystemUiStore } from '../../domain/store/systemUiStore'

function ToastIcon(props: { variant: 'success' | 'error' | 'info' }) {
  const v = props.variant
  if (v === 'success') return <span style={{ color: '#86efac', fontWeight: 900 }}>✓</span>
  if (v === 'error') return <span style={{ color: '#fca5a5', fontWeight: 900 }}>!</span>
  return <span style={{ color: 'var(--text-muted)', fontWeight: 900 }}>i</span>
}

export function SystemPopups() {
  const toasts = useSystemUiStore((s) => s.toasts)
  const dismissToast = useSystemUiStore((s) => s.dismissToast)
  const confirm = useSystemUiStore((s) => s.confirm)
  const resolveConfirm = useSystemUiStore((s) => s.resolveConfirm)
  const newSessionPopup = useSystemUiStore((s) => s.newSessionPopup)
  const resolveNewSessionPopup = useSystemUiStore((s) => s.resolveNewSessionPopup)

  useEffect(() => {
    if (!toasts.length) return
    const timers = toasts.map((t) =>
      window.setTimeout(() => dismissToast(t.id), Math.max(1200, Math.min(20_000, t.ttlMs))),
    )
    return () => timers.forEach((id) => window.clearTimeout(id))
  }, [toasts, dismissToast])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (newSessionPopup && e.key === 'Escape') {
        resolveNewSessionPopup('ok')
        return
      }
      if (!confirm) return
      if (e.key === 'Escape') resolveConfirm(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [confirm, resolveConfirm, newSessionPopup, resolveNewSessionPopup])

  const host = typeof document !== 'undefined' ? document.body : null
  if (!host) return null

  const isMobile = (() => {
    try {
      return typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(max-width: 720px)').matches
    } catch {
      return false
    }
  })()

  return createPortal(
    <>
      {/* Toasts */}
      <div
        style={{
          position: 'fixed',
          zIndex: 200,
          ...(isMobile
            ? { top: 12, left: 12, right: 12 }
            : { bottom: 14, right: 14, width: 380, maxWidth: 'calc(100vw - 28px)' }),
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
          pointerEvents: 'none',
        }}
      >
        {toasts
          .slice()
          .sort((a, b) => b.createdAt - a.createdAt)
          .map((t) => {
            const border =
              t.variant === 'success'
                ? 'rgba(34,197,94,0.18)'
                : t.variant === 'error'
                  ? 'rgba(239,68,68,0.20)'
                  : 'rgba(255,255,255,0.10)'
            const bg =
              t.variant === 'success'
                ? 'linear-gradient(180deg, rgba(17,24,31,0.92), rgba(10,12,16,0.88))'
                : t.variant === 'error'
                  ? 'linear-gradient(180deg, rgba(31,17,17,0.92), rgba(10,12,16,0.88))'
                  : 'linear-gradient(180deg, rgba(17,24,31,0.92), rgba(10,12,16,0.88))'
            return (
              <div
                key={t.id}
                style={{
                  pointerEvents: 'auto',
                  borderRadius: 14,
                  border: `1px solid ${border}`,
                  background: bg,
                  backdropFilter: 'blur(10px) saturate(120%)',
                  boxShadow: 'var(--shadow-medium)',
                  padding: '10px 12px',
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 10,
                }}
              >
                <div
                  style={{
                    width: 28,
                    height: 28,
                    borderRadius: 999,
                    border: '1px solid var(--surface-border)',
                    background: 'rgba(255,255,255,0.06)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    flexShrink: 0,
                  }}
                >
                  <ToastIcon variant={t.variant} />
                </div>
                <div style={{ minWidth: 0, flex: 1 }}>
                  {t.title ? (
                    <div style={{ fontSize: 13, fontWeight: 900, color: 'var(--text-primary)', marginBottom: 2 }}>
                      {t.title}
                    </div>
                  ) : null}
                  <div style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.2, overflowWrap: 'anywhere' }}>
                    {t.message}
                  </div>
                </div>
                <button
                  type="button"
                  className="btn btn-icon btn-ghost"
                  onClick={() => dismissToast(t.id)}
                  aria-label="Закрыть"
                  style={{ width: 32, height: 32, minWidth: 32, borderRadius: 999 }}
                >
                  <X size={16} />
                </button>
              </div>
            )
          })}
      </div>

      {/* Confirm modal */}
      {confirm ? (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 210,
            background: 'rgba(10,12,16,0.62)',
            backdropFilter: 'blur(8px) saturate(120%)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 16,
          }}
          onClick={() => resolveConfirm(false)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: 520,
              maxWidth: '96vw',
              borderRadius: 18,
              border: '1px solid var(--surface-border)',
              background: 'linear-gradient(180deg, var(--surface-200), var(--surface-100))',
              boxShadow: 'var(--shadow-medium)',
              overflow: 'hidden',
            }}
          >
            <div style={{ padding: 16, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
              <div style={{ fontWeight: 900, fontSize: 16, color: 'var(--text-primary)' }}>{confirm.title}</div>
              <button
                type="button"
                className="btn btn-icon btn-ghost"
                onClick={() => resolveConfirm(false)}
                aria-label="Закрыть"
              >
                <X size={18} />
              </button>
            </div>
            {confirm.message ? (
              <div style={{ padding: '0 16px 16px', color: 'var(--text-muted)', fontSize: 14, lineHeight: '18px' }}>
                {confirm.message}
              </div>
            ) : null}
            <div style={{ padding: 16, display: 'flex', gap: 10, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
              <button type="button" className="btn btn-secondary" onClick={() => resolveConfirm(false)}>
                {confirm.cancelText ?? 'Отмена'}
              </button>
              <button
                type="button"
                className={confirm.danger ? 'btn btn-primary' : 'btn btn-primary'}
                onClick={() => resolveConfirm(true)}
                style={confirm.danger ? { background: '#ef4444', borderColor: '#ef4444', color: '#fff' } : undefined}
              >
                {confirm.confirmText ?? 'Подтвердить'}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* New session popup */}
      {newSessionPopup ? (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 215,
            background: 'rgba(10,12,16,0.62)',
            backdropFilter: 'blur(8px) saturate(120%)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 16,
          }}
          onClick={() => resolveNewSessionPopup('ok')}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: 400,
              maxWidth: '96vw',
              borderRadius: 18,
              border: '1px solid var(--surface-border)',
              background: 'linear-gradient(180deg, var(--surface-200), var(--surface-100))',
              boxShadow: 'var(--shadow-medium)',
              overflow: 'hidden',
            }}
          >
            <div style={{ padding: 16, fontWeight: 900, fontSize: 16, color: 'var(--text-primary)' }}>
              Новый сеанс
            </div>
            <div style={{ padding: '0 16px 16px', color: 'var(--text-muted)', fontSize: 14, lineHeight: 1.4 }}>
              {[newSessionPopup.deviceName, newSessionPopup.platform].filter(Boolean).length > 0
                ? `Подключено устройство: ${[newSessionPopup.deviceName, newSessionPopup.platform].filter(Boolean).join(' • ')}`
                : 'Подключено новое устройство.'}
            </div>
            <div style={{ padding: 16, display: 'flex', gap: 10, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => resolveNewSessionPopup('ok')}
              >
                ОК
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => resolveNewSessionPopup('forbid')}
                style={{ background: '#ef4444', borderColor: '#ef4444', color: '#fff' }}
              >
                Запретить
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>,
    host,
  )
}

