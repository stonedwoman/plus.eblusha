/**
 * Рендер оверлея активного звонка (ленивый CallOverlay). Вынесено из ChatsPage;
 * это обычная функция рендера (не компонент), получает нужные значения через ctx.
 */
import { Suspense, lazy } from 'react'
import { endActiveCallAction } from '../../../../core/call-state/incomingCallActions'
import { endCall } from '../../../../core/realtime'

const CallOverlay = lazy(() => import('../../../components/CallOverlay').then((m) => ({ default: m.CallOverlay })))

export interface CallOverlayHostCtx {
  callConvId: any
  minimizedCallConvId: any
  conversationsQuery: any
  activeConversation: any
  currentUserId: any
  me: any
  meInfoQuery: any
  setMinimizedCallConvId: any
  getConversationFromCache: any
  callStore: any
  setCallConvId: any
  callConvIdRef: any
  setActiveCalls: any
  activeCalls?: Record<string, { startedAt?: number | null }>
  stopRingtone: any
  scheduleAfterMinCallDuration: any
  clearMinCallDurationGuard: any
  isOneToOneConversation: any
  outgoingCall: any
  outgoingCallTimerRef: any
  setOutgoingCall: any
  stopDialingSound: any
  playEndCallSound: any
  dialingTonePeriodMs: any
}

export function renderActiveCallOverlay(ctx: CallOverlayHostCtx) {
  const { callConvId, minimizedCallConvId, conversationsQuery, activeConversation, currentUserId, me, meInfoQuery, setMinimizedCallConvId, getConversationFromCache, callStore, setCallConvId, callConvIdRef, setActiveCalls, activeCalls, stopRingtone, scheduleAfterMinCallDuration, clearMinCallDurationGuard, isOneToOneConversation, outgoingCall, outgoingCallTimerRef, setOutgoingCall, stopDialingSound, playEndCallSound, dialingTonePeriodMs } = ctx
    // Дозвон 1:1 идёт в том же оверлее: панель появляется в момент набора, комната —
    // только после ответа. У групп дозвона нет — там оверлей открывается сразу.
    const dialConv = !callConvId && outgoingCall ? getConversationFromCache(outgoingCall.conversationId) : null
    const dialGroup = !!(dialConv?.isGroup || (dialConv?.participants?.length ?? 0) > 2)
    const dialConvId = !callConvId && outgoingCall && !dialGroup ? outgoingCall.conversationId : null
    const shownConvId = callConvId ?? dialConvId
    if (!shownConvId) return null
    const dialing = !callConvId
    // Сброс на дозвоне — прежний путь диалога «дозвон…»: сторож, звук, call:end, состояние.
    const cancelDial = () => {
      if (!outgoingCall) return
      const convId = outgoingCall.conversationId
      if (outgoingCallTimerRef.current) {
        window.clearTimeout(outgoingCallTimerRef.current)
        outgoingCallTimerRef.current = null
      }
      stopDialingSound()
      playEndCallSound()
      endCall(convId)
      setOutgoingCall(null)
      setActiveCalls((prev: any) => {
        const current = prev[convId]
        if (current?.active) {
          return { ...prev, [convId]: { ...current, active: false, endedAt: Date.now() } }
        }
        const { [convId]: _omit, ...rest } = prev
        return rest
      })
      callStore.endCall()
    }

    return (
      <Suspense fallback={null}>
        <CallOverlay
          open
          conversationId={shownConvId}
          minimized={!dialing && minimizedCallConvId === callConvId}
          dialing={dialing}
          dialingSince={outgoingCall?.startedAt ?? null}
          ringPeriodMs={dialingTonePeriodMs ?? null}
          onCancelDial={cancelDial}
          peerAvatarUrl={(() => {
            // Keep the overlay outside responsive panes so orientation changes do not remount LiveKit.
            const conv = shownConvId
              ? conversationsQuery.data?.find((r: any) => r.conversation.id === shownConvId)?.conversation
              : activeConversation
            const parts = conv?.participants || []
            if (parts.length === 2) {
              const peer = parts.find((p: any) => (currentUserId ? p.user.id !== currentUserId : true))?.user
              return peer?.avatarUrl ?? null
            }
            return null
          })()}
          avatarsByName={(() => {
            const conv = shownConvId
              ? conversationsQuery.data?.find((r: any) => r.conversation.id === shownConvId)?.conversation
              : activeConversation
            const parts = conv?.participants || []
            const map: Record<string, string | null> = {}
            for (const p of parts) {
              const u = p.user
              const name = u.displayName ?? u.username ?? u.id
              map[name] = u.avatarUrl ?? null
            }
            if (me) map[me.displayName ?? me.username ?? me.id] = meInfoQuery.data?.avatarUrl ?? me.avatarUrl ?? null
            return map
          })()}
          avatarsById={(() => {
            const conv = shownConvId
              ? conversationsQuery.data?.find((r: any) => r.conversation.id === shownConvId)?.conversation
              : activeConversation
            const parts = conv?.participants || []
            const map: Record<string, string | null> = {}
            for (const p of parts) {
              const u = p.user
              map[u.id] = u.avatarUrl ?? null
            }
            if (me) map[me.id] = meInfoQuery.data?.avatarUrl ?? me.avatarUrl ?? null
            return map
          })()}
          localUserId={me?.id ?? null}
          isGroup={(() => {
            const conv = shownConvId
              ? conversationsQuery.data?.find((r: any) => r.conversation.id === shownConvId)?.conversation
              : activeConversation
            return !!conv?.isGroup
          })()}
          peerName={(() => {
            const conv = shownConvId
              ? conversationsQuery.data?.find((r: any) => r.conversation.id === shownConvId)?.conversation
              : activeConversation
            const peer = conv?.participants?.find((p: any) => (currentUserId ? p.user.id !== currentUserId : true))?.user
            return peer?.displayName ?? peer?.username ?? null
          })()}
          peerId={(() => {
            const conv = shownConvId
              ? conversationsQuery.data?.find((r: any) => r.conversation.id === shownConvId)?.conversation
              : activeConversation
            return conv?.participants?.find((p: any) => (currentUserId ? p.user.id !== currentUserId : true))?.user?.id ?? null
          })()}
          conversationTitle={(() => {
            const conv = shownConvId
              ? conversationsQuery.data?.find((r: any) => r.conversation.id === shownConvId)?.conversation
              : activeConversation
            return conv?.title ?? null
          })()}
          conversationAvatarUrl={(() => {
            const conv = shownConvId
              ? conversationsQuery.data?.find((r: any) => r.conversation.id === shownConvId)?.conversation
              : activeConversation
            return conv?.avatarUrl ?? null
          })()}
          callStartedAt={callConvId ? activeCalls?.[callConvId]?.startedAt ?? null : null}
          onExpand={() => {
            if (!callConvId) return
            setCallConvId(callConvId)
            setMinimizedCallConvId(null)
          }}
          onMinimize={dialing ? undefined : () => {
            if (callConvId) {
              const convIdToMinimize = callConvId
              setMinimizedCallConvId(convIdToMinimize)
              const conv = getConversationFromCache(convIdToMinimize)
              const isGroupConv = !!(conv?.isGroup || (conv?.participants?.length ?? 0) > 2)
              if (!isGroupConv && callStore.activeConvId !== convIdToMinimize) {
                callStore.startOutgoing(convIdToMinimize, callStore.initialVideo)
              }
              if (callConvId !== convIdToMinimize) {
                setCallConvId(convIdToMinimize)
              }
            }
          }}
          onClose={(options) => {
            const convId = callConvId ?? callConvIdRef.current
            if (!convId) return
            const finalize = () => {
              const conv = getConversationFromCache(convId)
              const participantsCount = conv?.participants?.length ?? 0
              const isGroupConv = !!(conv?.isGroup || participantsCount > 2)
              const isDialog = !isGroupConv
              if (isDialog) {
                endCall(convId)
              }
              setActiveCalls((prev: any) => {
                const current = prev[convId]
                if (!current) return prev
                if (isGroupConv) {
                  const participants = (current.participants || []).filter((id: string) =>
                    currentUserId ? id !== currentUserId : true,
                  )
                  return { ...prev, [convId]: { ...current, participants } }
                }
                if (current.active) {
                  return { ...prev, [convId]: { ...current, active: false, endedAt: Date.now() } }
                }
                return prev
              })
              setCallConvId((prev: any) => (prev === convId ? null : prev))
              setMinimizedCallConvId((prev: any) => (prev === convId ? null : prev))
              callStore.endCall()
              stopRingtone()
            }
            if (options?.manual) {
              // Ручное завершение обязано доводить звонок до конца — даже если он был
              // свёрнут и даже если общий end-action не смог зарезолвить runtime/цель
              // (раньше это молча ничего не делало, и звонок «зависал» на экране).
              // Если endActiveCallAction сообщил, что ничего не сделал — падаем в
              // локальную очистку.
              void endActiveCallAction(
                { callId: convId, conversationId: convId },
                'web_ui',
              )
                .then((ended) => {
                  if (!ended) {
                    console.warn('[call] ручное завершение: fallback на локальную очистку')
                    finalize()
                  }
                })
                .catch(() => {
                  finalize()
                })
              return
            }
            // Не-ручное закрытие = кратковременный обрыв LiveKit. Сохраняем гард, чтобы
            // свёрнутый (фоновый) звонок не сносился спонтанным onClose.
            if (minimizedCallConvId === convId) {
              return
            }
            if (isOneToOneConversation(convId)) {
              scheduleAfterMinCallDuration(convId, finalize)
            } else {
              clearMinCallDurationGuard(convId)
              finalize()
            }
          }}
          initialVideo={dialing ? !!outgoingCall?.video : callStore.initialVideo}
          initialAudio={callStore.initialAudio}
        />
      </Suspense>
    )
}
