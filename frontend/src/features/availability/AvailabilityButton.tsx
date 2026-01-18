import type { CSSProperties } from 'react'
import { CalendarDays } from 'lucide-react'

type AvailabilityButtonProps = {
  onClick: () => void
  title?: string
  className?: string
  style?: CSSProperties
}

export const AvailabilityButton = ({ onClick, title = 'Календарь доступности', className, style }: AvailabilityButtonProps) => {
  return (
    <button
      type="button"
      className={className ?? 'btn btn-icon btn-ghost'}
      title={title}
      onClick={onClick}
      style={style}
    >
      <CalendarDays size={20} />
    </button>
  )
}
