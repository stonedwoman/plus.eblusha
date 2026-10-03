/**
 * Значок режима шифрования звонка. Щит, а не замок: замок читается как сквозное шифрование,
 * а ключ звонка 1:1 пока выдаёт сервер (callSecurity.ts). Перечёркнутый щит — без шифрования.
 */
import { Shield, ShieldOff } from 'lucide-react'
import { CALL_SECURITY_DETAIL, CALL_SECURITY_LABEL, type CallSecurity } from './callSecurity'

export function CallSecurityIcon({ security, size = 12 }: { security: CallSecurity; size?: number }) {
  const Icon = security === 'server-key' ? Shield : ShieldOff
  return <Icon size={size} aria-hidden="true" focusable="false" />
}

/** Значок с подписью для экранных читалок и подсказкой по наведению (текст — по желанию). */
export function CallSecurityMark({
  security,
  size = 12,
  withText = false,
  className,
}: {
  security: CallSecurity
  size?: number
  withText?: boolean
  className?: string
}) {
  const label = CALL_SECURITY_LABEL[security]
  return (
    <span
      className={`eb-call-sec is-${security}${className ? ` ${className}` : ''}`}
      role={withText ? undefined : 'img'}
      aria-label={withText ? undefined : label}
      title={`${label}. ${CALL_SECURITY_DETAIL[security]}`}
      data-call-security={security}
      style={{ display: 'inline-flex', alignItems: 'center', gap: withText ? 6 : 0 }}
    >
      <CallSecurityIcon security={security} size={size} />
      {withText && <span className="eb-call-sec__text">{label}</span>}
    </span>
  )
}

/**
 * Плашка состояния развёрнутого звонка: «Подключено · [щит] Шифрование через сервер» или
 * «… · Без шифрования». floating — в углу оверлея звонка (как раньше ConnectionStatusBadge).
 */
export function CallStatusPill({
  label,
  security,
  floating = false,
}: {
  label: string
  security: CallSecurity | null
  floating?: boolean
}) {
  return (
    <div
      className="eb-conn-badge"
      data-call-security={security ?? undefined}
      title={security ? `${CALL_SECURITY_LABEL[security]}. ${CALL_SECURITY_DETAIL[security]}` : undefined}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        ...(floating ? { position: 'absolute' as const, top: 10, left: 10, zIndex: 20 } : {}),
        padding: '6px 10px',
        borderRadius: 999,
        background: 'rgba(0,0,0,0.45)',
        border: '1px solid rgba(255,255,255,0.12)',
        fontSize: 12,
        color: '#fff',
        backdropFilter: 'blur(6px)',
      }}
    >
      {label}
      {security && (
        <>
          <span aria-hidden="true" style={{ opacity: 0.5 }}>
            ·
          </span>
          <span style={{ display: 'inline-flex', color: security === 'server-key' ? '#e38b0a' : '#9aa0a8' }}>
            <CallSecurityIcon security={security} size={13} />
          </span>
          <span>{CALL_SECURITY_LABEL[security]}</span>
        </>
      )}
    </div>
  )
}
