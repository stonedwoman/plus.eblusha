import { Outlet } from 'react-router-dom'
import { SecretInboxPump } from '../../domain/secret/SecretInboxPump'
import { SecretV2InboxPump } from '../../domain/secretV2/inboxPump'
import { isSecretEngineV2Enabled } from '../../domain/secretV2/featureFlag'

export default function AppLayout() {
  const useV2 = isSecretEngineV2Enabled()
  return (
    <>
      {useV2 ? <SecretV2InboxPump /> : <SecretInboxPump />}
      <main className="content" style={{ height: 'calc(var(--vh, 1vh) * 100)' }}>
        <Outlet />
      </main>
    </>
  )
}



