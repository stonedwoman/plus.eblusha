/**
 * S3 — кто кому может слать конверты через POST /secret/send (H01, H03, H06, H07, X2, X4 — от ПОСТОРОННИХ).
 *
 * Сервер видит только открытые метаданные: `senderUserId` (ставит сам из авторизации — ему
 * верим), `toDeviceId` и заголовок `headerJson` (его пишет клиент). Ключей и шифротекста
 * проверка не касается — E2EE не меняется. Правила по `headerJson.kind`:
 *
 *   тредовые: `control`, `key_resend_request`, `prekeys_needed`, `key_package` c
 *   `packageKind:"thread_key"` — если в заголовке ЕСТЬ `threadId`: тред существует и секретный,
 *   отправитель И владелец устройства-получателя — участники треда. Для `thread_key` между
 *   РАЗНЫМИ пользователями тред обязан быть ACTIVE (ключ собеседнику уходит только после accept;
 *   ACTIVE выставляется до рассылки `secret:chat:accepted`), своим устройствам — PENDING/ACTIVE
 *   (правка скептика Б2). Статус остальных тредовых не проверяется: участники остаются
 *   участниками и в CANCELLED, честная «сверка» должна работать.
 *   Если `threadId` в заголовке НЕТ — это легаси (1527 старых `thread_key` веба до 2026-02,
 *   правка скептика Б1): пропускаем ВСЕГДА, даже в жёстком режиме, только считаем
 *   (`relation`: себе / есть общая секретка / чужой) — по этим счётчикам решается волна 3.
 *
 *   свои: `link_device_join`, `key_package` c `packageKind:"device_link_keys"` — связывание
 *   устройств одного аккаунта: владелец устройства-получателя == отправитель.
 *
 *   остальные (`msg`, `self_check`, `direct`, неизвестные — белого списка нет): правил по
 *   содержимому нет.
 *
 *   любой конверт: `toDeviceId` — существующее НЕотозванное устройство (раньше на любой id
 *   писалась доставка-сирота).
 *
 * Режим — `SECRET_SEND_ENFORCE` (читается на каждый запрос):
 *   не задан / 0 — ЛОГ-РЕЖИМ (волна 2, по умолчанию): конверт принимается как раньше, нарушение
 *                  пишется в лог `secret-send-reject` и в счётчики secret:obs (would_reject);
 *   1           — жёсткий режим (волна 3, после ≥7 суток чистых логов): нарушивший конверт
 *                  отбрасывается (не пишется ни в БД, ни в инбокс), остальная пачка доставляется.
 *
 * От злоумышленника-УЧАСТНИКА и от самого сервера S3 не защищает (подмена треда внутри
 * зашифрованного payload, H16) — это закрывают клиентские проверки (W-H01 и т.п.).
 */
import prisma from "./prisma";

export const SECRET_SEND_REJECTED_CODE = "SECRET_SEND_REJECTED";

export type SecretSendReason =
  | "recipient_unknown"
  | "recipient_revoked"
  | "thread_not_found"
  | "thread_not_secret"
  | "sender_not_participant"
  | "recipient_not_participant"
  | "thread_not_active"
  | "cross_user_link";

export type SecretSendScope = "thread" | "own" | "none";
export type LegacyRelation = "self" | "shared_secret" | "stranger";

export type SecretSendVerdict = {
  index: number;
  kind: string;
  packageKind: string | null;
  scope: SecretSendScope;
  /** Нарушение S3 (null — правила соблюдены). */
  reason: SecretSendReason | null;
  /** Тредовый конверт без threadId в заголовке (легаси, Б1) — пропускается всегда. */
  legacyNoThreadId: boolean;
  legacyRelation: LegacyRelation | null;
  /** Получатель — устройство самого отправителя. */
  selfTarget: boolean;
};

export function secretSendEnforced(): boolean {
  const raw = String(process.env.SECRET_SEND_ENFORCE ?? "").trim().toLowerCase();
  return ["1", "true", "on", "yes", "enforce"].includes(raw);
}

const THREAD_KINDS = new Set(["control", "key_resend_request", "prekeys_needed"]);

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

export function classifySecretEnvelope(header: unknown): {
  kind: string;
  packageKind: string | null;
  scope: SecretSendScope;
  isThreadKey: boolean;
} {
  const h = (header && typeof header === "object" && !Array.isArray(header) ? header : {}) as Record<string, unknown>;
  const kind = str(h.kind);
  const packageKind = str(h.packageKind) || null;
  if (kind === "key_package") {
    if (packageKind === "thread_key") return { kind, packageKind, scope: "thread", isThreadKey: true };
    if (packageKind === "device_link_keys") return { kind, packageKind, scope: "own", isThreadKey: false };
    return { kind, packageKind, scope: "none", isThreadKey: false };
  }
  if (THREAD_KINDS.has(kind)) return { kind, packageKind, scope: "thread", isThreadKey: false };
  if (kind === "link_device_join") return { kind, packageKind, scope: "own", isThreadKey: false };
  return { kind, packageKind, scope: "none", isThreadKey: false };
}

/** Проверка пачки /secret/send. Порядок вердиктов = порядок конвертов. Только чтение БД. */
export async function evaluateSecretSend(
  senderUserId: string,
  envelopes: Array<{ toDeviceId: string; header: unknown }>,
): Promise<SecretSendVerdict[]> {
  const deviceIds = Array.from(new Set(envelopes.map((e) => e.toDeviceId).filter(Boolean)));
  const devices = deviceIds.length
    ? await prisma.userDevice.findMany({
        where: { id: { in: deviceIds } },
        select: { id: true, userId: true, revokedAt: true },
      })
    : [];
  const deviceById = new Map(devices.map((d) => [d.id, d]));

  const classified = envelopes.map((e) => ({ ...classifySecretEnvelope(e.header), header: e.header }));
  const threadIds = Array.from(
    new Set(
      classified
        .filter((c) => c.scope === "thread")
        .map((c) => str((c.header as any)?.threadId))
        .filter((t) => t && t.length <= 200),
    ),
  );
  const threads = threadIds.length
    ? await prisma.conversation.findMany({
        where: { id: { in: threadIds } },
        select: {
          id: true,
          type: true,
          isSecret: true,
          secretStatus: true,
          participants: { select: { userId: true } },
        },
      })
    : [];
  const threadById = new Map(threads.map((t) => [t.id, t]));

  const verdicts: SecretSendVerdict[] = envelopes.map((env, index) => {
    const c = classified[index]!;
    const verdict: SecretSendVerdict = {
      index,
      kind: c.kind,
      packageKind: c.packageKind,
      scope: c.scope,
      reason: null,
      legacyNoThreadId: false,
      legacyRelation: null,
      selfTarget: false,
    };
    const dev = deviceById.get(env.toDeviceId);
    verdict.selfTarget = !!dev && dev.userId === senderUserId;
    // Легаси без threadId отмечаем всегда — даже если получатель не годится (для полноты счётчика).
    if (c.scope === "thread" && !str((c.header as any)?.threadId)) verdict.legacyNoThreadId = true;
    if (!dev) {
      verdict.reason = "recipient_unknown";
      return verdict;
    }
    if (dev.revokedAt) {
      verdict.reason = "recipient_revoked";
      return verdict;
    }
    if (c.scope === "own") {
      if (dev.userId !== senderUserId) verdict.reason = "cross_user_link";
      return verdict;
    }
    if (c.scope !== "thread" || verdict.legacyNoThreadId) return verdict;

    const thread = threadById.get(str((c.header as any)?.threadId));
    if (!thread) {
      verdict.reason = "thread_not_found";
      return verdict;
    }
    if (thread.type !== "SECRET" && !thread.isSecret) {
      verdict.reason = "thread_not_secret";
      return verdict;
    }
    const members = new Set(thread.participants.map((p) => p.userId));
    if (!members.has(senderUserId)) {
      verdict.reason = "sender_not_participant";
      return verdict;
    }
    if (!members.has(dev.userId)) {
      verdict.reason = "recipient_not_participant";
      return verdict;
    }
    if (c.isThreadKey) {
      const status = String(thread.secretStatus ?? "");
      const ok = verdict.selfTarget ? status === "PENDING" || status === "ACTIVE" : status === "ACTIVE";
      if (!ok) verdict.reason = "thread_not_active";
    }
    return verdict;
  });

  // Легаси без threadId: отношение отправителя к владельцу получателя — только для наблюдения.
  const legacyOwners = new Set<string>();
  for (const v of verdicts) {
    if (!v.legacyNoThreadId) continue;
    const dev = deviceById.get(envelopes[v.index]!.toDeviceId);
    if (dev && dev.userId !== senderUserId) legacyOwners.add(dev.userId);
  }
  const sharedWith = new Set<string>();
  for (const owner of legacyOwners) {
    const shared = await prisma.conversation.findFirst({
      where: {
        OR: [{ type: "SECRET" }, { isSecret: true }],
        AND: [{ participants: { some: { userId: senderUserId } } }, { participants: { some: { userId: owner } } }],
      } as any,
      select: { id: true },
    });
    if (shared) sharedWith.add(owner);
  }
  for (const v of verdicts) {
    if (!v.legacyNoThreadId) continue;
    const dev = deviceById.get(envelopes[v.index]!.toDeviceId);
    v.legacyRelation = !dev ? "stranger" : dev.userId === senderUserId ? "self" : sharedWith.has(dev.userId) ? "shared_secret" : "stranger";
  }
  return verdicts;
}
