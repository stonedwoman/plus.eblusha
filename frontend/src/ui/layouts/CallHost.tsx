import { Suspense, lazy, useCallback, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { useQuery } from '@tanstack/react-query'
import { useLocation, useNavigate } from 'react-router-dom'
import { Maximize2, Minus, Phone, PhoneOff, Video } from 'lucide-react'
import { api } from '../../core/api'
import {
  acceptIncomingCallAction,
  declineIncomingCallAction,
  endActiveCallAction,
  registerActiveCallRuntime,
  registerIncomingCallRuntime,
  type ResolvedActiveCall,
  type ResolvedIncomingCall,
} from '../../core/call-state/incomingCallActions'
import { acceptCall, declineCall, endCall } from '../../core/realtime'
import { useCallStore } from '../../domain/store/callStore'
import { Avatar } from '../components/Avatar'
import { ensureMediaPermissions } from '../../utils/media'
import { isChatsRoute, withAppRoutePrefix } from '../../core/navigation/routes'
import { signalApkIncomingAccepted } from '../../utils/apkCallSignal'

const CallOverlay = lazy(() => import('../components/CallOverlay').then((module) => ({ default: module.CallOverlay })))

function useConversationData() {
  const conversationsQuery = useQuery({
    queryKey: ['conversations'],
    queryFn: async () => {
      const response = await api.get('/conversations')
      return response.data.conversations as any[]
    },
  })

  const contactsQuery = useQuery({
    queryKey: ['contacts'],
    queryFn: async () => {
      const response = await api.get('/contacts')
      return response.data.contacts as any[]
    },
  })

  const meQuery = useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      const response = await api.get('/status/me')
      return response.data.user
    },
  })

  return { conversationsQuery, contactsQuery, meQuery }
}

export function CallHost() {
  const location = useLocation()
  const navigate = useNavigate()
  const onChatsRoute = isChatsRoute(location.pathname)

  const incoming = useCallStore((state) => state.incoming)
  const outgoingCall = useCallStore((state) => state.outgoingCall)
  const overlayConvId = useCallStore((state) => state.overlayConvId)
  const minimizedCallConvId = useCallStore((state) => state.minimizedCallConvId)
  const callPermissionError = useCallStore((state) => state.callPermissionError)
  const setIncoming = useCallStore((state) => state.setIncoming)
  const setOutgoingCall = useCallStore((state) => state.setOutgoingCall)
  const setOverlayConvId = useCallStore((state) => state.setOverlayConvId)
  const setMinimizedCallConvId = useCallStore((state) => state.setMinimizedCallConvId)
  const setCallPermissionError = useCallStore((state) => state.setCallPermissionError)
  const startOutgoing = useCallStore((state) => state.startOutgoing)
  const endStoredCall = useCallStore((state) => state.endCall)

  const { conversationsQuery, contactsQuery, meQuery } = useConversationData()
  const me = meQuery.data

  const conversations = conversationsQuery.data ?? []
  const contacts = contactsQuery.data ?? []

  const getConversation = (conversationId: string | null | undefined) =>
    conversations.find((row: any) => row?.conversation?.id === conversationId)?.conversation ?? null

  const requireMediaAccess = useCallback(async (needsVideo: boolean) => {
    const result = await ensureMediaPermissions({ audio: true, video: needsVideo })
    if (!result.ok) {
      setCallPermissionError(
        needsVideo
          ? 'Не удалось получить доступ к камере и микрофону.'
          : 'Не удалось получить доступ к микрофону.',
      )
      return false
    }
    setCallPermissionError(null)
    return true
  }, [setCallPermissionError])

  const performAcceptIncomingCall = useCallback(async (
    call: ResolvedIncomingCall,
    source: 'web_ui' | 'android_native' | 'bootstrap_replay' | 'remote_event',
  ) => {
    if (!(await requireMediaAccess(call.isVideo))) return false
    const conversationId = call.conversationId
    acceptCall(conversationId, call.isVideo)
    signalApkIncomingAccepted(conversationId, call.isVideo)
    startOutgoing(conversationId, call.isVideo)
    setOverlayConvId(conversationId)
    setMinimizedCallConvId((prev) => (prev === conversationId ? null : prev))
    setIncoming(null)
    if (source === 'web_ui') {
      navigate(withAppRoutePrefix(location.pathname, `/chats/${conversationId}`))
    }
    return true
  }, [location.pathname, navigate, requireMediaAccess, setIncoming, setMinimizedCallConvId, setOverlayConvId, startOutgoing])

  const performDeclineIncomingCall = useCallback((call: ResolvedIncomingCall) => {
    declineCall(call.conversationId)
    setIncoming(null)
    return true
  }, [setIncoming])

  const performEndActiveCall = useCallback((call: ResolvedActiveCall) => {
    endCall(call.conversationId)
    endStoredCall()
    navigate(withAppRoutePrefix(location.pathname, `/chats/${call.conversationId}`))
    return true
  }, [endStoredCall, location.pathname, navigate])

  useEffect(() => {
    return registerIncomingCallRuntime({
      id: 'call-host',
      priority: 50,
      isReady: () => !onChatsRoute,
      acceptIncomingCall: performAcceptIncomingCall,
      declineIncomingCall: performDeclineIncomingCall,
    })
  }, [onChatsRoute, performAcceptIncomingCall, performDeclineIncomingCall])

  useEffect(() => {
    return registerActiveCallRuntime({
      id: 'call-host',
      priority: 50,
      isReady: () => !onChatsRoute,
      endActiveCall: performEndActiveCall,
    })
  }, [onChatsRoute, performEndActiveCall])

  const closeOverlay = () => {
    if (!overlayConvId) return
    void endActiveCallAction(
      {
        callId: overlayConvId,
        conversationId: overlayConvId,
      },
      'web_ui',
    )
  }

  if (onChatsRoute) {
    return null
  }

  return (
    <>
      <Suspense fallback={null}>
        {overlayConvId && (
          <CallOverlay
            open={!!overlayConvId}
            conversationId={overlayConvId}
            minimized={minimizedCallConvId === overlayConvId}
            peerAvatarUrl={(() => {
              const conversation = getConversation(overlayConvId)
              const parts = conversation?.participants || []
              if (parts.length === 2) {
                const peer = parts.find((participant: any) => participant.user.id !== me?.id)?.user
                return peer?.avatarUrl ?? null
              }
              return null
            })()}
            avatarsByName={(() => {
              const conversation = getConversation(overlayConvId)
              const parts = conversation?.participants || []
              const map: Record<string, string | null> = {}
              for (const participant of parts) {
                const user = participant.user
                map[user.displayName ?? user.username ?? user.id] = user.avatarUrl ?? null
              }
              if (me) {
                map[me.displayName ?? me.username ?? me.id] = me.avatarUrl ?? null
              }
              return map
            })()}
            avatarsById={(() => {
              const conversation = getConversation(overlayConvId)
              const parts = conversation?.participants || []
              const map: Record<string, string | null> = {}
              for (const participant of parts) {
                const user = participant.user
                map[user.id] = user.avatarUrl ?? null
              }
              if (me) {
                map[me.id] = me.avatarUrl ?? null
              }
              return map
            })()}
            localUserId={me?.id ?? null}
            isGroup={!!getConversation(overlayConvId)?.isGroup}
            onMinimize={() => {
              if (overlayConvId) {
                setMinimizedCallConvId(overlayConvId)
              }
            }}
            onClose={() => {
              closeOverlay()
            }}
          />
        )}
      </Suspense>

      {outgoingCall &&
        (() => {
          const conversation = getConversation(outgoingCall.conversationId)
          const isGroup = !!(conversation?.isGroup || (conversation?.participants?.length ?? 0) > 2)
          if (isGroup) return null

          let displayName = 'Неизвестный'
          let avatarUrl: string | undefined
          let avatarId = outgoingCall.conversationId
          const otherParticipant = conversation?.participants?.find((participant: any) => participant.user.id !== me?.id)?.user
          if (otherParticipant) {
            displayName = otherParticipant.displayName ?? otherParticipant.username ?? otherParticipant.id ?? 'Неизвестный'
            avatarUrl = otherParticipant.avatarUrl
            avatarId = otherParticipant.id
          } else {
            const contact = contacts.find((entry: any) => (entry.conversationIds || []).includes(outgoingCall.conversationId))
            if (contact?.friend) {
              displayName = contact.friend.displayName ?? contact.friend.username ?? contact.friend.id ?? 'Неизвестный'
              avatarUrl = contact.friend.avatarUrl
              avatarId = contact.friend.id
            }
          }

          const elapsed = Math.floor((Date.now() - outgoingCall.startedAt) / 1000)
          const minutes = Math.floor(elapsed / 60)
          const seconds = elapsed % 60
          const timeStr = `${minutes}:${seconds.toString().padStart(2, '0')}`

          return createPortal(
            <div
              style={{
                position: 'fixed',
                inset: 0,
                background: 'rgba(10,12,16,0.55)',
                backdropFilter: 'blur(4px) saturate(110%)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                zIndex: 1001,
              }}
            >
              <div
                style={{
                  background: 'var(--surface-200)',
                  borderRadius: 16,
                  border: '1px solid var(--surface-border)',
                  padding: 24,
                  width: 'min(92vw, 440px)',
                  boxShadow: 'var(--shadow-sharp)',
                  transform: 'translateY(-4vh)',
                  color: 'var(--text-primary)',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
                  <div style={{ fontWeight: 700 }}>{outgoingCall.video ? 'Видеозвонок' : 'Звонок'}</div>
                  {!outgoingCall.minimized ? (
                    <button
                      className="btn btn-icon btn-ghost"
                      onClick={() => {
                        setOutgoingCall((prev) => (prev ? { ...prev, minimized: true } : null))
                      }}
                      style={{ padding: 8 }}
                    >
                      <Minus size={18} />
                    </button>
                  ) : null}
                </div>
                <div
                  className="caller-tile"
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12,
                    padding: 12,
                    background: 'var(--surface-100)',
                    border: '1px solid var(--surface-border)',
                    borderRadius: 12,
                    marginBottom: 16,
                  }}
                >
                  <Avatar name={displayName} id={avatarId} size={64} avatarUrl={avatarUrl} />
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 600, fontSize: 16 }}>{displayName}</div>
                    <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>дозвон…</div>
                  </div>
                  <div style={{ fontSize: 18, fontWeight: 600, color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums' }}>
                    {timeStr}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button
                    className="btn"
                    style={{
                      background: '#ef4444',
                      color: '#fff',
                      flex: 1,
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: 8,
                      padding: '14px 16px',
                      minHeight: 48,
                      borderRadius: 12,
                    }}
                    onClick={() => {
                      endCall(outgoingCall.conversationId)
                      setOutgoingCall(null)
                      endStoredCall()
                    }}
                  >
                    <PhoneOff size={18} />
                    <span>Сбросить</span>
                  </button>
                  {outgoingCall.minimized ? (
                    <button
                      className="btn btn-primary"
                      style={{
                        flex: 1,
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: 8,
                        padding: '14px 16px',
                        minHeight: 48,
                        borderRadius: 12,
                      }}
                      onClick={() => {
                        setOutgoingCall((prev) => (prev ? { ...prev, minimized: false } : null))
                        navigate(withAppRoutePrefix(location.pathname, `/chats/${outgoingCall.conversationId}`))
                      }}
                    >
                      <Maximize2 size={18} />
                      <span>Развернуть</span>
                    </button>
                  ) : null}
                </div>
              </div>
            </div>,
            document.body,
          )
        })()}

      {incoming && incoming.source !== 'android_native' &&
        createPortal(
          <div
            style={{
              position: 'fixed',
              inset: 0,
              background: 'rgba(10,12,16,0.55)',
              backdropFilter: 'blur(4px) saturate(110%)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              zIndex: 1001,
            }}
          >
            <div
              style={{
                background: 'var(--surface-200)',
                borderRadius: 16,
                border: '1px solid var(--surface-border)',
                padding: 24,
                width: 'min(92vw, 440px)',
                boxShadow: 'var(--shadow-sharp)',
                transform: 'translateY(-4vh)',
                color: 'var(--text-primary)',
              }}
            >
              <div style={{ fontWeight: 700, marginBottom: 12 }}>
                {incoming.video ? 'Входящий видеозвонок' : 'Входящий аудиозвонок'}
              </div>
              <div
                className="caller-tile"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  padding: 12,
                  background: 'var(--surface-100)',
                  border: '1px solid var(--surface-border)',
                  borderRadius: 12,
                  marginBottom: 12,
                }}
              >
                <Avatar
                  name={incoming.from.name ?? incoming.from.id}
                  id={incoming.from.id}
                  size={64}
                  avatarUrl={
                    incoming.from.avatarUrl ??
                    getConversation(incoming.conversationId)?.participants?.find((participant: any) => participant.user.id === incoming.from.id)?.user?.avatarUrl ??
                    contacts.find((contact: any) => contact.friend?.id === incoming.from.id)?.friend?.avatarUrl ??
                    undefined
                  }
                />
                <div>
                  <div style={{ fontWeight: 600, fontSize: 16 }}>{incoming.from.name ?? incoming.from.id}</div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>звонит…</div>
                </div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button
                    className="btn btn-primary"
                    style={{
                      flex: 1,
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: 8,
                      padding: '14px 16px',
                      minHeight: 48,
                      borderRadius: 12,
                    }}
                    onClick={() => {
                      void acceptIncomingCallAction(
                        {
                          callId: incoming.callId ?? incoming.conversationId,
                          conversationId: incoming.conversationId,
                          isVideo: false,
                        },
                        'web_ui',
                      )
                    }}
                  >
                    <Phone size={18} />
                    <span>Ответить</span>
                  </button>
                  <button
                    className="btn"
                    style={{
                      background: 'var(--brand)',
                      color: '#fff',
                      flex: 1,
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: 8,
                      padding: '14px 16px',
                      minHeight: 48,
                      borderRadius: 12,
                    }}
                    onClick={() => {
                      void acceptIncomingCallAction(
                        {
                          callId: incoming.callId ?? incoming.conversationId,
                          conversationId: incoming.conversationId,
                          isVideo: true,
                        },
                        'web_ui',
                      )
                    }}
                  >
                    <Video size={18} />
                    <span>Ответить с видео</span>
                  </button>
                </div>
                <div style={{ display: 'flex' }}>
                  <button
                    className="btn"
                    style={{
                      background: '#ef4444',
                      color: '#fff',
                      width: '100%',
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: 8,
                      padding: '14px 16px',
                      minHeight: 48,
                      borderRadius: 12,
                    }}
                    onClick={() => {
                      void declineIncomingCallAction(
                        {
                          callId: incoming.callId ?? incoming.conversationId,
                          conversationId: incoming.conversationId,
                        },
                        'web_ui',
                      )
                    }}
                  >
                    <PhoneOff size={18} />
                    <span>Отмена</span>
                  </button>
                </div>
                {callPermissionError ? (
                  <div style={{ marginTop: 12, fontSize: 13, color: '#fca5a5', textAlign: 'center', lineHeight: 1.4 }}>
                    {callPermissionError}
                  </div>
                ) : null}
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  )
}
