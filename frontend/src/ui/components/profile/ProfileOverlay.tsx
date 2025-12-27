import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  Copy,
  Hash,
  Info,
  Lock,
  MessageSquare,
  MoreHorizontal,
  Phone,
  ShieldOff,
  Trash2,
  UserPlus,
  X,
} from 'lucide-react'
import { Avatar } from '../Avatar'

type ConfirmState =
  | null
  | {
      title: string
      text: string
      confirmLabel: string
      tone?: 'danger' | 'muted'
      onConfirm: () => void | Promise<void>
    }

type ToastState = null | { text: string }

export type ProfileHeaderUser = {
  id: string
  username?: string | null
  displayName?: string | null
  avatarUrl?: string | null
  status?: string | null
  lastSeenAt?: string | null
  eblid?: string | null
  bio?: string | null
}

export type ProfileOverlayProps = {
  open: boolean
  isMobile: boolean
  user: ProfileHeaderUser | null
  meId: string | null
  loadError?: string | null
  onRetry?: () => void
  statusText: string
  idLabel: string
  idValue: string
  isContact: boolean
  canBlock: boolean
  contactRequest: { incoming: boolean } | null
  mediaPreview?: Array<{ id: string; title?: string; type?: string }>
  secret: { enabled: boolean; canOpen: boolean }
  commonGroups: Array<{ id: string; title: string }>
  onClose: () => void
  onCopyId: () => Promise<void> | void
  onAcceptContact?: () => Promise<void> | void
  onRejectContact?: () => Promise<void> | void
  onWrite?: () => Promise<void> | void
  onCall?: () => Promise<void> | void
  onStartSecretChat?: () => Promise<void> | void
  onOpenSecretChat?: () => Promise<void> | void
  onEditProfile?: () => void
  onChangeAvatar?: () => void
  onPrivacy?: () => void
  onAddContact?: () => Promise<void> | void
  onRemoveContact?: () => Promise<void> | void
  onBlock?: () => Promise<void> | void
  onReport?: () => Promise<void> | void
}

export function ProfileOverlay(props: ProfileOverlayProps) {
  const {
    open,
    isMobile,
    user,
    meId,
    loadError,
    onRetry,
    statusText,
    idLabel,
    idValue,
    isContact,
    canBlock,
    contactRequest,
    mediaPreview,
    secret,
    commonGroups,
    onClose,
    onCopyId,
    onAcceptContact,
    onRejectContact,
    onWrite,
    onCall,
    onStartSecretChat,
    onOpenSecretChat,
    onEditProfile,
    onChangeAvatar,
    onPrivacy,
    onAddContact,
    onRemoveContact,
    onBlock,
    onReport,
  } = props

  const isSelf = !!(user?.id && meId && user.id === meId)
  const [confirm, setConfirm] = useState<ConfirmState>(null)
  const [toast, setToast] = useState<ToastState>(null)
  const [menu, setMenu] = useState<{ open: boolean; x: number; y: number }>(() => ({ open: false, x: 0, y: 0 }))
  const moreBtnRef = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    if (!open) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, onClose])

  useEffect(() => {
    if (!toast) return
    const t = window.setTimeout(() => setToast(null), 1400)
    return () => window.clearTimeout(t)
  }, [toast])

  useEffect(() => {
    if (!open) {
      setConfirm(null)
      setToast(null)
      setMenu({ open: false, x: 0, y: 0 })
    }
  }, [open])

  const canRender = open && typeof document !== 'undefined'
  const panelMode = isMobile ? 'sheet' : 'panel'

  const menuItems = useMemo(() => {
    const items: Array<{
      key: string
      label: string
      icon: React.ReactNode
      tone?: 'danger'
      onClick: () => void
    }> = []

    if (isSelf) {
      if (typeof onEditProfile === 'function') {
        items.push({
          key: 'settings',
          label: 'Настройки',
          icon: <Info size={18} />,
          onClick: () => {
            setMenu({ open: false, x: 0, y: 0 })
            onEditProfile()
          },
        })
      }
      if (typeof onChangeAvatar === 'function') {
        items.push({
          key: 'avatar',
          label: 'Сменить аватар',
          icon: <UserPlus size={18} />,
          onClick: () => {
            setMenu({ open: false, x: 0, y: 0 })
            onChangeAvatar()
          },
        })
      }
      if (typeof onPrivacy === 'function') {
        items.push({
          key: 'privacy',
          label: 'Приватность',
          icon: <Lock size={18} />,
          onClick: () => {
            setMenu({ open: false, x: 0, y: 0 })
            onPrivacy()
          },
        })
      }
    } else {
      if (isContact && typeof onRemoveContact === 'function') {
        items.push({
          key: 'remove-contact',
          label: 'Удалить контакт',
          icon: <Trash2 size={18} />,
          tone: 'danger',
          onClick: () => {
            setConfirm({
              title: 'Удалить контакт?',
              text: 'Контакт будет удалён из вашего списка.',
              confirmLabel: 'Удалить',
              tone: 'danger',
              onConfirm: async () => {
                await onRemoveContact()
                setConfirm(null)
              },
            })
            setMenu({ open: false, x: 0, y: 0 })
          },
        })
      } else if (!isContact && typeof onAddContact === 'function') {
        items.push({
          key: 'add-contact',
          label: 'Добавить в контакты',
          icon: <UserPlus size={18} />,
          onClick: () => {
            setConfirm({
              title: 'Добавить в контакты?',
              text: 'Пользователь получит запрос на добавление.',
              confirmLabel: 'Добавить',
              tone: 'muted',
              onConfirm: async () => {
                await onAddContact()
                setConfirm(null)
              },
            })
            setMenu({ open: false, x: 0, y: 0 })
          },
        })
      }

      if (canBlock && typeof onBlock === 'function') {
        items.push({
          key: 'block',
          label: 'Заблокировать',
          icon: <ShieldOff size={18} />,
          onClick: () => {
            setConfirm({
              title: 'Заблокировать?',
              text: 'Пользователь не сможет писать и звонить вам.',
              confirmLabel: 'Заблокировать',
              tone: 'danger',
              onConfirm: async () => {
                await onBlock()
                setConfirm(null)
              },
            })
            setMenu({ open: false, x: 0, y: 0 })
          },
        })
      }

      if (typeof onReport === 'function') {
        items.push({
          key: 'report',
          label: 'Пожаловаться',
          icon: <Info size={18} />,
          onClick: () => {
            setConfirm({
              title: 'Пожаловаться?',
              text: 'Мы получим жалобу и сможем проверить ситуацию.',
              confirmLabel: 'Отправить',
              tone: 'muted',
              onConfirm: async () => {
                await onReport()
                setConfirm(null)
              },
            })
            setMenu({ open: false, x: 0, y: 0 })
          },
        })
      }
    }

    return items
  }, [
    isSelf,
    secret?.enabled,
    onOpenSecretChat,
    onStartSecretChat,
    onEditProfile,
    onChangeAvatar,
    onPrivacy,
    isContact,
    onRemoveContact,
    onAddContact,
    canBlock,
    onBlock,
    onReport,
  ])

  const openMoreMenu = () => {
    if (!moreBtnRef.current) return
    const rect = moreBtnRef.current.getBoundingClientRect()
    const menuW = 260
    const menuH = 320
    const pad = 12
    const x = Math.min(Math.max(pad, rect.right - menuW), window.innerWidth - menuW - pad)
    const y = Math.min(Math.max(pad, rect.bottom + 10), window.innerHeight - menuH - pad)
    setMenu({ open: true, x, y })
  }

  const body = useMemo(() => {
    if (!open) return null

    const name = user?.displayName ?? user?.username ?? 'Пользователь'
    const status = statusText || ''
    const showActions = !!(onWrite || onCall || (contactRequest?.incoming && (onAcceptContact || onRejectContact)) || menuItems.length > 0)
    const canSecret = !isSelf && (!!secret?.enabled ? typeof onOpenSecretChat === 'function' : typeof onStartSecretChat === 'function')

    const infoRows: Array<
      | { key: string; icon: React.ReactNode; title: string; subtitle?: string; right?: React.ReactNode; onClick?: () => void }
      | null
    > = [
      idValue
        ? {
            key: 'id',
            icon: <Hash size={18} />,
            title: `${idLabel}: ${idValue}`,
            subtitle: undefined,
            right: (
              <button
                className="pov-row__iconbtn"
                onClick={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  void onCopyId()
                  setToast({ text: 'Скопировано' })
                }}
                aria-label="Скопировать"
              >
                <Copy size={18} />
              </button>
            ),
          }
        : null,
      user?.bio
        ? {
            key: 'bio',
            icon: <Info size={18} />,
            title: user.bio,
            subtitle: 'О себе',
          }
        : null,
    ].filter(Boolean) as any

    return (
      <div
        className={`profile-overlay profile-overlay--${panelMode} ${open ? 'is-open' : ''}`}
        role="dialog"
        aria-modal="true"
        onClick={() => onClose()}
      >
        <div className={`profile-surface profile-surface--${panelMode}`} onClick={(e) => e.stopPropagation()}>
          {!user ? (
            loadError ? (
              <div className="profile-error">
                <div className="profile-error__title">Не удалось загрузить профиль</div>
                <div className="profile-error__text">{loadError}</div>
                <div className="profile-error__actions">
                  <button className="btn btn-secondary" onClick={onClose}>
                    Закрыть
                  </button>
                  <button className="btn btn-primary" onClick={onRetry}>
                    Повторить
                  </button>
                </div>
              </div>
            ) : (
              <div className="profile-skeleton">
                <div className="profile-skeleton__header" />
                <div className="profile-skeleton__actions" />
                <div className="profile-skeleton__block" />
                <div className="profile-skeleton__block" />
              </div>
            )
          ) : (
            <>
              <div className="pov">
                <div className="pov-top">
                  <button className="pov-close" onClick={onClose} aria-label="Закрыть">
                    <X size={20} />
                  </button>
                  <div className="pov-avatar">
                    <Avatar name={name} id={user.id} size={96} presence={(user.status as any) ?? undefined} avatarUrl={user.avatarUrl ?? undefined} />
                  </div>
                  <div className="pov-name" title={name}>
                    {name}
                  </div>
                  {status ? <div className="pov-sub">{status}</div> : null}
                </div>

                {showActions ? (
                  <div className="pov-actions">
                    {contactRequest?.incoming ? (
                      <>
                        {typeof onAcceptContact === 'function' ? (
                          <button className="pov-action pov-action--accent" onClick={() => void onAcceptContact()}>
                            <UserPlus size={20} />
                            <span>Принять</span>
                          </button>
                        ) : null}
                        {typeof onRejectContact === 'function' ? (
                          <button className="pov-action" onClick={() => void onRejectContact()}>
                            <X size={20} />
                            <span>Отклонить</span>
                          </button>
                        ) : null}
                      </>
                    ) : null}

                    {isSelf && typeof onEditProfile === 'function' ? (
                      <button className="pov-action pov-action--accent" onClick={() => void onEditProfile()}>
                        <Info size={20} />
                        <span>Профиль</span>
                      </button>
                    ) : null}

                    {!isSelf && typeof onWrite === 'function' ? (
                      <button className="pov-action pov-action--accent" onClick={() => void onWrite()}>
                        <MessageSquare size={20} />
                        <span>Чат</span>
                      </button>
                    ) : null}
                    {!isSelf && canSecret ? (
                      <button
                        className="pov-action"
                        onClick={() => {
                          if (secret?.enabled) void onOpenSecretChat?.()
                          else void onStartSecretChat?.()
                        }}
                      >
                        <Lock size={20} />
                        <span>Секрет</span>
                      </button>
                    ) : null}
                    {typeof onCall === 'function' ? (
                      <button className="pov-action" onClick={() => void onCall()}>
                        <Phone size={20} />
                        <span>Звонок</span>
                      </button>
                    ) : null}
                    {menuItems.length > 0 ? (
                      <button
                        ref={moreBtnRef}
                        className="pov-action"
                        onClick={(e) => {
                          e.preventDefault()
                          e.stopPropagation()
                          openMoreMenu()
                        }}
                      >
                        <MoreHorizontal size={20} />
                        <span>Ещё</span>
                      </button>
                    ) : null}
                  </div>
                ) : null}

                {infoRows.length > 0 ? (
                  <div className="pov-list">
                    {infoRows.map((r) => (
                      <div key={r.key} className="pov-row" onClick={r.onClick} role={r.onClick ? 'button' : undefined}>
                        <div className="pov-row__icon">{r.icon}</div>
                        <div className="pov-row__main">
                          <div className="pov-row__title">{r.title}</div>
                          {r.subtitle ? <div className="pov-row__sub">{r.subtitle}</div> : null}
                        </div>
                        {r.right ? <div className="pov-row__right">{r.right}</div> : null}
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>

              {confirm ? (
                <div className="profile-confirm" onClick={() => setConfirm(null)} role="presentation">
                  <div className="profile-confirm__surface" onClick={(e) => e.stopPropagation()}>
                    <div className="profile-confirm__top">
                      <div className="profile-confirm__title">{confirm.title}</div>
                      <button className="btn btn-icon btn-ghost" onClick={() => setConfirm(null)} aria-label="Закрыть">
                        <X size={18} />
                      </button>
                    </div>
                    <div className="profile-confirm__text">{confirm.text}</div>
                    <div className="profile-confirm__actions">
                      <button className="btn btn-secondary" onClick={() => setConfirm(null)}>
                        Отмена
                      </button>
                      <button
                        className="btn btn-primary"
                        style={
                          confirm.tone === 'danger'
                            ? { background: '#ef4444', borderColor: '#ef4444' }
                            : undefined
                        }
                        onClick={() => void confirm.onConfirm()}
                      >
                        {confirm.confirmLabel}
                      </button>
                    </div>
                  </div>
                </div>
              ) : null}

              {toast ? <div className="profile-toast">{toast.text}</div> : null}
            </>
          )}
        </div>

        {menu.open ? (
          <div
            className="pov-menu-overlay"
            onClick={(e) => {
              e.preventDefault()
              e.stopPropagation()
              setMenu({ open: false, x: 0, y: 0 })
            }}
          >
            <div className="pov-menu" style={{ position: 'fixed', left: menu.x, top: menu.y }} onClick={(e) => e.stopPropagation()}>
              {menuItems.map((item) => (
                <button
                  key={item.key}
                  className={`pov-menu__item ${item.tone === 'danger' ? 'is-danger' : ''}`}
                  onClick={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    item.onClick()
                  }}
                >
                  <span className="pov-menu__icon">{item.icon}</span>
                  <span className="pov-menu__label">{item.label}</span>
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    )
  }, [
    open,
    panelMode,
    user,
    loadError,
    onRetry,
    statusText,
    idLabel,
    idValue,
    onClose,
    onCopyId,
    isSelf,
    onWrite,
    onCall,
    contactRequest,
    onAcceptContact,
    onRejectContact,
    mediaPreview,
    secret,
    onStartSecretChat,
    onOpenSecretChat,
    onEditProfile,
    onChangeAvatar,
    onPrivacy,
    commonGroups,
    isContact,
    canBlock,
    onAddContact,
    onRemoveContact,
    onBlock,
    onReport,
    confirm,
    toast,
    menu.open,
    menu.x,
    menu.y,
    menuItems,
  ])

  if (!canRender) return null
  return createPortal(body, document.body)
}


