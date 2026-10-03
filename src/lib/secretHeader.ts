/**
 * S2 — форма открытого заголовка (`headerJson`) секретных конвертов.
 *
 * Зачем: Android (kotlinx, `SecretDtos.kt` SecretHeader) и iOS (Codable, `SecretDTOs.swift`)
 * разбирают инбокс и страницу истории ОДНИМ массивом; один заголовок неверной формы роняет
 * всю пачку, ack становится невозможен, и входящие/история клинят навсегда (H12).
 *
 * Правило — ровно то, на чём падают строгие клиенты, и ничего сверх:
 *   - `headerJson` — объект;
 *   - `kind` — непустая строка. БЕЛОГО СПИСКА НЕТ: в проде живут msg, key_package, control,
 *     prekeys_needed, link_device_join и (с 2026-10-03) self_check — новые kind не режем;
 *   - `v`, `schemaVersion` — целые в диапазоне Int32 (Android: `v: Int`), если поле есть и не null;
 *   - `ts` — безопасное целое (Long/Int64), если есть и не null;
 *   - `attachment` — если есть и не null: объект, `objectKey` — строка, `size` — безопасное целое ≥ 0;
 *   - строковые поля заголовка клиентов (`nonce`, `threadId`, …) — строки, если есть и не null;
 *   - неизвестные ключи разрешены с любым значением (обе стороны их игнорируют; в проде есть,
 *     например, `reasonCode`, `expiresAt`).
 *
 * Сверено с продом 2026-10-03 по всем 21906 строкам `messages_secret` (только SELECT):
 * kind всегда непустая строка, v всегда 1, ts всегда целое (мс), attachment всегда
 * {objectKey:string, size:int}, все прочие известные поля — строки. Ни одна строка правилу
 * не противоречит.
 */

const INT32_MAX = 2_147_483_647;
const INT32_MIN = -2_147_483_648;

/** Строковые поля SecretHeader у Android/iOS (`String?`): число/объект/bool там роняет разбор. */
const STRING_FIELDS = [
  "nonce",
  "packageKind",
  "threadId",
  "recipientDeviceId",
  "initiatorDeviceId",
  "initiatorIdentityKey",
  "prekeyId",
  "handshakeSalt",
  "hkdfInfo",
  "alg",
  "type",
  "fromDeviceId",
  "requesterDeviceId",
  "token",
  "code",
] as const;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function isInt32(v: unknown): boolean {
  return typeof v === "number" && Number.isInteger(v) && v >= INT32_MIN && v <= INT32_MAX;
}

/** Список нарушений (имена полей, без значений). Пустой — заголовок годен. */
export function secretHeaderProblems(header: unknown): string[] {
  if (!isPlainObject(header)) return ["headerJson:not_object"];
  const problems: string[] = [];
  const kind = header.kind;
  if (typeof kind !== "string" || kind.length === 0) problems.push("kind");

  for (const key of ["v", "schemaVersion"] as const) {
    const val = header[key];
    if (val !== undefined && val !== null && !isInt32(val)) problems.push(key);
  }
  const ts = header.ts;
  if (ts !== undefined && ts !== null && !(typeof ts === "number" && Number.isSafeInteger(ts))) problems.push("ts");

  const att = header.attachment;
  if (att !== undefined && att !== null) {
    if (!isPlainObject(att)) {
      problems.push("attachment");
    } else {
      if (typeof att.objectKey !== "string") problems.push("attachment.objectKey");
      const size = att.size;
      if (!(typeof size === "number" && Number.isSafeInteger(size) && size >= 0)) problems.push("attachment.size");
    }
  }

  for (const key of STRING_FIELDS) {
    const val = header[key];
    if (val !== undefined && val !== null && typeof val !== "string") problems.push(key);
  }
  return problems;
}

export function isValidSecretHeader(header: unknown): boolean {
  return secretHeaderProblems(header).length === 0;
}

/**
 * Режим проверки на ВХОДЕ (/secret/send, /secret/messages/push).
 * По умолчанию — жёсткий (400): прод-перепись не нашла ни одного нарушения.
 * Аварийный откат без пересборки: `SECRET_HEADER_ENFORCE=0` (или false/off/log) в .env
 * + перезапуск backend — тогда нарушения только пишутся в лог (`secret-header-invalid`),
 * а конверт принимается. Фильтр на ВЫДАЧЕ (pull/history) от флага не зависит.
 * Читается на каждый запрос, чтобы тесты могли переключать режим.
 */
export function secretHeaderEnforced(): boolean {
  const raw = String(process.env.SECRET_HEADER_ENFORCE ?? "").trim().toLowerCase();
  if (!raw) return true;
  return !["0", "false", "off", "no", "log"].includes(raw);
}

export const SECRET_HEADER_INVALID_CODE = "SECRET_HEADER_INVALID";

/** kind для логов: только если это короткая строка (не тащим в лог произвольные значения). */
export function headerKindForLog(header: unknown): string {
  if (!isPlainObject(header)) return "<not_object>";
  const k = header.kind;
  if (typeof k !== "string") return `<${k === null ? "null" : typeof k}>`;
  if (!k) return "<empty>";
  return k.length > 40 ? `${k.slice(0, 40)}…` : k;
}
