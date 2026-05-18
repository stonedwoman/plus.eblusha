import { socket, connectSocket } from '../../utils/socket'
import { useAppStore } from '../../domain/store/appStore'
import type { RealtimeClient } from './client'
import type { RealtimeInboundEventMap, RealtimeOutboundEventMap } from './events'

export class WebRealtimeClient implements RealtimeClient {
  readonly mode = 'web' as const

  connect(): void {
    connectSocket()
  }

  ensureConnected(): void {
    if (!socket.connected) {
      connectSocket()
    }
  }

  isConnected(): boolean {
    return socket.connected
  }

  on<K extends keyof RealtimeInboundEventMap>(
    event: K,
    listener: (payload: RealtimeInboundEventMap[K]) => void,
  ): () => void {
    socket.on(event as string, listener as (payload: unknown) => void)
    return () => {
      socket.off(event as string, listener as (payload: unknown) => void)
    }
  }

  emit<K extends keyof RealtimeOutboundEventMap>(
    event: K,
    payload: RealtimeOutboundEventMap[K],
  ): void {
    connectSocket()

    const eventName = event as string
    /** Не звать WS send в CLOSING/CLOSED и не посылать до connect (connectSocket асинхронный). */
    const safeEmit = (): void => {
      try {
        if (!socket.connected) return
        ;(socket.emit as (ev: string, ...args: unknown[]) => void)(eventName, payload)
      } catch {
        /* ignore */
      }
    }

    if (socket.connected) {
      safeEmit()
      return
    }

    let token: string | null | undefined
    try {
      token = useAppStore.getState().session?.accessToken
    } catch {
      return
    }
    if (!token) return

    socket.once('connect', safeEmit)
  }
}
