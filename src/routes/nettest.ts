import crypto from "node:crypto";
import { Router } from "express";
import { rateLimit } from "../middlewares/rateLimit";
import env from "../config/env";
import { buildLivekitPublicUrl } from "../lib/livekitUrl";

/**
 * Выдача временных TURN-кредитов для страницы проверки связи (/nettest).
 *
 * Страница гоняет пакеты через ТОТ ЖЕ ретранслятор, что и звонки, поэтому меряет
 * ровно тот путь, на котором у человека рвётся голос. Логина здесь нет намеренно:
 * ссылку отправляют тому, у кого проблемы, и заставлять его входить — лишний шаг.
 * Секрет наружу не уходит: клиент получает только производную пару логин/пароль
 * с коротким сроком жизни.
 */
const router = Router();

const TEST_TTL_SECONDS = 600;

router.get(
  "/turn",
  rateLimit({ name: "nettest_turn", windowMs: 60_000, max: 30 }),
  (_req, res) => {
    const host = (process.env.LIVEKIT_TURN_HOST || "").trim();
    const secret = (process.env.LIVEKIT_TURN_SECRET || "").trim();
    if (!host || !secret) {
      res.status(503).json({ message: "TURN is not configured" });
      return;
    }

    // Схема coturn с общим секретом: логин — это срок годности, пароль — подпись.
    const expiry = Math.floor(Date.now() / 1000) + TEST_TTL_SECONDS;
    const username = `${expiry}:nettest`;
    const credential = crypto.createHmac("sha1", secret).update(username).digest("base64");

    const udpPort = (process.env.LIVEKIT_TURN_UDP_PORT || "3478").trim();
    const tcpPort = (process.env.LIVEKIT_TURN_TCP_PORT || "3478").trim();
    const tlsPort = (process.env.LIVEKIT_TURN_TLS_PORT || "").trim();

    const urls = [
      `turn:${host}:${udpPort}?transport=udp`,
      `turn:${host}:${tcpPort}?transport=tcp`,
      ...(tlsPort ? [`turns:${host}:${tlsPort}?transport=tcp`] : []),
    ];

    res.json({ urls, username, credential, ttl: TEST_TTL_SECONDS });
  }
);

/**
 * Токен для пробного подключения к пустой комнате: страница проверяет, удаётся ли
 * связаться с нашим сервером НАПРЯМУЮ, без ретранслятора. Комната одноразовая и
 * техническая, право публиковать не выдаём — только установить соединение.
 */
router.get(
  "/livekit-token",
  rateLimit({ name: "nettest_lk", windowMs: 60_000, max: 20 }),
  async (_req, res) => {
    const apiKey = (process.env.LIVEKIT_API_KEY || "").trim();
    const apiSecret = (process.env.LIVEKIT_API_SECRET || "").trim();
    // Адрес берём ровно так же, как боевой роут звонков, иначе пробник проверял бы не тот путь.
    const wsUrl = env.LIVEKIT_PATH ? buildLivekitPublicUrl(_req, env.LIVEKIT_PATH) : (env.LIVEKIT_URL || "");
    if (!apiKey || !apiSecret) {
      res.status(503).json({ message: "LiveKit is not configured" });
      return;
    }
    const { AccessToken } = await import("livekit-server-sdk");
    const room = `nettest-${crypto.randomBytes(6).toString("hex")}`;
    const at = new AccessToken(apiKey, apiSecret, {
      identity: `probe-${crypto.randomBytes(4).toString("hex")}`,
      ttl: 300,
    });
    at.addGrant({ room, roomJoin: true, canPublish: false, canSubscribe: true, canPublishData: true });
    res.json({ token: await at.toJwt(), room, url: wsUrl });
  }
);

export default router;
