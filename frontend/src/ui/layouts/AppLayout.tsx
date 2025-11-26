import { Outlet } from 'react-router-dom'
import { PresenceReporter } from '../components/PresenceReporter'

export default function AppLayout() {
  return (
    <>
      <PresenceReporter />
      <main className="content" style={{ height: 'calc(var(--vh, 1vh) * 100)' }}>
        <Outlet />
      </main>
    </>
  )
}



