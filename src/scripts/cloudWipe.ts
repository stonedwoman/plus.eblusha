/**
 * Полная очистка данных Eblusha Cloud: хуяпки, файлы, объекты, производные.
 *
 * НЕОБРАТИМО. Ничего не уносит в корзину — стирает подчистую, вместе с байтами
 * на диске. Нужен для сброса после тестовых заливок, когда чистый лист дешевле
 * разбора накопленного мусора.
 *
 * Не трогает: пользователей, чаты, звонки и вообще что-либо за пределами
 * таблиц Cloud*. Журнал аудита (CloudAuditEvent) тоже сохраняется — это лог
 * действий, а не пользовательские данные.
 *
 *   npx ts-node src/scripts/cloudWipe.ts                          # показать, что будет
 *   npx ts-node src/scripts/cloudWipe.ts --yes-wipe-everything    # выполнить
 */
import fsp from "node:fs/promises";
import path from "node:path";
import prisma from "../lib/prisma";
import logger from "../config/logger";
import { DERIVED_DIR, OBJECTS_DIR, STAGING_DIR, TMP_DIR } from "../cloud/paths";

const CONFIRM = "--yes-wipe-everything";

async function countAll() {
  const [spaces, files, objects, uploads, variants, shares, invites, comments, folders] = await Promise.all([
    prisma.cloudSpace.count(),
    prisma.cloudFile.count(),
    prisma.cloudStorageObject.count(),
    prisma.cloudUploadSession.count(),
    prisma.cloudFileVariant.count(),
    prisma.cloudShareLink.count(),
    prisma.cloudInvite.count(),
    prisma.cloudComment.count(),
    prisma.cloudFolder.count(),
  ]);
  return { spaces, files, objects, uploads, variants, shares, invites, comments, folders };
}

/** Опустошает каталог, сохраняя его самого и права на нём. */
async function emptyDir(dir: string): Promise<number> {
  let removed = 0;
  let entries: string[];
  try {
    entries = await fsp.readdir(dir);
  } catch {
    return 0;
  }
  for (const name of entries) {
    await fsp.rm(path.join(dir, name), { recursive: true, force: true });
    removed++;
  }
  return removed;
}

async function main(): Promise<void> {
  const apply = process.argv.includes(CONFIRM);
  const before = await countAll();

  console.log(apply ? "ОЧИСТКА Eblusha Cloud" : "Пробный прогон (ничего не меняется)");
  for (const [k, v] of Object.entries(before)) console.log(`  ${k}: ${v}`);

  if (!apply) {
    console.log(`\nВыполнить: npx ts-node src/scripts/cloudWipe.ts ${CONFIRM}`);
    await prisma.$disconnect();
    return;
  }

  // Порядок важен: сначала то, что ссылается, потом то, на что ссылаются.
  // Часть связей стоит на Cascade, но полагаться на неё не будем — явное
  // удаление читается однозначно и не зависит от текущей схемы.
  await prisma.cloudReaction.deleteMany({});
  await prisma.cloudFavorite.deleteMany({});
  await prisma.cloudComment.deleteMany({});
  await prisma.cloudFileVariant.deleteMany({});
  await prisma.cloudActivityEvent.deleteMany({});
  await prisma.cloudShareLink.deleteMany({});
  await prisma.cloudInvite.deleteMany({});
  await prisma.cloudUploadSession.deleteMany({});
  await prisma.cloudFile.deleteMany({});
  await prisma.cloudFolder.deleteMany({});
  await prisma.cloudSpaceMember.deleteMany({});
  await prisma.cloudSpace.deleteMany({});
  await prisma.cloudStorageObject.deleteMany({});

  const objects = await emptyDir(OBJECTS_DIR);
  const derived = await emptyDir(DERIVED_DIR);
  const staging = await emptyDir(STAGING_DIR);
  const tmp = await emptyDir(TMP_DIR);

  const after = await countAll();
  logger.warn({ before, objects, derived, staging, tmp }, "cloud: storage wiped");
  console.log(`\nУдалено с диска: objects ${objects}, derived ${derived}, staging ${staging}, tmp ${tmp}`);
  console.log("Осталось в БД:", JSON.stringify(after));
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
