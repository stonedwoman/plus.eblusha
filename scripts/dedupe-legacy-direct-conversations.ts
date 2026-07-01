/**
 * One-off admin cleanup for legacy duplicate 1:1 conversations.
 *
 * Historically the backend deduplicated conversations on every GET /conversations,
 * which could silently destroy legitimate groups with identical member sets and
 * left attachment files orphaned in storage. That logic was removed from the API;
 * this script is its safe replacement for the remaining legacy 1:1 duplicates.
 *
 * Scope: strictly non-group conversations (isGroup=false). Groups are never touched.
 * Two direct conversations are duplicates when isSecret matches and the sorted
 * participant userId sets are identical. The newest one (lastMessageAt ?? createdAt)
 * is kept; the rest are deleted together with their messages, receipts, reactions,
 * attachment rows and attachment files in storage.
 *
 * Usage (from repo root, DATABASE_URL must be reachable):
 *   npx ts-node scripts/dedupe-legacy-direct-conversations.ts           # dry-run, prints report only
 *   npx ts-node scripts/dedupe-legacy-direct-conversations.ts --apply   # actually delete
 */
import prisma from "../src/lib/prisma";
import { deleteStorageObjectsByUrls } from "../src/lib/storageDeletion";

const APPLY = process.argv.includes("--apply");

async function main() {
  console.log(`[dedupe] mode: ${APPLY ? "APPLY (destructive)" : "DRY-RUN (no changes)"}`);

  const list = await prisma.conversation.findMany({
    where: { isGroup: false },
    include: {
      participants: { include: { user: { select: { username: true } } } },
    },
    orderBy: [{ lastMessageAt: "desc" }, { createdAt: "desc" }],
  });
  console.log(`[dedupe] direct (non-group) conversations scanned: ${list.length}`);

  const groups = new Map<string, typeof list>();
  for (const c of list) {
    if (c.participants.length === 0) {
      console.log(`[dedupe] skip ${c.id}: no participants (orphan, not touched)`);
      continue;
    }
    const key = `${c.isSecret ? "S" : "N"}:${c.participants
      .map((p) => p.userId)
      .sort()
      .join(",")}`;
    const arr = groups.get(key) ?? [];
    arr.push(c);
    groups.set(key, arr);
  }

  let dupGroups = 0;
  let deleted = 0;
  let failed = 0;

  for (const [key, arr] of groups) {
    if (arr.length <= 1) continue;
    dupGroups++;

    const sorted = [...arr].sort(
      (a, b) =>
        new Date(b.lastMessageAt ?? b.createdAt).getTime() -
        new Date(a.lastMessageAt ?? a.createdAt).getTime()
    );
    const keep = sorted[0]!;
    const toDelete = sorted.slice(1);

    const usernames = keep.participants.map((p) => p.user?.username ?? p.userId).join(", ");
    console.log(`\n[dedupe] duplicate set (${arr.length}) [${keep.isSecret ? "secret" : "plain"}] members: ${usernames} (key ${key})`);
    console.log(`  KEEP   ${keep.id} created=${keep.createdAt.toISOString()} lastMessageAt=${keep.lastMessageAt?.toISOString() ?? "-"}`);

    for (const conv of toDelete) {
      const [messageCount, attachments] = await Promise.all([
        prisma.message.count({ where: { conversationId: conv.id } }),
        prisma.messageAttachment.findMany({
          where: { message: { conversationId: conv.id } },
          select: { url: true },
        }),
      ]);
      console.log(
        `  DELETE ${conv.id} created=${conv.createdAt.toISOString()} lastMessageAt=${conv.lastMessageAt?.toISOString() ?? "-"} messages=${messageCount} attachments=${attachments.length}`
      );

      if (!APPLY) continue;

      try {
        await prisma.$transaction([
          prisma.messageReceipt.deleteMany({ where: { message: { conversationId: conv.id } } }),
          prisma.messageAttachment.deleteMany({ where: { message: { conversationId: conv.id } } }),
          prisma.messageReaction.deleteMany({ where: { message: { conversationId: conv.id } } }),
          prisma.message.deleteMany({ where: { conversationId: conv.id } }),
          prisma.conversationParticipant.deleteMany({ where: { conversationId: conv.id } }),
          prisma.conversation.delete({ where: { id: conv.id } }),
        ]);
        deleted++;
        if (attachments.length) {
          const result = await deleteStorageObjectsByUrls(
            attachments.map((a) => a.url),
            { reason: `dedupe-legacy:${conv.id}` }
          );
          console.log(`         storage cleanup: ${JSON.stringify(result)}`);
        }
      } catch (e) {
        failed++;
        console.error(`  ERROR deleting ${conv.id}:`, e);
      }
    }
  }

  console.log(`\n[dedupe] duplicate sets found: ${dupGroups}`);
  if (APPLY) {
    console.log(`[dedupe] conversations deleted: ${deleted}, failed: ${failed}`);
  } else {
    console.log(`[dedupe] dry-run only — re-run with --apply to delete`);
  }
}

main()
  .catch((e) => {
    console.error("[dedupe] fatal:", e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
