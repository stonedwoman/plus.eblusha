import type { RealtimeInboundEventMap, RealtimeOutboundEventMap } from './events'

export interface RealtimeClient {
  readonly mode: 'web' | 'native'
  connect(): void
  ensureConnected(): void
  isConnected(): boolean
  on<K extends keyof RealtimeInboundEventMap>(
    event: K,
    listener: (payload: RealtimeInboundEventMap[K]) => void,
  ): () => void
  emit<K extends keyof RealtimeOutboundEventMap>(
    event: K,
    payload: RealtimeOutboundEventMap[K],
  ): void
}
