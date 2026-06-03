import { create } from 'zustand'

type MobileView = 'list' | 'conversation'
type Updater<T> = T | ((prev: T) => T)

export interface ChatUiState {
  activeConversationId: string | null
  mobileView: MobileView
  joinedConversationIds: string[]
  needsFullSync: boolean
  pendingReceipts: string[]
  needSecretInboxPull: boolean
  lastSyncAt: number | null
  setActiveConversationId: (next: Updater<string | null>) => void
  setMobileView: (next: Updater<MobileView>) => void
  markConversationJoined: (conversationId: string) => void
  clearConversationJoined: (conversationId: string) => void
  setNeedsFullSync: (needsFullSync: boolean) => void
  setPendingReceipts: (pendingReceipts: string[]) => void
  setNeedSecretInboxPull: (needSecretInboxPull: boolean) => void
  markSyncFinished: () => void
}

function resolveUpdater<T>(prev: T, next: Updater<T>): T {
  return typeof next === 'function' ? (next as (value: T) => T)(prev) : next
}

// Derive the initial mobile view from the current URL. If we boot directly on a conversation
// route (/chats/<id>), the view must start as 'conversation'; otherwise the URL ('/chats/<id>')
// and the default 'list' disagree, and the two effects that keep mobile view-state ↔ URL in sync
// ping-pong /chats ↔ /chats/<id> ~50×/s, remounting the whole screen (the "everything jitters" bug).
const initialMobileView: MobileView =
  typeof window !== 'undefined' && /^\/(?:app\/)?chats\/[^/]+/.test(window.location.pathname)
    ? 'conversation'
    : 'list'

export const useChatUiStore = create<ChatUiState>((set) => ({
  activeConversationId: null,
  mobileView: initialMobileView,
  joinedConversationIds: [],
  needsFullSync: true,
  pendingReceipts: [],
  needSecretInboxPull: false,
  lastSyncAt: null,
  setActiveConversationId: (next) =>
    set((state) => ({
      activeConversationId: resolveUpdater(state.activeConversationId, next),
    })),
  setMobileView: (next) =>
    set((state) => ({
      mobileView: resolveUpdater(state.mobileView, next),
    })),
  markConversationJoined: (conversationId) =>
    set((state) => ({
      joinedConversationIds: state.joinedConversationIds.includes(conversationId)
        ? state.joinedConversationIds
        : [...state.joinedConversationIds, conversationId],
    })),
  clearConversationJoined: (conversationId) =>
    set((state) => ({
      joinedConversationIds: state.joinedConversationIds.filter((id) => id !== conversationId),
    })),
  setNeedsFullSync: (needsFullSync) => set({ needsFullSync }),
  setPendingReceipts: (pendingReceipts) => set({ pendingReceipts }),
  setNeedSecretInboxPull: (needSecretInboxPull) => set({ needSecretInboxPull }),
  markSyncFinished: () =>
    set({
      needsFullSync: false,
      lastSyncAt: Date.now(),
    }),
}))
