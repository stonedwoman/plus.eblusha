import type { SocketService } from '../../capacitor/services/socket-service'
import type { RealtimeClient } from './client'
import { EventBus } from './eventBus'
import type { RealtimeInboundEventMap, RealtimeOutboundEventMap } from './events'

type PendingAction = () => void

export class NativeRealtimeClient implements RealtimeClient {
  readonly mode = 'native' as const

  private service: SocketService | null = null
  private bus = new EventBus<RealtimeInboundEventMap>()
  private pendingActions: PendingAction[] = []
  private teardownBindings: Array<() => void> = []

  bindService(service: SocketService): void {
    if (this.service === service) return
    this.unbindService()
    this.service = service
    this.teardownBindings = [
      this.bindIncoming(service, 'connect'),
      this.bindIncoming(service, 'disconnect'),
      this.bindIncoming(service, 'message:new'),
      this.bindIncoming(service, 'message:notify'),
      this.bindIncoming(service, 'message:reaction'),
      this.bindIncoming(service, 'message:update'),
      this.bindIncoming(service, 'receipts:update'),
      this.bindIncoming(service, 'conversation:typing'),
      this.bindIncoming(service, 'conversation:typing_update'),
      this.bindIncoming(service, 'conversations:new'),
      this.bindIncoming(service, 'conversations:updated'),
      this.bindIncoming(service, 'conversations:deleted'),
      this.bindIncoming(service, 'conversations:member:removed'),
      this.bindIncoming(service, 'contacts:request:new'),
      this.bindIncoming(service, 'contacts:request:accepted'),
      this.bindIncoming(service, 'contacts:request:rejected'),
      this.bindIncoming(service, 'contacts:removed'),
      this.bindIncoming(service, 'profile:update'),
      this.bindIncoming(service, 'presence:update'),
      this.bindIncoming(service, 'presence:game'),
      this.bindIncoming(service, 'presence:game:snapshot'),
      this.bindIncoming(service, 'presence:game:snapshot:batch'),
      this.bindIncoming(service, 'call:incoming'),
      this.bindIncoming(service, 'call:accepted'),
      this.bindIncoming(service, 'call:declined'),
      this.bindIncoming(service, 'call:ended'),
      this.bindIncoming(service, 'call:status'),
      this.bindIncoming(service, 'call:status:bulk'),
      this.bindIncoming(service, 'availability:updated'),
      this.bindIncoming(service, 'availability:proposals:updated'),
      this.bindIncoming(service, 'session:new'),
      this.bindIncoming(service, 'secret:notify'),
    ]
    this.flushPendingActions()
  }

  unbindService(): void {
    this.teardownBindings.forEach((dispose) => dispose())
    this.teardownBindings = []
    this.service = null
  }

  connect(): void {
    this.withService((service) => {
      service.ensureConnected()
    })
  }

  ensureConnected(): void {
    this.withService((service) => {
      service.ensureConnected()
    })
  }

  isConnected(): boolean {
    return this.service?.isConnected() ?? false
  }

  on<K extends keyof RealtimeInboundEventMap>(
    event: K,
    listener: (payload: RealtimeInboundEventMap[K]) => void,
  ): () => void {
    return this.bus.on(event, listener)
  }

  emit<K extends keyof RealtimeOutboundEventMap>(
    event: K,
    payload: RealtimeOutboundEventMap[K],
  ): void {
    this.withService((service) => {
      switch (event) {
        case 'conversation:join':
          service.emitConversationJoin(payload as RealtimeOutboundEventMap['conversation:join'])
          break
        case 'conversation:leave':
          service.emitRaw('conversation:leave', payload)
          break
        case 'conversation:typing':
          service.emitConversationTyping(payload as RealtimeOutboundEventMap['conversation:typing'])
          break
        case 'typing_start':
        case 'typing_ping':
        case 'typing_stop':
          service.emitRaw(event, payload)
          break
        case 'call:invite':
          service.emitCallInvite(payload as RealtimeOutboundEventMap['call:invite'])
          break
        case 'call:accept':
          service.emitCallAccept(payload as RealtimeOutboundEventMap['call:accept'])
          break
        case 'call:decline':
          service.emitCallDecline(payload as RealtimeOutboundEventMap['call:decline'])
          break
        case 'call:end':
          service.emitCallEnd(payload as RealtimeOutboundEventMap['call:end'])
          break
        case 'call:room:join':
          service.emitCallRoomJoin(payload as RealtimeOutboundEventMap['call:room:join'])
          break
        case 'call:room:leave':
          service.emitCallRoomLeave(payload as RealtimeOutboundEventMap['call:room:leave'])
          break
        case 'call:status:request':
          service.emitCallStatusRequest(payload as RealtimeOutboundEventMap['call:status:request'])
          break
        case 'presence:focus':
        case 'presence:state':
        case 'presence:game:subscribe':
        case 'presence:game:hello':
          service.emitRaw(event, payload)
          break
      }
    })
  }

  private withService(action: (service: SocketService) => void): void {
    if (this.service) {
      action(this.service)
      return
    }
    this.pendingActions.push(() => {
      if (this.service) {
        action(this.service)
      }
    })
  }

  private flushPendingActions(): void {
    if (!this.service || this.pendingActions.length === 0) return
    const queue = [...this.pendingActions]
    this.pendingActions = []
    for (const action of queue) {
      action()
    }
  }

  private bindIncoming<K extends keyof RealtimeInboundEventMap>(
    service: SocketService,
    event: K,
  ): () => void {
    return service.onRaw(event as string, (payload: RealtimeInboundEventMap[K]) => {
      this.bus.emit(event, payload)
    })
  }
}

export const nativeRealtimeClient = new NativeRealtimeClient()
