import prisma from "../lib/prisma";
import logger from "../config/logger";
import { sendFcm, isFcmConfigured } from "./fcm";
import { sendApns, isApnsConfigured } from "./apns";
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
    if (urgent && device.voip) chosen.push(device.voip);
    else if (device.alert) chosen.push(device.alert);
  }

  // Транспорты разные (у FCM и APNs свои «мёртвые» статусы) — разводим по провайдеру.
  const fcmTargets = chosen.filter((t) => t.provider === "fcm");
  const apnsTargets = chosen.filter((t) => t.provider !== "fcm");

  const [fcmResult, apnsResult] = await Promise.all([
    sendFcm(fcmTargets, payload),
    sendApns(apnsTargets, payload),
  ]);
  await dropDeadTokens([...fcmResult.dead, ...apnsResult.dead]);
  const sent = fcmResult.sent + apnsResult.sent;
  // Повторяем только если НИКОМУ не ушло: повтор job'а шлёт всем заново, и тот, кому уже
  // доставили, получил бы дубль. (Для call/call-cancel дубли и так схлопывает
  // apns-collapse-id, но сообщений это не касается.)
  const retryable = (fcmResult.retryable === true || apnsResult.retryable === true) && sent === 0;
  return { sent, retryable };
}
