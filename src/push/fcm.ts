import crypto from "crypto";
import fs from "fs";
import env from "../config/env";
import logger from "../config/logger";
import type { PushPayload, PushTarget, PushSendResult } from "./types";
import { isUrgent } from "./types";

/**
 * Отправка через FCM HTTP v1.
 *
 * Без firebase-admin намеренно: весь SDK нужен ради одного POST-запроса и OAuth-подписи,
 * а тянуть его в образ ради этого дорого. Здесь ровно два шага — подписать JWT сервис-аккаунта
 * и обменять его на access-токен, дальше обычный HTTPS.
 */

type ServiceAccount = {
  project_id: string;
  client_email: string;
  private_key: string;
};

let cachedAccount: ServiceAccount | null | undefined;
let cachedToken: { value: string; expiresAt: number } | null = null;

function loadServiceAccount(): ServiceAccount | null {
  if (cachedAccount !== undefined) return cachedAccount;
  const raw = env.FCM_SERVICE_ACCOUNT;
  if (!raw) {
    cachedAccount = null;
    return null;
  }
  try {
    // Принимаем и путь к файлу, и сам JSON (в т.ч. base64) — чтобы ключ можно было
    // прокинуть и файлом в контейнер, и переменной окружения.
    let text = raw.trim();
    if (!text.startsWith("{")) {
      if (fs.existsSync(text)) {
        text = fs.readFileSync(text, "utf8");
      } else {
        text = Buffer.from(text, "base64").toString("utf8");
      }
    }
    const parsed = JSON.parse(text) as ServiceAccount;
    if (!parsed.project_id || !parsed.client_email || !parsed.private_key) {
      throw new Error("service account is missing project_id/client_email/private_key");
    }
    cachedAccount = parsed;
    logger.info({ projectId: parsed.project_id }, "FCM push configured");
    return parsed;
  } catch (error) {
    // Мягкая деградация: кривой ключ выключает пуши, но не роняет сервер.
    logger.error({ error }, "FCM service account is unusable — push disabled");
    cachedAccount = null;
    return null;
  }
}

export function isFcmConfigured(): boolean {
  return loadServiceAccount() !== null;
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function getAccessToken(account: ServiceAccount): Promise<string | null> {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.expiresAt > now + 60) return cachedToken.value;

  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(
    JSON.stringify({
      iss: account.client_email,
      scope: "https://www.googleapis.com/auth/firebase.messaging",
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    }),
  );
  const signature = crypto.createSign("RSA-SHA256").update(`${header}.${claims}`).sign(account.private_key);
  const assertion = `${header}.${claims}.${base64url(signature)}`;

  try {
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }),
    });
    if (!res.ok) {
      logger.warn({ status: res.status, body: await res.text() }, "FCM: token exchange failed");
      return null;
    }
    const json = (await res.json()) as { access_token: string; expires_in: number };
    cachedToken = { value: json.access_token, expiresAt: now + (json.expires_in ?? 3600) };
    return cachedToken.value;
  } catch (error) {
    logger.warn({ error }, "FCM: token exchange error");
    return null;
  }
}

/** Плоский словарь строк — FCM принимает в data только строки. */
function toDataPayload(payload: PushPayload): Record<string, string> {
  const flat: Record<string, string> = { kind: payload.kind };
  for (const [key, value] of Object.entries(payload)) {
    if (key === "kind" || value === undefined || value === null) continue;
    flat[key] = typeof value === "string" ? value : JSON.stringify(value);
  }
  return flat;
}

export async function sendFcm(targets: PushTarget[], payload: PushPayload): Promise<PushSendResult> {
  const account = loadServiceAccount();
  if (!account || targets.length === 0) return { sent: 0, dead: [] };
  const accessToken = await getAccessToken(account);
  if (!accessToken) return { sent: 0, dead: [] };

  const url = `https://fcm.googleapis.com/v1/projects/${account.project_id}/messages:send`;
  const data = toDataPayload(payload);
  const urgent = isUrgent(payload);
  const dead: string[] = [];
  let sent = 0;

  // FCM v1 шлёт по одному адресату за запрос. Устройств у пользователя единицы,
  // поэтому простой цикл дешевле любой батч-механики.
  for (const target of targets) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          message: {
            token: target.token,
            // Только data: уведомление рисует само приложение. Иначе система показала бы
            // своё поверх нашего, а в свёрнутом виде мы бы не смогли поднять звонок.
            data,
            android: {
              priority: urgent ? "HIGH" : "NORMAL",
              // Звонок бессмысленно доставлять с опозданием: 60 секунд — наш ring-timeout.
              ttl: urgent ? "60s" : "86400s",
            },
          },
        }),
      });
      if (res.ok) {
        sent += 1;
        continue;
      }
      const body = await res.text();
      // 404 UNREGISTERED / 403 SENDER_ID_MISMATCH — токен мёртв, снимаем с устройства.
      if (res.status === 404 || res.status === 403 || body.includes("UNREGISTERED")) {
        dead.push(target.token);
        logger.info({ deviceId: target.deviceId }, "FCM: token is dead, dropping");
      } else {
        logger.warn({ status: res.status, body, deviceId: target.deviceId }, "FCM: send failed");
      }
    } catch (error) {
      logger.warn({ error, deviceId: target.deviceId }, "FCM: send error");
    }
  }
  return { sent, dead };
}
