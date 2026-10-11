import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import prisma from "../lib/prisma";
import logger from "../config/logger";
import { authenticate } from "../middlewares/auth";
import { isSecretConversation } from "../lib/secretLatch";
import { getSystemBot, readBotGrant, spendBotGrant, BOT_GRANT_MAX_MESSAGES, type BotGrant, type SystemBotProfile } from "../lib/systemBot";
import { CardError } from "../lib/botCards";
import { sanitizeSpec } from "../lib/promiseTime";
import {
  activePromises,
  cancelTimer,
  createPromiseTimer,
  deadlineFromWords,
  extendTimer,
  markArrived,
  PROMISE_CORRECT_MS,
  promiseCandidates,
  participantByName,
  promiseTimersEnabled,
  punctualityBoard,
  punctualityStats,
  summaryOf,
} from "../lib/promiseTimer";
import {
  botShareEnabled,
  declineShare,
  grantShare,
  requestShare,
  reopenShare,
  revokeAllShares,
  shareAnswered,
  shareChanges,
  shareEstimate,
  shareInScope,
  shareMessagesPage,
  SHARE_MAX_ANSWERS,
  SHARE_PAGE_DEFAULT,
  SHARE_PAGE_MAX,
  SHARE_PAGES_PER_GRANT,
} from "../lib/botShare";

/**
 * Карточки бота — маршруты ДЛЯ СЕРВИСА БОТА (учётка с isBot; клиенты их не вызывают). Монтируются ПЕРЕД /api/bot
 * (src/routes/index.ts). Контракт — docs/bot-cards.md (таймер обещания и «поделиться перепиской»), ревизия задачи 4.
 *
 *   /api/bot/promises/*  — таймер «Еблуша, проконтролируй» (src/lib/promiseTimer.ts);
 *   /api/bot/share/*     — «поделиться перепиской» (src/lib/botShare.ts).
 * Всё — по разрешению задачи (grant): только беседа обращения; продолжение (followup) сюда не пускает.
 */

type AuthedRequest = Request & { user?: { id: string }; systemBot?: SystemBotProfile };
const uid = (req: Request) => (req as AuthedRequest).user!.id;

async function requireSystemBot(req: Request, res: Response, next: NextFunction): Promise<void> {
  const bot = await getSystemBot();
  if (!bot || bot.id !== uid(req)) {
    res.status(403).json({ message: "Only the system bot may call this", code: "BOT_ONLY" });
    return;
  }
  (req as AuthedRequest).systemBot = bot;
  next();
}

const botOf = (req: Request) => (req as AuthedRequest).systemBot!;

/** Живое обычное разрешение + живое обращение + обычная беседа. null — ответ уже отправлен. */
async function liveGrant(res: Response, token: unknown, opts: { allowFollowup?: boolean } = {}): Promise<BotGrant | null> {
  const g = await readBotGrant(token);
  if (!g) {
    res.status(410).json({ message: "Grant expired or unknown", code: "BOT_GRANT_EXPIRED" });
    return null;
  }
  if (g.followup && !opts.allowFollowup) {
    res.status(400).json({ message: "Not available for a follow-up grant", code: "BOT_FOLLOWUP_NESTED" });
    return null;
  }
  const t = await prisma.message.findUnique({ where: { id: g.triggerMessageId }, select: { deletedAt: true } });
  if (!t || t.deletedAt) {
    res.status(409).json({ message: "The request message was deleted", code: "BOT_TRIGGER_DELETED" });
    return null;
  }
  const conv = await prisma.conversation.findUnique({ where: { id: g.conversationId }, select: { type: true, isSecret: true } });
  if (!conv || isSecretConversation(conv)) {
    res.status(409).json({ message: "Conversation is not writable for the bot", code: "BOT_CONVERSATION_GONE" });
    return null;
  }
  return g;
}

function cardErr(res: Response, e: unknown): void {
  if (e instanceof CardError) {
    res.status(e.status).json({ message: e.message, code: e.code, ...(e.card ? { card: e.card } : {}) });
    return;
  }
  logger.error({ error: e }, "bot cards: failed");
  res.status(500).json({ message: "Something went wrong", code: "CARD_ERROR" });
}

const grantOnly = z.object({ grant: z.string().min(1).max(100) }).strict();
const cuid = z.string().cuid();

// ═════════════════════════════ /api/bot/promises ═════════════════════════════

export const botPromisesRouter = Router();
botPromisesRouter.use(authenticate, requireSystemBot);

/** Выключатель PROMISE_TIMERS=off — маршруты бота 404 (бот говорит «Таймеры пока выключены»). */
botPromisesRouter.use((_req, res, next) => {
  if (!promiseTimersEnabled()) {
    res.status(404).json({ message: "Promise timers are turned off", code: "PROMISE_DISABLED" });
    return;
  }
  next();
});

const specSchema = z.unknown().optional();

botPromisesRouter.post("/candidates", async (req, res) => {
  const p = grantOnly.safeParse(req.body ?? {});
  if (!p.success) return void res.status(400).json({ message: "Invalid payload", code: "PROMISE_BAD" });
  const g = await liveGrant(res, p.data.grant);
  if (!g) return;
  if (!(await spendBotGrant(p.data.grant, "promise", 20))) return void res.status(429).json({ message: "Too many lookups", code: "BOT_GRANT_EXHAUSTED" });
  const candidates = await promiseCandidates(g.conversationId, g.triggerMessageId, g.authorId, botOf(req).id);
  logger.info({ conversationId: g.conversationId, n: candidates.length }, "bot: promise candidates");
  res.json({ candidates });
});

const createSchema = z
  .object({
    grant: z.string().min(1).max(100),
    promiserId: cuid.optional(),
    /** Имя участника, как его назвали («проследи, чтобы Вася был к девяти»): сервер ищет среди участников беседы. */
    promiserName: z.string().min(1).max(64).optional(),
    promiseMessageId: cuid.optional(),
    text: z.string().max(1000).optional(),
    spec: specSchema,
    cancelAllowedIds: z.array(z.string().max(64)).max(5).optional(),
    confirmAmbiguous: z.boolean().optional(),
    dryRun: z.boolean().optional(),
  })
  .strict();

botPromisesRouter.post("/", async (req, res) => {
  const p = createSchema.safeParse(req.body ?? {});
  if (!p.success) return void res.status(400).json({ message: "Invalid payload", code: "PROMISE_BAD" });
  const b = p.data;
  const g = await liveGrant(res, b.grant);
  if (!g) return;
  let spec = null;
  if (b.spec !== undefined && b.spec !== null) {
    spec = sanitizeSpec(b.spec);
    if (!spec) return void res.status(400).json({ message: "Invalid spec", code: "PROMISE_BAD" });
  }
  let promiserId = b.promiserId ?? null;
  if (!promiserId && b.promiserName) {
    const who = await participantByName(g.conversationId, b.promiserName, botOf(req).id);
    if (who.kind === "none") return void res.status(409).json({ message: "No such participant", code: "PROMISE_NAME_UNKNOWN" });
    if (who.kind === "ambiguous") return void res.status(409).json({ message: "Several participants", code: "PROMISE_NAME_AMBIGUOUS", names: who.names });
    promiserId = who.userId;
  }
  if (!promiserId) return void res.status(400).json({ message: "promiserId or promiserName", code: "PROMISE_BAD" });
  if (!b.dryRun && !(await spendBotGrant(b.grant, "msg", BOT_GRANT_MAX_MESSAGES))) {
    return void res.status(429).json({ message: "Too many messages for this request", code: "BOT_GRANT_EXHAUSTED" });
  }
  try {
    const r = await createPromiseTimer({
      conversationId: g.conversationId,
      triggerMessageId: g.triggerMessageId,
      requesterId: g.authorId,
      promiserId,
      promiseMessageId: b.promiseMessageId ?? null,
      text: b.text ?? null,
      spec,
      cancelAllowedIds: b.cancelAllowedIds ?? [],
      confirmAmbiguous: b.confirmAmbiguous === true,
      dryRun: b.dryRun === true,
    });
    if (!r.ok) {
      const { status, ...rest } = r.error;
      return void res.status(status).json(rest);
    }
    if (r.dryRun) return void res.json({ promise: r.preview, dryRun: true });
    res.status(201).json({ promise: await summaryOf(r.row), cardMessageId: r.row.cardMessageId });
  } catch (e) {
    cardErr(res, e);
  }
});

/** Таймер беседы разрешения (иначе 404). */
async function timerOf(res: Response, id: string, g: BotGrant | null) {
  const t = await prisma.promiseTimer.findUnique({ where: { id } });
  if (!t || (g && t.conversationId !== g.conversationId)) {
    res.status(404).json({ message: "No such timer", code: "PROMISE_NOT_FOUND" });
    return null;
  }
  return t;
}

const extendSchema = z
  .object({ grant: z.string().min(1).max(100), text: z.string().max(1000).optional(), spec: specSchema, sourceMessageId: cuid.optional() })
  .strict();

botPromisesRouter.post("/:id/extend", async (req, res) => {
  const p = extendSchema.safeParse(req.body ?? {});
  const id = cuid.safeParse(req.params.id);
  if (!p.success || !id.success) return void res.status(400).json({ message: "Invalid payload", code: "PROMISE_BAD" });
  const g = await liveGrant(res, p.data.grant);
  if (!g) return;
  const t = await timerOf(res, id.data, g);
  if (!t) return;
  // Продлевает только сам обещавший: его обращение или его же новое сообщение, на которое ответили.
  let base: Date | null = null;
  let byMessageId: string | null = null;
  if (g.authorId === t.promiserId) {
    const trig = await prisma.message.findUnique({ where: { id: g.triggerMessageId }, select: { createdAt: true } });
    base = trig?.createdAt ?? new Date();
    byMessageId = g.triggerMessageId;
  } else if (p.data.sourceMessageId) {
    const src = await prisma.message.findUnique({
      where: { id: p.data.sourceMessageId },
      select: { conversationId: true, senderId: true, createdAt: true, deletedAt: true },
    });
    if (src && !src.deletedAt && src.conversationId === g.conversationId && src.senderId === t.promiserId && src.createdAt > t.createdAt) {
      base = src.createdAt;
      byMessageId = p.data.sourceMessageId;
    }
  }
  if (!base) return void res.status(403).json({ message: "Only the promiser may extend", code: "PROMISE_EXTEND_FORBIDDEN" });
  const spec = p.data.spec !== undefined && p.data.spec !== null ? sanitizeSpec(p.data.spec) : null;
  const d = await deadlineFromWords({ row: t, text: p.data.text ?? null, spec, base });
  if (!d.ok) return void res.status(409).json({ message: "No new time", code: d.code, ...(d.deadlineAt ? { deadlineAt: d.deadlineAt } : {}) });
  try {
    const row = await extendTimer(t.id, { byId: g.authorId, newDeadline: d.deadlineAt, label: d.label, byMessageId });
    res.json({ promise: await summaryOf(row) });
  } catch (e) {
    cardErr(res, e);
  }
});

botPromisesRouter.post("/:id/correct", async (req, res) => {
  const p = extendSchema.safeParse(req.body ?? {});
  const id = cuid.safeParse(req.params.id);
  if (!p.success || !id.success) return void res.status(400).json({ message: "Invalid payload", code: "PROMISE_BAD" });
  const g = await liveGrant(res, p.data.grant);
  if (!g) return;
  const t = await timerOf(res, id.data, g);
  if (!t) return;
  if (g.authorId !== t.requesterId) return void res.status(403).json({ message: "Only the requester may correct", code: "PROMISE_CORRECT_FORBIDDEN" });
  if (Date.now() - t.createdAt.getTime() > PROMISE_CORRECT_MS) return void res.status(409).json({ message: "Too late to correct", code: "PROMISE_CORRECT_EXPIRED" });
  const spec = p.data.spec !== undefined && p.data.spec !== null ? sanitizeSpec(p.data.spec) : null;
  const d = await deadlineFromWords({ row: t, text: p.data.text ?? null, spec, base: t.startAt });
  if (!d.ok) return void res.status(409).json({ message: "No new time", code: d.code });
  try {
    const row = await extendTimer(t.id, { byId: g.authorId, newDeadline: d.deadlineAt, label: d.label, byMessageId: g.triggerMessageId, correct: true });
    res.json({ promise: await summaryOf(row) });
  } catch (e) {
    cardErr(res, e);
  }
});

const arrivedSchema = z
  .object({
    grant: z.string().min(1).max(100).optional(),
    via: z.enum(["phrase", "valheim"]),
    at: z.string().datetime().optional(),
    detail: z.string().max(64).optional(),
  })
  .strict();

botPromisesRouter.post("/:id/arrived", async (req, res) => {
  const p = arrivedSchema.safeParse(req.body ?? {});
  const id = cuid.safeParse(req.params.id);
  if (!p.success || !id.success) return void res.status(400).json({ message: "Invalid payload", code: "PROMISE_BAD" });
  try {
    if (p.data.via === "phrase") {
      const g = await liveGrant(res, p.data.grant);
      if (!g) return;
      const t = await timerOf(res, id.data, g);
      if (!t) return;
      const row = await markArrived(t.id, { via: g.authorId === t.promiserId ? "self" : "phrase", byId: g.authorId });
      return void res.json({ promise: await summaryOf(row) });
    }
    // Valheim: без разрешения (наблюдатель бота), at ∈ [startAt; сейчас + 5 с].
    const t = await timerOf(res, id.data, null);
    if (!t) return;
    const at = p.data.at ? new Date(p.data.at) : new Date();
    if (at.getTime() > Date.now() + 5000 || at.getTime() < t.startAt.getTime() - 1000) {
      return void res.status(409).json({ message: "Entered before the promise", code: "PROMISE_TOO_EARLY" });
    }
    const row = await markArrived(t.id, { via: "valheim", at, byId: null, detail: p.data.detail ?? null });
    res.json({ promise: await summaryOf(row) });
  } catch (e) {
    cardErr(res, e);
  }
});

botPromisesRouter.post("/:id/cancel", async (req, res) => {
  const p = grantOnly.safeParse(req.body ?? {});
  const id = cuid.safeParse(req.params.id);
  if (!p.success || !id.success) return void res.status(400).json({ message: "Invalid payload", code: "PROMISE_BAD" });
  const g = await liveGrant(res, p.data.grant);
  if (!g) return;
  const t = await timerOf(res, id.data, g);
  if (!t) return;
  if (!t.cancelAllowedIds.includes(g.authorId)) return void res.status(403).json({ message: "Not allowed", code: "PROMISE_CANCEL_FORBIDDEN" });
  try {
    const row = await cancelTimer(t.id, g.authorId);
    res.json({ promise: await summaryOf(row) });
  } catch (e) {
    cardErr(res, e);
  }
});

botPromisesRouter.get("/active", async (_req, res) => {
  res.json({ promises: await activePromises() });
});

botPromisesRouter.post("/in-conversation", async (req, res) => {
  const p = grantOnly.safeParse(req.body ?? {});
  if (!p.success) return void res.status(400).json({ message: "Invalid payload", code: "PROMISE_BAD" });
  const g = await liveGrant(res, p.data.grant);
  if (!g) return;
  const rows = await prisma.promiseTimer.findMany({ where: { conversationId: g.conversationId, status: "RUNNING" }, orderBy: { deadlineAt: "asc" }, take: 10 });
  const out = [];
  for (const r of rows) out.push(await summaryOf(r));
  res.json({ promises: out });
});

const statsSchema = z
  .object({ grant: z.string().min(1).max(100), userId: cuid.optional(), name: z.string().min(1).max(64).optional(), board: z.boolean().optional() })
  .strict();

botPromisesRouter.post("/stats", async (req, res) => {
  const p = statsSchema.safeParse(req.body ?? {});
  if (!p.success || (!p.data.userId && !p.data.name && !p.data.board)) return void res.status(400).json({ message: "Invalid payload", code: "PROMISE_BAD" });
  const g = await liveGrant(res, p.data.grant);
  if (!g) return;
  if (!(await spendBotGrant(p.data.grant, "promise", 20))) return void res.status(429).json({ message: "Too many lookups", code: "BOT_GRANT_EXHAUSTED" });
  if (p.data.board) return void res.json({ board: await punctualityBoard(g.conversationId, g.authorId, botOf(req).id) });
  let target = p.data.userId ?? null;
  if (!target && p.data.name) {
    const who = await participantByName(g.conversationId, p.data.name, botOf(req).id);
    if (who.kind === "none") return void res.status(404).json({ message: "No such participant", code: "PROMISE_NAME_UNKNOWN" });
    if (who.kind === "ambiguous") return void res.status(409).json({ message: "Several participants", code: "PROMISE_NAME_AMBIGUOUS", names: who.names });
    target = who.userId;
  }
  // Только о людях с общей беседой со спрашивающим.
  const shared = await prisma.conversationParticipant.count({
    where: { userId: target!, conversation: { isSecret: false, participants: { some: { userId: g.authorId } } } },
  });
  if (!shared) return void res.status(404).json({ message: "No shared conversations", code: "PROMISE_NOT_FOUND" });
  res.json({ stats: await punctualityStats(target!, g.authorId) });
});

// ═════════════════════════════ /api/bot/share ═════════════════════════════

export const botShareRouter = Router();
botShareRouter.use(authenticate, requireSystemBot);
botShareRouter.use((_req, res, next) => {
  if (!botShareEnabled()) {
    res.status(404).json({ message: "Chat sharing is turned off", code: "SHARE_DISABLED" });
    return;
  }
  next();
});

botShareRouter.post("/estimate", async (req, res) => {
  const p = grantOnly.safeParse(req.body ?? {});
  if (!p.success) return void res.status(400).json({ message: "Invalid payload", code: "SHARE_BAD" });
  const g = await liveGrant(res, p.data.grant);
  if (!g) return;
  if (g.kind === "bot") return void res.status(409).json({ message: "The bot already sees this chat", code: "SHARE_NOT_NEEDED" });
  if (!(await spendBotGrant(p.data.grant, "share", 5))) return void res.status(429).json({ message: "Too many estimates", code: "BOT_GRANT_EXHAUSTED" });
  const est = await shareEstimate({ conversationId: g.conversationId, triggerMessageId: g.triggerMessageId, authorId: g.authorId, kind: g.kind });
  logger.info({ conversationId: g.conversationId, n: est.periods.map((x) => x.messages) }, "bot: share estimate");
  res.json(est);
});

const periodEnum = z.enum(["today", "week", "all"]);
const optionSchema = z.object({ enabled: z.boolean(), off: z.enum(["too_big", "budget"]).nullable().optional() }).strict();
const requestSchema = z
  .object({
    grant: z.string().min(1).max(100),
    suggest: z.object({ period: periodEnum, photos: z.boolean() }).strict(),
    options: z.object({ today: optionSchema.optional(), week: optionSchema.optional(), all: optionSchema.optional() }).strict().optional(),
  })
  .strict();

const shareOut = (s: { id: string; status: string; period: string | null; includePhotos: boolean; periodFrom: Date | null; until: Date | null; cardMessageId: string | null; triggerMessageId: string; answers: number }) => ({
  id: s.id,
  status: s.status.toLowerCase(),
  period: s.period,
  photos: s.includePhotos,
  from: s.periodFrom ? s.periodFrom.toISOString() : null,
  until: s.until ? s.until.toISOString() : null,
  cardMessageId: s.cardMessageId,
  triggerMessageId: s.triggerMessageId,
  answers: s.answers,
});

botShareRouter.post("/request", async (req, res) => {
  const p = requestSchema.safeParse(req.body ?? {});
  if (!p.success) return void res.status(400).json({ message: "Invalid payload", code: "SHARE_BAD" });
  const g = await liveGrant(res, p.data.grant);
  if (!g) return;
  if (g.kind === "bot") return void res.status(409).json({ message: "The bot already sees this chat", code: "SHARE_NOT_NEEDED" });
  const inScope = await shareInScope(g.conversationId, g.triggerMessageId);
  if (!inScope && !(await spendBotGrant(p.data.grant, "msg", BOT_GRANT_MAX_MESSAGES))) {
    return void res.status(429).json({ message: "Too many messages for this request", code: "BOT_GRANT_EXHAUSTED" });
  }
  const r = await requestShare({
    conversationId: g.conversationId,
    triggerMessageId: g.triggerMessageId,
    askerId: g.authorId,
    suggest: p.data.suggest,
    options: p.data.options ?? {},
  });
  if (!r.ok) {
    const { status, ...rest } = r.error;
    return void res.status(status).json(rest);
  }
  if ("granted" in r) return void res.json({ share: shareOut(r.granted), status: "granted" });
  res.status(201).json({ share: shareOut(r.created), cardMessageId: r.created.cardMessageId });
});

/** Согласие, в области которого grant (вопрос, его уточнения) и которое ещё действует. null — ответ отправлен. */
async function scopedShare(res: Response, id: string, g: BotGrant) {
  const s = await prisma.botShare.findUnique({ where: { id } });
  if (!s || s.conversationId !== g.conversationId) {
    res.status(404).json({ message: "No such share", code: "SHARE_NOT_FOUND" });
    return null;
  }
  if (s.status === "REVOKED") {
    res.status(410).json({ message: "Access revoked", code: "SHARE_REVOKED" });
    return null;
  }
  if (s.status !== "GRANTED" || !s.until || s.until.getTime() <= Date.now()) {
    res.status(410).json({ message: "Access ended", code: "SHARE_ENDED" });
    return null;
  }
  if (s.triggerMessageId !== g.triggerMessageId) {
    const inScope = await shareInScope(g.conversationId, g.triggerMessageId);
    if (!inScope || inScope.id !== s.id) {
      res.status(403).json({ message: "This request is outside the share", code: "SHARE_SCOPE" });
      return null;
    }
  }
  return s;
}

const pageSchema = z
  .object({
    grant: z.string().min(1).max(100),
    after: z.object({ at: z.string().datetime(), id: z.string().max(64) }).strict().nullable().optional(),
    limit: z.number().int().min(0).max(SHARE_PAGE_MAX).optional(),
    ids: z.array(cuid).max(100).optional(),
    changesSince: z.number().int().nonnegative().nullable().optional(),
  })
  .strict();

botShareRouter.post("/:id/messages", async (req, res) => {
  const p = pageSchema.safeParse(req.body ?? {});
  const id = cuid.safeParse(req.params.id);
  if (!p.success || !id.success) return void res.status(400).json({ message: "Invalid payload", code: "SHARE_BAD" });
  const g = await liveGrant(res, p.data.grant);
  if (!g) return;
  const s = await scopedShare(res, id.data, g);
  if (!s) return;
  if (s.answers >= SHARE_MAX_ANSWERS) return void res.status(429).json({ message: "Too many answers for this share", code: "SHARE_ANSWERS_LIMIT" });
  if (!(await spendBotGrant(p.data.grant, "sharepage", SHARE_PAGES_PER_GRANT))) {
    return void res.status(429).json({ message: "Too many pages for this request", code: "BOT_GRANT_EXHAUSTED" });
  }
  const checkedAt = Date.now();
  const changes = await shareChanges(s.conversationId, p.data.changesSince ?? null);
  const page =
    p.data.limit === 0
      ? { messages: [], next: null }
      : await shareMessagesPage({
          share: s,
          after: p.data.after ? { at: new Date(p.data.after.at), id: p.data.after.id } : null,
          limit: p.data.limit ?? SHARE_PAGE_DEFAULT,
          ...(p.data.ids ? { ids: p.data.ids } : {}),
        });
  logger.info({ shareId: s.id, n: page.messages.length, photos: page.messages.reduce((a, m) => a + (m.photos?.length ?? 0), 0), more: page.next !== null }, "bot: share read");
  res.json({
    share: shareOut(s),
    messages: page.messages,
    next: page.next,
    changes,
    checkedAt,
  });
});

botShareRouter.post("/:id/status", async (req, res) => {
  const p = grantOnly.safeParse(req.body ?? {});
  const id = cuid.safeParse(req.params.id);
  if (!p.success || !id.success) return void res.status(400).json({ message: "Invalid payload", code: "SHARE_BAD" });
  const g = await liveGrant(res, p.data.grant);
  if (!g) return;
  const s = await scopedShare(res, id.data, g);
  if (!s) return;
  res.json({ share: shareOut(s) });
});

const answeredSchema = z
  .object({
    grant: z.string().min(1).max(100),
    messageId: cuid.optional(),
    messageIds: z.array(cuid).max(12).optional(),
    read: z.object({ messages: z.number().int().min(0), photos: z.number().int().min(0) }).strict(),
    usd: z.number().min(0).max(100).optional(),
  })
  .strict();

botShareRouter.post("/:id/answered", async (req, res) => {
  const p = answeredSchema.safeParse(req.body ?? {});
  const id = cuid.safeParse(req.params.id);
  if (!p.success || !id.success) return void res.status(400).json({ message: "Invalid payload", code: "SHARE_BAD" });
  const g = await liveGrant(res, p.data.grant);
  if (!g) return;
  const s = await scopedShare(res, id.data, g);
  if (!s) return;
  const ids = [...(p.data.messageIds ?? []), ...(p.data.messageId ? [p.data.messageId] : [])];
  if (!ids.length) return void res.status(400).json({ message: "messageId required", code: "SHARE_BAD" });
  try {
    const row = await shareAnswered({ share: s, messageIds: ids, triggerMessageId: g.triggerMessageId, read: p.data.read, usd: p.data.usd ?? null });
    res.json({ share: shareOut(row) });
  } catch (e) {
    cardErr(res, e);
  }
});

const reopenSchema = z
  .object({ grant: z.string().min(1).max(100), off: z.object({ period: periodEnum, reason: z.enum(["too_big", "budget"]) }).strict() })
  .strict();

botShareRouter.post("/:id/reopen", async (req, res) => {
  const p = reopenSchema.safeParse(req.body ?? {});
  const id = cuid.safeParse(req.params.id);
  if (!p.success || !id.success) return void res.status(400).json({ message: "Invalid payload", code: "SHARE_BAD" });
  const g = await liveGrant(res, p.data.grant);
  if (!g) return;
  const s = await scopedShare(res, id.data, g);
  if (!s) return;
  try {
    const row = await reopenShare(s.id, { period: p.data.off.period, reason: p.data.off.reason });
    res.json({ share: shareOut(row) });
  } catch (e) {
    cardErr(res, e);
  }
});

botShareRouter.post("/revoke", async (req, res) => {
  const p = grantOnly.safeParse(req.body ?? {});
  if (!p.success) return void res.status(400).json({ message: "Invalid payload", code: "SHARE_BAD" });
  const g = await liveGrant(res, p.data.grant);
  if (!g) return;
  const n = await revokeAllShares(g.conversationId, g.authorId);
  logger.info({ conversationId: g.conversationId, n }, "bot: share revoke phrase");
  res.json({ revoked: n });
});

const chooseSchema = z
  .object({ grant: z.string().min(1).max(100), period: periodEnum.optional(), photos: z.boolean().optional(), decline: z.boolean().optional() })
  .strict();

botShareRouter.post("/:id/choose", async (req, res) => {
  const p = chooseSchema.safeParse(req.body ?? {});
  const id = cuid.safeParse(req.params.id);
  if (!p.success || !id.success || (!p.data.decline && !p.data.period)) return void res.status(400).json({ message: "Invalid payload", code: "SHARE_BAD" });
  const g = await liveGrant(res, p.data.grant);
  if (!g) return;
  const s = await prisma.botShare.findUnique({ where: { id: id.data } });
  if (!s || s.conversationId !== g.conversationId) return void res.status(404).json({ message: "No such share", code: "SHARE_NOT_FOUND" });
  if (g.authorId !== s.askerId) return void res.status(403).json({ message: "Only the asker decides", code: "SHARE_NOT_ASKER" });
  try {
    const row = p.data.decline ? await declineShare(s.id, g.authorId) : await grantShare(s.id, g.authorId, { period: p.data.period!, photos: p.data.photos === true });
    res.json({ share: shareOut(row) });
  } catch (e) {
    cardErr(res, e);
  }
});
