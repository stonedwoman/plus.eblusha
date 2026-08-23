/**
 * Схлопывание дубликатов внутри хуяпки.
 *
 * Появились они до того, как finalizeUpload научился узнавать уже загруженный
 * снимок: перезаливка папки создавала вторую логическую запись на тот же
 * физический объект. Места это не занимало (blob один), но галерею засоряло.
 *
 * Скрипт оставляет САМУЮ РАННЮЮ копию и уносит остальные в корзину — то есть
 * действие обратимо в течение CLOUD_TRASH_RETENTION_DAYS. Комментарии, реакции
 * и избранное, привязанные к дубликатам, переносятся на оставшуюся копию,
 * иначе они исчезли бы вместе с ней из виду.
 *
 *   npx ts-node src/scripts/cloudDedupeSpaceFiles.ts              # показать, что будет
 *   npx ts-node src/scripts/cloudDedupeSpaceFiles.ts --apply      # выполнить
 *   npx ts-node src/scripts/cloudDedupeSpaceFiles.ts --space <id> --apply
 */
import prisma from "../lib/prisma";
import logger from "../config/logger";

type Group = { spaceId: string; storageObjectId: string; ids: string[] };

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const spaceArg = process.argv.indexOf("--space");
  const onlySpace = spaceArg >= 0 ? process.argv[spaceArg + 1] : null;

  const rows = await prisma.$queryRawUnsafe<{ spaceId: string; storageObjectId: string; ids: string[] }[]>(
    `SELECT f."spaceId", f."storageObjectId", array_agg(f."id" ORDER BY f."createdAt" ASC, f."id" ASC) AS ids
     FROM "CloudFile" f
     WHERE f."deletedAt" IS NULL ${onlySpace ? `AND f."spaceId" = '${onlySpace.replace(/'/g, "")}'` : ""}
     GROUP BY f."spaceId", f."storageObjectId"
     HAVING count(*) > 1`
  );

  const groups: Group[] = rows.map((r) => ({ spaceId: r.spaceId, storageObjectId: r.storageObjectId, ids: r.ids }));
  const doomed = groups.flatMap((g) => g.ids.slice(1));
  const keepers = new Map<string, string>();
  for (const g of groups) for (const id of g.ids.slice(1)) keepers.set(id, g.ids[0] as string);

  const spaces = await prisma.cloudSpace.findMany({
    where: { id: { in: [...new Set(groups.map((g) => g.spaceId))] } },
    select: { id: true, name: true },
  });
  const names = new Map(spaces.map((s) => [s.id, s.name]));

  const perSpace = new Map<string, number>();
  for (const g of groups) perSpace.set(g.spaceId, (perSpace.get(g.spaceId) ?? 0) + g.ids.length - 1);

  console.log(apply ? "Схлопывание дубликатов:" : "Пробный прогон (ничего не меняется):");
  for (const [spaceId, count] of perSpace) {
    console.log(`  ${names.get(spaceId) ?? spaceId}: в корзину уедет ${count}`);
  }
  console.log(`  групп: ${groups.length}, файлов в корзину: ${doomed.length}`);

  if (!apply) {
    console.log("\nЗапустить по-настоящему: добавьте --apply");
    await prisma.$disconnect();
    return;
  }
  if (doomed.length === 0) {
    await prisma.$disconnect();
    return;
  }

  // Соцданные переносим на остающуюся копию — терять обсуждение снимка из-за
  // технической чистки нельзя.
  let movedComments = 0;
  let movedFavorites = 0;
  for (const [from, to] of keepers) {
    const c = await prisma.cloudComment.updateMany({ where: { fileId: from }, data: { fileId: to } });
    movedComments += c.count;
    // Избранное уникально по (userId, fileId): если у пользователя уже отмечена
    // остающаяся копия, перенос упёрся бы в constraint — такие просто удаляем.
    const favs = await prisma.cloudFavorite.findMany({ where: { fileId: from } });
    for (const fav of favs) {
      const exists = await prisma.cloudFavorite.findUnique({
        where: { userId_fileId: { userId: fav.userId, fileId: to } },
      });
      if (exists) await prisma.cloudFavorite.delete({ where: { id: fav.id } });
      else {
        await prisma.cloudFavorite.update({ where: { id: fav.id }, data: { fileId: to } });
        movedFavorites++;
      }
    }
    await prisma.cloudReaction.updateMany({ where: { targetType: "FILE", targetId: from }, data: { targetId: to } });
  }

  const now = new Date();
  let moved = 0;
  for (let i = 0; i < doomed.length; i += 500) {
    const chunk = doomed.slice(i, i + 500);
    const res = await prisma.cloudFile.updateMany({ where: { id: { in: chunk } }, data: { deletedAt: now } });
    moved += res.count;
  }

  logger.info({ moved, movedComments, movedFavorites }, "cloud: duplicates collapsed");
  console.log(`\nГотово. В корзину: ${moved}. Перенесено комментариев: ${movedComments}, избранного: ${movedFavorites}.`);
  console.log("Восстановить всё можно из корзины, пока не истёк retention.");
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
