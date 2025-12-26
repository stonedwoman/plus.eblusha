import { useId, useMemo, useState } from 'react'
import { ChevronDown } from 'lucide-react'

type Props = {
  title: string
  defaultOpen?: boolean
  children: React.ReactNode
}

export function ProfileSection({ title, defaultOpen = false, children }: Props) {
  const reactId = useId()
  const contentId = useMemo(() => `profile-sec-${reactId}`, [reactId])
  const [open, setOpen] = useState(defaultOpen)

  return (
    <section className="profile-section">
      <button
        type="button"
        className="profile-section__toggle"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={contentId}
      >
        <span className="profile-section__title">{title}</span>
        <span className={`profile-section__chev ${open ? 'is-open' : ''}`} aria-hidden="true">
          <ChevronDown size={18} />
        </span>
      </button>
      <div id={contentId} className={`profile-section__content ${open ? 'is-open' : ''}`}>
        {children}
      </div>
    </section>
  )
}


