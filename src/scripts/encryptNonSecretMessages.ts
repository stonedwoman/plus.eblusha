import prisma from "../lib/prisma";
import {
  encryptNonSecretChatText,
  getOrCreateNonSecretConversationDek,
} from "../lib/nonSecretChatEncryption";

const hasFlag = (flag: string) => process.argv.includes(flag);
const getArg = (name: string) => {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return null;
  return process.argv[idx + 1] ?? null;
};

const dryRun = hasFlag("--dry-run");
const limitConversations = Number(getArg("--limit-conversations") ?? "0") || 0;
const limitMessages = Number(getArg("--limit-messages") ?? "0") || 0;
const batchSize = Number(getArg("--batch") ?? "200") || 200;

async function main() {
  console.log("Encrypting non-secret message content in DB");
  console.log("Dry-run:", dryRun);
  if (limitConversations) console.log("Limit conversations:", limitConversations);
  if (limitMessages) console.log("Limit messages:", limitMessages);
  console.log("Batch size:", batchSize);

  const convs = await prisma.conversation.findMany({
    where: { isSecret: false },
    select: { id: true },
    orderBy: { createdAt: "asc" },
    ...(limitConversations ? { take: limitConversations } : {}),
  });

  let processedMessages = 0;
  let encryptedMessages = 0;

  for (const conv of convs) {
    const conversationId = conv.id;

    // Only create DEK when we actually have work to do.
    const totalPending = await prisma.message.count({
      where: {
        conversationId,
        contentEncV: 0,
        content: { not: null },
      },
    });
    if (totalPending === 0) continue;

    console.log("Conversation:", conversationId, "pending:", totalPending);

    const dek = await getOrCreateNonSecretConversationDek(conversationId);

    let cursor: string | null = null;
    while (true) {
      if (limitMessages && processedMessages >= limitMessages) break;

      const items: Array<{ id: string; content: string | null }> = await prisma.message.findMany({
        where: {
          conversationId,
          contentEncV: 0,
          content: { not: null },
        },
        orderBy: { id: "asc" },
        take: Math.min(batchSize, limitMessages ? Math.max(0, limitMessages - processedMessages) : batchSize),
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        select: { id: true, content: true },
      });
      if (items.length === 0) break;

      for (const m of items) {
        processedMessages += 1;
        cursor = m.id;
        const content = m.content;
        if (typeof content !== "string" || content.length === 0) continue;

        const encrypted = encryptNonSecretChatText(content, dek, conversationId);
        encryptedMessages += 1;

        if (!dryRun) {
          await prisma.message.update({
            where: { id: m.id },
            data: { content: encrypted, contentEncV: 1 },
          });
        }
      }
    }
  }

  console.log("Done.");
  console.log("Processed messages:", processedMessages);
  console.log("Encrypted messages:", encryptedMessages);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    try {
      await prisma.$disconnect();
    } catch {}
  });

