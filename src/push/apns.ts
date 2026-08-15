import crypto from "crypto";
import fs from "fs";
import http2 from "http2";
import env from "../config/env";
import logger from "../config/logger";
import type { PushPayload, PushTarget, PushSendResult } from "./types";
import { isUrgent } from "./types";

/**
 * Отправка через APNs (token-based, ключ .p8).
 *
 * Без node-apn и прочих SDK намеренно (как и в fcm.ts): весь протокол — это HTTP/2 POST
 * с JWT в заголовке. node:http2 и node:crypto покрывают это целиком, а лишняя зависимость
 * в образе дороже сотни строк ниже.
 *
 * Два провайдера на одном ключе:
 *  - "apns"      — обычный alert-пуш на основной bundle id (сообщения; звонки как fallback);
 *  - "apns-voip" — VoIP-пуш на topic `<bundle>.voip` (звонки: только он гарантированно
 *                  будит убитое iOS-приложение через PushKit).
 */

type ApnsConfig = {
  /** Приватный ключ из .p8 — PEM-текст, каким его отдаёт Apple Developer. */
  key: string;
  keyId: string;
  teamId: string;
  bundleId: string;
  /** Прод и sandbox — разные кластеры; токен устройства валиден только в «своём». */
  host: string;
};

let cachedConfig: ApnsConfig | null | undefined;
let cachedJwt: { value: string; expiresAt: number } | null = null;

function loadConfig(): ApnsConfig | null {
  if (cachedConfig !== undefined) return cachedConfig;
  const keyFile = env.APNS_KEY_FILE;
  const keyId = env.APNS_KEY_ID;
  const teamId = env.APNS_TEAM_ID;
  if (!keyFile || !keyId || !teamId) {
    // Не настроено — это норма (инстанс без iOS-клиентов), молча выключаемся.
    cachedConfig = null;
    return null;
  }
  try {
    const key = fs.readFileSync(keyFile, "utf8");
    // Проверяем ключ сразу при загрузке, а не на первой отправке: кривой файл должен
    // быть виден в логах при старте, а не теряться среди ошибок доставки.
    crypto.createPrivateKey(key);
    cachedConfig = {
      key,
      keyId,
      teamId,
      bundleId: env.APNS_BUNDLE_ID,
      host: env.APNS_ENV === "sandbox" ? "api.sandbox.push.apple.com" : "api.push.apple.com",
    };
    logger.info({ bundleId: cachedConfig.bundleId, env: env.APNS_ENV }, "APNs push configured");
    return cachedConfig;
  } catch (error) {
    // Мягкая деградация, как у FCM: без ключа пуши выключены, но сервер живёт.
    logger.error({ error, keyFile }, "APNs key is unusable — APNs push disabled");
    cachedConfig = null;
    return null;
  }
}

export function isApnsConfigured(): boolean {
  return loadConfig() !== null;
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * JWT для заголовка authorization. Apple требует обновлять его не чаще раза в 20 минут
 * и не реже раза в час — кэшируем на 50, чтобы не попасть ни в TooManyProviderTokenUpdates,
 * ни в ExpiredProviderToken.
 */
function getJwt(config: ApnsConfig): string | null {
  const now = Math.floor(Date.now() / 1000);
  if (cachedJwt && cachedJwt.expiresAt > now) return cachedJwt.value;
  try {
    const header = base64url(JSON.stringify({ alg: "ES256", kid: config.keyId }));
    const claims = base64url(JSON.stringify({ iss: config.teamId, iat: now }));
    // ieee-p1363 обязателен: JOSE ждёт «сырую» подпись r||s, а по умолчанию createSign
    // отдаёт DER — с ним APNs молча отвечает InvalidProviderToken.
    const signature = crypto
      .createSign("SHA256")
      .update(`${header}.${claims}`)
      .sign({ key: config.key, dsaEncoding: "ieee-p1363" });
    const jwt = `${header}.${claims}.${base64url(signature)}`;
    cachedJwt = { value: jwt, expiresAt: now + 50 * 60 };
    return jwt;
  } catch (error) {
    logger.warn({ error }, "APNs: failed to sign provider JWT");
    return null;
  }
}

/** Кастомные поля рядом с aps — то же содержимое, что FCM кладёт в data. */
function toCustomData(payload: PushPayload): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (value === undefined || value === null) continue;
    data[key] = value;
  }
  return data;
}

type PreparedRequest = {
  headers: Record<string, string>;
  body: string;
};

function buildRequest(config: ApnsConfig, target: PushTarget, payload: PushPayload): PreparedRequest | null {
  const now = Math.floor(Date.now() / 1000);
  const urgent = isUrgent(payload);

  if (target.provider === "apns-voip") {
    // VoIP-пуши живут только для звонков: iOS 13+ требует от приложения немедленно показать
    // CallKit-экран, иначе система перестаёт доставлять пуши вовсе. Сообщения сюда не шлём.
    if (!urgent) return null;
    return {
      headers: {
        "apns-topic": `${config.bundleId}.voip`,
        "apns-push-type": "voip",
        "apns-priority": "10",
        // Просроченный звонок доставлять бессмысленно: 60 секунд — наш ring-timeout.
        "apns-expiration": String(now + 60),
        "apns-collapse-id": `call-${payload.conversationId}`,
      },
      // Весь payload как есть: клиент разбирает его в PushKit-обработчике сам.
      body: JSON.stringify(toCustomData(payload)),
    };
  }

  const data = toCustomData(payload);

  if (payload.kind === "message") {
    return {
      headers: {
        "apns-topic": config.bundleId,
        "apns-push-type": "alert",
        // Как и в FCM: обычное сообщение может подождать, иначе Apple урежет лимиты.
        "apns-priority": "5",
        "apns-expiration": String(now + 86400),
      },
      body: JSON.stringify({
        aps: {
          // Текста сообщения тут нет намеренно (см. PushPayload): заголовок — имя отправителя,
          // тело — либо короткая пометка («Фото»), либо заглушка. mutable-content даёт
          // Notification Service Extension шанс подменить заглушку расшифрованным текстом.
          alert: { title: payload.senderName, body: payload.preview || "Новое сообщение" },
          sound: "default",
          "mutable-content": 1,
          "thread-id": payload.conversationId,
        },
        ...data,
      }),
    };
  }

  if (payload.kind === "call") {
    // Fallback для устройств без VoIP-токена: обычный баннер «входящий звонок».
    // Поднять CallKit из убитого приложения он не сможет, но хотя бы позовёт человека.
    return {
      headers: {
        "apns-topic": config.bundleId,
        "apns-push-type": "alert",
        "apns-priority": "10",
        "apns-expiration": String(now + 60),
        "apns-collapse-id": `call-${payload.conversationId}`,
      },
      body: JSON.stringify({
        aps: {
          alert: {
            title: payload.callerName,
            body: payload.video ? "Входящий видеозвонок" : "Входящий звонок",
          },
          sound: "default",
          "interruption-level": "time-sensitive",
        },
        ...data,
      }),
    };
  }

  // call-cancel на alert-токен: баннер «звонок отменён» — шум, поэтому тихий background-пуш,
  // чтобы приложение убрало экран входящего. Для background Apple требует priority 5.
  return {
    headers: {
      "apns-topic": config.bundleId,
      "apns-push-type": "background",
      "apns-priority": "5",
      "apns-expiration": String(now + 60),
      "apns-collapse-id": `call-${payload.conversationId}`,
    },
    body: JSON.stringify({ aps: { "content-available": 1 }, ...data }),
  };
}

/**
 * Живое соединение с APNs, общее на процесс. Apple прямо просит держать коннект и слать
 * в него поток пушей: новое TLS+HTTP/2-рукопожатие на каждое уведомление она трактует как
 * DoS-паттерн и начинает резать. Пересоздаём только когда соединение действительно умерло.
 */
let sharedSession: http2.ClientHttp2Session | null = null;
let sharedSessionHost: string | null = null;

async function getSession(host: string): Promise<http2.ClientHttp2Session | null> {
  if (sharedSession && !sharedSession.closed && !sharedSession.destroyed && sharedSessionHost === host) {
    return sharedSession;
  }
  // Хост сменился (sandbox↔prod через конфиг) — старое соединение больше не нужно.
  if (sharedSession && sharedSessionHost !== host) {
    sharedSession.close();
  }
  const session = await connect(host);
  if (!session) {
    sharedSession = null;
    sharedSessionHost = null;
    return null;
  }
  // GOAWAY прилетает штатно: Apple периодически просит переехать на новое соединение.
  const forget = () => {
    if (sharedSession === session) {
      sharedSession = null;
      sharedSessionHost = null;
    }
  };
  session.once("close", forget);
  session.once("goaway", forget);
  session.once("error", forget);
  // Простаивающее соединение не должно держать процесс живым при остановке воркера.
  session.unref();
  sharedSession = session;
  sharedSessionHost = host;
  return session;
}

function connect(host: string): Promise<http2.ClientHttp2Session | null> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (session: http2.ClientHttp2Session | null) => {
      if (settled) return;
      settled = true;
      resolve(session);
    };
    const session = http2.connect(`https://${host}:443`);
    const timer = setTimeout(() => {
      logger.warn({ host }, "APNs: connect timeout");
      session.destroy();
      done(null);
    }, 10_000);
    session.once("connect", () => {
      clearTimeout(timer);
      done(session);
    });
    // Обработчик нужен и ПОСЛЕ connect: без него обрыв сокета уронит процесс.
    session.on("error", (error) => {
      clearTimeout(timer);
      logger.warn({ error, host }, "APNs: connection error");
      done(null);
    });
  });
}

type ApnsResponse = { status: number; body: string };

function requestOnce(
  session: http2.ClientHttp2Session,
  path: string,
  headers: Record<string, string>,
  body: string,
): Promise<ApnsResponse | null> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value: ApnsResponse | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    let stream: http2.ClientHttp2Stream;
    try {
      stream = session.request({
        ":method": "POST",
        ":path": path,
        "content-type": "application/json",
        ...headers,
      });
    } catch (error) {
      logger.warn({ error }, "APNs: request failed to start");
      done(null);
      return;
    }
    let status = 0;
    let data = "";
    stream.setEncoding("utf8");
    stream.on("response", (resHeaders) => {
      status = Number(resHeaders[":status"] ?? 0);
    });
    stream.on("data", (chunk: string) => {
      data += chunk;
    });
    stream.on("end", () => done({ status, body: data }));
    stream.on("error", (error) => {
      logger.warn({ error }, "APNs: stream error");
      done(null);
    });
    stream.setTimeout(10_000, () => {
      stream.close(http2.constants.NGHTTP2_CANCEL);
      done(null);
    });
    stream.end(body);
  });
}

/** Reason из тела ответа APNs — там всегда {"reason": "..."} при ошибке. */
function parseReason(body: string): string {
  try {
    return String((JSON.parse(body) as { reason?: string }).reason ?? "");
  } catch {
    return "";
  }
}

export async function sendApns(targets: PushTarget[], payload: PushPayload): Promise<PushSendResult> {
  const config = loadConfig();
  if (!config || targets.length === 0) return { sent: 0, dead: [] };
  const jwt = getJwt(config);
  if (!jwt) return { sent: 0, dead: [] };

  const session = await getSession(config.host);
  if (!session) return { sent: 0, dead: [] };

  const dead: string[] = [];
  let sent = 0;
  {
    // Запросы по очереди: устройств у пользователя единицы, мультиплексирование тут
    // ничего не выиграет (ср. цикл в fcm.ts). Само соединение переиспользуется — см. getSession.
    for (const target of targets) {
      const prepared = buildRequest(config, target, payload);
      if (!prepared) continue; // например, message на voip-токен — туда нельзя
      const res = await requestOnce(
        session,
        `/3/device/${target.token}`,
        { authorization: `bearer ${jwt}`, ...prepared.headers },
        prepared.body,
      );
      if (!res) continue;
      if (res.status === 200) {
        sent += 1;
        continue;
      }
      const reason = parseReason(res.body);
      // 410 Gone — токен снят; BadDeviceToken прилетает и когда prod-токен ушёл в sandbox
      // (или наоборот) — в обоих случаях хранить его дальше бессмысленно.
      if (res.status === 410 || (res.status === 400 && (reason === "BadDeviceToken" || reason === "Unregistered"))) {
        dead.push(target.token);
        logger.info({ deviceId: target.deviceId, reason }, "APNs: token is dead, dropping");
        continue;
      }
      if (res.status === 403 && reason === "ExpiredProviderToken") {
        // Часы разъехались или кэш пережил своё — следующая отправка подпишет свежий JWT.
        cachedJwt = null;
      }
      logger.warn(
        { status: res.status, reason, deviceId: target.deviceId, provider: target.provider },
        "APNs: send failed",
      );
    }
  }
  return { sent, dead };
}
