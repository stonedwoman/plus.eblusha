-- CreateTable
CREATE TABLE "ConversationAvailabilityInterval" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "conversationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "startUtc" TIMESTAMP(3) NOT NULL,
    "endUtc" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConversationAvailabilityInterval_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ConversationAvailabilityInterval_conversationId_userId_idx" ON "ConversationAvailabilityInterval"("conversationId", "userId");

-- CreateIndex
CREATE INDEX "ConversationAvailabilityInterval_conversationId_startUtc_idx" ON "ConversationAvailabilityInterval"("conversationId", "startUtc");

-- CreateIndex
CREATE UNIQUE INDEX "ConversationAvailabilityInterval_conversationId_userId_startUtc_endUtc_key" ON "ConversationAvailabilityInterval"("conversationId", "userId", "startUtc", "endUtc");

-- AddForeignKey
ALTER TABLE "ConversationAvailabilityInterval" ADD CONSTRAINT "ConversationAvailabilityInterval_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationAvailabilityInterval" ADD CONSTRAINT "ConversationAvailabilityInterval_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

