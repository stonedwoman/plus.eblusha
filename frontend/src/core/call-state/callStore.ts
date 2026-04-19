import { create } from 'zustand'
import { finalizeApkCallSignal, signalApkIncomingCanceled } from '../../utils/apkCallSignal'

type Incoming = {
  callId?: string
  conversationId: string
  from: { id: string; name?: string; avatarUrl?: string | null }
  video: boolean
  source?: 'web_ui' | 'android_native' | 'bootstrap_replay' | 'remote_event'
  eventVersion?: number
  timestamp?: number
} | null

export type OutgoingCallState = {
  conversationId: string
  startedAt: number
  video: boolean
  minimized?: boolean
} | null

type Updater<T> = T | ((prev: T) => T)

export interface CallState {
  incoming: Incoming
  activeConvId: string | null
  initialVideo: boolean
  initialAudio: boolean
  overlayConvId: string | null
  minimizedCallConvId: string | null
  outgoingCall: OutgoingCallState
  callPermissionError: string | null
  setIncoming: (incoming: Incoming) => void
  setOverlayConvId: (next: Updater<string | null>) => void
  setMinimizedCallConvId: (next: Updater<string | null>) => void
  setOutgoingCall: (next: Updater<OutgoingCallState>) => void
  setCallPermissionError: (error: string | null) => void
  startOutgoing: (conversationId: string, video: boolean) => void
  startIncoming: (payload: {
    callId?: string
    conversationId: string
    from: { id: string; name?: string; avatarUrl?: string | null }
    video: boolean
    source?: 'web_ui' | 'android_native' | 'bootstrap_replay' | 'remote_event'
    eventVersion?: number
    timestamp?: number
  }) => void
  endCall: () => void
}

function resolveUpdater<T>(prev: T, next: Updater<T>): T {
  return typeof next === 'function' ? (next as (value: T) => T)(prev) : next
}

export const useCallStore = create<CallState>((set) => ({
  incoming: null,
  activeConvId: null,
  initialVideo: false,
  initialAudio: true,
  overlayConvId: null,
  minimizedCallConvId: null,
  outgoingCall: null,
  callPermissionError: null,
  setIncoming: (incoming) =>
    set((state) => {
      const previousIncoming = state.incoming
      if (!incoming && previousIncoming?.conversationId) {
        signalApkIncomingCanceled(previousIncoming.conversationId, previousIncoming.video)
      }
      return { incoming }
    }),
  setOverlayConvId: (next) =>
    set((state) => ({
      overlayConvId: resolveUpdater(state.overlayConvId, next),
    })),
  setMinimizedCallConvId: (next) =>
    set((state) => ({
      minimizedCallConvId: resolveUpdater(state.minimizedCallConvId, next),
    })),
  setOutgoingCall: (next) =>
    set((state) => ({
      outgoingCall: resolveUpdater(state.outgoingCall, next),
    })),
  setCallPermissionError: (callPermissionError) => set({ callPermissionError }),
  startOutgoing: (conversationId, video) =>
    set({
      activeConvId: conversationId,
      incoming: null,
      initialVideo: !!video,
      initialAudio: true,
    }),
  startIncoming: (payload) => set({ incoming: payload }),
  endCall: () =>
    set((state) => {
      const conversationId =
        state.overlayConvId ?? state.activeConvId ?? state.outgoingCall?.conversationId ?? state.incoming?.conversationId ?? null
      const video =
        state.outgoingCall?.video ??
        state.incoming?.video ??
        state.initialVideo ??
        false

      if (conversationId) {
        finalizeApkCallSignal(conversationId, video)
      }

      return {
        activeConvId: null,
        incoming: null,
        initialVideo: false,
        overlayConvId: null,
        minimizedCallConvId: null,
        outgoingCall: null,
        callPermissionError: null,
      }
    }),
}))
