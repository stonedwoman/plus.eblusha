/**
 * S3 — кто кому может слать конверты через POST /secret/send (H01, H03, H06, H07, X2, X4 — от ПОСТОРОННИХ).
 *
 * Сервер видит только открытые метаданные: `senderUserId` (ставит сам из авторизации — ему
 * верим), `toDeviceId` и заголовок `headerJson` (его пишет клиент). Ключей и шифротекста
 * проверка не касается — E2EE не меняется. Правила по `headerJson.kind`:
 *
 *   key_package: вид пакета — ТОЛЬКО ровно `thread_key` или `device_link_keys` (так шлют все
 *   честные клиенты с первой версии протокола). Пакет без `packageKind` или с иным значением
 *   (`THREAD_KEY`, мусор) — `bad_package_kind`: старый веб берёт вид пакета из ЗАШИФРОВАННОГО
 *   payload (`decoded.kind ?? header.packageKind`), и без этого правила посторонний, убрав
 *   packageKind из заголовка, проводил бы ему thread_key/device_link_keys мимо всех проверок.
 *
 *   тредовые: `control`, `key_resend_request`, `prekeys_needed`, `key_package/thread_key` —
 *   если в заголовке ЕСТЬ `threadId`: тред существует и секретный, отправитель И владелец
 *   устройства-получателя — участники треда. Статус треда между РАЗНЫМИ пользователями:
 *     thread_key, prekeys_needed — только ACTIVE (ключ собеседнику уходит только после accept;
 *       ACTIVE выставляется до рассылки `secret:chat:accepted`; правка скептика Б2);
 *     control, key_resend_request — не PENDING (PENDING-тред с жертвой кто угодно заводит сам
 *       через POST /threads/secret без её согласия; в CANCELLED честная «сверка» работает).
 *   Своим устройствам: thread_key — PENDING/ACTIVE, остальные — в любом статусе.
 *   Если `threadId` в заголовке НЕТ:
 *     thread_key — легаси (1527 старых `thread_key` веба до 2026-02, правка скептика Б1):
 *       пропускается, только если получатель — устройство самого отправителя ИЛИ у отправителя
 *       и владельца получателя есть общая ACTIVE-секретка; иначе `legacy_stranger`. Клиенты
 *       старше этой правки берут тред из ЗАШИФРОВАННОГО payload (Android 0.3.35, iOS 946,
 *       старый веб-кэш Electron), поэтому «посторонний обязан указать настоящий threadId»
 *       неверно — без этого правила любой подменял бы ключ любого треда жертвы на
 *       необновлённом клиенте, просто убрав threadId из заголовка;
 *     control, key_resend_request, prekeys_needed — `thread_id_missing`: все честные отправители
 *       кладут threadId с первой версии (веб sendSecretControl/nudgeDeviceToPublishPrekeys/
 *       keyShare, Android, iOS), легаси-пропуска для них нет.
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
  | "thread_id_missing"
  | "legacy_stranger"
  | "bad_package_kind"
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
  /**
   * thread_key без threadId в заголовке (легаси, Б1): пропускается только себе или при общей
   * ACTIVE-секретке (`legacyRelation`), иначе `legacy_stranger`.
   */
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
  /** key_package без packageKind или с нестандартным значением (честные клиенты так не шлют). */
  badPackageKind: boolean;
} {
  const h = (header && typeof header === "object" && !Array.isArray(header) ? header : {}) as Record<string, unknown>;
  const kind = str(h.kind);
  const packageKind = str(h.packageKind) || null;
  if (kind === "key_package") {
    if (packageKind === "device_link_keys") {
      return { kind, packageKind, scope: "own", isThreadKey: false, badPackageKind: false };
    }
    // Всё, что не связка своих устройств, — по правилам thread_key: старый веб вид пакета берёт
    // из payload, так что «без packageKind» для него может оказаться и thread_key, и связкой.
    return { kind, packageKind, scope: "thread", isThreadKey: true, badPackageKind: packageKind !== "thread_key" };
  }
  if (THREAD_KINDS.has(kind)) return { kind, packageKind, scope: "thread", isThreadKey: false, badPackageKind: false };
  if (kind === "link_device_join") return { kind, packageKind, scope: "own", isThreadKey: false, badPackageKind: false };
  return { kind, packageKind, scope: "none", isThreadKey: false, badPackageKind: false };
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

  // Легаси thread_key без threadId (Б1): с кем из владельцев получателей у отправителя есть
  // общая ACTIVE-секретка. PENDING не в счёт: её посторонний заводит сам, без согласия жертвы.
  const legacyOwners = new Set<string>();
  envelopes.forEach((env, index) => {
    const c = classified[index]!;
    if (!c.isThreadKey || c.badPackageKind || str((c.header as any)?.threadId)) return;
    const dev = deviceById.get(env.toDeviceId);
    if (dev && dev.userId !== senderUserId) legacyOwners.add(dev.userId);
  });
  const sharedActiveWith = new Set<string>();
  for (const owner of legacyOwners) {
    const shared = await prisma.conversation.findFirst({
      where: {
        OR: [{ type: "SECRET" }, { isSecret: true }],
        secretStatus: "ACTIVE",
        AND: [{ participants: { some: { userId: senderUserId } } }, { participants: { some: { userId: owner } } }],
      } as any,
      select: { id: true },
    });
    if (shared) sharedActiveWith.add(owner);
  }

  return envelopes.map((env, index) => {
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
    const threadId = str((c.header as any)?.threadId);
    // Легаси без threadId отмечаем всегда — даже если получатель не годится (для полноты счётчика).
    if (c.isThreadKey && !c.badPackageKind && !threadId) {
      verdict.legacyNoThreadId = true;
      verdict.legacyRelation = !dev
        ? "stranger"
        : verdict.selfTarget
          ? "self"
          : sharedActiveWith.has(dev.userId)
            ? "shared_secret"
            : "stranger";
    }
    if (!dev) {
      verdict.reason = "recipient_unknown";
      return verdict;
    }
    if (dev.revokedAt) {
      verdict.reason = "recipient_revoked";
      return verdict;
    }
    if (c.badPackageKind) {
      verdict.reason = "bad_package_kind";
      return verdict;
    }
    if (c.scope === "own") {
      if (dev.userId !== senderUserId) verdict.reason = "cross_user_link";
      return verdict;
    }
    if (c.scope !== "thread") return verdict;

    if (!threadId) {
      if (!c.isThreadKey) verdict.reason = "thread_id_missing";
      else if (verdict.legacyRelation === "stranger") verdict.reason = "legacy_stranger";
      return verdict;
    }

    const thread = threadById.get(threadId);
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
    const status = String(thread.secretStatus ?? "");
    let ok = true;
    if (c.isThreadKey) {
      ok = verdict.selfTarget ? status === "PENDING" || status === "ACTIVE" : status === "ACTIVE";
    } else if (!verdict.selfTarget) {
      // prekeys_needed собеседнику — только при раздаче ключа после accept (ACTIVE);
      // control/key_resend_request — не в PENDING (тред-«приглашение» мог завести посторонний).
      ok = c.kind === "prekeys_needed" ? status === "ACTIVE" : status !== "PENDING";
    }
    if (!ok) verdict.reason = "thread_not_active";
    return verdict;
  });
}
