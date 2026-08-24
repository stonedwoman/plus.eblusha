import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { create } from 'zustand'
import type { CloudUserLite } from '../types'
import { convertToProxyUrl } from '../../utils/media'

/** Мелкие переиспользуемые куски интерфейса Cloud. */

export function Avatar({ user, size = 'sm', online }: { user: CloudUserLite | null; size?: 'sm' | 'lg'; online?: boolean }) {
  const label = (user?.displayName || user?.username || '?').trim()
  const cls = `cl-ava${size === 'lg' ? ' lg' : ''}${online ? ' online' : ''}`
  const [broken, setBroken] = useState(false)
  const raw = user?.avatarUrl ?? null

  // Аватар может быть эмодзи (`emoji:🐙`) — так их хранит мессенджер.
  if (raw?.startsWith('emoji:')) {
    return (
      <div className={cls} title={label} style={{ fontSize: size === 'lg' ? 19 : 15 }}>
        {raw.slice('emoji:'.length)}
      </div>
    )
  }

  // Через прокси, а не напрямую: в БД лежат абсолютные ссылки на прежний S3,
  // который больше не отдаёт файлы. convertToProxyUrl переводит их на
  // /api/files/uploads/... — тот же путь, которым аватары живут в чате.
  const src = broken ? null : convertToProxyUrl(raw)
  if (src) {
    return (
      <img
        className={cls}
        src={src}
        alt={label}
        title={label}
        loading="lazy"
        onError={() => setBroken(true)}
      />
    )
  }
  return (
    <div className={cls} title={label}>
      {label.slice(0, 1).toUpperCase()}
    </div>
  )
}

export function Modal({
  title,
  onClose,
  children,
  footer,
  wide,
}: {
  title: string
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  wide?: boolean
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="cl-modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="cl-modal" style={wide ? { width: 'min(720px, 100%)' } : undefined} role="dialog" aria-modal="true">
        <div className="cl-modal-head">
          <h2>{title}</h2>
          <div className="cl-spacer" />
          <button className="cl-btn ghost icon sm" onClick={onClose} aria-label="Закрыть">
            ✕
          </button>
        </div>
        <div className="cl-modal-body">{children}</div>
        {footer ? <div className="cl-modal-foot">{footer}</div> : null}
      </div>
    </div>
  )
}

// ── Тосты ────────────────────────────────────────────────────────────────────

type Toast = { id: number; text: string; kind: 'info' | 'error' | 'success' }
type ToastStore = { toasts: Toast[]; push: (t: Omit<Toast, 'id'>) => void; drop: (id: number) => void }

const useToastStore = create<ToastStore>((set) => ({
  toasts: [],
  push: (t) =>
    set((s) => {
      const id = Date.now() + Math.random()
      setTimeout(() => set((cur) => ({ toasts: cur.toasts.filter((x) => x.id !== id) })), t.kind === 'error' ? 7000 : 3800)
      return { toasts: [...s.toasts, { ...t, id }] }
    }),
  drop: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}))

export const toast = {
  info: (text: string) => useToastStore.getState().push({ text, kind: 'info' }),
  error: (text: string) => useToastStore.getState().push({ text, kind: 'error' }),
  success: (text: string) => useToastStore.getState().push({ text, kind: 'success' }),
}

export function Toasts() {
  const toasts = useToastStore((s) => s.toasts)
  const drop = useToastStore((s) => s.drop)
  return (
    <div className="cl-toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`cl-toast ${t.kind}`} onClick={() => drop(t.id)}>
          <span>{t.text}</span>
        </div>
      ))}
    </div>
  )
}

export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    // Небезопасный контекст или отказ в разрешении — старый добрый execCommand.
    try {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      const ok = document.execCommand('copy')
      document.body.removeChild(ta)
      return ok
    } catch {
      return false
    }
  }
}

export function Empty({ icon, title, text, action }: { icon?: ReactNode; title: string; text?: string; action?: ReactNode }) {
  return (
    <div className="cl-empty">
      {icon ? <div style={{ fontSize: 40, opacity: 0.45 }}>{icon}</div> : null}
      <h3>{title}</h3>
      {text ? <p>{text}</p> : null}
      {action ? <div style={{ marginTop: 18 }}>{action}</div> : null}
    </div>
  )
}

export function SkeletonTiles({ count = 12 }: { count?: number }) {
  return (
    <div className="cl-tiles">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="cl-skeleton" style={{ aspectRatio: '1' }} />
      ))}
    </div>
  )
}

/**
 * Наблюдатель «конца списка» — бесконечная подгрузка вместо кнопки «ещё».
 *
 * Ref-объект здесь не годится: его присвоение не вызывает повторный рендер, и
 * если узел появлялся ПОСЛЕ первого прогона эффекта (а он появляется — сначала
 * рисуется скелетон, потом список), наблюдатель молча цеплялся к null и не
 * работал вовсе. Поэтому callback-ref: узел живёт в состоянии и входит в deps.
 *
 * root тоже важен: реальный скроллер — .cl-root, а не окно (у документа
 * прокрутка залочена мессенджером). Без него rootMargin считался от вьюпорта и
 * срабатывал не тогда, когда нужно.
 */
export function useInfiniteSentinel(onHit: () => void, enabled: boolean) {
  const [node, setNode] = useState<HTMLDivElement | null>(null)
  const cb = useRef(onHit)
  cb.current = onHit

  useEffect(() => {
    if (!enabled || !node) return
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) cb.current()
      },
      { root: node.closest('.cl-root'), rootMargin: '600px 0px' }
    )
    io.observe(node)
    return () => io.disconnect()
  }, [enabled, node])

  return useCallback((el: HTMLDivElement | null) => setNode(el), [])
}

/** QR генерируется в браузере: отдельный серверный генератор картинок не нужен. */
export function QrCode({ text, size = 200 }: { text: string; size?: number }) {
  const [dataUrl, setDataUrl] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    void import('qrcode').then(async (QR) => {
      try {
        const url = await QR.toDataURL(text, {
          width: size,
          margin: 1,
          color: { dark: '#0f1217', light: '#ffffff' },
        })
        if (alive) setDataUrl(url)
      } catch {
        if (alive) setDataUrl(null)
      }
    })
    return () => {
      alive = false
    }
  }, [text, size])
  if (!dataUrl) return <div className="cl-skeleton" style={{ width: size, height: size }} />
  return <img src={dataUrl} width={size} height={size} alt="QR-код ссылки" style={{ borderRadius: 10, display: 'block' }} />
}
