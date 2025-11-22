// Типы для всех Socket.IO событий

// ========== Сообщения ==========

export interface MessageNewPayload {
  conversationId: string
  messageId: string
  senderId: string
  message?: Message
}

export interface MessageNotifyPayload {
  conversationId: string
  messageId: string
  senderId: string
  message?: Message
}

export interface ConversationTypingPayload {
  conversationId: string
  userId: string
  typing: boolean
}

export interface MessageReactionPayload {
  conversationId: string
  messageId: string
  message?: Message
}

export interface ReceiptsUpdatePayload {
  conversationId: string
  messageIds: string[]
}

// ========== Беседы ==========

export interface ConversationNewPayload {
  conversationId: string
  conversation?: any
}

export interface ConversationUpdatedPayload {
  conversationId: string
  conversation?: any
}

export interface ConversationDeletedPayload {
  conversationId: string
}

export interface ConversationMemberRemovedPayload {
  conversationId: string
  userId: string
}

// ========== Контакты и профили ==========

export interface PresenceUpdatePayload {
  userId: string
  status: 'ONLINE' | 'OFFLINE' | 'AWAY'
}

export interface ContactRequestPayload {
  contactId: string
  from: { id: string; name: string }
}

export interface ContactAcceptedPayload {
  contactId: string
}

export interface ContactRemovedPayload {
  contactId: string
}

export interface ProfileUpdatePayload {
  userId: string
  avatarUrl?: string | null
  displayName?: string | null
}

// ========== Звонки (1:1) ==========

export interface CallIncomingPayload {
  conversationId: string
  from: { id: string; name: string }
  video: boolean
}

export interface CallAcceptedPayload {
  conversationId: string
  by: { id: string }
  video: boolean
}

export interface CallDeclinedPayload {
  conversationId: string
  by: { id: string }
}

export interface CallEndedPayload {
  conversationId: string
  by: { id: string }
}

// ========== Групповые звонки ==========

export interface CallStatusPayload {
  conversationId: string
  active: boolean
  startedAt?: number
  elapsedMs?: number
  participants?: string[]
}

export interface CallStatusBulkPayload {
  statuses: Record<string, CallStatusPayload>
}

// ========== Общие типы ==========

export interface Message {
  id: string
  conversationId: string
  senderId: string
  content?: string
  attachments?: Array<{
    url: string
    type: 'IMAGE' | 'FILE'
    width?: number
    height?: number
  }>
  createdAt: number
}

// ========== Исходящие события (от клиента) ==========

export interface CallInvitePayload {
  conversationId: string
  video: boolean
}

export interface CallAcceptPayload {
  conversationId: string
  video: boolean
}

export interface CallDeclinePayload {
  conversationId: string
}

export interface CallEndPayload {
  conversationId: string
}

export interface CallRoomJoinPayload {
  conversationId: string
  video?: boolean
}

export interface CallRoomLeavePayload {
  conversationId: string
}

export interface CallStatusRequestPayload {
  conversationIds: string[]
}

export interface ConversationTypingEmitPayload {
  conversationId: string
  typing: boolean
}

