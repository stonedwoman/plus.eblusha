import { Copy, X } from 'lucide-react'
import { Avatar } from '../Avatar'

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

type Props = {
  user: ProfileHeaderUser
  statusText: string
  onClose: () => void
  idLabel: string
  idValue: string
  onCopyId: () => void
}

export function ProfileHeader({ user, statusText, onClose, idLabel, idValue, onCopyId }: Props) {
  const name = user.displayName ?? user.username ?? 'Пользователь'
  return (
    <div className="profile-header">
      <div className="profile-header__top">
        <div className="profile-header__avatar">
          <Avatar name={name} id={user.id} size={84} presence={(user.status as any) ?? undefined} avatarUrl={user.avatarUrl ?? undefined} />
        </div>
        <button className="btn btn-icon btn-ghost profile-close" onClick={onClose} aria-label="Закрыть профиль">
          <X size={18} />
        </button>
      </div>

      <div className="profile-header__main">
        <div className="profile-header__name" title={name}>
          {name}
        </div>
        <div className="profile-header__status">{statusText}</div>
      </div>

      <div className="profile-header__idrow">
        <div className="profile-header__idtext">
          <span className="profile-header__idlabel">{idLabel}:</span>
          <span className="profile-header__idvalue">{idValue}</span>
        </div>
        <button className="btn btn-secondary btn-icon" onClick={onCopyId} aria-label="Скопировать">
          <Copy size={16} />
        </button>
      </div>
    </div>
  )
}


