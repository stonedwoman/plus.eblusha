/**
 * Кирпичики «Центра управления»: значки, строка единого вида, тумблер, итог у строки, сегменты, вкладки,
 * список, капсулы, пунктирная пометка, ebox, вопрос на месте, панель сохранения (SPEC §3.6–§3.11).
 * Вид — settings.css (классы ebs-*). Поиск подсвечивает слова прямо в названиях и пояснениях (Hl).
 */
import { createContext, useContext, useEffect, useId, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'
import {
  AppWindow,
  ArrowLeft,
  ArrowRight,
  Bell,
  Camera,
  Check,
  ChevronRight,
  CircleAlert,
  Clock,
  Copy,
  ExternalLink,
  Globe,
  Headphones,
  Image as ImageIcon,
  Info,
  KeyRound,
  LayoutGrid,
  Lock,
  LogOut,
  Maximize2,
  MessageSquare,
  Mic,
  Monitor,
  Pencil,
  Phone,
  PlayCircle,
  QrCode,
  RotateCw,
  ScanLine,
  ScreenShare,
  Search,
  Server,
  Shield,
  SlidersHorizontal,
  Smartphone,
  Star,
  Tablet,
  Trash2,
  UserRound,
  Video,
  X,
  Zap,
  type LucideIcon,
} from 'lucide-react'
import { splitHighlight } from './settingsIndex'
import type { SettingsMode } from './settingsLayout'

// ───────────────────────────── значки (SPEC §3.4: lucide) ─────────────────────────────

const ICONS = {
  user: UserRound,
  globe: Globe,
  mic: Mic,
  shield: Shield,
  app: AppWindow,
  grid: LayoutGrid,
  search: Search,
  x: X,
  expand: Maximize2,
  chev: ChevronRight,
  back: ArrowLeft,
  logout: LogOut,
  check: Check,
  alert: CircleAlert,
  info: Info,
  lock: Lock,
  zap: Zap,
  phone: Phone,
  server: Server,
  headphones: Headphones,
  video: Video,
  sliders: SlidersHorizontal,
  share: ScreenShare,
  key: KeyRound,
  smartphone: Smartphone,
  tablet: Tablet,
  monitor: Monitor,
  browser: Globe,
  clock: Clock,
  bot: MessageSquare,
  image: ImageIcon,
  copy: Copy,
  pencil: Pencil,
  external: ExternalLink,
  qr: QrCode,
  scan: ScanLine,
  bell: Bell,
  play: PlayCircle,
  star: Star,
  trash: Trash2,
  retry: RotateCw,
  arrow: ArrowRight,
  camera: Camera,
} satisfies Record<string, LucideIcon>

export type IconName = keyof typeof ICONS

export function Ic({ n, className }: { n: IconName; className?: string }) {
  const C = ICONS[n]
  return <C className={`ebs-ic${className ? ' ' + className : ''}`} aria-hidden="true" focusable="false" strokeWidth={2} />
}

// ───────────────────────────── контекст оформления ─────────────────────────────

export interface SettingsUiState {
  mode: SettingsMode
  query: string
  /** id строк, подходящих под запрос; null — поиска нет */
  matchIds: ReadonlySet<string> | null
  /** строка, которую надо кратко подсветить после перехода из выдачи */
  flashId: string | null
}

const UiCtx = createContext<SettingsUiState>({ mode: 'wide', query: '', matchIds: null, flashId: null })
export const SettingsUiProvider = UiCtx.Provider
export const useSettingsUi = (): SettingsUiState => useContext(UiCtx)

/** Текст с подсвеченными словами поиска (названия, пояснения, заголовки). */
export function Hl({ text }: { text: string }) {
  const { query } = useSettingsUi()
  if (!query) return <>{text}</>
  const segs = splitHighlight(text, query)
  if (segs.length === 1 && !segs[0].hit) return <>{text}</>
  return (
    <>
      {segs.map((s, i) => (s.hit ? <mark key={i}>{s.t}</mark> : <span key={i}>{s.t}</span>))}
    </>
  )
}

// ───────────────────────────── итог у строки ─────────────────────────────

export type MsgKind = 'ok' | 'busy' | 'err' | 'note' | 'lock' | 'dim'

export function Msg({ kind, children }: { kind: MsgKind; children: ReactNode }) {
  const icon =
    kind === 'ok' ? <Ic n="check" /> : kind === 'err' ? <Ic n="alert" /> : kind === 'note' ? <Ic n="info" /> : kind === 'lock' ? <Ic n="lock" /> : kind === 'busy' ? <span className="ebs-spin" aria-hidden="true" /> : null
  return (
    <div className={`ebs-msg ebs-msg--${kind}`} role={kind === 'err' ? 'alert' : kind === 'dim' ? undefined : 'status'}>
      {icon}
      <span>{children}</span>
    </div>
  )
}

export type RowMsg = { kind: MsgKind; text: string } | null

/** Итог у строки из состояния модели. */
export function MsgLine({ msg }: { msg: RowMsg | undefined }) {
  return msg ? <Msg kind={msg.kind}>{msg.text}</Msg> : null
}

// ───────────────────────────── тумблер ─────────────────────────────

export function Switch({
  checked,
  onChange,
  labelledBy,
  describedBy,
  label,
  disabled,
  small,
  onClickStop,
}: {
  checked: boolean
  onChange: (next: boolean) => void
  labelledBy?: string
  describedBy?: string
  label?: string
  disabled?: boolean
  small?: boolean
  onClickStop?: boolean
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      aria-label={labelledBy ? undefined : label}
      disabled={disabled}
      className={`ebs-sw${small ? ' ebs-sw--sm' : ''}`}
      onClick={(e) => {
        if (onClickStop) e.stopPropagation()
        onChange(!checked)
      }}
    />
  )
}

// ───────────────────────────── строка единого вида ─────────────────────────────

export interface RowProps {
  /** id строки в указателе поиска (можно несколько — через пробел) */
  id?: string
  title: string
  desc?: ReactNode
  desc2?: ReactNode
  /** управление справа (на телефоне, если wide, уходит под текст) */
  ctl?: ReactNode
  ctlTop?: boolean
  wide?: boolean
  err?: boolean
  locked?: boolean
  /** ряд 2 на всю ширину: капсулы, итоги, кнопки к итогу */
  children?: ReactNode
  /** строка-тумблер: вся строка — один переключатель */
  toggle?: { checked: boolean; onChange: (next: boolean) => void; disabled?: boolean }
}

export function Row({ id, title, desc, desc2, ctl, ctlTop, wide, err, locked, children, toggle }: RowProps) {
  const { matchIds, flashId } = useSettingsUi()
  const uid = useId()
  const tId = `${uid}-t`
  const dId = `${uid}-d`
  const ids = id ? id.split(' ') : []
  const matched = matchIds ? ids.some((x) => matchIds.has(x)) : null
  const cls = [
    'ebs-row',
    toggle ? 'ebs-row--tg' : '',
    wide ? 'ebs-row--wide' : '',
    err ? 'ebs-row--err' : '',
    locked ? 'ebs-row--locked' : '',
    matched === true ? 'ebs-row--match' : '',
    matched === false && ids.length ? 'ebs-row--nomatch' : '',
    flashId && ids.includes(flashId) ? 'ebs-row--flash' : '',
  ]
    .filter(Boolean)
    .join(' ')
  const onRowClick = toggle
    ? (e: MouseEvent<HTMLDivElement>) => {
        if (toggle.disabled) return
        // щелчок по кнопке/ссылке/полю внутри строки (например, «Открыть чат») тумблер не переключает
        const t = e.target as HTMLElement
        if (t.closest('button:not([role="switch"]), a, input, textarea, select')) return
        if (t.closest('[role="switch"]')) return // сам тумблер уже переключил себя
        toggle.onChange(!toggle.checked)
      }
    : undefined
  return (
    <div className={cls} data-ebs-id={id || undefined} onClick={onRowClick}>
      <div>
        <div className="ebs-row__t" id={tId}>
          <Hl text={title} />
        </div>
        {typeof desc === 'string' ? (
          <div className="ebs-row__d" id={dId}>
            <Hl text={desc} />
          </div>
        ) : desc ? (
          <div className="ebs-row__d" id={dId}>
            {desc}
          </div>
        ) : null}
        {typeof desc2 === 'string' ? (
          <div className="ebs-row__d2">
            <Hl text={desc2} />
          </div>
        ) : desc2 ? (
          <div className="ebs-row__d2">{desc2}</div>
        ) : null}
      </div>
      {toggle ? (
        <div className="ebs-row__ctl ebs-row__ctl--top">
          <Switch checked={toggle.checked} onChange={toggle.onChange} labelledBy={tId} describedBy={desc ? dId : undefined} disabled={toggle.disabled} />
        </div>
      ) : ctl ? (
        <div className={`ebs-row__ctl${ctlTop ? ' ebs-row__ctl--top' : ''}`}>{ctl}</div>
      ) : null}
      <div className="ebs-row__x">{children}</div>
    </div>
  )
}

// ───────────────────────────── группы и карточки ─────────────────────────────

export function Group({ icon, title, extra, caption, children, first }: { icon?: IconName; title?: string; extra?: ReactNode; caption?: string; children: ReactNode; first?: boolean }) {
  return (
    <section className={`ebs-grp${first ? ' ebs-grp--first' : ''}`}>
      {title ? (
        <div className="ebs-grp__h">
          {icon ? <Ic n={icon} /> : null}
          <h3>
            <Hl text={title} />
          </h3>
          {extra}
        </div>
      ) : null}
      {caption ? (
        <div className="ebs-grp__cap">
          <Hl text={caption} />
        </div>
      ) : null}
      {children}
    </section>
  )
}

export const Card = ({ children, id }: { children: ReactNode; id?: string }) => (
  <div className="ebs-card" data-ebs-id={id}>
    {children}
  </div>
)
export const Small = ({ children }: { children: ReactNode }) => <div className="ebs-small">{children}</div>

// ───────────────────────────── кнопки, капсулы, пометки ─────────────────────────────

type BtnKind = 'def' | 'pri' | 'ghost' | 'danger' | 'dtext'
export function Btn({
  kind = 'def',
  sm,
  icon,
  children,
  className,
  ...rest
}: {
  kind?: BtnKind
  sm?: boolean
  icon?: IconName
  children?: ReactNode
  className?: string
} & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'className' | 'children'>) {
  const cls = ['ebs-btn', sm ? 'ebs-btn--sm' : '', kind === 'pri' ? 'ebs-btn--pri' : '', kind === 'ghost' ? 'ebs-btn--ghost' : '', kind === 'danger' ? 'ebs-btn--danger' : '', kind === 'dtext' ? 'ebs-btn--dtext' : '', className ?? '']
    .filter(Boolean)
    .join(' ')
  return (
    <button type="button" className={cls} {...rest}>
      {icon ? <Ic n={icon} /> : null}
      {children}
    </button>
  )
}

export const Kbd = ({ children }: { children: ReactNode }) => <span className="ebs-kbd">{children}</span>

/** Ctrl на Windows/Linux, ⌘ на macOS. */
export const isMac = (): boolean => typeof navigator !== 'undefined' && /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent || '')
export const modKey = (): string => (isMac() ? '⌘' : 'Ctrl')

export function Dash({ children }: { children: ReactNode }) {
  return (
    <div className="ebs-dash">
      <Ic n="info" />
      <span>{children}</span>
    </div>
  )
}

export function Ebox({ children, onRetry, retryLabel = 'Повторить' }: { children: ReactNode; onRetry?: () => void; retryLabel?: string }) {
  return (
    <div className="ebs-ebox" role="alert">
      <Ic n="alert" />
      <span>{children}</span>
      {onRetry ? (
        <Btn sm icon="retry" onClick={onRetry}>
          {retryLabel}
        </Btn>
      ) : null}
    </div>
  )
}

export function Empty({ icon, title, desc }: { icon: IconName; title: string; desc: string }) {
  return (
    <div className="ebs-empty">
      <Ic n={icon} />
      <div className="ebs-empty__t">{title}</div>
      <div className="ebs-empty__d">{desc}</div>
    </div>
  )
}

// ───────────────────────────── сегменты и вкладки ─────────────────────────────

export function Seg<T extends string | number>({
  value,
  options,
  onChange,
  label,
  full,
  disabled,
}: {
  value: T
  options: ReadonlyArray<{ value: T; label: string }>
  onChange: (v: T) => void
  label: string
  full?: boolean
  disabled?: boolean
}) {
  return (
    <div className={`ebs-seg${full ? ' ebs-seg--full' : ''}`} role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={String(o.value)} type="button" role="radio" aria-checked={o.value === value} disabled={disabled} onClick={() => onChange(o.value)} className="ebs-num">
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
  label,
}: {
  tabs: ReadonlyArray<{ id: T; label: string; count?: number; faded?: boolean; bang?: boolean }>
  value: T
  onChange: (id: T) => void
  label: string
}) {
  const refs = useRef<Record<string, HTMLButtonElement | null>>({})
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return
    e.preventDefault()
    const i = tabs.findIndex((t) => t.id === value)
    const n = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length]
    onChange(n.id)
    window.setTimeout(() => refs.current[n.id]?.focus(), 0)
  }
  return (
    <div className="ebs-tabs" role="tablist" aria-label={label} onKeyDown={onKey}>
      {tabs.map((t) => (
        <button
          key={t.id}
          ref={(el) => {
            refs.current[t.id] = el
          }}
          type="button"
          role="tab"
          aria-selected={t.id === value}
          tabIndex={t.id === value ? 0 : -1}
          className={`ebs-tab${t.faded ? ' is-faded' : ''}`}
          aria-label={t.count ? `${t.label}, ${t.count} совпадений` : undefined}
          onClick={() => onChange(t.id)}
        >
          {t.label}
          {t.count ? <span className="ebs-count">{t.count}</span> : null}
          {t.bang ? <span className="ebs-bang" aria-hidden="true">!</span> : null}
        </button>
      ))}
    </div>
  )
}

// ───────────────────────────── список (выпадашка) ─────────────────────────────

export interface SelectOption {
  value: string
  label: string
  /** вторая строка пункта (например, «сейчас: …») */
  sub?: string
}

export function Select({
  value,
  options,
  onChange,
  label,
  placeholder,
  disabled,
  invalid,
}: {
  value: string
  options: readonly SelectOption[]
  onChange: (v: string) => void
  label: string
  placeholder?: string
  disabled?: boolean
  invalid?: boolean
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const listId = useId()
  const cur = options.find((o) => o.value === value)

  useEffect(() => {
    if (!open) return
    const onDown = (e: Event) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown, true)
    document.addEventListener('touchstart', onDown, true)
    return () => {
      document.removeEventListener('mousedown', onDown, true)
      document.removeEventListener('touchstart', onDown, true)
    }
  }, [open])

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape' && open) {
      e.preventDefault()
      e.stopPropagation()
      setOpen(false)
      ;(rootRef.current?.querySelector('.ebs-select__btn') as HTMLElement | null)?.focus()
      return
    }
    if (!open) return
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const items = Array.from(rootRef.current?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])
      const i = items.indexOf(document.activeElement as HTMLElement)
      const next = items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1) + items.length) % items.length]
      next?.focus()
    }
  }

  return (
    <div className={`ebs-select${invalid ? ' is-err' : ''}${disabled ? ' is-off' : ''}`} ref={rootRef} onKeyDown={onKey}>
      <button
        type="button"
        className="ebs-select__btn"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={label}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
      >
        <span>{cur ? cur.label : placeholder ?? ''}</span>
        <Ic n="chev" />
      </button>
      {open ? (
        <div className="ebs-menu" role="listbox" id={listId} aria-label={label}>
          {options.map((o) => (
            <button
              key={o.value}
              type="button"
              role="option"
              aria-selected={o.value === value}
              className="ebs-menu__it"
              onClick={() => {
                onChange(o.value)
                setOpen(false)
                ;(rootRef.current?.querySelector('.ebs-select__btn') as HTMLElement | null)?.focus()
              }}
            >
              {o.sub ? (
                <>
                  <b>{o.label}</b>
                  <small>{o.sub}</small>
                </>
              ) : (
                <span>{o.label}</span>
              )}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}

// ───────────────────────────── вопрос на месте и панель сохранения ─────────────────────────────

/** Вопрос на месте (выход, отключение сеанса, «все другие»): фокус — на «Отмена», Esc — отмена (в оболочке). */
export function Confirm({
  title,
  text,
  cancelLabel = 'Отмена',
  okLabel,
  okIcon = 'x',
  onCancel,
  onOk,
  busy,
  className,
}: {
  title: string
  text: string
  cancelLabel?: string
  okLabel: string
  okIcon?: IconName
  onCancel: () => void
  onOk: () => void
  busy?: boolean
  className?: string
}) {
  const cancelRef = useRef<HTMLButtonElement | null>(null)
  useEffect(() => {
    cancelRef.current?.focus({ preventScroll: true })
  }, [])
  return (
    <div className={`ebs-confirm${className ? ' ' + className : ''}`} role="alertdialog" aria-label={title}>
      <span>
        <b>{title}</b> {text}
      </span>
      <span className="ebs-confirm__btns">
        <button ref={cancelRef} type="button" className="ebs-btn ebs-btn--sm" onClick={onCancel} disabled={busy}>
          {cancelLabel}
        </button>
        <button type="button" className="ebs-btn ebs-btn--sm ebs-btn--danger" onClick={onOk} disabled={busy}>
          <Ic n={okIcon} /> {okLabel}
        </button>
      </span>
    </div>
  )
}

export type SaveState = 'dirty' | 'saving' | 'error' | 'done'

export function SaveBar({
  state,
  hint,
  onDiscard,
  onSave,
  compact,
}: {
  state: SaveState
  hint: string
  onDiscard: () => void
  onSave: () => void
  compact: boolean
}) {
  const title = state === 'saving' ? 'Сохраняем…' : state === 'error' ? 'Не удалось сохранить изменения' : state === 'done' ? 'Изменения сохранены.' : 'Есть несохранённые изменения'
  const sub = state === 'error' ? 'Попробуйте ещё раз — изменения не потеряны.' : state === 'dirty' ? hint : ''
  return (
    <div className={`ebs-save${state === 'error' ? ' ebs-save--err' : ''}${state === 'done' ? ' ebs-save--done' : ''}`} role="region" aria-label="Несохранённые изменения">
      {state === 'saving' ? <span className="ebs-spin" aria-hidden="true" /> : state === 'error' ? <Ic n="alert" /> : state === 'done' ? <Ic n="check" /> : <Ic n="pencil" />}
      <div aria-live={state === 'error' ? 'assertive' : 'polite'}>
        <div className="ebs-save__t">{title}</div>
        {sub ? <div className="ebs-save__s">{sub}</div> : null}
      </div>
      {state !== 'done' ? (
        <div className="ebs-save__b">
          <Btn sm kind="ghost" onClick={onDiscard} disabled={state === 'saving'}>
            Не сохранять
          </Btn>
          <Btn sm kind="pri" icon={state === 'error' ? 'retry' : 'check'} onClick={onSave} disabled={state === 'saving'}>
            {state === 'saving' ? 'Сохраняем…' : state === 'error' ? 'Повторить' : compact ? 'Сохранить' : 'Сохранить изменения'}
          </Btn>
        </div>
      ) : null}
    </div>
  )
}

/** Карточка-вопрос поверх панели («Сохранить изменения в профиле?»). */
export function LeaveDialog({ onCancel, onDiscard, onSave }: { onCancel: () => void; onDiscard: () => void; onSave: () => void }) {
  const ref = useRef<HTMLButtonElement | null>(null)
  useEffect(() => {
    ref.current?.focus()
  }, [])
  return (
    <div className="ebs-scrim" onClick={onCancel}>
      <div className="ebs-dlg" role="alertdialog" aria-modal="false" aria-labelledby="ebs-leave-t" onClick={(e) => e.stopPropagation()}>
        <h3 id="ebs-leave-t">Сохранить изменения в профиле?</h3>
        <p>Вы изменили профиль, но не сохранили изменения.</p>
        <div className="ebs-dlg__btns">
          <button ref={ref} type="button" className="ebs-btn" onClick={onCancel}>
            Отмена
          </button>
          <Btn onClick={onDiscard}>Не сохранять</Btn>
          <Btn kind="pri" onClick={onSave}>
            Сохранить
          </Btn>
        </div>
      </div>
    </div>
  )
}

/** Копирование в буфер с запасным путём (старые браузеры, http). */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    try {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      const ok = document.execCommand('copy')
      ta.remove()
      return ok
    } catch {
      return false
    }
  }
}
