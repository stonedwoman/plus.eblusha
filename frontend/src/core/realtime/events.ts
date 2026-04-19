import type {
  CallAcceptedPayload,
  CallDeclinedPayload,
  CallEndedPayload,
  CallIncomingPayload,
  CallInvitePayload,
  CallRoomJoinPayload,
  CallRoomLeavePayload,
  CallStatusBulkPayload,
  CallStatusPayload,
  CallStatusRequestPayload,
  ConversationDeletedPayload,
  ConversationMemberRemovedPayload,
  ConversationNewPayload,
  ConversationTypingEmitPayload,
  ConversationTypingPayload,
  ConversationUpdatedPayload,
  ContactAcceptedPayload,
  ContactRemovedPayload,
  ContactRequestPayload,
  MessageNewPayload,
  MessageNotifyPayload,
  MessageReactionPayload,
  PresenceUpdatePayload,
  ProfileUpdatePayload,
  ReceiptsUpdatePayload,
} from '../../capacitor/types/socket-events'

export type PresenceGame = {
  discordAppId: string
  name: string
  steamAppId?: string | number
  startedAt: number
  imageUrl?: string | null
}

export type PresenceGameClearReason = 'no_game' | 'privacy_off'
export type PresenceGamePayload = {
  userId: string
  ts: number
  game: PresenceGame | null
  reason?: PresenceGameClearReason
}

export type PresenceGameSnapshotBatchPayload = {
  items: PresenceGamePayload[]
}

export type MessageUpdatePayload = {
  conversationId: string
  messageId: string
  reason: string
  message?: any
}

export type ConversationTypingUpdatePayload = {
  conversationId: string
  userId: string
  isTyping: boolean
  displayName?: string | null
}

export type ContactRejectedPayload = {
  contactId: string
  friend?: { id: string; username: string; displayName: string | null }
}

export type AvailabilityUpdatedPayload = {
  conversationId: string
  userId: string
}

export type AvailabilityProposalsUpdatedPayload = {
  conversationId: string
  proposalId?: string
}

export type SessionNewPayload = {
  userId: string
  deviceId: string
  deviceName?: string
  platform?: string
  lastIp?: string
  lastCity?: string
  lastCountry?: string
  ts: number
}

export type SecretNotifyPayload = {
  conversationId?: string
  threadId?: string
  messageId?: string
}

export type RealtimeInboundEventMap = {
  connect: undefined
  disconnect: string | undefined
  'message:new': MessageNewPayload
  'message:notify': MessageNotifyPayload
  'message:reaction': MessageReactionPayload
  'message:update': MessageUpdatePayload
  'receipts:update': ReceiptsUpdatePayload
  'conversation:typing': ConversationTypingPayload
  'conversation:typing_update': ConversationTypingUpdatePayload
  'conversations:new': ConversationNewPayload
  'conversations:updated': ConversationUpdatedPayload
  'conversations:deleted': ConversationDeletedPayload
  'conversations:member:removed': ConversationMemberRemovedPayload
  'contacts:request:new': ContactRequestPayload
  'contacts:request:accepted': ContactAcceptedPayload
  'contacts:request:rejected': ContactRejectedPayload
  'contacts:removed': ContactRemovedPayload
  'profile:update': ProfileUpdatePayload
  'presence:update': PresenceUpdatePayload
  'presence:game': PresenceGamePayload
  'presence:game:snapshot': PresenceGamePayload
  'presence:game:snapshot:batch': PresenceGameSnapshotBatchPayload
  'call:incoming': CallIncomingPayload
  'call:accepted': CallAcceptedPayload
  'call:declined': CallDeclinedPayload
  'call:ended': CallEndedPayload
  'call:status': CallStatusPayload
  'call:status:bulk': CallStatusBulkPayload
  'availability:updated': AvailabilityUpdatedPayload
  'availability:proposals:updated': AvailabilityProposalsUpdatedPayload
  'session:new': SessionNewPayload
  'secret:notify': SecretNotifyPayload
}

export type RealtimeOutboundEventMap = {
  'conversation:join': string
  'conversation:leave': string
  'conversation:typing': ConversationTypingEmitPayload
  'typing_start': string
  'typing_ping': string
  'typing_stop': string
  'call:invite': CallInvitePayload
  'call:accept': { conversationId: string; video: boolean }
  'call:decline': { conversationId: string }
  'call:end': { conversationId: string }
  'call:room:join': CallRoomJoinPayload
  'call:room:leave': CallRoomLeavePayload
  'call:status:request': CallStatusRequestPayload
  'presence:focus': { focused: boolean }
  'presence:state': {
    active: boolean
    visibility: 'visible' | 'hidden'
    source: 'web' | 'electron' | 'mobile'
  }
  'presence:game:subscribe': { peerUserId: string }
  'presence:game:hello': { openPeers: string[] }
}
