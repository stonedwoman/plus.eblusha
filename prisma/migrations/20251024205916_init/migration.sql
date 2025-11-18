-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ONLINE', 'OFFLINE', 'AWAY', 'DND');

-- CreateEnum
CREATE TYPE "ContactStatus" AS ENUM ('PENDING', 'ACCEPTED', 'BLOCKED');

-- CreateEnum
CREATE TYPE "ConversationRole" AS ENUM ('MEMBER', 'ADMIN', 'OWNER');

-- CreateEnum
CREATE TYPE "MessageType" AS ENUM ('TEXT', 'IMAGE', 'VIDEO', 'AUDIO', 'FILE', 'SYSTEM', 'CALL');

-- CreateEnum
CREATE TYPE "AttachmentType" AS ENUM ('IMAGE', 'VIDEO', 'AUDIO', 'FILE');

-- CreateEnum
CREATE TYPE "ReceiptStatus" AS ENUM ('DELIVERED', 'READ', 'SEEN');

-- CreateEnum
CREATE TYPE "CallType" AS ENUM ('VOICE', 'VIDEO');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "username" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "displayName" TEXT,
    "bio" TEXT,
    "avatarUrl" TEXT,
    "passwordHash" TEXT NOT NULL,
    "status" "UserStatus" NOT NULL DEFAULT 'OFFLINE',
    "lastSeenAt" TIMESTAMP(3),

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Contact" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "requesterId" TEXT NOT NULL,
    "addresseeId" TEXT NOT NULL,
    "status" "ContactStatus" NOT NULL DEFAULT 'PENDING',

    CONSTRAINT "Contact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Conversation" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "title" TEXT,
    "isGroup" BOOLEAN NOT NULL DEFAULT false,
    "lastMessageAt" TIMESTAMP(3),
    "createdById" TEXT,

    CONSTRAINT "Conversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConversationParticipant" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "ConversationRole" NOT NULL DEFAULT 'MEMBER',
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "mutedUntil" TIMESTAMP(3),

    CONSTRAINT "ConversationParticipant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "conversationId" TEXT NOT NULL,
    "senderId" TEXT NOT NULL,
    "type" "MessageType" NOT NULL DEFAULT 'TEXT',
    "content" TEXT,
    "metadata" JSONB,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MessageAttachment" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "messageId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "type" "AttachmentType" NOT NULL,
    "size" INTEGER,
    "metadata" JSONB,

    CONSTRAINT "MessageAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MessageReaction" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "messageId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "emoji" TEXT NOT NULL,

    CONSTRAINT "MessageReaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MessageReceipt" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "messageId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "ReceiptStatus" NOT NULL DEFAULT 'DELIVERED',

    CONSTRAINT "MessageReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RefreshToken" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "RefreshToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CallSession" (
    "id" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "conversationId" TEXT NOT NULL,
    "initiatorId" TEXT NOT NULL,
    "roomName" TEXT NOT NULL,
    "type" "CallType" NOT NULL DEFAULT 'VOICE',

    CONSTRAINT "CallSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CallParticipant" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leftAt" TIMESTAMP(3),

    CONSTRAINT "CallParticipant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_phone_key" ON "User"("phone");

-- CreateIndex
CREATE INDEX "Contact_addresseeId_status_idx" ON "Contact"("addresseeId", "status");

-- CreateIndex
CREATE INDEX "Contact_requesterId_status_idx" ON "Contact"("requesterId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Contact_requesterId_addresseeId_key" ON "Contact"("requesterId", "addresseeId");

-- CreateIndex
CREATE INDEX "ConversationParticipant_userId_idx" ON "ConversationParticipant"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "ConversationParticipant_conversationId_userId_key" ON "ConversationParticipant"("conversationId", "userId");

-- CreateIndex
CREATE INDEX "Message_conversationId_createdAt_idx" ON "Message"("conversationId", "createdAt");

-- CreateIndex
CREATE INDEX "MessageAttachment_messageId_idx" ON "MessageAttachment"("messageId");

-- CreateIndex
CREATE UNIQUE INDEX "MessageReaction_messageId_userId_emoji_key" ON "MessageReaction"("messageId", "userId", "emoji");

-- CreateIndex
CREATE INDEX "MessageReceipt_userId_status_idx" ON "MessageReceipt"("userId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "MessageReceipt_messageId_userId_key" ON "MessageReceipt"("messageId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "RefreshToken_token_key" ON "RefreshToken"("token");

-- CreateIndex
CREATE INDEX "RefreshToken_userId_idx" ON "RefreshToken"("userId");

-- CreateIndex
CREATE INDEX "CallSession_conversationId_idx" ON "CallSession"("conversationId");

-- CreateIndex
CREATE INDEX "CallParticipant_userId_idx" ON "CallParticipant"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "CallParticipant_sessionId_userId_key" ON "CallParticipant"("sessionId", "userId");

-- AddForeignKey
ALTER TABLE "Contact" ADD CONSTRAINT "Contact_requesterId_fkey" FOREIGN KEY ("requesterId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Contact" ADD CONSTRAINT "Contact_addresseeId_fkey" FOREIGN KEY ("addresseeId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationParticipant" ADD CONSTRAINT "ConversationParticipant_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationParticipant" ADD CONSTRAINT "ConversationParticipant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageAttachment" ADD CONSTRAINT "MessageAttachment_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageReaction" ADD CONSTRAINT "MessageReaction_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageReaction" ADD CONSTRAINT "MessageReaction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageReceipt" ADD CONSTRAINT "MessageReceipt_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageReceipt" ADD CONSTRAINT "MessageReceipt_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefreshToken" ADD CONSTRAINT "RefreshToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CallSession" ADD CONSTRAINT "CallSession_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CallSession" ADD CONSTRAINT "CallSession_initiatorId_fkey" FOREIGN KEY ("initiatorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CallParticipant" ADD CONSTRAINT "CallParticipant_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "CallSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CallParticipant" ADD CONSTRAINT "CallParticipant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
