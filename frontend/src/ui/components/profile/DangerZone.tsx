import { AlertTriangle, ShieldOff, Trash2, UserPlus } from 'lucide-react'

type Props = {
  isSelf: boolean
  isContact: boolean
  canBlock: boolean
  onAddContact?: () => void
  onRemoveContact?: () => void
  onBlock?: () => void
  onReport?: () => void
}

export function DangerZone({ isSelf, isContact, canBlock, onAddContact, onRemoveContact, onBlock, onReport }: Props) {
  if (isSelf) return null

  return (
    <div className="profile-danger">
      <div className="profile-danger__title">
        <AlertTriangle size={16} />
        Опасные действия
      </div>
      <div className="profile-danger__actions">
        <button className="btn profile-danger__btn profile-danger__btn--muted" onClick={onBlock} disabled={!canBlock}>
          <ShieldOff size={18} />
          Заблокировать
        </button>
        {isContact ? (
          <button className="btn profile-danger__btn profile-danger__btn--danger" onClick={onRemoveContact}>
            <Trash2 size={18} />
            Удалить контакт
          </button>
        ) : (
          <button className="btn profile-danger__btn profile-danger__btn--muted" onClick={onAddContact}>
            <UserPlus size={18} />
            Добавить в контакты
          </button>
        )}
        <button className="btn profile-danger__btn profile-danger__btn--muted" onClick={onReport}>
          <AlertTriangle size={18} />
          Пожаловаться
        </button>
      </div>
    </div>
  )
}


