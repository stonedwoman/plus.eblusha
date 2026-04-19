import type { QueryClient } from '@tanstack/react-query'
import { useCallStore } from '../../domain/store/callStore'
import { forceRefreshSession } from '../auth'
import { connectSocket, joinConversation, requestCallStatuses } from '../realtime'
import { useChatUiStore } from './chatUiStore'

export type PendingSyncSnapshot = {
  version: 1
  needsFullSync: boolean
  conversationIds: string[]
  pendingReceipts: string[]
  needSecretInboxPull: boolean
  activeCallConversationId?: string | null
}

export function getPendingSyncSnapshot(): PendingSyncSnapshot {
  const chatUi = useChatUiStore.getState()
  const callState = useCallStore.getState()
  const conversationIds = Array.from(
    new Set(
      [
        ...chatUi.joinedConversationIds,
        chatUi.activeConversationId,
        callState.activeConvId,
        callState.overlayConvId,
        callState.outgoingCall?.conversationId ?? null,
        callState.incoming?.conversationId ?? null,
      ].filter((value): value is string => typeof value === 'string' && value.length > 0),
    ),
  )

  return {
    version: 1,
    needsFullSync: chatUi.needsFullSync,
    conversationIds,
    pendingReceipts: chatUi.pendingReceipts,
    needSecretInboxPull: chatUi.needSecretInboxPull,
    activeCallConversationId: callState.overlayConvId ?? callState.activeConvId ?? null,
  }
}

export async function syncAfterResume(queryClient: QueryClient): Promise<PendingSyncSnapshot> {
  try {
    await forceRefreshSession()
  } catch {
    // keep sync best-effort; hard auth failures are handled elsewhere
  }

  connectSocket()

  const snapshot = getPendingSyncSnapshot()
  if (snapshot.conversationIds.length > 0) {
    snapshot.conversationIds.forEach((conversationId) => {
      joinConversation(conversationId)
    })
    requestCallStatuses(snapshot.conversationIds)
  }

  const queryKeys = [
    ['conversations'],
    ['me'],
    ['my-devices'],
    ['my-devices-settings'],
    ['contacts'],
    ['incoming-contacts'],
  ]

  await Promise.allSettled(
    queryKeys.map((queryKey) =>
      queryClient.invalidateQueries({
        queryKey,
      }),
    ),
  )

  const activeConversationId = useChatUiStore.getState().activeConversationId
  if (activeConversationId) {
    await queryClient.invalidateQueries({
      queryKey: ['messages', activeConversationId],
    })
  }

  useChatUiStore.getState().markSyncFinished()
  return getPendingSyncSnapshot()
}
