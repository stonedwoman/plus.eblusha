import { Outlet } from 'react-router-dom'
import { SecretInboxPump } from '../../domain/secret/SecretInboxPump'

export default function AppLayout() {
  return (
    <>
      <SecretInboxPump />
      <main className="content" style={{ height: 'calc(var(--vh, 1vh) * 100)' }}>
        <Outlet />
      </main>
    </>
  )
}



