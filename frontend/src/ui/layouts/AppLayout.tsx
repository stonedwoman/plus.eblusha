import { useEffect } from 'react'
import { Outlet } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { SecretInboxPump } from '../../domain/secret/SecretInboxPump'
import { SecretV2InboxPump } from '../../domain/secretV2/inboxPump'
import { isSecretEngineV2Enabled } from '../../domain/secretV2/featureFlag'
import { getStoredDeviceInfo } from '../../domain/device/deviceManager'
import { useSystemUiStore } from '../../domain/store/systemUiStore'
import { api } from '../../utils/api'
import { onSessionNew } from '../../core/realtime'
import { SystemPopups } from '../components/SystemPopups'
import { AppRuntimeCoordinator } from './AppRuntimeCoordinator'
import { CallHost } from './CallHost'

const NEW_SESSION_SEEN_KEY = 'eb.newSession.seen.v1'

/** true — устройство ещё не показывали (и теперь запомнили); false — уже показывали. */
function rememberNewSessionShown(userId: string, deviceId: string): boolean {
  const id = String(deviceId || '').trim()
  const uid = String(userId || '').trim() || '_'
  if (!id) return false
  try {
    const raw = window.localStorage.getItem(NEW_SESSION_SEEN_KEY)
    const parsed = (raw ? JSON.parse(raw) : {}) as Record<string, string[]>
    const list = Array.isArray(parsed[uid]) ? parsed[uid] : []
    if (list.includes(id)) return false
    parsed[uid] = [...list.slice(-199), id]
    window.localStorage.setItem(NEW_SESSION_SEEN_KEY, JSON.stringify(parsed))
  } catch {
    // приватный режим — покажем и так
  }
  return true
}

export default function AppLayout() {
  const useV2 = isSecretEngineV2Enabled()
  const queryClient = useQueryClient()

  useEffect(() => {
    const off = onSessionNew((payload) => {
      const currentId = getStoredDeviceInfo()?.deviceId ?? ''
      if (String(payload.deviceId ?? '').trim() === String(currentId ?? '').trim()) return
      queryClient.refetchQueries({ queryKey: ['my-devices'] })
      queryClient.refetchQueries({ queryKey: ['my-devices-settings'] })
      // Плашка — только про ДЕЙСТВИТЕЛЬНО новое устройство: сервер шлёт session:new при каждом
      // подключении сокета (телефон открыли — событие), а первое появление помечает firstSeen.
      // Уже показанные устройства помним: две вкладки или гонка с записью lastSeenAt на сервере
      // могут прислать firstSeen дважды.
      if (payload.firstSeen !== true) return
      if (!rememberNewSessionShown(payload.userId, payload.deviceId)) return
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
      <AppRuntimeCoordinator />
      {useV2 ? <SecretV2InboxPump /> : <SecretInboxPump />}
      <SystemPopups />
      <CallHost />
      <main
        className="content"
        style={{
          height: 'calc(var(--vh, 1vh) * 100)',
        }}
      >
        <Outlet />
      </main>
    </>
  )
}



