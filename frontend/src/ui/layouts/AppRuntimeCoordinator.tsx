import { useEffect, useRef } from 'react'
import { matchPath, useLocation, useNavigate } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { appLifecycle } from '../../core/lifecycle/appLifecycle'
import { getPendingSyncSnapshot, syncAfterResume } from '../../core/chat-sync/syncAfterResume'
import { useChatUiStore } from '../../core/chat-sync/chatUiStore'
import {
  acceptIncomingCallAction,
  cancelIncomingCallAction,
  clearActiveCallTracking,
  clearIncomingCallTracking,
  declineIncomingCallAction,
  endActiveCallAction,
  openCallRoute,
  rememberIncomingCall,
  setIncomingCallBootstrapReady,
} from '../../core/call-state/incomingCallActions'
import { getRealtimeClient } from '../../core/realtime'
import {
  nativeBridge,
  type CallCanceledBridgePayload,
  type IncomingCallBridgePayload,
  type NativeCallActionPayload,
} from '../../platform/native-bridge/bridge'
import {
  mapNotificationPayloadToIntent,
  mapPushPayloadToIntent,
  useNavigationIntentStore,
} from '../../core/navigation/intents'
import { withAppRoutePrefix } from '../../core/navigation/routes'
import { useCallStore } from '../../domain/store/callStore'
import { useAppStore } from '../../domain/store/appStore'

function toPresenceState(mode: 'foreground' | 'background' | 'offline' | 'dnd' | 'in_call') {
  switch (mode) {
    case 'background':
    case 'offline':
      return {
        active: false,
        visibility: 'hidden' as const,
      }
    case 'foreground':
    case 'dnd':
    case 'in_call':
    default:
      return {
        active: true,
        visibility: 'visible' as const,
      }
  }
}

function toIncomingCallActionRequest(
  payload: IncomingCallBridgePayload | CallCanceledBridgePayload | NativeCallActionPayload,
) {
  return {
    callId: payload.callId ?? payload.conversationId,
    conversationId: payload.conversationId ?? payload.callId,
    callerId:
      'fromUserId' in payload ? (payload.callerId ?? payload.fromUserId) : payload.callerId,
    callerDisplayName:
      'fromName' in payload ? (payload.callerDisplayName ?? payload.fromName) : payload.callerDisplayName,
    isVideo: 'video' in payload ? (payload.isVideo ?? payload.video) : payload.isVideo,
    eventVersion: payload.eventVersion,
    timestamp:
      'startedAt' in payload
        ? (payload.timestamp ?? payload.eventTimestamp ?? payload.startedAt)
        : (payload.timestamp ?? payload.eventTimestamp),
    source: payload.source,
    roomName: 'roomName' in payload ? (payload.roomName ?? payload.roomHint) : undefined,
    tokenHint: 'tokenHint' in payload ? (payload.tokenHint ?? payload.callTokenHint) : undefined,
  }
}

export function AppRuntimeCoordinator() {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const location = useLocation()
  const session = useAppStore((state) => state.session)
  const setActiveConversationId = useChatUiStore((state) => state.setActiveConversationId)
  const setMobileView = useChatUiStore((state) => state.setMobileView)
  const pendingIntent = useNavigationIntentStore((state) => state.pendingIntent)
  const consumeIntent = useNavigationIntentStore((state) => state.consumeIntent)
  const setIntent = useNavigationIntentStore((state) => state.setIntent)
  const syncingRef = useRef(false)

  useEffect(() => {
    setIncomingCallBootstrapReady(Boolean(session))
  }, [session])

  useEffect(() => {
    return useCallStore.subscribe((state, previousState) => {
      if (previousState.incoming && !state.incoming) {
        clearIncomingCallTracking(previousState.incoming.callId ?? previousState.incoming.conversationId)
      }

      const previousCallId =
        previousState.activeConvId ??
        previousState.overlayConvId ??
        previousState.outgoingCall?.conversationId ??
        null
      const nextCallId =
        state.activeConvId ??
        state.overlayConvId ??
        state.outgoingCall?.conversationId ??
        null

      if (previousCallId && previousCallId !== nextCallId) {
        clearActiveCallTracking(previousCallId)
        clearIncomingCallTracking(previousCallId)
      }
    })
  }, [])

  useEffect(() => {
    nativeBridge.setPendingSyncProvider(async () => getPendingSyncSnapshot())
    nativeBridge.setPresenceModeHandler(async (mode) => {
      const client = getRealtimeClient()
      const next = toPresenceState(mode)
      client.emit('presence:state', {
        ...next,
        source: client.mode === 'native' ? 'mobile' : 'web',
      })
      return { applied: true }
    })
  }, [])

  useEffect(() => {
    const runSync = async () => {
      if (!session || syncingRef.current) return
      syncingRef.current = true
      try {
        await syncAfterResume(queryClient)
      } finally {
        syncingRef.current = false
      }
    }

    const emitPresenceMode = (mode: 'foreground' | 'background') => {
      const client = getRealtimeClient()
      const next = toPresenceState(mode)
      client.emit('presence:state', {
        ...next,
        source: client.mode === 'native' ? 'mobile' : 'web',
      })
    }

    const offForeground = appLifecycle.on('foreground', () => {
      emitPresenceMode('foreground')
      void runSync()
    })
    const offBackground = appLifecycle.on('background', () => {
      emitPresenceMode('background')
    })
    const offFocus = appLifecycle.on('focus', () => {
      emitPresenceMode('foreground')
      void runSync()
    })
    const offNetwork = appLifecycle.on('networkChange', (payload) => {
      if (payload.online) {
        void runSync()
      }
    })

    return () => {
      offForeground()
      offBackground()
      offFocus()
      offNetwork()
    }
  }, [queryClient, session])

  useEffect(() => {
    const offPush = nativeBridge.on('pushMessage', (payload) => {
      setIntent(mapPushPayloadToIntent(payload))
    })
    const offNotification = nativeBridge.on('notificationOpened', (payload) => {
      const intent = mapNotificationPayloadToIntent(payload)
      if (intent) {
        setIntent(intent)
      }
    })
    const offIncomingCall = nativeBridge.on('incomingCall', (payload) => {
      const call = rememberIncomingCall(toIncomingCallActionRequest(payload))
      const conversationId = call?.conversationId ?? payload.conversationId ?? payload.callId
      if (!conversationId) {
        return
      }
      useCallStore.getState().startIncoming({
        callId: call?.callId ?? payload.callId ?? conversationId,
        conversationId,
        from: {
          id: payload.callerId ?? payload.fromUserId ?? 'unknown',
          name: payload.callerDisplayName ?? payload.fromName,
        },
        video: !!(payload.isVideo ?? payload.video),
        source: 'android_native',
        eventVersion: payload.eventVersion,
        timestamp: payload.timestamp ?? payload.startedAt,
      })
    })
    const offCallCanceled = nativeBridge.on('callCanceled', (payload) => {
      cancelIncomingCallAction(toIncomingCallActionRequest(payload), 'remote_event')
    })
    const offNativeAccept = nativeBridge.on('acceptIncomingCallFromNative', (payload) => {
      void acceptIncomingCallAction(toIncomingCallActionRequest(payload), 'android_native')
    })
    const offNativeDecline = nativeBridge.on('declineIncomingCallFromNative', (payload) => {
      void declineIncomingCallAction(toIncomingCallActionRequest(payload), 'android_native')
    })
    const offNativeOpen = nativeBridge.on('openCallFromNative', (payload) => {
      openCallRoute(toIncomingCallActionRequest(payload), 'android_native')
    })
    const offNativeEnd = nativeBridge.on('endActiveCallFromNative', (payload) => {
      void endActiveCallAction(toIncomingCallActionRequest(payload), 'android_native')
    })

    nativeBridge.notifyWebReady()

    return () => {
      offPush()
      offNotification()
      offIncomingCall()
      offCallCanceled()
      offNativeAccept()
      offNativeDecline()
      offNativeOpen()
      offNativeEnd()
    }
  }, [setIntent])

  useEffect(() => {
    if (!pendingIntent) return

    if (pendingIntent.kind === 'call') {
      useNavigationIntentStore.getState().setActiveCallConversationId(pendingIntent.conversationId)
      setActiveConversationId(pendingIntent.conversationId)
      setMobileView('conversation')
      navigate(withAppRoutePrefix(location.pathname, `/chats/${pendingIntent.conversationId}`))
    } else {
      setActiveConversationId(pendingIntent.conversationId)
      setMobileView('conversation')
      navigate(withAppRoutePrefix(location.pathname, `/chats/${pendingIntent.conversationId}`))
    }
    consumeIntent()
  }, [consumeIntent, location.pathname, navigate, pendingIntent, setActiveConversationId, setMobileView])

  useEffect(() => {
    const conversationMatch =
      matchPath('/chats/:conversationId', location.pathname) ??
      matchPath('/app/chats/:conversationId', location.pathname)
    if (conversationMatch?.params.conversationId) {
      setActiveConversationId(conversationMatch.params.conversationId)
      setMobileView('conversation')
      return
    }

    if (location.pathname === '/chats' || location.pathname === '/app/chats') {
      setMobileView('list')
    }
  }, [location.pathname, setActiveConversationId, setMobileView])

  return null
}
