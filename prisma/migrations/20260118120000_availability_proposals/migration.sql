-- CreateEnum
CREATE TYPE "AvailabilityProposalReactionValue" AS ENUM ('YES', 'MAYBE', 'NO');

-- CreateTable
CREATE TABLE "ConversationAvailabilityProposal" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "conversationId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "note" TEXT,
    "maxEndUtc" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "ConversationAvailabilityProposal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConversationAvailabilityProposalInterval" (
    "id" TEXT NOT NULL,
    "proposalId" TEXT NOT NULL,
    "startUtc" TIMESTAMP(3) NOT NULL,
    "endUtc" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConversationAvailabilityProposalInterval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConversationAvailabilityProposalReaction" (
    "id" TEXT NOT NULL,
    "proposalId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "value" "AvailabilityProposalReactionValue" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConversationAvailabilityProposalReaction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ConversationAvailabilityProposal_conversationId_maxEndUtc_idx" ON "ConversationAvailabilityProposal"("conversationId", "maxEndUtc");

-- CreateIndex
CREATE INDEX "ConversationAvailabilityProposal_conversationId_createdAt_idx" ON "ConversationAvailabilityProposal"("conversationId", "createdAt");

-- CreateIndex
CREATE INDEX "ConversationAvailabilityProposal_createdById_createdAt_idx" ON "ConversationAvailabilityProposal"("createdById", "createdAt");

-- CreateIndex
CREATE INDEX "ConversationAvailabilityProposalInterval_proposalId_startUtc_idx" ON "ConversationAvailabilityProposalInterval"("proposalId", "startUtc");

-- CreateIndex
CREATE UNIQUE INDEX "ConversationAvailabilityProposalInterval_proposalId_startUtc_endUtc_key" ON "ConversationAvailabilityProposalInterval"("proposalId", "startUtc", "endUtc");

-- CreateIndex
CREATE UNIQUE INDEX "ConversationAvailabilityProposalReaction_proposalId_userId_key" ON "ConversationAvailabilityProposalReaction"("proposalId", "userId");

-- CreateIndex
CREATE INDEX "ConversationAvailabilityProposalReaction_userId_createdAt_idx" ON "ConversationAvailabilityProposalReaction"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "ConversationAvailabilityProposal" ADD CONSTRAINT "ConversationAvailabilityProposal_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationAvailabilityProposal" ADD CONSTRAINT "ConversationAvailabilityProposal_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationAvailabilityProposalInterval" ADD CONSTRAINT "ConversationAvailabilityProposalInterval_proposalId_fkey" FOREIGN KEY ("proposalId") REFERENCES "ConversationAvailabilityProposal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationAvailabilityProposalReaction" ADD CONSTRAINT "ConversationAvailabilityProposalReaction_proposalId_fkey" FOREIGN KEY ("proposalId") REFERENCES "ConversationAvailabilityProposal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationAvailabilityProposalReaction" ADD CONSTRAINT "ConversationAvailabilityProposalReaction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

