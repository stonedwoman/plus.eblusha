import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import prisma from "../lib/prisma";
import logger from "../config/logger";
import { authenticate } from "../middlewares/auth";
import { rateLimit } from "../middlewares/rateLimit";
import { getIO } from "../realtime/socket";
import { isSecretConversation } from "../lib/secretLatch";
import {
  BOT_FOLLOWUP_MAX_MESSAGES,
  BOT_FOLLOWUP_TTL_SECONDS,
  BOT_FOLLOWUPS_PER_GRANT,
  BOT_GRANT_MAX_MESSAGES,
  BOT_GRANT_MAX_REACTIONS,
  BOT_GRANT_TTL_SECONDS,
  BOT_MESSAGE_KINDS,
  BOT_NOTICES_PER_HOUR,
  BOT_SECRET_REFUSAL,
  BotNotConfiguredError,
  botRateOk,
  createBotFollowupGrant,
  createBotMessage,
  findActiveBotChat,
  getBotChatState,
  getSystemBot,
  readBotGrant,
  setBotChatEnabled,
  spendBotGrant,
  type BotGrant,
  type SystemBotProfile,
} from "../lib/systemBot";

/**
 * /api/bot — бот «Еблуша» как часть системы (src/lib/systemBot.ts).
 *
 * Для всех (любой вошедший пользователь):
 *   GET  /api/bot           → { bot: {id, displayName, avatarUrl, eblid, bio, isBot:true},
 *                               botChat: {botChatEnabled, conversationId}, secretChatRefusal }
 *                             404 BOT_NOT_CONFIGURED — бота нет (клиент прячет всё «ботовое»).
 *   GET  /api/bot/settings  → { botChatEnabled, conversationId }
 *   PUT  /api/bot/settings  { botChatEnabled: boolean } → то же. Своим устройствам — сокет bot:settings
 *                             {botChatEnabled, conversationId} и conversations:new / conversations:deleted.
 *
 * Только системный бот (его учётка, User.isBot):
 *   POST /api/bot/messages  { grant | userId, type: TEXT|IMAGE|FILE, content?, replyToId?, attachments?,
 *                             kind?: answer|command|notice|confirm, linkPreview?: boolean } → 201 {message}
 *       grant  — из задачи очереди: ответ ТОЛЬКО в беседу обращения, ≤ BOT_GRANT_MAX_MESSAGES, пока жив;
 *       userId — уведомление в личный «Чат с Еблушей» этого человека (если он его включил),
 *                ≤ BOT_NOTICES_PER_HOUR в час.
 *   POST /api/bot/typing    { grant, typing: boolean } → 204; в комнату беседы
 *                           conversation:typing_update {conversationId, userId, isTyping, displayName, isBot:true}
 *   POST /api/bot/react     { grant, messageId, emoji } → 200 {reaction}; сообщение — из беседы обращения.
 *   POST /api/bot/followup  { grant } → 201 {grant, expiresAt}: продолжение для отчёта о долгой задаче
 *                           (агент Valheim ждёт перезапуска сервера) — та же беседа и обращение,
 *                           ≤ BOT_FOLLOWUP_MAX_MESSAGES сообщений, BOT_FOLLOWUP_TTL_SECONDS, без реакций;
 *                           только по живому обычному разрешению (из продолжения — 400 BOT_FOLLOWUP_NESTED),
 *                           не больше BOT_FOLLOWUPS_PER_GRANT (429 BOT_GRANT_EXHAUSTED).
 *   По grant: обращение удалено автором → 409 BOT_TRIGGER_DELETED (ответа, реакции и «печатает» уже не будет).
 */

const router = Router();
router.use(authenticate);

type AuthedRequest = Request & { user?: { id: string } };
type BotRequest = Request & { user?: { id: string }; systemBot?: SystemBotProfile };

const userId = (req: Request) => (req as AuthedRequest).user!.id;

async function requireSystemBot(req: Request, res: Response, next: NextFunction): Promise<void> {
  const bot = await getSystemBot();
  if (!bot || bot.id !== userId(req)) {
    res.status(403).json({ message: "Only the system bot may call this", code: "BOT_ONLY" });
    return;
  }
  (req as BotRequest).systemBot = bot;
  next();
}

// ───────────────────────────── Для всех ─────────────────────────────

router.get("/", async (req, res) => {
  const bot = await getSystemBot();
  if (!bot) {
    res.status(404).json({ message: "Bot is not configured", code: "BOT_NOT_CONFIGURED" });
    return;
  }
  const botChat = await getBotChatState(userId(req));
  res.json({
    bot: { id: bot.id, displayName: bot.displayName, avatarUrl: bot.avatarUrl, eblid: bot.eblid, bio: bot.bio, isBot: true },
    botChat,
    secretChatRefusal: BOT_SECRET_REFUSAL,
  });
});

router.get("/settings", async (req, res) => {
  res.json(await getBotChatState(userId(req)));
});

const settingsSchema = z.object({ botChatEnabled: z.boolean() });

router.put("/settings", rateLimit({ name: "bot_settings", windowMs: 60_000, max: 20 }), async (req, res) => {
  const parsed = settingsSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid payload" });
    return;
  }
  const bot = await getSystemBot();
  if (bot && bot.id === userId(req)) {
    res.status(400).json({ message: "The bot has no bot chat", code: "BOT_SELF" });
    return;
  }
  try {
    res.json(await setBotChatEnabled(userId(req), parsed.data.botChatEnabled));
  } catch (error) {
    if (error instanceof BotNotConfiguredError) {
      res.status(404).json({ message: "Bot is not configured", code: "BOT_NOT_CONFIGURED" });
      return;
    }
    throw error;
  }
});

// ───────────────────────────── Только бот ─────────────────────────────

/** Своё хранилище: /api/files/<ключ> (бот грузит через /api/upload). Чужие адреса не принимаем. */
const FILE_URL_RE = /^\/api\/files\/[A-Za-z0-9._\/-]+$/;

const botMessageSchema = z
  .object({
    grant: z.string().min(1).max(100).optional(),
    userId: z.string().cuid().optional(),
    type: z.enum(["TEXT", "IMAGE", "FILE"]),
    content: z.string().max(8000).optional(),
    replyToId: z.string().cuid().optional(),
    attachments: z
      .array(
        z.object({
          url: z.string().regex(FILE_URL_RE),
          type: z.enum(["IMAGE", "FILE"]),
          size: z.number().int().nonnegative().optional(),
          metadata: z.record(z.string(), z.unknown()).optional(),
        }),
      )
      .max(4)
      .optional(),
    kind: z.enum(BOT_MESSAGE_KINDS as unknown as [string, ...string[]]).optional(),
    linkPreview: z.boolean().optional(),
  })
  .refine((v) => (v.grant ? 1 : 0) + (v.userId ? 1 : 0) === 1, { message: "grant or userId (exactly one)" })
  .refine((v) => (v.content ?? "").trim().length > 0 || (v.attachments?.length ?? 0) > 0, { message: "empty message" });

/** Беседа, куда бот может писать: обычная облачная, не секретная. */
async function writableConversation(conversationId: string) {
  const conv = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { id: true, type: true, isSecret: true, isGroup: true },
  });
  if (!conv || isSecretConversation(conv)) return null;
  return conv;
}

async function grantOr410(res: Response, token: unknown): Promise<BotGrant | null> {
  const g = await readBotGrant(token);
  if (!g) {
    res.status(410).json({ message: "Grant expired or unknown", code: "BOT_GRANT_EXPIRED" });
    return null;
  }
  return g;
}

/**
 * Человек удалил своё обращение, пока бот думал, — отвечать на него (и «печатать») уже нельзя: ответ
 * пересказал бы удалённый вопрос всем участникам. true — обращение на месте.
 */
async function triggerAliveOr409(res: Response, g: BotGrant): Promise<boolean> {
  const t = await prisma.message.findUnique({ where: { id: g.triggerMessageId }, select: { deletedAt: true } });
  if (t && !t.deletedAt) return true;
  res.status(409).json({ message: "The request message was deleted", code: "BOT_TRIGGER_DELETED" });
  return false;
}

router.post("/messages", requireSystemBot, async (req, res) => {
  const bot = (req as BotRequest).systemBot!;
  const parsed = botMessageSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid bot message", errors: parsed.error.issues });
    return;
  }
  const b = parsed.data;

  let conversationId: string;
  let triggerMessageId: string | null = null;
  if (b.grant) {
    const g = await grantOr410(res, b.grant);
    if (!g) return;
    if (!(await triggerAliveOr409(res, g))) return;
    const maxMessages = g.followup ? BOT_FOLLOWUP_MAX_MESSAGES : BOT_GRANT_MAX_MESSAGES;
    if (!(await spendBotGrant(b.grant, "msg", maxMessages, g.followup ? BOT_FOLLOWUP_TTL_SECONDS : BOT_GRANT_TTL_SECONDS))) {
      res.status(429).json({ message: "Too many messages for this request", code: "BOT_GRANT_EXHAUSTED" });
      return;
    }
    conversationId = g.conversationId;
    triggerMessageId = g.triggerMessageId;
  } else {
    const chat = await findActiveBotChat(b.userId!, bot.id);
    if (!chat) {
      res.status(409).json({ message: "The user has the bot chat turned off", code: "BOT_CHAT_DISABLED" });
      return;
    }
    if (!(await botRateOk(`bot:notice:${b.userId}`, 3600, BOT_NOTICES_PER_HOUR))) {
      res.status(429).json({ message: "Too many notices", code: "BOT_NOTICE_RATE" });
      return;
    }
    conversationId = chat;
  }

  // Повторная проверка беседы: за время ответа её могли удалить, а секретной она быть не может вовсе.
  const conv = await writableConversation(conversationId);
  if (!conv) {
    res.status(409).json({ message: "Conversation is not writable for the bot", code: "BOT_CONVERSATION_GONE" });
    return;
  }
  if (b.replyToId) {
    const parent = await prisma.message.findUnique({ where: { id: b.replyToId }, select: { conversationId: true } });
    if (!parent || parent.conversationId !== conversationId) {
      res.status(400).json({ message: "replyToId is not in this conversation", code: "BOT_REPLY_FOREIGN" });
      return;
    }
  }

  const message = await createBotMessage({
    botId: bot.id,
    conversationId,
    type: b.type,
    content: b.content ?? null,
    replyToId: b.replyToId ?? null,
    attachments: b.attachments ?? [],
    kind: (b.kind as "answer" | "command" | "notice" | "confirm" | undefined) ?? "answer",
    triggerMessageId,
    linkPreview: b.linkPreview === true,
  });
  logger.info({ conversationId, messageId: message.id, via: b.grant ? "grant" : "notice" }, "bot: message posted");
  res.status(201).json({ message });
});

// typing: сервер держит «печатает» 6 с (socket.ts TYPING_TTL); бот пингует раньше. Если бот упал
// посреди ответа — сами погасим через BOT_TYPING_AUTO_OFF_MS после последнего «печатает».
const BOT_TYPING_AUTO_OFF_MS = 10_000;
const typingOff = new Map<string, NodeJS.Timeout>();

function emitBotTyping(conversationId: string, bot: SystemBotProfile, isTyping: boolean): void {
  getIO()?.to(conversationId).emit("conversation:typing_update", {
    conversationId,
    userId: bot.id,
    isTyping,
    displayName: bot.displayName ?? "Еблуша",
    isBot: true,
  });
}

const typingSchema = z.object({ grant: z.string().min(1).max(100), typing: z.boolean() });

router.post("/typing", requireSystemBot, async (req, res) => {
  const bot = (req as BotRequest).systemBot!;
  const parsed = typingSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid payload" });
    return;
  }
  const g = await grantOr410(res, parsed.data.grant);
  if (!g) return;
  // «Печатает» на удалённый вопрос не включаем; погасить — можно всегда.
  if (parsed.data.typing && !(await triggerAliveOr409(res, g))) return;
  const key = g.conversationId;
  const prev = typingOff.get(key);
  if (prev) clearTimeout(prev);
  typingOff.delete(key);
  emitBotTyping(g.conversationId, bot, parsed.data.typing);
  if (parsed.data.typing) {
    const t = setTimeout(() => {
      typingOff.delete(key);
      emitBotTyping(g.conversationId, bot, false);
    }, BOT_TYPING_AUTO_OFF_MS);
    t.unref?.();
    typingOff.set(key, t);
  }
  res.status(204).send();
});

const reactSchema = z.object({
  grant: z.string().min(1).max(100),
  messageId: z.string().cuid(),
  emoji: z.string().min(1).max(32),
});

router.post("/react", requireSystemBot, async (req, res) => {
  const bot = (req as BotRequest).systemBot!;
  const parsed = reactSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid reaction" });
    return;
  }
  const g = await grantOr410(res, parsed.data.grant);
  if (!g) return;
  if (!(await triggerAliveOr409(res, g))) return;
  const msg = await prisma.message.findUnique({
    where: { id: parsed.data.messageId },
    select: { id: true, conversationId: true, deletedAt: true },
  });
  if (!msg || msg.conversationId !== g.conversationId || msg.deletedAt) {
    res.status(400).json({ message: "Message is not in the granted conversation", code: "BOT_REPLY_FOREIGN" });
    return;
  }
  if (!(await writableConversation(msg.conversationId))) {
    res.status(409).json({ message: "Conversation is not writable for the bot", code: "BOT_CONVERSATION_GONE" });
    return;
  }
  // По продолжению реакций нет: оно — для отчёта о долгой задаче, а не для «спасибо» → 👍.
  if (!(await spendBotGrant(parsed.data.grant, "react", g.followup ? 0 : BOT_GRANT_MAX_REACTIONS))) {
    res.status(429).json({ message: "Too many reactions for this request", code: "BOT_GRANT_EXHAUSTED" });
    return;
  }
  const reaction = await prisma.messageReaction.upsert({
    where: { messageId_userId_emoji: { messageId: msg.id, userId: bot.id, emoji: parsed.data.emoji } },
    update: {},
    create: { messageId: msg.id, userId: bot.id, emoji: parsed.data.emoji },
  });
  getIO()?.to(msg.conversationId).emit("message:reaction", { conversationId: msg.conversationId, messageId: msg.id, senderId: bot.id });
  res.json({ reaction });
});

const followupSchema = z.object({ grant: z.string().min(1).max(100) });

router.post("/followup", requireSystemBot, async (req, res) => {
  const parsed = followupSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid payload" });
    return;
  }
  const g = await grantOr410(res, parsed.data.grant);
  if (!g) return;
  if (g.followup) {
    res.status(400).json({ message: "A follow-up grant cannot be extended", code: "BOT_FOLLOWUP_NESTED" });
    return;
  }
  if (!(await triggerAliveOr409(res, g))) return;
  if (!(await writableConversation(g.conversationId))) {
    res.status(409).json({ message: "Conversation is not writable for the bot", code: "BOT_CONVERSATION_GONE" });
    return;
  }
  if (!(await spendBotGrant(parsed.data.grant, "followup", BOT_FOLLOWUPS_PER_GRANT))) {
    res.status(429).json({ message: "Too many follow-ups for this request", code: "BOT_GRANT_EXHAUSTED" });
    return;
  }
  const f = await createBotFollowupGrant(g);
  logger.info({ conversationId: g.conversationId, triggerMessageId: g.triggerMessageId }, "bot: follow-up grant");
  res.status(201).json(f);
});

export default router;
