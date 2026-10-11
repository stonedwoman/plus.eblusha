import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import prisma from "../lib/prisma";
import env from "../config/env";
import logger from "../config/logger";
import { authenticate } from "../middlewares/auth";
import { rateLimit } from "../middlewares/rateLimit";
import { getIO } from "../realtime/socket";
import { isSecretConversation } from "../lib/secretLatch";
import { BOT_HISTORY_PAGE_DEFAULT, BOT_HISTORY_PAGE_MAX, BOT_HISTORY_PAGES_PER_GRANT } from "../lib/botContract";
import {
  BOT_FOLLOWUP_MAX_MESSAGES,
  BOT_FOLLOWUP_TTL_SECONDS,
  BOT_FOLLOWUPS_PER_GRANT,
  BOT_GRANT_MAX_LOOKUPS,
  BOT_GRANT_MAX_MESSAGES,
  BOT_GRANT_MAX_REACTIONS,
  BOT_GRANT_TTL_SECONDS,
  BOT_NOTICES_PER_HOUR,
  BOT_POST_KINDS,
  BOT_SECRET_REFUSAL,
  BotNotConfiguredError,
  botMemoryStatus,
  botRateOk,
  createBotFollowupGrant,
  createBotMessage,
  findActiveBotChat,
  getBotChatState,
  getSystemBot,
  loadBotHistoryPage,
  lookupBotPeople,
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
 *                             kind?: answer|command|notice|confirm, linkPreview?: boolean,
 *                             depth?: "deep", model?: string } → 201 {message}
 *       depth/model — «Подумал лучше» (docs/bot-cards.md): metadata.bot.depth = "deep", metadata.bot.model.
 *       Карточки (kind "card") бот сам не шлёт — их ставит сервер (/api/bot/promises, /api/bot/share).
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
 *   POST /api/bot/people    { grant, query?: string(≤64), ids?: cuid[](≤20) } → 200 {participants, matches, users, truncated}:
 *                           люди для привязки персонажей владельцем (lookupBotPeople): участники беседы
 *                           обращения, поиск по имени/логину(точно)/EBLID, имена по id (без удалённых и заблокированных). Каждый —
 *                           {id, displayName, eblid, inConversation}, в matches ещё matchedBy (name|username|eblid);
 *                           логин не отдаётся. Сервер знает владельца (env BOT_OWNER_USER_ID) — только по его
 *                           обращению (иначе 403 BOT_OWNER_ONLY) и среди всех людей; не знает — по любому, но
 *                           только среди людей с общей беседой со спрашивающим. Только по живому обычному
 *                           разрешению (продолжение — 400 BOT_FOLLOWUP_NESTED), ≤ BOT_GRANT_MAX_LOOKUPS на
 *                           обращение (429 BOT_GRANT_EXHAUSTED). В журнал — без текста запроса.
 *   POST /api/bot/history   { grant, after?: {at: ISO, id} | null, limit?: 0..500, changesSince?: ms | null,
 *                             epoch?: string | null } → 200 BotHistoryPage {mode, messages, next, memory}:
 *                           память бота о своих разговорах в беседе обращения (контракт rev 3, botContract.ts):
 *                           «Чат с Еблушей» — весь чат, обычная беседа — только обращения к боту и его ответы;
 *                           memory — журнал изменений (таблица BotMemoryChange, пишется в транзакции удаления/
 *                           правки): удалили/поправили запомненное → бот пересобирает сводку; changes — сами
 *                           записи (какое сообщение, удалено или поправлено) — бот решает, видела ли их модель.
 *                           Только по живому обычному разрешению (продолжение — 400 BOT_FOLLOWUP_NESTED),
 *                           ≤ BOT_HISTORY_PAGES_PER_GRANT страниц на обращение (429 BOT_GRANT_EXHAUSTED).
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
    kind: z.enum(BOT_POST_KINDS).optional(),
    linkPreview: z.boolean().optional(),
    /** «Подумай лучше» (docs/bot-cards.md): ответ самой мощной моделью — metadata.bot.depth = "deep" и model. */
    depth: z.literal("deep").optional(),
    model: z.string().regex(/^[a-z0-9.-]{1,64}$/).optional(),
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
  let askerId: string | null = null;
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
    askerId = g.authorId;
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
    kind: b.kind ?? "answer",
    triggerMessageId,
    askerId,
    linkPreview: b.linkPreview === true,
    ...(b.depth || b.model ? { extraBot: { ...(b.depth ? { depth: b.depth } : {}), ...(b.model ? { model: b.model } : {}) } } : {}),
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

const peopleSchema = z
  .object({
    grant: z.string().min(1).max(100),
    query: z.string().trim().min(1).max(64).optional(),
    ids: z.array(z.string().cuid()).max(20).optional(),
  })
  .strict();

router.post("/people", requireSystemBot, async (req, res) => {
  const bot = (req as BotRequest).systemBot!;
  const parsed = peopleSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid payload" });
    return;
  }
  const g = await grantOr410(res, parsed.data.grant);
  if (!g) return;
  if (g.followup) {
    res.status(400).json({ message: "Not available for a follow-up grant", code: "BOT_FOLLOWUP_NESTED" });
    return;
  }
  // Привязывать других людей может только владелец бота. Сервер его знает (BOT_OWNER_USER_ID) — ищем только
  // по его обращению и среди всех; не знает — среди тех, с кем у спрашивающего есть общая беседа: так ни
  // ошибка в боте, ни обманутая модель не переберут имена и EBLID всей базы.
  const ownerId = env.BOT_OWNER_USER_ID ?? null;
  if (ownerId && g.authorId !== ownerId) {
    res.status(403).json({ message: "Only the bot owner's requests may look people up", code: "BOT_OWNER_ONLY" });
    return;
  }
  if (!(await writableConversation(g.conversationId))) {
    res.status(409).json({ message: "Conversation is not writable for the bot", code: "BOT_CONVERSATION_GONE" });
    return;
  }
  if (!(await spendBotGrant(parsed.data.grant, "people", BOT_GRANT_MAX_LOOKUPS))) {
    res.status(429).json({ message: "Too many lookups for this request", code: "BOT_GRANT_EXHAUSTED" });
    return;
  }
  const result = await lookupBotPeople({
    conversationId: g.conversationId,
    botId: bot.id,
    authorId: g.authorId,
    scope: ownerId ? "all" : "shared",
    query: parsed.data.query,
    ids: parsed.data.ids,
  });
  logger.info(
    {
      conversationId: g.conversationId,
      query: parsed.data.query ? true : false,
      ids: parsed.data.ids?.length ?? 0,
      matches: result.matches.length,
      scope: ownerId ? "all" : "shared",
    },
    "bot: people lookup",
  );
  res.json(result);
});

const historySchema = z
  .object({
    grant: z.string().min(1).max(100),
    after: z
      .object({ at: z.string().datetime(), id: z.string().max(64) })
      .strict()
      .nullable()
      .optional(),
    limit: z.number().int().min(0).max(BOT_HISTORY_PAGE_MAX).optional(),
    changesSince: z.number().int().nonnegative().nullable().optional(),
    epoch: z.string().max(64).nullable().optional(),
  })
  .strict();

router.post("/history", requireSystemBot, async (req, res) => {
  const parsed = historySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid payload" });
    return;
  }
  const b = parsed.data;
  const g = await grantOr410(res, b.grant);
  if (!g) return;
  if (g.followup) {
    res.status(400).json({ message: "Not available for a follow-up grant", code: "BOT_FOLLOWUP_NESTED" });
    return;
  }
  // Обращение удалили — отвечать на него не будут, и память беседы ему не нужна.
  if (!(await triggerAliveOr409(res, g))) return;
  if (!(await writableConversation(g.conversationId))) {
    res.status(409).json({ message: "Conversation is not writable for the bot", code: "BOT_CONVERSATION_GONE" });
    return;
  }
  if (!(await spendBotGrant(b.grant, "history", BOT_HISTORY_PAGES_PER_GRANT))) {
    res.status(429).json({ message: "Too many history pages for this request", code: "BOT_GRANT_EXHAUSTED" });
    return;
  }
  // Сначала журнал (его checkedAt — ДО чтения сообщений), потом сами сообщения.
  const memory = await botMemoryStatus(g.conversationId, { changesSince: b.changesSince ?? null, epoch: b.epoch ?? null });
  const page = await loadBotHistoryPage({
    conversationId: g.conversationId,
    kind: g.kind,
    after: b.after ? { at: new Date(b.after.at), id: b.after.id } : null,
    limit: b.limit ?? BOT_HISTORY_PAGE_DEFAULT,
  });
  logger.info(
    {
      conversationId: g.conversationId,
      mode: page.mode,
      n: page.messages.length,
      more: page.next !== null,
      reset: memory.reset,
      changed: memory.changedFrom !== null,
    },
    "bot: history",
  );
  res.json({ ...page, memory });
});

export default router;
