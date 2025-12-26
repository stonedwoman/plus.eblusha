import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { ProfileHeader, type ProfileHeaderUser } from './ProfileHeader'
import { ProfileActions } from './ProfileActions'
import { ProfileSection } from './ProfileSection'
import { DangerZone } from './DangerZone'

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
    }
  }, [open])

  const canRender = open && typeof document !== 'undefined'
  const panelMode = isMobile ? 'sheet' : 'panel'

  const body = useMemo(() => {
    if (!open) return null
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
              <div className="profile-sticky">
                <ProfileHeader
                  user={user}
                  statusText={statusText}
                  onClose={onClose}
                  idLabel={idLabel}
                  idValue={idValue}
                  onCopyId={async () => {
                    await onCopyId()
                    setToast({ text: 'Скопировано' })
                  }}
                />
                <ProfileActions
                  isSelf={isSelf}
                  canCall={!!onCall}
                  secretState={secret}
                  contactRequest={
                    contactRequest?.incoming
                      ? {
                          incoming: true,
                          onAccept: () => void onAcceptContact?.(),
                          onReject: () => void onRejectContact?.(),
                        }
                      : null
                  }
                  onWrite={() => void onWrite?.()}
                  onCall={() => void onCall?.()}
                  onStartSecretChat={() => void onStartSecretChat?.()}
                  onOpenSecretChat={() => void onOpenSecretChat?.()}
                  onEditProfile={onEditProfile}
                  onChangeAvatar={onChangeAvatar}
                  onPrivacy={onPrivacy}
                />
              </div>

              <div className="profile-body">
                <ProfileSection title="О пользователе" defaultOpen>
                  <div className="profile-kv">
                    <div className="profile-kv__row">
                      <div className="profile-kv__k">Имя</div>
                      <div className="profile-kv__v">{user.displayName ?? '—'}</div>
                    </div>
                    <div className="profile-kv__row">
                      <div className="profile-kv__k">Ник</div>
                      <div className="profile-kv__v">{user.username ?? '—'}</div>
                    </div>
                    {user.bio ? (
                      <div className="profile-kv__row">
                        <div className="profile-kv__k">О себе</div>
                        <div className="profile-kv__v profile-kv__v--multiline">{user.bio}</div>
                      </div>
                    ) : null}
                  </div>
                </ProfileSection>

                <ProfileSection title="Общие медиа / файлы">
                  <div className="profile-empty">Пока тут пусто</div>
                </ProfileSection>

                <ProfileSection title="Общие чаты">
                  {commonGroups.length === 0 ? (
                    <div className="profile-empty">Пока тут пусто</div>
                  ) : (
                    <div className="profile-list">
                      {commonGroups.slice(0, 6).map((g) => (
                        <div key={g.id} className="profile-list__item">
                          <div className="profile-list__title">{g.title}</div>
                        </div>
                      ))}
                      {commonGroups.length > 6 ? <div className="profile-muted">Показать все</div> : null}
                    </div>
                  )}
                </ProfileSection>

                <ProfileSection title="Тех-инфо">
                  <div className="profile-kv">
                    <div className="profile-kv__row">
                      <div className="profile-kv__k">ID</div>
                      <div className="profile-kv__v profile-kv__v--mono">{user.id}</div>
                    </div>
                    {user.eblid ? (
                      <div className="profile-kv__row">
                        <div className="profile-kv__k">EBLID</div>
                        <div className="profile-kv__v profile-kv__v--mono">{user.eblid}</div>
                      </div>
                    ) : null}
                    {user.lastSeenAt ? (
                      <div className="profile-kv__row">
                        <div className="profile-kv__k">last seen</div>
                        <div className="profile-kv__v">{new Date(user.lastSeenAt).toLocaleString()}</div>
                      </div>
                    ) : null}
                  </div>
                </ProfileSection>

                <DangerZone
                  isSelf={isSelf}
                  isContact={isContact}
                  canBlock={canBlock}
                  onAddContact={() => {
                    setConfirm({
                      title: 'Добавить в контакты?',
                      text: 'Пользователь получит запрос на добавление.',
                      confirmLabel: 'Добавить',
                      tone: 'muted',
                      onConfirm: async () => {
                        await onAddContact?.()
                        setConfirm(null)
                      },
                    })
                  }}
                  onRemoveContact={() => {
                    setConfirm({
                      title: 'Удалить контакт?',
                      text: 'Контакт будет удалён из вашего списка. Это действие можно будет отменить только повторным добавлением.',
                      confirmLabel: 'Удалить',
                      tone: 'danger',
                      onConfirm: async () => {
                        await onRemoveContact?.()
                        setConfirm(null)
                      },
                    })
                  }}
                  onBlock={() => {
                    setConfirm({
                      title: 'Заблокировать пользователя?',
                      text: 'Он не сможет писать и звонить вам. Вы сможете снять блокировку позже.',
                      confirmLabel: 'Заблокировать',
                      tone: 'danger',
                      onConfirm: async () => {
                        await onBlock?.()
                        setConfirm(null)
                      },
                    })
                  }}
                  onReport={() => {
                    setConfirm({
                      title: 'Пожаловаться?',
                      text: 'Мы получим жалобу и сможем проверить ситуацию.',
                      confirmLabel: 'Отправить',
                      tone: 'muted',
                      onConfirm: async () => {
                        await onReport?.()
                        setConfirm(null)
                      },
                    })
                  }}
                />
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
  ])

  if (!canRender) return null
  return createPortal(body, document.body)
}


