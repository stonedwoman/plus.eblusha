import { Lock, MessageSquare, Phone, Shield, Settings } from 'lucide-react'

type Props = {
  isSelf: boolean
  canCall?: boolean
  secretState?: { enabled: boolean; canOpen: boolean }
  contactRequest?: {
    incoming: boolean
    onAccept: () => void
    onReject: () => void
  } | null
  onWrite?: () => void
  onCall?: () => void
  onStartSecretChat?: () => void
  onOpenSecretChat?: () => void
  onEditProfile?: () => void
  onChangeAvatar?: () => void
  onPrivacy?: () => void
}

export function ProfileActions({
  isSelf,
  canCall,
  secretState,
  contactRequest,
  onWrite,
  onCall,
  onStartSecretChat,
  onOpenSecretChat,
  onEditProfile,
  onChangeAvatar,
  onPrivacy,
}: Props) {
  if (isSelf) {
    return (
      <div className="profile-actions">
        <button className="btn btn-primary" onClick={onEditProfile}>
          <Settings size={18} />
          Редактировать профиль
        </button>
        <button className="btn btn-secondary" onClick={onChangeAvatar}>
          <MessageSquare size={18} />
          Сменить аватар
        </button>
        <button className="btn btn-secondary" onClick={onPrivacy}>
          <Shield size={18} />
          Настройки приватности
        </button>
      </div>
    )
  }

  return (
    <div className="profile-actions">
      {contactRequest?.incoming ? (
        <div className="profile-actions__request">
          <button className="btn btn-primary" onClick={contactRequest.onAccept}>
            Принять
          </button>
          <button className="btn btn-secondary" onClick={contactRequest.onReject}>
            Отклонить
          </button>
        </div>
      ) : null}
      <button className="btn btn-primary" onClick={onWrite}>
        <MessageSquare size={18} />
        Написать
      </button>
      {canCall && (
        <button className="btn btn-secondary" onClick={onCall}>
          <Phone size={18} />
          Позвонить
        </button>
      )}
      {secretState?.enabled ? (
        <div className="profile-actions__secret">
          <div className="profile-actions__secret-state">🔒 Секретный чат включён</div>
          <button className="btn btn-secondary" onClick={onOpenSecretChat} disabled={!secretState.canOpen}>
            Открыть секретный чат
          </button>
        </div>
      ) : (
        <button className="btn btn-secondary" onClick={onStartSecretChat}>
          <Lock size={18} />
          Секретный чат
        </button>
      )}
    </div>
  )
}


