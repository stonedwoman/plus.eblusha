import prisma from "../lib/prisma";
import { deleteS3ObjectsByKeys } from "../lib/storageDeletion";

async function runOnce(limit = 500) {
  const now = new Date();
  const rows = await prisma.secretAttachmentRef.findMany({
    where: {
      deletedAt: null,
      expiresAt: { lt: now },
    },
    select: { id: true, objectKey: true },
    take: Math.max(1, Math.min(2000, Math.floor(limit || 500))),
    orderBy: { expiresAt: "asc" },
  });
  if (!rows.length) {
    console.log(JSON.stringify({ ok: true, expired: 0, deleted: 0 }));
    return;
  }

  const keys = rows.map((r) => r.objectKey).filter(Boolean);
  const del = await deleteS3ObjectsByKeys(keys, { reason: "secret_attachment_gc" });
  await prisma.secretAttachmentRef.updateMany({
    where: { id: { in: rows.map((r) => r.id) } },
    data: { deletedAt: now },
  });
  console.log(
    JSON.stringify({
      ok: true,
      expired: rows.length,
      storage: del,
    })
  );
}

runOnce(Number(process.argv[2] || "500"))
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });

