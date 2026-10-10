/** Формы данных backend Еблуши в том виде, в каком их отдают /api/* и socket.io (src/routes, src/realtime). */

export type EbAttachmentType = "IMAGE" | "VIDEO" | "AUDIO" | "FILE";
export type EbMessageType = "TEXT" | "IMAGE" | "VIDEO" | "AUDIO" | "FILE" | "SYSTEM" | "CALL";

export interface EbUserRef {
  id: string;
  username?: string;
  displayName?: string | null;
  avatarUrl?: string | null;
}

export interface EbAttachment {
  id?: string;
  url: string;
  type: EbAttachmentType;
  size?: number | null;
  metadata?: Record<string, unknown> | null;
}

export interface EbReplyRef {
  id: string;
  content: string | null;
  senderId: string;
  createdAt?: string;
}

export interface EbMessage {
  id: string;
  conversationId: string;
  senderId: string;
  type: EbMessageType;
  content: string | null;
  createdAt: string;
  replyToId?: string | null;
  replyTo?: EbReplyRef | null;
  sender?: EbUserRef | null;
  attachments?: EbAttachment[];
  metadata?: Record<string, unknown> | null;
  deletedAt?: string | null;
  reactions?: Array<{ userId: string; emoji: string }>;
}

export interface EbParticipant {
  userId: string;
  user?: EbUserRef | null;
}

export interface EbConversation {
  id: string;
  type?: "CLOUD" | "SECRET" | string;
  isGroup: boolean;
  isSecret?: boolean;
  secretStatus?: string | null;
  title?: string | null;
  lastMessageAt?: string | null;
  participants: EbParticipant[];
}

/** Секретная беседа (V2 type=SECRET или легаси isSecret): облачный канал закрыт, бот туда не пишет. */
export function isSecretConversation(c: Pick<EbConversation, "type" | "isSecret"> | null | undefined): boolean {
  if (!c) return false;
  return c.type === "SECRET" || c.isSecret === true;
}

export interface SendMessageInput {
  conversationId: string;
  type: EbMessageType;
  content?: string;
  replyToId?: string;
  metadata?: Record<string, unknown>;
  attachments?: Array<{
    url: string;
    type: EbAttachmentType;
    size?: number;
    metadata?: Record<string, unknown>;
  }>;
}

export interface UploadResult {
  url: string;
  path?: string;
  publicUrl?: string;
}
