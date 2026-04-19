import { create } from 'zustand'
import type {
  IncomingCallBridgePayload,
  NotificationOpenedPayload,
  PushMessagePayload,
} from '../../platform/native-bridge/bridge'

export type AppIntent =
  | {
      kind: 'conversation'
      conversationId: string
      messageId?: string
      source: 'push' | 'local' | 'incoming-call' | 'manual'
    }
  | {
      kind: 'call'
      conversationId: string
      source: 'push' | 'local' | 'incoming-call' | 'manual'
    }

interface NavigationIntentState {
  pendingIntent: AppIntent | null
  activeCallConversationId: string | null
  setIntent: (intent: AppIntent | null) => void
  consumeIntent: () => AppIntent | null
  setActiveCallConversationId: (conversationId: string | null) => void
}

export const useNavigationIntentStore = create<NavigationIntentState>((set, get) => ({
  pendingIntent: null,
  activeCallConversationId: null,
  setIntent: (pendingIntent) => set({ pendingIntent }),
  consumeIntent: () => {
    const current = get().pendingIntent
    set({ pendingIntent: null })
    return current
  },
  setActiveCallConversationId: (activeCallConversationId) => set({ activeCallConversationId }),
}))

export function createConversationIntent(
  conversationId: string,
  options?: { messageId?: string; source?: AppIntent['source'] },
): AppIntent {
  return {
    kind: 'conversation',
    conversationId,
    ...(options?.messageId ? { messageId: options.messageId } : {}),
    source: options?.source ?? 'manual',
  }
}

export function createCallIntent(
  conversationId: string,
  source: AppIntent['source'] = 'manual',
): AppIntent {
  return {
    kind: 'call',
    conversationId,
    source,
  }
}

export function mapNotificationPayloadToIntent(payload: NotificationOpenedPayload): AppIntent | null {
  if (!payload.conversationId) return null
  if (payload.target === 'call') {
    return createCallIntent(payload.conversationId, payload.source)
  }
  return createConversationIntent(payload.conversationId, {
    messageId: payload.messageId,
    source: payload.source,
  })
}

export function mapPushPayloadToIntent(payload: PushMessagePayload): AppIntent {
  return createConversationIntent(payload.conversationId, {
    messageId: payload.messageId,
    source: 'push',
  })
}

export function mapIncomingCallPayloadToIntent(payload: IncomingCallBridgePayload): AppIntent | null {
  if (!payload.conversationId) return null
  return createCallIntent(payload.conversationId, 'incoming-call')
}
