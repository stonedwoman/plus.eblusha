import prisma from "../lib/prisma";
import logger from "../config/logger";
import { sendFcm, isFcmConfigured } from "./fcm";
import { sendApns, isApnsConfigured, type ApnsSendExtras } from "./apns";
import { apnsBadgeEnabled, apnsBadges, badgeCapableDevices } from "./badge";
import type { PushPayload, PushProvider, PushTarget } from "./types";
import { isUrgent } from "./types";

/**
 * Отправка пушей пользователям. Точка входа для воркера.
 *
 * Здесь сознательно НЕТ проверки «а вдруг человек и так онлайн»: присутствие живёт в Redis с
 * TTL и после обрыва связи ещё какое-то время врёт «в сети» — на этом мы бы теряли ровно те
 * уведомления, ради которых всё затевалось. Дубли гасит клиент: у уведомления стабильный id,
 * а поверх открытого приложения оно просто не показывается.
 */

export async function pushEnabled(): Promise<boolean> {
  return isFcmConfigured() || isApnsConfigured();
}

/**
 * Цели одного устройства. У iOS их две: обычный alert-токен и VoIP-токен PushKit —
 * система выдаёт их независимо, и живут они одновременно. У Android VoIP-слот пуст.
 */
type DeviceTargets = {
  deviceId: string;
  alert?: PushTarget;
  voip?: PushTarget;
};

async function loadTargets(userIds: string[]): Promise<DeviceTargets[]> {
  if (userIds.length === 0) return [];
  const devices = await prisma.userDevice.findMany({
    where: {
      userId: { in: userIds },
      revokedAt: null,
      OR: [{ pushToken: { not: null } }, { pushVoipToken: { not: null } }],
    },
    select: {
      id: true,
      userId: true,
      pushToken: true,
      pushProvider: true,
      pushVoipToken: true,
    },
  });
  return devices.map((d) => {
    const entry: DeviceTargets = { deviceId: d.id };
    if (d.pushToken) {
      entry.alert = {
        userId: d.userId,
        deviceId: d.id,
        token: d.pushToken,
        provider: (d.pushProvider ?? "fcm") as PushProvider,
      };
    }
    if (d.pushVoipToken) {
      entry.voip = {
        userId: d.userId,
        deviceId: d.id,
        token: d.pushVoipToken,
        provider: "apns-voip",
      };
    }
    return entry;
  });
}

async function dropDeadTokens(tokens: string[]): Promise<void> {
  if (tokens.length === 0) return;
  try {
    // Токен мог протухнуть в любом из двух слотов — чистим оба, попадёт в тот, где лежал.
    await prisma.userDevice.updateMany({
      where: { pushToken: { in: tokens } },
      data: { pushToken: null, pushProvider: null },
    });
    await prisma.userDevice.updateMany({
      where: { pushVoipToken: { in: tokens } },
      data: { pushVoipToken: null },
    });
  } catch (error) {
    logger.warn({ error }, "push: failed to drop dead tokens");
  }
}

export type SendPushOptions = {
  /** Устройства, которым этот пуш не нужен — например, то, что само приняло звонок. */
  excludeDeviceIds?: string[] | undefined;
};

export type SendPushResult = {
  sent: number;
  /** Никому не доставили и хотя бы один транспорт споткнулся о временное — воркеру стоит повторить. */
  retryable: boolean;
};

export async function sendPushToUsers(
  userIds: string[],
  payload: PushPayload,
  opts?: SendPushOptions,
): Promise<SendPushResult> {
  const unique = Array.from(new Set(userIds.filter(Boolean)));
  const excluded = new Set(opts?.excludeDeviceIds ?? []);
  const devices = (await loadTargets(unique)).filter((d) => !excluded.has(d.deviceId));
  if (devices.length === 0) return { sent: 0, retryable: false };

  // Выбор канала — ПОУСТРОЙСТВЕННО, не по провайдеру в куче: звонок должен прийти на
  // телефон ОДИН раз. Есть VoIP-токен — будим им (только он поднимает убитое приложение
  // через PushKit и рисует CallKit); нет — уходит обычный alert как запасной путь.
  // Сообщения на VoIP-токены не шлём вовсе: iOS 13+ требует от VoIP-пуша немедленно
  // показать экран звонка, иначе Apple перестаёт доставлять их устройству.
  const urgent = isUrgent(payload);
  const chosen: PushTarget[] = [];
  for (const device of devices) {
    // «Прочитано на другом устройстве» — тихий пуш только на alert-токен: iOS (APNs background на
    // основной topic) и Android (FCM data). VoIP-токен для него запрещён (см. выше).
    if (payload.kind === "read") {
      if (device.alert && (device.alert.provider === "apns" || device.alert.provider === "fcm")) chosen.push(device.alert);
      continue;
    }
    // Число на значке — только iOS alert-токен (кому из них — решает badgeNumbers ниже).
    if (payload.kind === "badge") {
      if (device.alert?.provider === "apns") chosen.push(device.alert);
      continue;
    }
    if (urgent && device.voip) chosen.push(device.voip);
    else if (device.alert) chosen.push(device.alert);
  }

  // Транспорты разные (у FCM и APNs свои «мёртвые» статусы) — разводим по провайдеру.
  const fcmTargets = chosen.filter((t) => t.provider === "fcm");
  let apnsTargets = chosen.filter((t) => t.provider !== "fcm");

  // Значок iOS (push/badge.ts): число непрочитанного без заглушённых бесед — в момент отправки, только
  // устройствам, объявившим caps badge (старые сборки значок не сбрасывают — у них он залип бы).
  //  - message: число в сам alert-пуш;
  //  - badge: только число (кому его нет — не шлём);
  //  - read: тихий read-пуш число нести не может — следом тем же устройствам badge-only пуш.
  const badgeByDevice = await badgeNumbers(payload, apnsTargets);
  if (payload.kind === "badge") apnsTargets = apnsTargets.filter((t) => badgeByDevice.has(t.deviceId));
  const apnsExtras: ApnsSendExtras | undefined =
    badgeByDevice.size > 0 && payload.kind !== "read" ? { badgeByDevice } : undefined;

  const [fcmResult, apnsResult] = await Promise.all([
    sendFcm(fcmTargets, payload),
    apnsExtras ? sendApns(apnsTargets, payload, apnsExtras) : sendApns(apnsTargets, payload),
  ]);
  const followUp =
    payload.kind === "read" && badgeByDevice.size > 0
      ? await sendApns(
          apnsTargets.filter((t) => badgeByDevice.has(t.deviceId)),
          { kind: "badge" },
          { badgeByDevice },
        )
      : { sent: 0, dead: [] as string[] };
  await dropDeadTokens([...fcmResult.dead, ...apnsResult.dead, ...followUp.dead]);
  const sent = fcmResult.sent + apnsResult.sent;
  // Повторяем только если НИКОМУ не ушло: повтор job'а шлёт всем заново, и тот, кому уже
  // доставили, получил бы дубль. (Для call/call-cancel дубли и так схлопывает
  // apns-collapse-id, но сообщений это не касается.)
  const retryable = (fcmResult.retryable === true || apnsResult.retryable === true) && sent === 0;
  return { sent, retryable };
}

/**
 * deviceId → число на значке для APNs alert-целей этого пуша (push/badge.ts). Пусто, если APNS_BADGE=off,
 * пуш не того вида или ни одно устройство не объявляло caps badge.
 */
async function badgeNumbers(payload: PushPayload, apnsTargets: PushTarget[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!apnsBadgeEnabled()) return out;
  if (payload.kind !== "message" && payload.kind !== "badge" && payload.kind !== "read") return out;
  const alertTargets = apnsTargets.filter((t) => t.provider === "apns");
  if (alertTargets.length === 0) return out;
  const capable = await badgeCapableDevices(alertTargets.map((t) => t.userId));
  const targets = alertTargets.filter((t) => capable.has(t.deviceId));
  if (targets.length === 0) return out;
  const counts = await apnsBadges(targets.map((t) => t.userId));
  for (const t of targets) {
    const n = counts.get(t.userId);
    if (n !== undefined) out.set(t.deviceId, n);
  }
  return out;
}
