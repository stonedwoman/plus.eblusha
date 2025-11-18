import { create } from 'zustand'

type Incoming = { conversationId: string; from: { id: string; name?: string; avatarUrl?: string | null }; video: boolean } | null

interface CallState {
  incoming: Incoming
  activeConvId: string | null
  initialVideo: boolean
  initialAudio: boolean
  setIncoming: (i: Incoming) => void
  startOutgoing: (conversationId: string, video: boolean) => void
  startIncoming: (payload: { conversationId: string; from: { id: string; name?: string }; video: boolean }) => void
  endCall: () => void
}

export const useCallStore = create<CallState>((set) => ({
  incoming: null,
  activeConvId: null,
  initialVideo: false,
  initialAudio: true,
  setIncoming: (i) => set({ incoming: i }),
  startOutgoing: (conversationId, video) => set({ activeConvId: conversationId, incoming: null, initialVideo: !!video, initialAudio: true }),
  startIncoming: (payload) => set({ incoming: payload }),
  endCall: () => set({ activeConvId: null, incoming: null, initialVideo: false }),
}))


