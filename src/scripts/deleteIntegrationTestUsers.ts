#!/usr/bin/env npx ts-node
/**
 * Remove users created by integration tests (username prefixes from test/*.integration.test.ts).
 *
 * Patterns: calls_a_, calls_b_, direct_a_, direct_b_, prekey_owner_, sec_s_, sec_r_, st_a_, st_b_
 *
 * 1) Hard-delete conversations where every participant is a test user (and there is ≥1 participant).
 * 2) Purge each test user: messages (as sender), contacts, call rows, participants, devices, secrets, tokens.
 *
 * Usage:
 *   npx ts-node src/scripts/deleteIntegrationTestUsers.ts           # dry-run
 *   npx ts-node src/scripts/deleteIntegrationTestUsers.ts --delete  # execute
 */

import dotenv from "dotenv";
import path from "path";
import { Prisma, PrismaClient } from "@prisma/client";

type Tx = Prisma.TransactionClient;

dotenv.config({ path: path.resolve(process.cwd(), ".env") });
dotenv.config({ path: path.resolve(process.cwd(), ".env.local"), override: true });

const PREFIXES = [
  "calls_a_",
  "calls_b_",
  "direct_a_",
  "direct_b_",
  "prekey_owner_",
  "sec_s_",
  "sec_r_",
  "st_a_",
  "st_b_",
] as const;

function isTestUsername(username: string): boolean {
  return PREFIXES.some((p) => username.startsWith(p));
}

async function hardDeleteConversation(tx: Tx, conversationId: string) {
  await tx.callParticipant.deleteMany({
    where: { session: { conversationId } },
  });
  await tx.callSession.deleteMany({ where: { conversationId } });
  await tx.message.updateMany({
    where: { conversationId },
    data: { replyToId: null },
  });
  await tx.messageReceipt.deleteMany({
    where: { message: { conversationId } },
  });
  await tx.messageAttachment.deleteMany({
    where: { message: { conversationId } },
  });
  await tx.messageReaction.deleteMany({
    where: { message: { conversationId } },
  });
  await tx.message.deleteMany({ where: { conversationId } });
  await tx.conversationParticipant.deleteMany({ where: { conversationId } });
  await tx.conversation.delete({ where: { id: conversationId } });
}

async function wipeCallSessionsTouchingUser(tx: Tx, userId: string) {
  const sessions = await tx.callSession.findMany({
    where: {
      OR: [{ initiatorId: userId }, { participants: { some: { userId } } }],
    },
    select: { id: true },
  });
  for (const s of sessions) {
    await tx.callParticipant.deleteMany({ where: { sessionId: s.id } });
    await tx.callSession.delete({ where: { id: s.id } });
  }
}

async function purgeTestUser(tx: Tx, userId: string) {
  const devices = await tx.userDevice.findMany({
    where: { userId },
    select: { id: true },
  });
  const deviceIds = devices.map((d) => d.id);

  if (deviceIds.length) {
    await tx.secretDelivery.deleteMany({
      where: { receiverDeviceId: { in: deviceIds } },
    });
  }

  await tx.secretMessage.deleteMany({ where: { senderUserId: userId } });
  await tx.secretAttachmentRef.deleteMany({ where: { ownerUserId: userId } });

  await tx.devicePairing.deleteMany({ where: { userId } });
  if (deviceIds.length) {
    await tx.devicePairing.deleteMany({
      where: { newDeviceId: { in: deviceIds } },
    });
  }

  await wipeCallSessionsTouchingUser(tx, userId);

  await tx.messageReceipt.deleteMany({ where: { userId } });
  await tx.messageReaction.deleteMany({ where: { userId } });

  const sentIds = (
    await tx.message.findMany({
      where: { senderId: userId },
      select: { id: true },
    })
  ).map((m) => m.id);

  if (sentIds.length) {
    await tx.message.updateMany({
      where: { replyToId: { in: sentIds } },
      data: { replyToId: null },
    });
    await tx.message.updateMany({
      where: { senderId: userId },
      data: { replyToId: null },
    });
    await tx.messageReceipt.deleteMany({
      where: { messageId: { in: sentIds } },
    });
    await tx.messageReaction.deleteMany({
      where: { messageId: { in: sentIds } },
    });
    await tx.messageAttachment.deleteMany({
      where: { messageId: { in: sentIds } },
    });
    await tx.message.deleteMany({ where: { senderId: userId } });
  }

  await tx.contact.deleteMany({
    where: { OR: [{ requesterId: userId }, { addresseeId: userId }] },
  });

  await tx.conversationParticipant.deleteMany({ where: { userId } });

  await tx.refreshToken.deleteMany({ where: { userId } });
  await tx.userDevice.deleteMany({ where: { userId } });

  await tx.user.delete({ where: { id: userId } });
}

async function main() {
  const execute = process.argv.includes("--delete");
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set (.env / .env.local).");
    process.exit(1);
  }

  const prisma = new PrismaClient();
  try {
    const testUsers = await prisma.user.findMany({
      where: {
        OR: PREFIXES.map((p) => ({ username: { startsWith: p } })),
      },
      select: { id: true, username: true },
      orderBy: { createdAt: "asc" },
    });

    if (testUsers.length === 0) {
      console.log("No integration-test users found.");
      return;
    }

    const testIdSet = new Set(testUsers.map((u) => u.id));
    console.log(`Found ${testUsers.length} test user(s):`);
    for (const u of testUsers) console.log(`  ${u.username} (${u.id})`);

    if (!execute) {
      console.log("\nDry-run only. Pass --delete to remove them from the database.");
      return;
    }

    await prisma.$transaction(
      async (tx) => {
        let rounds = 0;
        const maxRounds = 50;
        while (rounds++ < maxRounds) {
          const convos = await tx.conversation.findMany({
            where: {
              AND: [
                { participants: { some: {} } },
                { participants: { every: { userId: { in: [...testIdSet] } } } },
              ],
            },
            select: { id: true },
          });
          if (convos.length === 0) break;
          for (const c of convos) {
            await hardDeleteConversation(tx, c.id);
          }
        }
        if (rounds >= maxRounds) {
          throw new Error("Too many rounds deleting test-only conversations; aborting.");
        }

        for (const u of testUsers) {
          const still = await tx.user.findUnique({ where: { id: u.id }, select: { id: true } });
          if (!still) continue;
          await purgeTestUser(tx, u.id);
          testIdSet.delete(u.id);
        }
      },
      { timeout: 120_000 }
    );

    console.log(`\nDeleted ${testUsers.length} integration-test user(s).`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
