import { useEffect } from 'react'
import { Outlet } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { SecretInboxPump } from '../../domain/secret/SecretInboxPump'
import { SecretV2InboxPump } from '../../domain/secretV2/inboxPump'
import { isSecretEngineV2Enabled } from '../../domain/secretV2/featureFlag'
import { getStoredDeviceInfo } from '../../domain/device/deviceManager'
import { useSystemUiStore } from '../../domain/store/systemUiStore'
import { api } from '../../utils/api'
import { onSessionNew } from '../../utils/socket'
import { SystemPopups } from '../components/SystemPopups'

export default function AppLayout() {
  const useV2 = isSecretEngineV2Enabled()
  const queryClient = useQueryClient()

  useEffect(() => {
    const off = onSessionNew((payload) => {
      const currentId = getStoredDeviceInfo()?.deviceId ?? ''
      if (String(payload.deviceId ?? '').trim() === String(currentId ?? '').trim()) return
      queryClient.refetchQueries({ queryKey: ['my-devices'] })
      queryClient.refetchQueries({ queryKey: ['my-devices-settings'] })
      useSystemUiStore.getState().requestNewSessionPopup({
        deviceId: payload.deviceId,
        deviceName: payload.deviceName,
        platform: payload.platform,
        lastIp: payload.lastIp,
        lastCity: payload.lastCity,
        lastCountry: payload.lastCountry,
      }).then((action) => {
        if (action === 'forbid') {
          api.delete(`/devices/${encodeURIComponent(payload.deviceId)}`).finally(() => {
            queryClient.refetchQueries({ queryKey: ['my-devices'] })
            queryClient.refetchQueries({ queryKey: ['my-devices-settings'] })
          })
        }
      })
    })
    return () => { off?.() }
  }, [queryClient])

  return (
    <>
      {useV2 ? <SecretV2InboxPump /> : <SecretInboxPump />}
      <SystemPopups />
      <main className="content" style={{ height: 'calc(var(--vh, 1vh) * 100)' }}>
        <Outlet />
      </main>
    </>
  )
}



