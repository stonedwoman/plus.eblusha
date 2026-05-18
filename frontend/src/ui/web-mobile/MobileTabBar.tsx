import { useEffect, useState, type ReactNode } from 'react'
import { MessageCircle, Phone, Settings, Users } from 'lucide-react'
import { NavLink, useLocation } from 'react-router-dom'
import { withAppRoutePrefix } from '../../core/navigation/routes'
import { isNativePlatform } from '../../utils/platform'

function useIsMobile() {
  const [isMobile, setIsMobile] = useState(() =>
    typeof window !== 'undefined' ? window.innerWidth <= 768 : false,
  )

  useEffect(() => {
    const update = () => {
      setIsMobile(window.innerWidth <= 768)
    }
    update()
    window.addEventListener('resize', update)
    return () => {
      window.removeEventListener('resize', update)
    }
  }, [])

  return isMobile
}

function MobileTabLink(props: {
  to: string
  label: string
  icon: ReactNode
}) {
  return (
    <NavLink
      to={props.to}
      className={({ isActive }) => (isActive ? 'is-active' : undefined)}
      style={({ isActive }) => ({
        flex: 1,
        minWidth: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 4,
        padding: '10px 8px',
        color: isActive ? 'var(--brand)' : 'var(--text-muted)',
        textDecoration: 'none',
        fontSize: 12,
        fontWeight: isActive ? 700 : 500,
      })}
    >
      {props.icon}
      <span>{props.label}</span>
    </NavLink>
  )
}

export function MobileTabBar() {
  const isMobile = useIsMobile()
  const location = useLocation()
  if (!isMobile || !isNativePlatform()) return null

  return (
    <nav
      aria-label="Mobile navigation"
      style={{
        position: 'fixed',
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 120,
        display: 'flex',
        alignItems: 'stretch',
        borderTop: '1px solid var(--surface-border)',
        background: 'rgba(20,24,30,0.92)',
        backdropFilter: 'blur(10px) saturate(130%)',
        paddingBottom: 'env(safe-area-inset-bottom, 0px)',
      }}
    >
      <MobileTabLink to={withAppRoutePrefix(location.pathname, '/chats')} label="Чаты" icon={<MessageCircle size={18} />} />
      <MobileTabLink to={withAppRoutePrefix(location.pathname, '/contacts')} label="Контакты" icon={<Users size={18} />} />
      <MobileTabLink to={withAppRoutePrefix(location.pathname, '/calls')} label="Звонки" icon={<Phone size={18} />} />
      <MobileTabLink to={withAppRoutePrefix(location.pathname, '/settings')} label="Настройки" icon={<Settings size={18} />} />
    </nav>
  )
}
