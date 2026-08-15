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

async function loadTargets(userIds: string[]): Promise<PushTarget[]> {
  if (userIds.length === 0) return [];
  const devices = await prisma.userDevice.findMany({
    where: {
      userId: { in: userIds },
      revokedAt: null,
      pushToken: { not: null },
    },
    select: { id: true, userId: true, pushToken: true, pushProvider: true },
  });
  return devices
    .filter((d: { pushToken: string | null }) => !!d.pushToken)
    .map((d: { id: string; userId: string; pushToken: string | null; pushProvider: string | null }) => ({
      userId: d.userId,
      deviceId: d.id,
      token: d.pushToken as string,
      provider: (d.pushProvider ?? "fcm") as PushProvider,
    }));
}

async function dropDeadTokens(tokens: string[]): Promise<void> {
  if (tokens.length === 0) return;
  try {
    await prisma.userDevice.updateMany({
      where: { pushToken: { in: tokens } },
      data: { pushToken: null, pushProvider: null },
    });
  } catch (error) {
    logger.warn({ error }, "push: failed to drop dead tokens");
  }
}

export async function sendPushToUsers(userIds: string[], payload: PushPayload): Promise<number> {
  const unique = Array.from(new Set(userIds.filter(Boolean)));
  const targets = await loadTargets(unique);
  if (targets.length === 0) return 0;

  // Группируем по провайдеру: FCM и APNs — разные транспорты с разными «мёртвыми» статусами.
  const byProvider = new Map<PushProvider, PushTarget[]>();
  for (const target of targets) {
    const bucket = byProvider.get(target.provider);
    if (bucket) bucket.push(target);
    else byProvider.set(target.provider, [target]);
  }

  const fcmTargets = byProvider.get("fcm") ?? [];
  const apnsAlertTargets = byProvider.get("apns") ?? [];
  const apnsVoipTargets = byProvider.get("apns-voip") ?? [];

  // Звонки на iOS будим VoIP-пушем (только он гарантированно поднимает убитое приложение
  // через PushKit); устройства без voip-токена получают обычный alert как fallback.
  // Сообщения на voip-токены не шлём вовсе: iOS 13+ требует от VoIP-пуша немедленно
  // показать CallKit-экран, иначе Apple перестаёт доставлять их устройству.
  const apnsTargets = isUrgent(payload) ? [...apnsVoipTargets, ...apnsAlertTargets] : apnsAlertTargets;

  const [fcmResult, apnsResult] = await Promise.all([
    sendFcm(fcmTargets, payload),
    sendApns(apnsTargets, payload),
  ]);
  await dropDeadTokens([...fcmResult.dead, ...apnsResult.dead]);
  return fcmResult.sent + apnsResult.sent;
}
