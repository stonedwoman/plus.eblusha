/**
 * «Без звука» — кусочки интерфейса веба (docs/conversation-mute.md §7):
 *  - MutedBellIcon — перечёркнутый колокольчик после названия беседы (плитка, шапка) с подсказкой
 *    «Без звука до 18:30» / «…навсегда»; беседа не заглушена — ничего;
 *  - MuteMenuSection — первый пункт меню беседы (правый клик / «⋮» плитки и «⋮» шапки):
 *      * не заглушена: «Без звука ▸» — подменю справа («1 час» … «Навсегда»); на телефонной ширине и
 *        тач-экранах подменю по наведению не работает, поэтому выбор срока раскрывается ВНУТРИ того же
 *        меню (MuteInlinePicker): «← Без звука на…», пять вариантов и «Отмена» (остальные пункты на это
 *        время прячутся);
 *      * заглушена: «Включить звук» с серой второй строкой «до 18:30» / «навсегда».
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Bell, BellOff, ChevronRight } from 'lucide-react'
import { muteLabel, muteTooltip, MUTE_PRESET_OPTIONS, MUTE_TEXT, type MutePreset } from '../../../../domain/mute/muteRules'
import { muteStore, useMutedUntil } from '../../../../domain/mute/muteSync'
import { setConversationMute } from '../hooks/useConversationMute'
import { MuteInlinePicker } from './MuteInlinePicker'

const MUTED_COLOR = 'var(--text-muted)'

export function MutedBellIcon({ conversationId, size = 14 }: { conversationId: string | null | undefined; size?: number }) {
  const until = useMutedUntil(conversationId)
  if (until === null) return null
  const tip = muteTooltip(until, muteStore.serverNow())
  return (
    <span
      className="eb-muted-bell"
      role="img"
      aria-label={MUTE_TEXT.mute}
      title={tip}
      data-testid="muted-bell"
      style={{ display: 'inline-flex', alignItems: 'center', flexShrink: 0, color: MUTED_COLOR, lineHeight: 0 }}
    >
      <BellOff size={size} color={MUTED_COLOR} aria-hidden />
    </span>
  )
}

function prefersInlinePicker(): boolean {
  try {
    return typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia('(hover: none)').matches
  } catch {
    return false
  }
}

const itemStyle = { display: 'flex', alignItems: 'center', gap: 8 } as const

export function MuteMenuSection(props: {
  conversationId: string
  /** Телефонная ширина: выбор срока внутри меню, а не подменю справа. */
  mobile: boolean
  /** Закрыть всё меню беседы. */
  onClose: () => void
  /** Остальные пункты меню (идут после «Без звука»). */
  children?: ReactNode
}) {
  const { conversationId, mobile, onClose, children } = props
  const until = useMutedUntil(conversationId)
  const inline = mobile || prefersInlinePicker()
  const [pickerOpen, setPickerOpen] = useState(false)
  const [subOpen, setSubOpen] = useState(false)
  const anchorRef = useRef<HTMLDivElement | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const subRef = useRef<HTMLDivElement | null>(null)
  const closeTimerRef = useRef<number | null>(null)

  const choose = (preset: MutePreset | null) => {
    onClose()
    void setConversationMute(conversationId, preset)
  }

  // Встроенный выбор срока выше прежнего меню — не даём ему уехать за низ экрана.
  useLayoutEffect(() => {
    const menu = rootRef.current?.closest('.msg-menu') as HTMLElement | null
    if (!menu) return
    menu.style.transform = ''
    if (!pickerOpen) return
    const vh = (window as any).visualViewport ? (window as any).visualViewport.height : window.innerHeight
    const rect = menu.getBoundingClientRect()
    const over = rect.bottom - (vh - 8)
    if (over > 0) menu.style.transform = `translateY(${-Math.min(over, Math.max(0, rect.top - 8))}px)`
    return () => {
      menu.style.transform = ''
    }
  }, [pickerOpen])

  // Подменю справа: если не влезает — слева; если уходит под низ — поднимаем.
  useLayoutEffect(() => {
    const sub = subRef.current
    const anchor = anchorRef.current
    if (!subOpen || !sub || !anchor) return
    const vw = window.innerWidth
    const vh = (window as any).visualViewport ? (window as any).visualViewport.height : window.innerHeight
    const a = anchor.getBoundingClientRect()
    const s = sub.getBoundingClientRect()
    const gap = 6
    if (a.right + gap + s.width > vw - 8 && a.left - gap - s.width >= 8) {
      sub.style.left = 'auto'
      sub.style.right = `calc(100% + ${gap}px)`
    }
    const overBottom = a.top - 6 + s.height - (vh - 8)
    if (overBottom > 0) sub.style.top = `${-6 - overBottom}px`
  }, [subOpen])

  useEffect(
    () => () => {
      if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current)
    },
    [],
  )

  const cancelClose = () => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current)
      closeTimerRef.current = null
    }
  }
  const scheduleClose = () => {
    cancelClose()
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null
      setSubOpen(false)
    }, 220)
  }

  if (until !== null) {
    const label = muteLabel(until, muteStore.serverNow())
    return (
      <div ref={rootRef} style={{ display: 'contents' }}>
        <button type="button" data-testid="mute-menu-unmute" onClick={() => choose(null)} style={itemStyle}>
          <Bell size={16} />
          <span style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.2, minWidth: 0 }}>
            <span>{MUTE_TEXT.unmute}</span>
            <span style={{ fontSize: 12, color: MUTED_COLOR }}>{label}</span>
          </span>
        </button>
        {children}
      </div>
    )
  }

  if (inline) {
    if (pickerOpen) {
      return (
        <div ref={rootRef} style={{ display: 'contents' }}>
          <MuteInlinePicker onBack={() => setPickerOpen(false)} onChoose={choose} onCancel={onClose} />
        </div>
      )
    }
    return (
      <div ref={rootRef} style={{ display: 'contents' }}>
        <button type="button" data-testid="mute-menu-mute" onClick={() => setPickerOpen(true)} style={itemStyle}>
          <BellOff size={16} />
          <span style={{ flex: 1 }}>{MUTE_TEXT.mute}</span>
          <ChevronRight size={16} color={MUTED_COLOR} />
        </button>
        {children}
      </div>
    )
  }

  return (
    <div ref={rootRef} style={{ display: 'contents' }}>
      <div
        ref={anchorRef}
        style={{ position: 'relative', display: 'flex', flexDirection: 'column' }}
        onMouseEnter={() => {
          cancelClose()
          setSubOpen(true)
        }}
        onMouseLeave={scheduleClose}
      >
        <button
          type="button"
          data-testid="mute-menu-mute"
          aria-haspopup="menu"
          aria-expanded={subOpen}
          onClick={() => {
            cancelClose()
            setSubOpen((v) => !v)
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowRight') {
              cancelClose()
              setSubOpen(true)
            }
          }}
          style={{ ...itemStyle, background: subOpen ? 'var(--surface-100)' : undefined }}
        >
          <BellOff size={16} />
          <span style={{ flex: 1 }}>{MUTE_TEXT.mute}</span>
          <ChevronRight size={16} color={MUTED_COLOR} />
        </button>
        {subOpen && (
          <div
            ref={subRef}
            className="msg-menu"
            role="menu"
            data-testid="mute-submenu"
            style={{ position: 'absolute', left: 'calc(100% + 6px)', top: -6, minWidth: 140 }}
            onClick={(e) => e.stopPropagation()}
          >
            {MUTE_PRESET_OPTIONS.map((o) => (
              <button key={o.preset} type="button" role="menuitem" data-testid={`mute-preset-${o.preset}`} onClick={() => choose(o.preset)}>
                {o.label}
              </button>
            ))}
          </div>
        )}
      </div>
      {children}
    </div>
  )
}
