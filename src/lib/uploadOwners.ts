/**
 * S7 (X1) — учёт загрузчика объектов хранилища.
 *
 * Корень X1: `/api/upload` не помнил, КТО загрузил объект, поэтому `/secret/attachments/ref`
 * регистрировал в секретке ЛЮБОЙ `objectKey` (чужую аватарку, файл из группы), а
 * `/secret/attachments/delete` его сносил. `secret_attachment_refs.ownerUserId` для этого не
 * годится: это «кто зарегистрировал реф», а не «кто загрузил» (правка скептика Б7).
 *
 * Таблица `upload_owners` (миграция 20261004120000_upload_owners): одна строка на объект,
 * пишется /api/upload и /api/upload/:id/complete сразу после записи объекта. Решение владельца:
 * регистрировать и удалять секретный файл может только загрузивший.
 *
 * Режимы (читаются на каждый запрос):
 *   - запись-владелец есть и это ДРУГОЙ пользователь → отказ (по умолчанию). Аварийный выключатель
 *     `SECRET_ATTACH_OWNER_ENFORCE=0` — только лог/счётчик (s7.*would_reject*), поведение до волны 2;
 *   - записи нет (объекты, загруженные до волны 2, и загрузки мимо /api/upload) — ПЕРЕХОДНЫЙ режим
 *     «нет записи = разрешить» с логом/счётчиком (s7.*no_owner*). `SECRET_ATTACH_OWNER_STRICT=1`
 *     (волна 3) превращает «нет записи» в отказ.
 *
 * Доступ — сырым SQL: модель UploadOwner в schema.prisma описана для миграций, а сгенерированный
 * клиент на хосте не нужно пересобирать ради одной таблицы.
 */
import prisma from "./prisma";
import logger from "../config/logger";

export type OwnerDecision = "owner" | "no_record" | "other_owner";

export function secretAttachOwnerEnforced(): boolean {
  const raw = String(process.env.SECRET_ATTACH_OWNER_ENFORCE ?? "").trim().toLowerCase();
  if (!raw) return true;
  return !["0", "false", "off", "no", "log"].includes(raw);
}

export function secretAttachOwnerStrict(): boolean {
  const raw = String(process.env.SECRET_ATTACH_OWNER_STRICT ?? "").trim().toLowerCase();
  return ["1", "true", "on", "yes", "strict"].includes(raw);
}

/** Нормализация ключа так же, как /secret/attachments/* (без ведущего «/»). */
export function normalizeObjectKey(key: string): string {
  return String(key ?? "").trim().replace(/^\/+/, "");
}

/** Запомнить загрузчика. Не бросает: сбой учёта не должен ронять саму загрузку. */
export async function recordUploadOwner(objectKey: string, userId: string): Promise<void> {
  const key = normalizeObjectKey(objectKey);
  if (!key || !userId) return;
  try {
    await prisma.$executeRaw`INSERT INTO "upload_owners" ("objectKey", "userId") VALUES (${key}, ${userId}) ON CONFLICT ("objectKey") DO NOTHING`;
  } catch (error) {
    logger.error({ error, objectKey: key }, "upload-owner: record failed");
  }
}

/** objectKey → userId загрузчика (только для тех, у кого запись есть). */
export async function getUploadOwners(objectKeys: string[]): Promise<Map<string, string>> {
  const keys = Array.from(new Set(objectKeys.map(normalizeObjectKey).filter(Boolean)));
  const out = new Map<string, string>();
  if (!keys.length) return out;
  const rows = await prisma.$queryRaw<Array<{ objectKey: string; userId: string }>>`SELECT "objectKey", "userId" FROM "upload_owners" WHERE "objectKey" = ANY(${keys}::text[])`;
  for (const r of rows) out.set(r.objectKey, r.userId);
  return out;
}

export function ownerDecision(owners: Map<string, string>, objectKey: string, userId: string): OwnerDecision {
  const owner = owners.get(normalizeObjectKey(objectKey));
  if (!owner) return "no_record";
  return owner === userId ? "owner" : "other_owner";
}

/**
 * Можно ли пользователю регистрировать/удалять этот объект как секретное вложение.
 * `other_owner` — отказ (если не аварийный режим), `no_record` — разрешено (если не строгий режим).
 */
export function ownerAllows(decision: OwnerDecision): boolean {
  if (decision === "owner") return true;
  if (decision === "other_owner") return !secretAttachOwnerEnforced();
  return !secretAttachOwnerStrict();
}
