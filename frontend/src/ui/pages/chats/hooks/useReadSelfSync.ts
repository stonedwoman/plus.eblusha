/**
 * read-sync в вебе/Electron как ПОЛУЧАТЕЛЬ: беседу прочитали на другом моём устройстве
 * (сокет "conversation:read-self", включая догон при подключении) → перечитать счётчики
 * непрочитанных и, в Electron, убрать «липкие» плашки, когда это безопасно.
 * Правила — в domain/readSync/readSelf.ts.
 */
import { useEffect, useRef } from 'react'
import type { QueryClient } from '@tanstack/react-query'
import { socket } from '../../../../core/realtime'
import { useCallStore } from '../../../../domain/store/callStore'
import { getStoredDeviceInfo } from '../../../../domain/device/deviceManager'
import { createReadSelfSync, READ_SELF_EVENT } from '../../../../domain/readSync/readSelf'

type ActiveCalls = Record<string, { active?: boolean } | undefined>

/** Мост старого ПК-клиента: прячет ВСЕ его плашки (сообщений и звонка). Нет моста — null. */
function electronHideAllOverlays(): (() => void) | null {
  try {
    const native = (window as unknown as { native?: { hideOverlay?: () => unknown } }).native
    if (native && typeof native.hideOverlay === 'function') {
      return () => {
        void Promise.resolve(native.hideOverlay!()).catch(() => {})
      }
    }
  } catch {
    /* ignore */
  }
  return null
}

export function useReadSelfSync(opts: { client: QueryClient; meId: string | null | undefined; activeCalls: ActiveCalls }) {
  const { client, meId } = opts
  const activeCallsRef = useRef<ActiveCalls>(opts.activeCalls)
  activeCallsRef.current = opts.activeCalls
  const meIdRef = useRef(meId)
  meIdRef.current = meId

  useEffect(() => {
    let lastIncomingAt = 0
    const sync = createReadSelfSync({
      myDeviceId: () => getStoredDeviceInfo()?.deviceId ?? null,
      refreshConversations: () => client.refetchQueries({ queryKey: ['conversations'], type: 'all' }),
      getConversationRows: () => client.getQueryData(['conversations']),
      hasCallActivity: () => {
        const calls = activeCallsRef.current || {}
        if (Object.values(calls).some((c) => !!c?.active)) return true
        const s = useCallStore.getState()
        return !!(s.incoming || s.activeConvId || s.overlayConvId || s.minimizedCallConvId || s.outgoingCall)
      },
      lastIncomingMessageAt: () => lastIncomingAt,
      hideAllOverlays: electronHideAllOverlays(),
    })
    const onReadSelf = (payload: unknown) => {
      sync.handle(payload)
    }
    const onNotify = (p: { senderId?: string }) => {
      if (p?.senderId && p.senderId !== meIdRef.current) lastIncomingAt = Date.now()
    }
    socket.on(READ_SELF_EVENT, onReadSelf)
    socket.on('message:notify', onNotify)
    return () => {
      socket.off(READ_SELF_EVENT, onReadSelf)
      socket.off('message:notify', onNotify)
      sync.dispose()
    }
  }, [client])
}
