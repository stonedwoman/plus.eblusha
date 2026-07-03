import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { CalendarDays, Check, ChevronLeft, ChevronRight, Copy, KeyRound, Trash2, X } from 'lucide-react'
import { Avatar } from './Avatar'
import { convertToProxyUrl } from '../../utils/media'

/**
 * Universal user card (Telegram/Discord-style profile popover).
 *
 * - `UserProfileHero` — banner + overlapping avatar + name/status/bio + info rows.
 *   The avatar opens a full-image viewer with avatar history (delete for the owner).
 *   Embeddable (the self «Профиль» popup reuses it above the sessions block).
 * - `UserProfileCard` — the standalone card: hero + action buttons + a children slot.
 *
 * The banner gradient derives from the user id (same identity-hue idea as the
 * avatar fallback), so every profile gets a stable personal palette.
 *
 * PRIVACY: the login-secret `username` is NEVER shown — EBLID takes its place.
 */

export type CardUser = {
  id: string
  displayName?: string | null
  avatarUrl?: string | null
  status?: string | null
  lastSeenAt?: string | null
  bio?: string | null
  createdAt?: string | null
  /** current + past avatar URLs (from GET /users/:id or /status/me). */
  avatars?: string[] | null
}

export type CardPresence = 'ONLINE' | 'AWAY' | 'BACKGROUND' | 'OFFLINE' | 'IN_CALL' | 'PLAYING'

export type CardAction = {
  key: string
  icon: ReactNode
  label: string
  onClick: () => void
  tint?: string
}

function hashHue(id: string): number {
  let h = 0
  for (let i = 0; i < id.length; i += 1) h = (h * 31 + id.charCodeAt(i)) | 0
  return Math.abs(h) % 360
}

function statusDotColor(s?: string | null): string {
  const v = (s ?? 'OFFLINE').toString().toUpperCase()
  if (v === 'ONLINE') return '#22c55e'
  if (v === 'IN_CALL') return '#ef4444'
  if (v === 'BACKGROUND') return '#facc15'
  if (v === 'AWAY') return '#f59e0b'
  return '#9ca3af'
}

/** Resolve a raw avatar URL to a displayable <img src>; null for emoji/blank. */
function resolveAvatarSrc(raw: string | null | undefined): string | null {
  if (!raw) return null
  const s = String(raw)
  if (s.startsWith('emoji:')) return null
  if (s.startsWith('data:') || s.startsWith('blob:')) return s
  const proxied = convertToProxyUrl(s)
  return proxied ?? s
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255; g /= 255; b /= 255
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b)
  const l = (mx + mn) / 2
  let h = 0, s = 0
  const d = mx - mn
  if (d !== 0) {
    s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn)
    if (mx === r) h = (g - b) / d + (g < b ? 6 : 0)
    else if (mx === g) h = (b - r) / d + 2
    else h = (r - g) / d + 4
    h *= 60
  }
  return [h, s, l]
}

/**
 * Derive a banner hue/saturation from the current avatar image (same-origin canvas
 * sample — the /api/files proxy keeps it untainted). Falls back to null on any cross-
 * origin taint / decode error, so the caller uses the identity-hue gradient instead.
 * Weights saturated mid-tone pixels so the banner picks up the avatar's real accent.
 */
function useAvatarPalette(src: string | null): { h: number; s: number } | null {
  const [pal, setPal] = useState<{ h: number; s: number } | null>(null)
  useEffect(() => {
    if (!src) { setPal(null); return }
    let cancelled = false
    const img = new Image()
    img.onload = () => {
      if (cancelled) return
      try {
        const N = 22
        const cvs = document.createElement('canvas')
        cvs.width = N; cvs.height = N
        const ctx = cvs.getContext('2d')
        if (!ctx) { setPal(null); return }
        ctx.drawImage(img, 0, 0, N, N)
        const d = ctx.getImageData(0, 0, N, N).data
        let rs = 0, gs = 0, bs = 0, wsum = 0
        let bestSat = -1, bestHue = 0
        for (let i = 0; i < d.length; i += 4) {
          if (d[i + 3] < 200) continue
          const r = d[i], g = d[i + 1], b = d[i + 2]
          const [h, s, l] = rgbToHsl(r, g, b)
          if (l < 0.08 || l > 0.95) continue // skip near-black / near-white
          const w = 0.15 + s
          rs += r * w; gs += g * w; bs += b * w; wsum += w
          if (s > bestSat) { bestSat = s; bestHue = h }
        }
        if (wsum === 0) { setPal(null); return }
        const [avgH, avgS] = rgbToHsl(rs / wsum, gs / wsum, bs / wsum)
        // Muddy/grey average → borrow the most vibrant pixel's hue.
        const h = avgS < 0.15 && bestSat > 0.2 ? bestHue : avgH
        const s = Math.min(0.7, Math.max(0.3, Math.max(avgS, bestSat * 0.7)))
        setPal({ h, s })
      } catch {
        setPal(null) // tainted canvas (cross-origin) → fall back to identity hue
      }
    }
    img.onerror = () => { if (!cancelled) setPal(null) }
    img.src = src
    return () => { cancelled = true }
  }, [src])
  return pal
}

function InfoRow(props: {
  icon: ReactNode
  label: string
  value: string
  copyable?: boolean
  copied?: boolean
  onClick?: () => void
  topBorder?: boolean
}) {
  const { icon, label, value, copyable, copied, onClick, topBorder } = props
  return (
    <div
      onClick={onClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '11px 14px',
        borderTop: topBorder ? '1px solid var(--surface-border)' : 'none',
        cursor: onClick ? 'pointer' : 'default',
      }}
      onMouseEnter={(e) => { if (onClick) e.currentTarget.style.background = 'rgba(255,255,255,0.03)' }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
    >
      <span style={{ width: 30, height: 30, borderRadius: 9, background: 'var(--surface-300)', border: '1px solid var(--surface-border)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', flex: '0 0 auto' }}>
        {icon}
      </span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: 'block', fontSize: 11, fontWeight: 600, letterSpacing: 0.3, color: 'var(--text-muted)', textTransform: 'uppercase' }}>{label}</span>
        <span style={{ display: 'block', fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{value}</span>
      </span>
      {copyable && (
        <span style={{ color: copied ? '#22c55e' : 'var(--text-muted)', flex: '0 0 auto', display: 'inline-flex' }}>
          {copied ? <Check size={15} /> : <Copy size={15} />}
        </span>
      )}
    </div>
  )
}

/** Fullscreen avatar viewer with a history strip; owner can delete past avatars. */
function AvatarViewer(props: {
  items: Array<{ raw: string; src: string; isCurrent: boolean }>
  startIndex: number
  canManage?: boolean
  onDelete?: (raw: string) => void
  onClose: () => void
}) {
  const { items, startIndex, canManage, onDelete, onClose } = props
  const [idx, setIdx] = useState(Math.min(Math.max(0, startIndex), items.length - 1))
  if (items.length === 0) return null
  const cur = items[Math.min(idx, items.length - 1)]
  const go = (d: number) => setIdx((i) => (i + d + items.length) % items.length)
  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 200, background: 'rgba(6,7,10,0.92)',
        backdropFilter: 'blur(6px)', display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center', padding: 20,
      }}
    >
      <button
        type="button" onClick={onClose} aria-label="Закрыть"
        style={{ position: 'absolute', top: 16, right: 16, width: 40, height: 40, borderRadius: 999, border: '1px solid rgba(255,255,255,0.16)', background: 'rgba(255,255,255,0.08)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}
      >
        <X size={20} />
      </button>

      <div onClick={(e) => e.stopPropagation()} style={{ position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center', maxWidth: '92vw', maxHeight: '70vh' }}>
        {items.length > 1 && (
          <button type="button" onClick={() => go(-1)} aria-label="Назад" style={navBtn('left')}><ChevronLeft size={26} /></button>
        )}
        <img src={cur.src} alt="avatar" style={{ maxWidth: '92vw', maxHeight: '70vh', borderRadius: 16, objectFit: 'contain', boxShadow: '0 24px 70px rgba(0,0,0,0.6)' }} />
        {items.length > 1 && (
          <button type="button" onClick={() => go(1)} aria-label="Вперёд" style={navBtn('right')}><ChevronRight size={26} /></button>
        )}
      </div>

      {/* History strip */}
      {items.length > 1 && (
        <div onClick={(e) => e.stopPropagation()} style={{ marginTop: 18, display: 'flex', gap: 10, overflowX: 'auto', maxWidth: '92vw', padding: '4px 2px' }}>
          {items.map((it, i) => (
            <div key={it.raw + i} style={{ position: 'relative', flex: '0 0 auto' }}>
              <img
                src={it.src} alt="" onClick={() => setIdx(i)}
                style={{
                  width: 58, height: 58, borderRadius: 12, objectFit: 'cover', cursor: 'pointer',
                  border: i === idx ? '2px solid var(--brand-600)' : '2px solid transparent',
                  opacity: i === idx ? 1 : 0.6,
                }}
              />
              {canManage && !it.isCurrent && onDelete && (
                <button
                  type="button" aria-label="Удалить"
                  onClick={(e) => { e.stopPropagation(); onDelete(it.raw) }}
                  style={{ position: 'absolute', top: -6, right: -6, width: 22, height: 22, borderRadius: 999, border: '1px solid rgba(255,255,255,0.2)', background: '#ef4444', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', padding: 0 }}
                >
                  <Trash2 size={12} />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      <div style={{ marginTop: 10, fontSize: 12, color: 'rgba(255,255,255,0.6)' }}>
        {cur.isCurrent ? 'Текущий аватар' : 'Прошлый аватар'}{items.length > 1 ? ` · ${idx + 1}/${items.length}` : ''}
      </div>
    </div>
  )
}

function navBtn(side: 'left' | 'right'): React.CSSProperties {
  return {
    position: 'absolute', [side]: -6, top: '50%', transform: 'translateY(-50%)',
    width: 44, height: 44, borderRadius: 999, border: '1px solid rgba(255,255,255,0.16)',
    background: 'rgba(255,255,255,0.10)', color: '#fff', display: 'flex', alignItems: 'center',
    justifyContent: 'center', cursor: 'pointer', zIndex: 2,
  } as React.CSSProperties
}

export function UserProfileHero(props: {
  user: CardUser
  statusText: string
  presence?: CardPresence
  inCall?: boolean
  /** Shown in place of the (hidden) username, for everyone. */
  eblid?: string | null
  /** current + past avatar URLs; drives the full-image viewer. Falls back to [avatarUrl]. */
  avatars?: string[] | null
  canManageAvatars?: boolean
  onDeleteAvatar?: (rawUrl: string) => void
  onClose?: () => void
  compact?: boolean
  /** Groups have no presence — hide the coloured status dot, keep the text. */
  hideStatusDot?: boolean
}) {
  const { user, statusText, presence, inCall, eblid, avatars, canManageAvatars, onDeleteAvatar, onClose, compact, hideStatusDot } = props
  const heroSrc = useMemo(() => resolveAvatarSrc(user.avatarUrl), [user.avatarUrl])
  const palette = useAvatarPalette(heroSrc)
  // Banner colours: from the avatar if we could sample it, else the stable identity hue.
  const hue = palette ? palette.h : hashHue(String(user.id ?? 'u'))
  const sat = palette ? Math.round(palette.s * 100) : 58
  const name = (user.displayName && String(user.displayName).trim()) || 'Без имени'
  const [copied, setCopied] = useState<string | null>(null)
  const [viewerAt, setViewerAt] = useState<number | null>(null)
  const copy = (key: string, value: string) => {
    try { void navigator.clipboard?.writeText(value) } catch { /* clipboard unavailable */ }
    setCopied(key)
    window.setTimeout(() => setCopied((c) => (c === key ? null : c)), 1400)
  }
  const joined = user.createdAt ? new Date(user.createdAt) : null
  const joinedText = joined && !Number.isNaN(joined.getTime())
    ? joined.toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' })
    : null
  const bio = user.bio && String(user.bio).trim() ? String(user.bio).trim() : null

  // Resolve the avatar history (current first). Falls back to the single current avatar.
  const viewerItems = useMemo(() => {
    const raws = (avatars && avatars.length ? avatars : [user.avatarUrl]).filter(
      (u): u is string => typeof u === 'string' && u.length > 0,
    )
    // de-dup, current stays index 0
    const seen = new Set<string>()
    const out: Array<{ raw: string; src: string; isCurrent: boolean }> = []
    raws.forEach((raw, i) => {
      if (seen.has(raw)) return
      seen.add(raw)
      const src = resolveAvatarSrc(raw)
      if (src) out.push({ raw, src, isCurrent: i === 0 })
    })
    return out
  }, [avatars, user.avatarUrl])
  const canOpenViewer = viewerItems.length > 0

  const eblidValue = eblid != null && String(eblid).trim() ? String(eblid).trim() : null
  const hasInfo = eblidValue != null || !!joinedText

  return (
    <div>
      {/* Personal banner: identity-hue gradient + soft highlight. */}
      <div
        style={{
          position: 'relative',
          height: compact ? 84 : 104,
          background: `linear-gradient(130deg, hsl(${hue} ${sat}% 32%) 0%, hsl(${(hue + 22) % 360} ${sat}% 20%) 55%, hsl(${(hue + 336) % 360} ${sat}% 12%) 100%)`,
          overflow: 'hidden',
          transition: 'background .35s ease',
        }}
      >
        <div style={{ position: 'absolute', inset: 0, background: `radial-gradient(130% 100% at 12% 0%, hsl(${hue} ${Math.min(90, sat + 25)}% 60% / 0.34) 0%, transparent 55%)` }} />
        <div style={{ position: 'absolute', inset: 0, background: 'radial-gradient(90% 130% at 100% 100%, rgba(0,0,0,0.28) 0%, transparent 60%)' }} />
        {onClose && (
          <button
            type="button" onClick={onClose} aria-label="Закрыть"
            style={{ position: 'absolute', top: 10, right: 10, width: 32, height: 32, borderRadius: 999, border: '1px solid rgba(255,255,255,0.16)', background: 'rgba(10,12,16,0.35)', backdropFilter: 'blur(6px)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', padding: 0 }}
          >
            <X size={16} />
          </button>
        )}
      </div>

      {/* Avatar overlapping the banner. Click → full-image viewer with history. */}
      <div style={{ padding: '0 20px', marginTop: compact ? -34 : -42, position: 'relative' }}>
        <div
          onClick={canOpenViewer ? () => setViewerAt(0) : undefined}
          style={{ display: 'inline-flex', borderRadius: '50%', padding: 4, background: 'var(--surface-200)', boxShadow: '0 10px 26px rgba(5,6,9,0.45)', cursor: canOpenViewer ? 'pointer' : 'default', position: 'relative' }}
          title={canOpenViewer ? 'Открыть аватар' : undefined}
        >
          <Avatar
            name={name}
            id={user.id}
            size={compact ? 68 : 82}
            avatarUrl={user.avatarUrl && String(user.avatarUrl).trim() ? user.avatarUrl : undefined}
            presence={presence}
            inCall={inCall}
          />
          {viewerItems.length > 1 && (
            <span style={{ position: 'absolute', bottom: 4, right: 4, minWidth: 20, height: 20, padding: '0 5px', borderRadius: 999, background: 'rgba(10,12,16,0.72)', border: '1px solid rgba(255,255,255,0.14)', color: '#fff', fontSize: 11, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              {viewerItems.length}
            </span>
          )}
        </div>
      </div>

      {/* Name + live status line. */}
      <div style={{ padding: '8px 20px 0' }}>
        <div style={{ fontWeight: 800, fontSize: compact ? 18 : 20, color: 'var(--text-primary)', lineHeight: 1.25, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {name}
        </div>
        <div style={{ marginTop: 4, display: 'flex', alignItems: 'center', gap: 7, fontSize: 13, color: 'var(--text-muted)' }}>
          {!hideStatusDot && (
            <span style={{ width: 8, height: 8, borderRadius: 999, background: statusDotColor(user.status), boxShadow: `0 0 10px ${statusDotColor(user.status)}66`, flex: '0 0 auto' }} />
          )}
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{statusText}</span>
        </div>
        {bio && (
          <div style={{ marginTop: 10, fontSize: 14, lineHeight: 1.45, color: 'var(--text-primary)', opacity: 0.88, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
            {bio}
          </div>
        )}
      </div>

      {/* Info rows (EBLID / joined date). Username is intentionally never shown. */}
      {hasInfo && (
        <div style={{ margin: '14px 20px 0', border: '1px solid var(--surface-border)', borderRadius: 14, background: 'var(--surface-100)', overflow: 'hidden' }}>
          {eblidValue != null && (
            <InfoRow
              icon={<KeyRound size={15} />}
              label="EBLID"
              value={eblidValue}
              copyable
              copied={copied === 'e'}
              onClick={() => copy('e', eblidValue)}
            />
          )}
          {joinedText && (
            <InfoRow
              icon={<CalendarDays size={15} />}
              label="В Еблуше с"
              value={joinedText}
              topBorder={eblidValue != null}
            />
          )}
        </div>
      )}

      {viewerAt != null && (
        <AvatarViewer
          items={viewerItems}
          startIndex={viewerAt}
          canManage={canManageAvatars}
          onDelete={onDeleteAvatar ? (raw) => { onDeleteAvatar(raw); if (viewerItems.length <= 1) setViewerAt(null) } : undefined}
          onClose={() => setViewerAt(null)}
        />
      )}
    </div>
  )
}

export function UserProfileCard(props: {
  user: CardUser
  statusText: string
  presence?: CardPresence
  inCall?: boolean
  eblid?: string | null
  avatars?: string[] | null
  actions?: CardAction[]
  onClose: () => void
  isMobile?: boolean
  children?: ReactNode
}) {
  const { user, statusText, presence, inCall, eblid, avatars, actions, onClose, isMobile, children } = props
  return (
    <div
      style={{
        width: isMobile ? '100%' : 400,
        maxWidth: '92vw',
        background: 'var(--surface-200)',
        borderRadius: 20,
        border: '1px solid var(--surface-border)',
        boxShadow: 'var(--shadow-soft)',
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        maxHeight: isMobile ? 'calc(100vh - 32px)' : '88vh',
      }}
    >
      <div style={{ overflowY: 'auto', flex: 1, minHeight: 0 }}>
        <UserProfileHero
          user={user}
          statusText={statusText}
          presence={presence}
          inCall={inCall}
          eblid={eblid}
          avatars={avatars}
          onClose={onClose}
        />

        {actions && actions.length > 0 && (
          <div style={{ display: 'flex', gap: 10, padding: '16px 20px 0' }}>
            {actions.map((a) => (
              <button
                key={a.key}
                type="button"
                onClick={a.onClick}
                style={{
                  flex: 1,
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  gap: 6,
                  padding: '12px 8px',
                  borderRadius: 14,
                  border: '1px solid var(--surface-border)',
                  background: 'var(--surface-100)',
                  color: a.tint ?? 'var(--brand-600)',
                  cursor: 'pointer',
                  transition: 'transform .12s ease, border-color .12s ease, background .12s ease',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.borderColor = 'var(--surface-border-strong)'
                  e.currentTarget.style.background = 'var(--surface-300)'
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.borderColor = 'var(--surface-border)'
                  e.currentTarget.style.background = 'var(--surface-100)'
                  e.currentTarget.style.transform = 'none'
                }}
                onMouseDown={(e) => { e.currentTarget.style.transform = 'scale(0.97)' }}
                onMouseUp={(e) => { e.currentTarget.style.transform = 'none' }}
              >
                {a.icon}
                <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.4, color: 'var(--text-muted)' }}>{a.label}</span>
              </button>
            ))}
          </div>
        )}

        {children && <div style={{ padding: '14px 20px 0' }}>{children}</div>}
        <div style={{ height: 18 }} />
      </div>
    </div>
  )
}
