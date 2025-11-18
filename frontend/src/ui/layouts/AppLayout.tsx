import { Outlet } from 'react-router-dom'

export default function AppLayout() {
  return (
    <main className="content" style={{ height: 'calc(var(--vh, 1vh) * 100)' }}>
      <Outlet />
    </main>
  )
}



