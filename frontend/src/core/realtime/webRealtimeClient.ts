import { socket, connectSocket } from '../../utils/socket'
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
    if (!socket.connected && event !== 'presence:focus' && event !== 'presence:state') {
      connectSocket()
    }
    socket.emit(event as string, payload)
  }
}
