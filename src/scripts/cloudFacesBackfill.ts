/**
 * Поставить в очередь распознавание лиц для уже загруженных фото.
 *
 *   npx ts-node src/scripts/cloudFacesBackfill.ts            # несканированные
 *   npx ts-node src/scripts/cloudFacesBackfill.ts --all      # заново все
 *   npx ts-node src/scripts/cloudFacesBackfill.ts --space <id>
 */
import prisma from "../lib/prisma";
import { enqueueFacesJob } from "../cloud/jobs/queues";

async function main(): Promise<void> {
  const all = process.argv.includes("--all");
  const spaceIdx = process.argv.indexOf("--space");
  const spaceId = spaceIdx > 0 ? process.argv[spaceIdx + 1] : null;
  const files = await prisma.cloudFile.findMany({
    where: {
      kind: "IMAGE",
      deletedAt: null,
      status: "READY",
      ...(all ? {} : { facesScannedAt: null }),
      ...(spaceId ? { spaceId } : {}),
    },
    select: { id: true },
    orderBy: { takenAt: "desc" },
  });
  console.log(`Ставим в очередь: ${files.length} фото`);
  for (const f of files) await enqueueFacesJob(f.id, all ? `re-${Date.now()}` : "backfill");
  console.log("Готово — следите за логом eblusha-face-worker.");
  await prisma.$disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
