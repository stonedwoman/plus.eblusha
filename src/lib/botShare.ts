/**
 * «Поделиться перепиской» (решение владельца 2026-10-11; docs/bot-cards.md, раздел «Поделиться перепиской»).
 *
 * В обычной беседе бот видит только обращения к себе и свои ответы. Если для ответа нужна переписка людей, модель
 * зовёт read_chat — бот просит сервер поставить КАРТОЧКУ СОГЛАСИЯ (сообщение бота, metadata.card type "share"):
 * «Сегодня / Эта неделя / Всё время» со счётом сообщений, галка «Включать фото», «Поделиться» / «Не делиться».
 * Решает только спросивший; остальные видят, что происходит. После выбора сервер ставит боту ПРОДОЛЖЕНИЕ (та же
 * задача на исходный вопрос, новый grant, job.share), бот читает переписку страницами ТОЛЬКО по grant из области
 * согласия (вопрос и уточнения к нему по цепочке) и только пока окно (60 мин) не закрылось.
 *
 * Хранится здесь (BotShare) только кто/когда/период/счётчики/статус — без текстов. Пока у беседы есть действующее
 * согласие, удаления и правки пишутся в Redis share:chg:<беседа> — бот выкидывает удалённое из своего кэша.
 * Секретных бесед тут не бывает: разрешение на них не выдаётся, и каждый маршрут проверяет это ещё раз.
 */
import { Prisma, type BotShare } from "@prisma/client";
import logger from "../config/logger";
import prisma from "./prisma";
import { getRedisClient } from "./redis";
import { getEffectiveTimeZone } from "./localTime";
import { isValidZone, zonedParts, zonedToUtc, hmIn } from "./promiseTime";
import {
  CardError,
  announceCardMessage,
  assertCanAct,
  displayNames,
  insertCardMessage,
  iso,
  publishCardUpdate,
  registerCardType,
  writeCardTx,
  type CardAction,
  type CardEnvelope,
} from "./botCards";
import { botTriggerOf, dispatchBotSignal, dispatchShareResume, getSystemBot } from "./systemBot";
import { decryptNonSecretChatText, getNonSecretConversationDek } from "./nonSecretChatEncryption";
import { enqueueCardsJob } from "../jobs/queue";

export type SharePeriod = "today" | "week" | "all";
export const SHARE_PERIODS: readonly SharePeriod[] = ["today", "week", "all"];
export const SHARE_PENDING_MS = 30 * 60_000;
export const SHARE_WINDOW_MS = 60 * 60_000;
export const SHARE_DECLINE_QUIET_MS = 30 * 60_000;
export const SHARE_REOPEN_MS = 2 * 60_000;
export const SHARE_MAX_MESSAGES = 30_000;
export const SHARE_MAX_PHOTOS = 60;
export const SHARE_MAX_ANSWERS = 10;
export const SHARE_MAX_PENDING_PER_CONVERSATION = 3;
export const SHARE_MAX_PER_ASKER_DAY = 10;
export const SHARE_PAGE_DEFAULT = 300;
export const SHARE_PAGE_MAX = 500;
export const SHARE_PAGES_PER_GRANT = 200;
export const SHARE_TEXT_MAX = 2000;
export const SHARE_BOT_TEXT_MAX = 300;
const DAY_START_HOUR = 5;

/** Выключатель BOT_SHARE=off (в .env backend). */
export function botShareEnabled(): boolean {
  return (process.env.BOT_SHARE ?? "on").trim().toLowerCase() !== "off";
}

export const PERIOD_FOR: Record<SharePeriod, string> = { today: "за сегодня", week: "за эту неделю", all: "за всё время" };

// ───────────────────────────── периоды ─────────────────────────────

/** Сутки начинаются в 5 утра по поясу спросившего; неделя — с понедельника 5 утра. */
export function periodStarts(now: Date, zone: string): { today: Date; week: Date } {
  const z = isValidZone(zone) ? zone : "Europe/Moscow";
  const p = zonedParts(now.getTime(), z);
  let day = { y: p.y, m: p.m, d: p.d };
  if (p.h < DAY_START_HOUR) {
    const t = new Date(Date.UTC(p.y, p.m - 1, p.d - 1));
    day = { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
  }
  const today = new Date(zonedToUtc(day.y, day.m, day.d, DAY_START_HOUR, 0, z));
  const wd = new Date(Date.UTC(day.y, day.m - 1, day.d)).getUTCDay(); // 0 — воскресенье
  const back = (wd + 6) % 7; // от понедельника
  const mon = new Date(Date.UTC(day.y, day.m - 1, day.d - back));
  const week = new Date(zonedToUtc(mon.getUTCFullYear(), mon.getUTCMonth() + 1, mon.getUTCDate(), DAY_START_HOUR, 0, z));
  return { today, week };
}

async function askerZone(askerId: string): Promise<string> {
  const z = await getEffectiveTimeZone(askerId);
  return isValidZone(z) ? z : "Europe/Moscow";
}

export interface PeriodEstimate {
  period: SharePeriod;
  from: string | null;
  messages: number;
  botMessages: number;
  chars: number;
  photos: number;
  capped?: boolean;
}

/** Счётчики по трём периодам (сообщения людей, бота, длина текстов, фото) — без текстов. */
export async function estimatePeriods(conversationId: string, zone: string, now: Date = new Date()): Promise<PeriodEstimate[]> {
  const { today, week } = periodStarts(now, zone);
  const rows = await prisma.$queryRaw<
    Array<{ tm: bigint; tb: bigint; tc: bigint; wm: bigint; wb: bigint; wc: bigint; am: bigint; ab: bigint; ac: bigint }>
  >`
    SELECT
      count(*) FILTER (WHERE NOT m."isBot" AND m."createdAt" >= ${today}) AS tm,
      count(*) FILTER (WHERE m."isBot" AND m."createdAt" >= ${today}) AS tb,
      coalesce(sum(length(coalesce(m.content, ''))) FILTER (WHERE m."createdAt" >= ${today}), 0) AS tc,
      count(*) FILTER (WHERE NOT m."isBot" AND m."createdAt" >= ${week}) AS wm,
      count(*) FILTER (WHERE m."isBot" AND m."createdAt" >= ${week}) AS wb,
      coalesce(sum(length(coalesce(m.content, ''))) FILTER (WHERE m."createdAt" >= ${week}), 0) AS wc,
      count(*) FILTER (WHERE NOT m."isBot") AS am,
      count(*) FILTER (WHERE m."isBot") AS ab,
      coalesce(sum(length(coalesce(m.content, ''))), 0) AS ac
    FROM "Message" m
    WHERE m."conversationId" = ${conversationId}
      AND m."deletedAt" IS NULL
      AND (m."expiresAt" IS NULL OR m."expiresAt" > ${now})
      AND m."type" <> 'SYSTEM'
      AND m."createdAt" <= ${now}`;
  const ph = await prisma.$queryRaw<Array<{ t: bigint; w: bigint; a: bigint }>>`
    SELECT
      count(*) FILTER (WHERE m."createdAt" >= ${today}) AS t,
      count(*) FILTER (WHERE m."createdAt" >= ${week}) AS w,
      count(*) AS a
    FROM "MessageAttachment" a
    JOIN "Message" m ON m.id = a."messageId"
    WHERE m."conversationId" = ${conversationId}
      AND a."type" = 'IMAGE'
      AND m."deletedAt" IS NULL
      AND (m."expiresAt" IS NULL OR m."expiresAt" > ${now})
      AND m."createdAt" <= ${now}`;
  const r = rows[0]!;
  const p = ph[0]!;
  const n = (x: bigint | number | null | undefined) => Number(x ?? 0);
  const all: PeriodEstimate = { period: "all", from: null, messages: n(r.am), botMessages: n(r.ab), chars: n(r.ac), photos: n(p.a), capped: false };
  if (all.messages + all.botMessages > SHARE_MAX_MESSAGES) {
    const cut = await prisma.message.findMany({
      where: { conversationId, deletedAt: null, type: { not: "SYSTEM" }, createdAt: { lte: now } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: SHARE_MAX_MESSAGES - 1,
      take: 1,
      select: { createdAt: true },
    });
    if (cut[0]) {
      all.from = cut[0].createdAt.toISOString();
      all.capped = true;
    }
  }
  return [
    { period: "today", from: today.toISOString(), messages: n(r.tm), botMessages: n(r.tb), chars: n(r.tc), photos: n(p.t) },
    { period: "week", from: week.toISOString(), messages: n(r.wm), botMessages: n(r.wb), chars: n(r.wc), photos: n(p.w) },
    all,
  ];
}

// ───────────────────────────── карточка ─────────────────────────────

interface ShareOption {
  period: SharePeriod;
  from: string | null;
  messages: number;
  photos: number;
  photosUsed: number;
  enabled: boolean;
  off: "too_big" | "budget" | null;
  capped: boolean;
}

const STATE: Record<BotShare["status"], string> = {
  PENDING: "pending",
  GRANTED: "granted",
  DECLINED: "declined",
  EXPIRED: "expired",
  REVOKED: "revoked",
  ENDED: "ended",
};

function optionsOf(row: BotShare): ShareOption[] {
  const raw = Array.isArray(row.options) ? (row.options as unknown as ShareOption[]) : [];
  return SHARE_PERIODS.map((p) => raw.find((o) => o && o.period === p)).filter((o): o is ShareOption => !!o);
}

export function buildShareCard(row: BotShare, names: Map<string, string>): CardEnvelope {
  const actions: CardAction[] = [];
  if (row.status === "PENDING") {
    actions.push({ id: "share", who: { ids: [row.askerId] }, until: row.pendingUntil.toISOString() });
    actions.push({ id: "decline", who: { ids: [row.askerId] }, until: row.pendingUntil.toISOString() });
  } else if (row.status === "GRANTED" && row.until) {
    actions.push({ id: "forget", who: { any: true }, until: row.until.toISOString() });
  }
  const who = (id: string | null | undefined) => (id ? { id, displayName: names.get(id) ?? "Участник" } : null);
  const ended = row.status === "DECLINED" || row.status === "EXPIRED" || row.status === "REVOKED" || row.status === "ENDED";
  return {
    v: 1,
    type: "share",
    id: row.id,
    rev: row.rev,
    state: STATE[row.status],
    closed: ended,
    actions,
    data: {
      asker: who(row.askerId),
      suggest: { period: (row.suggestPeriod as SharePeriod | null) ?? "today", photos: row.suggestPhotos },
      options: optionsOf(row).map((o) => ({
        period: o.period,
        messages: o.messages,
        photos: o.photos,
        photosUsed: o.photosUsed,
        enabled: o.enabled,
        off: o.off ?? null,
        capped: o.capped === true,
      })),
      note: row.status === "PENDING" ? row.note ?? null : null,
      choice: row.period && row.decidedAt ? { period: row.period, photos: row.includePhotos, by: who(row.decidedById ?? row.askerId), at: row.decidedAt.toISOString() } : null,
      until: iso(row.until),
      answerMessageId: row.answerMessageIds[0] ?? null,
      read: row.readMessages !== null ? { messages: row.readMessages ?? 0, photos: row.readPhotos ?? 0 } : null,
      endedBy: ended ? { reason: row.endReason ?? STATE[row.status], by: who(row.endedById), at: iso(row.endedAt) } : null,
    },
  };
}

const bold = (s: string) => `**${s.replace(/\*/g, "")}**`;

/** Запасной текст (§6.6): старые клиенты, превью, поиск. Время — МСК. */
export function shareFallbackText(row: BotShare, names: Map<string, string>): string {
  const asker = bold(names.get(row.askerId) ?? "Участник");
  const per = row.period ? PERIOD_FOR[row.period as SharePeriod] ?? "" : "";
  const photos = row.includePhotos ? ", с фото" : "";
  const msk = (d: Date | null) => (d ? `${hmIn(d.getTime(), "Europe/Moscow")} МСК` : "");
  switch (row.status) {
    case "PENDING":
      if (row.note) {
        return `🔒 Переписки выходит слишком много для моего лимита. ${asker}, выбери период поменьше: ответь «сегодня» или «неделя».`;
      }
      return `🔒 Чтобы ответить, мне нужно почитать переписку этой беседы. ${asker}, поделиться?\nОтветь на это сообщение: «сегодня», «неделя» или «всё время» (можно добавить «с фото») — или «не надо».`;
    case "GRANTED":
      return row.answerMessageIds.length
        ? `🔒 ${asker} поделился перепиской ${per}${photos}. Доступ до ${msk(row.until)}.`
        : `🔒 ${asker} поделился перепиской ${per}${photos}. Читаю…`;
    case "ENDED":
      return `🔒 ${asker} делился перепиской ${per}${photos}. Доступ закончился в ${msk(row.endedAt ?? row.until)}.`;
    case "DECLINED":
      return `🔒 ${asker} не стал делиться перепиской.`;
    case "EXPIRED":
      if (row.endReason === "question_deleted") return "🔒 Вопрос удалили — переписку не читаю.";
      if (row.endReason === "replaced") return "🔒 Вопрос сменился — по этой карточке переписку не читаю.";
      if (row.endReason === "asker_left") return `🔒 ${asker} вышел из беседы — переписку не читаю.`;
      return `🔒 ${asker} не ответил — переписку не читаю.`;
    case "REVOKED": {
      if (row.endReason === "asker_left") return `🔒 ${asker} вышел из беседы — переписку забыл.`;
      if (row.endedById && row.endedById !== row.askerId) return `🔒 Переписка забыта · попросил ${bold(names.get(row.endedById) ?? "Участник")}.`;
      return `🔒 ${asker} забрал разрешение.`;
    }
  }
}

// ───────────────────────────── переходы под замком ─────────────────────────────

type Tx = Prisma.TransactionClient;

async function lockShare(tx: Tx, id: string): Promise<BotShare | null> {
  const r = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM "BotShare" WHERE id = ${id} FOR UPDATE`;
  if (!r.length) return null;
  return tx.botShare.findUnique({ where: { id } });
}

async function namesFor(row: BotShare): Promise<Map<string, string>> {
  return displayNames([row.askerId, row.decidedById, row.endedById]);
}

async function applyTx(tx: Tx, row: BotShare, data: Prisma.BotShareUpdateInput): Promise<BotShare> {
  const next = await tx.botShare.update({ where: { id: row.id }, data: { ...data, rev: { increment: 1 } } });
  if (next.cardMessageId) {
    const names = await namesFor(next);
    await writeCardTx(tx, next.cardMessageId, buildShareCard(next, names), shareFallbackText(next, names));
  }
  return next;
}

async function cardOfRow(row: BotShare): Promise<CardEnvelope> {
  return buildShareCard(row, await namesFor(row));
}

const activeKey = (conv: string) => `share:active:${conv}`;
const changesKey = (conv: string) => `share:chg:${conv}`;

/** Флаг «у беседы есть действующее согласие» (для журнала изменений) — по базе, TTL до конца самого долгого окна. */
async function refreshActiveFlag(conversationId: string): Promise<void> {
  try {
    const redis = await getRedisClient();
    const last = await prisma.botShare.findFirst({
      where: { conversationId, status: "GRANTED", until: { gt: new Date() } },
      orderBy: { until: "desc" },
      select: { until: true },
    });
    if (!last?.until) {
      await redis.del(activeKey(conversationId));
      return;
    }
    const ttl = Math.max(1, Math.ceil((last.until.getTime() - Date.now()) / 1000) + 600);
    await redis.set(activeKey(conversationId), "1", { EX: ttl });
  } catch (error) {
    logger.warn({ error, conversationId }, "share: active flag failed");
  }
}

/** Крючок удаления/правки (src/routes/messages.ts): пока у беседы есть согласие — запись в журнал изменений. */
export async function shareNoteChange(conversationId: string, messageId: string, kind: "deleted" | "edited"): Promise<void> {
  try {
    const redis = await getRedisClient();
    if (!(await redis.exists(activeKey(conversationId)))) return;
    const k = changesKey(conversationId);
    await redis.zAdd(k, { score: Date.now(), value: `${kind}:${messageId}` });
    const ttl = await redis.ttl(activeKey(conversationId));
    await redis.expire(k, Math.max(600, ttl > 0 ? ttl : 3600));
  } catch (error) {
    logger.warn({ error, conversationId }, "share: change log failed");
  }
}

async function changesSince(conversationId: string, since: number | null): Promise<{ deleted: string[]; edited: string[] }> {
  const out = { deleted: [] as string[], edited: [] as string[] };
  if (since === null) return out;
  try {
    const redis = await getRedisClient();
    const list = await redis.zRangeByScore(changesKey(conversationId), since - 10_000, "+inf");
    for (const v of list) {
      const [kind, id] = v.split(":");
      if (!id) continue;
      if (kind === "deleted" && !out.deleted.includes(id)) out.deleted.push(id);
      if (kind === "edited" && !out.edited.includes(id)) out.edited.push(id);
    }
  } catch {
    /* без журнала — бот перечитает при следующем вопросе */
  }
  return out;
}

/** После фиксации: событие, флаг, сигнал боту (стереть кэш). */
async function afterEnd(row: BotShare | null, reason: string, signal: boolean): Promise<void> {
  if (!row) return;
  if (row.cardMessageId) await publishCardUpdate(row.cardMessageId);
  await refreshActiveFlag(row.conversationId);
  if (signal) await dispatchBotSignal({ type: "share.ended", shareId: row.id, conversationId: row.conversationId, reason });
  logger.info({ shareId: row.id, status: row.status, reason }, "share: closed");
}

/** Выбор сделан: «Поделиться» (period, photos). Только PENDING; спросивший (права — у вызывающего). */
export async function grantShare(id: string, byId: string, input: { period: SharePeriod; photos: boolean }): Promise<BotShare> {
  const now = new Date();
  const row = await prisma.$transaction(async (tx) => {
    const r = await lockShare(tx, id);
    if (!r) throw new CardError(404, "CARD_NOT_FOUND", "No such card");
    if (r.status !== "PENDING") throw new CardError(409, "CARD_CLOSED", "Already decided", await cardOfRow(r));
    if (r.pendingUntil.getTime() <= now.getTime()) throw new CardError(409, "CARD_ACTION_EXPIRED", "Too late", await cardOfRow(r));
    if (byId !== r.askerId) throw new CardError(403, "CARD_FORBIDDEN", "Only the asker decides", await cardOfRow(r));
    const opt = optionsOf(r).find((o) => o.period === input.period);
    if (!opt || !opt.enabled || opt.messages + opt.photos <= 0) throw new CardError(400, "CARD_BAD_INPUT", "This period is not available", await cardOfRow(r));
    const zone = r.zone;
    // Граница — на момент выбора (живой конец — до конца окна).
    const starts = periodStarts(now, zone);
    const from = input.period === "today" ? starts.today : input.period === "week" ? starts.week : opt.from ? new Date(opt.from) : null;
    return applyTx(tx, r, {
      status: "GRANTED",
      period: input.period,
      includePhotos: input.photos && opt.photos > 0,
      periodFrom: from,
      decidedAt: now,
      decidedById: byId,
      until: new Date(now.getTime() + SHARE_WINDOW_MS),
      note: null,
    });
  });
  if (row.cardMessageId) await publishCardUpdate(row.cardMessageId);
  await refreshActiveFlag(row.conversationId);
  try {
    await enqueueCardsJob({ kind: "share.end", id: row.id, untilMs: row.until!.getTime() }, row.until!.getTime());
  } catch (error) {
    logger.warn({ error, shareId: row.id }, "share: end job failed (sweep will catch up)");
  }
  await dispatchShareResume({
    triggerMessageId: row.triggerMessageId,
    share: { id: row.id, period: row.period as SharePeriod, photos: row.includePhotos, from: iso(row.periodFrom), until: row.until!.toISOString() },
    // id задачи — по ревизии согласия: после «вернуть к выбору» и нового выбора — новая задача, а не повтор старой.
    seq: row.rev,
  });
  logger.info({ shareId: id, period: row.period, photos: row.includePhotos }, "share: granted");
  return row;
}

export async function declineShare(id: string, byId: string): Promise<BotShare> {
  const now = new Date();
  const row = await prisma.$transaction(async (tx) => {
    const r = await lockShare(tx, id);
    if (!r) throw new CardError(404, "CARD_NOT_FOUND", "No such card");
    if (r.status !== "PENDING") throw new CardError(409, "CARD_CLOSED", "Already decided", await cardOfRow(r));
    if (byId !== r.askerId) throw new CardError(403, "CARD_FORBIDDEN", "Only the asker decides", await cardOfRow(r));
    return applyTx(tx, r, { status: "DECLINED", decidedAt: now, decidedById: byId, endedAt: now, endReason: "declined", endedById: byId });
  });
  await afterEnd(row, "declined", false);
  return row;
}

/** «Забыть переписку» (любой участник) / удаление карточки / выход спросившего. */
export async function revokeShare(id: string, byId: string | null, reason: "revoked" | "asker_left" = "revoked"): Promise<BotShare | null> {
  const now = new Date();
  let wasGranted = false;
  const row = await prisma.$transaction(async (tx) => {
    const r = await lockShare(tx, id);
    if (!r) throw new CardError(404, "CARD_NOT_FOUND", "No such card");
    if (r.status !== "PENDING" && r.status !== "GRANTED") throw new CardError(409, "CARD_CLOSED", "Nothing to forget", await cardOfRow(r));
    wasGranted = r.status === "GRANTED";
    if (r.status === "PENDING" && reason === "asker_left") {
      return applyTx(tx, r, { status: "EXPIRED", endedAt: now, endReason: "asker_left", endedById: byId });
    }
    return applyTx(tx, r, { status: "REVOKED", endedAt: now, endReason: reason, endedById: byId });
  });
  await afterEnd(row, reason, wasGranted);
  return row;
}

registerCardType("share", {
  enabled: () => botShareEnabled(),
  async act({ message, card, userId, action, input, now }) {
    const fresh = await prisma.botShare.findUnique({ where: { id: card.id } });
    if (!fresh || fresh.cardMessageId !== message.id) throw new CardError(404, "CARD_NOT_FOUND", "No such card");
    const cur = await cardOfRow(fresh);
    if (action === "share") {
      assertCanAct(cur, "share", userId, now.getTime());
      const i = (input ?? {}) as { period?: unknown; photos?: unknown };
      if (i.period !== "today" && i.period !== "week" && i.period !== "all") throw new CardError(400, "CARD_BAD_INPUT", "period: today | week | all", cur);
      await grantShare(fresh.id, userId, { period: i.period, photos: i.photos === true });
    } else if (action === "decline") {
      assertCanAct(cur, "decline", userId, now.getTime());
      await declineShare(fresh.id, userId);
    } else if (action === "forget") {
      assertCanAct(cur, "forget", userId, now.getTime());
      await revokeShare(fresh.id, userId);
    } else {
      throw new CardError(400, "CARD_BAD_INPUT", "Unknown action", cur);
    }
    return { messageId: message.id, conversationId: message.conversationId };
  },
});

// ───────────────────────────── для бота ─────────────────────────────

/** Согласие, в области которого обращение (вопрос/карточка/ответ по согласию в цепочке, ≤ 12 шагов вверх). */
export async function shareInScope(conversationId: string, triggerMessageId: string, now: Date = new Date()): Promise<BotShare | null> {
  const active = await prisma.botShare.findMany({ where: { conversationId, status: "GRANTED", until: { gt: now } } });
  if (!active.length) return null;
  const byTrigger = new Map(active.map((s) => [s.triggerMessageId, s]));
  const byCard = new Map(active.filter((s) => s.cardMessageId).map((s) => [s.cardMessageId!, s]));
  const byId = new Map(active.map((s) => [s.id, s]));
  let id: string | null = triggerMessageId;
  const seen = new Set<string>();
  for (let i = 0; id && i < 12 && !seen.has(id); i++) {
    seen.add(id);
    const hit = byTrigger.get(id) ?? byCard.get(id);
    if (hit) return hit;
    const m: { id: string; conversationId: string; replyToId: string | null; isBot: boolean; metadata: unknown; deletedAt: Date | null } | null =
      await prisma.message.findUnique({ where: { id }, select: { id: true, conversationId: true, replyToId: true, isBot: true, metadata: true, deletedAt: true } });
    if (!m || m.conversationId !== conversationId) return null;
    if (m.isBot) {
      const sid = (m.metadata as { bot?: { shareId?: unknown } } | null)?.bot?.shareId;
      if (typeof sid === "string" && byId.has(sid)) return byId.get(sid)!;
    }
    id = m.replyToId ?? (m.isBot ? botTriggerOf(m.metadata) : null);
  }
  return null;
}

export interface ShareEstimate {
  conversationKind: "dm" | "group";
  zone: string;
  periods: PeriodEstimate[];
  active: { shareId: string; period: string | null; photos: boolean; until: string | null } | null;
  declinedAt: string | null;
}

export async function shareEstimate(g: { conversationId: string; triggerMessageId: string; authorId: string; kind: "dm" | "group" }): Promise<ShareEstimate> {
  const now = new Date();
  const zone = await askerZone(g.authorId);
  const periods = await estimatePeriods(g.conversationId, zone, now);
  const act = await shareInScope(g.conversationId, g.triggerMessageId, now);
  const declined = await prisma.botShare.findFirst({
    where: { conversationId: g.conversationId, askerId: g.authorId, status: "DECLINED", decidedAt: { gt: new Date(now.getTime() - SHARE_DECLINE_QUIET_MS) } },
    orderBy: { decidedAt: "desc" },
    select: { decidedAt: true },
  });
  return {
    conversationKind: g.kind,
    zone,
    periods,
    active: act ? { shareId: act.id, period: act.period, photos: act.includePhotos, until: iso(act.until) } : null,
    declinedAt: declined?.decidedAt ? declined.decidedAt.toISOString() : null,
  };
}

export type ShareRequestError = { status: number; code: string; message: string; [k: string]: unknown };

/** Поставить карточку согласия (или сразу «можно читать», если вопрос в области действующего согласия). */
export async function requestShare(o: {
  conversationId: string;
  triggerMessageId: string;
  askerId: string;
  suggest: { period: SharePeriod; photos: boolean };
  options: Partial<Record<SharePeriod, { enabled: boolean; off?: "too_big" | "budget" | null | undefined } | undefined>>;
}): Promise<{ ok: true; granted: BotShare } | { ok: true; created: BotShare } | { ok: false; error: ShareRequestError }> {
  const now = new Date();
  const bot = await getSystemBot();
  if (!bot) return { ok: false, error: { status: 404, code: "SHARE_DISABLED", message: "Bot is not configured" } };
  const inScope = await shareInScope(o.conversationId, o.triggerMessageId, now);
  if (inScope) return { ok: true, granted: inScope };
  const declined = await prisma.botShare.findFirst({
    where: { conversationId: o.conversationId, askerId: o.askerId, status: "DECLINED", decidedAt: { gt: new Date(now.getTime() - SHARE_DECLINE_QUIET_MS) } },
    select: { decidedAt: true },
  });
  if (declined) return { ok: false, error: { status: 409, code: "SHARE_DECLINED_RECENTLY", message: "Declined recently", at: declined.decidedAt?.toISOString() ?? null } };
  const zone = await askerZone(o.askerId);
  const periods = await estimatePeriods(o.conversationId, zone, now);
  if (periods.every((p) => p.messages + p.photos === 0)) return { ok: false, error: { status: 409, code: "SHARE_EMPTY", message: "Nothing to read" } };
  const options: ShareOption[] = periods.map((p) => {
    const b = o.options[p.period];
    const enabled = (b?.enabled ?? true) && p.messages + p.photos > 0;
    return {
      period: p.period,
      from: p.from,
      messages: p.messages,
      photos: p.photos,
      photosUsed: Math.min(p.photos, SHARE_MAX_PHOTOS),
      enabled,
      off: !enabled && b?.off ? b.off : null,
      capped: p.capped === true,
    };
  });
  if (!options.some((x) => x.enabled)) return { ok: false, error: { status: 409, code: "SHARE_TOO_BIG", message: "Every period is off" } };

  const res = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`share:${o.conversationId}`}))`;
    // Новая карточка того же спросившего заменяет его прежнюю ожидающую («вопрос сменился»).
    const mine = await tx.botShare.findMany({ where: { conversationId: o.conversationId, askerId: o.askerId, status: "PENDING" } });
    const others = await tx.botShare.count({ where: { conversationId: o.conversationId, status: "PENDING", askerId: { not: o.askerId } } });
    if (others >= SHARE_MAX_PENDING_PER_CONVERSATION) return { error: { status: 429, code: "SHARE_LIMIT", message: "Too many pending cards", scope: "conversation" } };
    const day = await tx.botShare.count({ where: { askerId: o.askerId, createdAt: { gt: new Date(now.getTime() - 86_400_000) } } });
    if (day >= SHARE_MAX_PER_ASKER_DAY) return { error: { status: 429, code: "SHARE_LIMIT", message: "Too many cards today", scope: "asker" } };
    const replaced: BotShare[] = [];
    for (const old of mine) replaced.push(await applyTx(tx, old, { status: "EXPIRED", endedAt: now, endReason: "replaced" }));
    const suggest = options.find((x) => x.period === o.suggest.period && x.enabled) ? o.suggest.period : options.find((x) => x.enabled)!.period;
    const row0 = await tx.botShare.create({
      data: {
        conversationId: o.conversationId,
        triggerMessageId: o.triggerMessageId,
        askerId: o.askerId,
        zone,
        options: options as unknown as Prisma.InputJsonValue,
        suggestPeriod: suggest,
        suggestPhotos: o.suggest.photos === true,
        pendingUntil: new Date(now.getTime() + SHARE_PENDING_MS),
      },
    });
    const names = await namesFor(row0);
    const content = shareFallbackText(row0, names);
    const msg = await insertCardMessage(tx, {
      botId: bot.id,
      conversationId: o.conversationId,
      replyToId: o.triggerMessageId,
      triggerMessageId: o.triggerMessageId,
      askerId: o.askerId,
      card: buildShareCard(row0, names),
      content,
    });
    const row = await tx.botShare.update({ where: { id: row0.id }, data: { cardMessageId: msg.id } });
    return { row, msg, content, replaced };
  });
  if ("error" in res) return { ok: false, error: res.error as ShareRequestError };
  for (const r of res.replaced) if (r.cardMessageId) await publishCardUpdate(r.cardMessageId);
  // Пуш — только спросившему: остальным сообщение приходит без звонка.
  await announceCardMessage({ conversationId: o.conversationId, botId: bot.id, message: res.msg, content: res.content, pushTo: [o.askerId] });
  try {
    await enqueueCardsJob({ kind: "share.pending", id: res.row.id }, res.row.pendingUntil.getTime());
  } catch (error) {
    logger.warn({ error, shareId: res.row.id }, "share: pending job failed (sweep will catch up)");
  }
  logger.info({ shareId: res.row.id, conversationId: o.conversationId, suggest: res.row.suggestPeriod }, "share: asked");
  return { ok: true, created: res.row };
}

/** Бот: выбранный период оказался неподъёмным — вернуть карточку к выбору с погашенным вариантом (≤ 2 мин, без ответа). */
export async function reopenShare(id: string, off: { period: SharePeriod; reason: "too_big" | "budget" }): Promise<BotShare> {
  const now = new Date();
  const row = await prisma.$transaction(async (tx) => {
    const r = await lockShare(tx, id);
    if (!r) throw new CardError(404, "SHARE_NOT_FOUND", "No such share");
    if (r.status !== "GRANTED" || !r.decidedAt || now.getTime() - r.decidedAt.getTime() > SHARE_REOPEN_MS || r.answers > 0) {
      throw new CardError(409, "SHARE_REOPEN_EXPIRED", "Too late to reopen");
    }
    const options = optionsOf(r).map((o) => (o.period === off.period ? { ...o, enabled: false, off: off.reason } : o));
    return applyTx(tx, r, {
      status: "PENDING",
      options: options as unknown as Prisma.InputJsonValue,
      note: off.reason,
      period: null,
      includePhotos: false,
      periodFrom: null,
      decidedAt: null,
      decidedById: null,
      until: null,
      pendingUntil: new Date(now.getTime() + SHARE_PENDING_MS),
    });
  });
  await afterEnd(row, "reopened", true);
  try {
    await enqueueCardsJob({ kind: "share.pending", id: row.id }, row.pendingUntil.getTime());
  } catch {
    /* sweep */
  }
  return row;
}

/** Ответ по согласию опубликован: пометить сообщения бота (metadata.bot.shareId) и карточку («ответ ниже»). */
export async function shareAnswered(o: { share: BotShare; messageIds: string[]; triggerMessageId: string; read: { messages: number; photos: number }; usd?: number | null }): Promise<BotShare> {
  const ids = o.messageIds.slice(0, 12);
  const msgs = await prisma.message.findMany({ where: { id: { in: ids }, conversationId: o.share.conversationId, isBot: true, deletedAt: null }, select: { id: true, metadata: true } });
  const ok = msgs.filter((m) => botTriggerOf(m.metadata) === o.triggerMessageId);
  const row = await prisma.$transaction(async (tx) => {
    const r = await lockShare(tx, o.share.id);
    if (!r) throw new CardError(404, "SHARE_NOT_FOUND", "No such share");
    for (const m of ok) {
      const meta = (m.metadata && typeof m.metadata === "object" ? { ...(m.metadata as Record<string, unknown>) } : {}) as Record<string, unknown>;
      meta.bot = { ...((meta.bot as Record<string, unknown>) ?? {}), shareId: r.id };
      await tx.message.update({ where: { id: m.id }, data: { metadata: meta as Prisma.InputJsonValue } });
    }
    const first = ok.map((m) => m.id).filter((id) => !r.answerMessageIds.includes(id));
    return applyTx(tx, r, {
      answerMessageIds: [...r.answerMessageIds, ...first.slice(0, 1)],
      answers: { increment: 1 },
      readMessages: Math.max(r.readMessages ?? 0, o.read.messages),
      readPhotos: Math.max(r.readPhotos ?? 0, o.read.photos),
      ...(typeof o.usd === "number" && Number.isFinite(o.usd) ? { usd: new Prisma.Decimal(((Number(r.usd ?? 0) || 0) + o.usd).toFixed(4)) } : {}),
    });
  });
  if (row.cardMessageId) await publishCardUpdate(row.cardMessageId);
  return row;
}

/** «Еблуша, забудь переписку»: все ожидающие и действующие согласия беседы. */
export async function revokeAllShares(conversationId: string, byId: string): Promise<number> {
  const rows = await prisma.botShare.findMany({ where: { conversationId, status: { in: ["PENDING", "GRANTED"] } }, select: { id: true } });
  let n = 0;
  for (const r of rows) {
    const x = await revokeShare(r.id, byId).catch(() => null);
    if (x) n++;
  }
  return n;
}

// ───────────────────────────── страницы переписки ─────────────────────────────

export interface ShareMessage {
  id: string;
  at: string;
  senderId: string;
  senderName: string | null;
  isBot: boolean;
  kind: "text" | "photo" | "video" | "voice" | "file" | "call";
  text: string | null;
  replyTo: { id: string; senderName: string | null; text: string | null } | null;
  edited: boolean;
  forwarded: boolean;
  reactions: Array<{ emoji: string; names: string[] }>;
  photos?: Array<{ url: string; w: number | null; h: number | null }>;
  meta: { durationSec?: number; fileName?: string; size?: number } | null;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…(обрезано)` : s);

function metaObj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** Страница переписки по согласию (только эта беседа; без удалённых, истёкших и SYSTEM). */
export async function shareMessagesPage(o: {
  share: BotShare;
  after: { at: Date; id: string } | null;
  limit: number;
  ids?: string[];
  now?: Date;
}): Promise<{ messages: ShareMessage[]; next: { at: string; id: string } | null }> {
  const now = o.now ?? new Date();
  const s = o.share;
  const upper = s.until && s.until < now ? s.until : now;
  const and: Prisma.MessageWhereInput[] = [{ OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] }];
  if (s.periodFrom) and.push({ createdAt: { gte: s.periodFrom } });
  if (o.after) and.push({ OR: [{ createdAt: { gt: o.after.at } }, { createdAt: o.after.at, id: { gt: o.after.id } }] });
  if (o.ids?.length) and.push({ id: { in: o.ids.slice(0, 100) } });
  const rows = await prisma.message.findMany({
    where: { conversationId: s.conversationId, deletedAt: null, type: { not: "SYSTEM" }, createdAt: { lte: upper }, AND: and },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: o.ids?.length ? 100 : o.limit + 1,
    include: {
      sender: { select: { displayName: true, username: true } },
      attachments: true,
      reactions: { include: { user: { select: { displayName: true, username: true } } } },
      replyTo: { select: { id: true, content: true, contentEncV: true, deletedAt: true, sender: { select: { displayName: true } } } },
    },
  });
  const more = !o.ids?.length && rows.length > o.limit;
  const page = more ? rows.slice(0, o.limit) : rows;
  // Фото — только с галкой и только самые новые SHARE_MAX_PHOTOS за период.
  let allowed = new Set<string>();
  if (s.includePhotos) {
    const att = await prisma.messageAttachment.findMany({
      where: {
        type: "IMAGE",
        message: { conversationId: s.conversationId, deletedAt: null, createdAt: { lte: upper, ...(s.periodFrom ? { gte: s.periodFrom } : {}) } },
      },
      orderBy: { createdAt: "desc" },
      take: SHARE_MAX_PHOTOS,
      select: { id: true },
    });
    allowed = new Set(att.map((a) => a.id));
  }
  let dek: Buffer | null | undefined;
  const text = async (content: string | null, encV: number): Promise<string | null> => {
    if (content === null) return null;
    if (encV === 0) return content;
    try {
      if (dek === undefined) dek = await getNonSecretConversationDek(s.conversationId).catch(() => null);
      if (!dek) return "[не удалось прочитать]";
      return decryptNonSecretChatText(content, dek, s.conversationId);
    } catch {
      return "[не удалось прочитать]";
    }
  };
  const out: ShareMessage[] = [];
  for (const m of page) {
    const md = metaObj(m.metadata);
    const atts = m.attachments ?? [];
    const kind: ShareMessage["kind"] =
      m.type === "IMAGE" || atts.some((a) => a.type === "IMAGE")
        ? "photo"
        : m.type === "VIDEO" || atts.some((a) => a.type === "VIDEO")
          ? "video"
          : m.type === "AUDIO" || atts.some((a) => a.type === "AUDIO")
            ? "voice"
            : m.type === "FILE" || atts.some((a) => a.type === "FILE")
              ? "file"
              : m.type === "CALL"
                ? "call"
                : "text";
    let body = await text(m.content, m.contentEncV);
    if (m.isBot && body) {
      const isCard = metaObj(md.bot).kind === "card";
      body = isCard ? body.split("\n")[0]!.slice(0, SHARE_BOT_TEXT_MAX) : clip(body, SHARE_BOT_TEXT_MAX);
    } else if (body) body = clip(body, SHARE_TEXT_MAX);
    const reacts = new Map<string, string[]>();
    for (const r of m.reactions ?? []) {
      const list = reacts.get(r.emoji) ?? [];
      list.push((r.user?.displayName ?? "").trim() || r.user?.username || "Участник");
      reacts.set(r.emoji, list);
    }
    const first = atts.find((a) => a.type !== "IMAGE") ?? null;
    const am = metaObj(first?.metadata);
    const dur = typeof am.duration === "number" ? am.duration : typeof am.durationMs === "number" ? am.durationMs / 1000 : undefined;
    const photos = s.includePhotos
      ? atts
          .filter((a) => a.type === "IMAGE" && allowed.has(a.id))
          .map((a) => {
            const x = metaObj(a.metadata);
            return { url: a.url, w: typeof x.width === "number" ? x.width : null, h: typeof x.height === "number" ? x.height : null };
          })
      : [];
    const rt = m.replyTo && !m.replyTo.deletedAt ? m.replyTo : null;
    out.push({
      id: m.id,
      at: m.createdAt.toISOString(),
      senderId: m.senderId,
      senderName: m.sender?.displayName ?? m.sender?.username ?? null,
      isBot: m.isBot,
      kind,
      text: body,
      replyTo: rt ? { id: rt.id, senderName: rt.sender?.displayName ?? null, text: ((await text(rt.content, rt.contentEncV)) ?? "").slice(0, 80) || null } : null,
      edited: typeof md.editedAt === "string",
      forwarded: !!md.forwardFrom,
      reactions: [...reacts.entries()].map(([emoji, names]) => ({ emoji, names: names.slice(0, 10) })),
      ...(photos.length ? { photos } : {}),
      meta:
        first && (dur !== undefined || am.originalName || first.size)
          ? {
              ...(dur !== undefined ? { durationSec: Math.round(dur) } : {}),
              ...(typeof am.originalName === "string" ? { fileName: am.originalName.slice(0, 120) } : {}),
              ...(typeof first.size === "number" ? { size: first.size } : {}),
            }
          : null,
    });
  }
  const last = page[page.length - 1];
  return { messages: out, next: more && last ? { at: last.createdAt.toISOString(), id: last.id } : null };
}

export async function shareChanges(conversationId: string, since: number | null) {
  return changesSince(conversationId, since);
}

// ───────────────────────────── очередь и крючки ─────────────────────────────

/** 30 мин без выбора — «не ответил». */
export async function processSharePending(id: string, force = false): Promise<boolean> {
  const now = new Date();
  const row = await prisma.$transaction(async (tx) => {
    const r = await lockShare(tx, id);
    if (!r || r.status !== "PENDING") return null;
    if (!force && r.pendingUntil.getTime() > now.getTime() + 1000 && process.env.NODE_ENV !== "test") return null;
    return applyTx(tx, r, { status: "EXPIRED", endedAt: now, endReason: "expired" });
  });
  await afterEnd(row, "expired", false);
  return !!row;
}

/** Окно закончилось — «доступ закончился», сигнал боту стереть кэш. */
export async function processShareEnd(id: string, untilMs: number | null, force = false): Promise<boolean> {
  const now = new Date();
  const row = await prisma.$transaction(async (tx) => {
    const r = await lockShare(tx, id);
    if (!r || r.status !== "GRANTED" || !r.until) return null;
    if (untilMs !== null && r.until.getTime() !== untilMs) return null;
    if (!force && r.until.getTime() > now.getTime() + 1000 && process.env.NODE_ENV !== "test") return null;
    return applyTx(tx, r, { status: "ENDED", endedAt: r.until.getTime() < now.getTime() ? r.until : now, endReason: "ended" });
  });
  await afterEnd(row, "ended", true);
  return !!row;
}

export async function sweepShares(now: Date = new Date()): Promise<{ expired: number; ended: number }> {
  let expired = 0;
  let ended = 0;
  const pend = await prisma.botShare.findMany({ where: { status: "PENDING", pendingUntil: { lte: now } }, select: { id: true }, take: 200 });
  for (const p of pend) if (await processSharePending(p.id, true).catch(() => false)) expired++;
  const gr = await prisma.botShare.findMany({ where: { status: "GRANTED", until: { lte: now } }, select: { id: true }, take: 200 });
  for (const g of gr) if (await processShareEnd(g.id, null, true).catch(() => false)) ended++;
  return { expired, ended };
}

/** Крючок удаления: вопрос при ожидании → «вопрос удалили»; карточка → забыто тем, кто удалил. Не бросает. */
export async function shareOnMessageDeleted(msg: { id: string; conversationId: string; isBot: boolean }, byUserId: string): Promise<void> {
  try {
    await shareNoteChange(msg.conversationId, msg.id, "deleted");
    if (msg.isBot) {
      const s = await prisma.botShare.findUnique({ where: { cardMessageId: msg.id } });
      if (s && (s.status === "PENDING" || s.status === "GRANTED")) {
        const now = new Date();
        const wasGranted = s.status === "GRANTED";
        const row = await prisma.$transaction(async (tx) => {
          const r = await lockShare(tx, s.id);
          if (!r || (r.status !== "PENDING" && r.status !== "GRANTED")) return null;
          return tx.botShare.update({ where: { id: r.id }, data: { status: "REVOKED", endedAt: now, endReason: "revoked", endedById: byUserId, rev: { increment: 1 } } });
        });
        await refreshActiveFlag(msg.conversationId);
        if (row && wasGranted) await dispatchBotSignal({ type: "share.ended", shareId: row.id, conversationId: row.conversationId, reason: "card_deleted" });
      }
      return;
    }
    const pend = await prisma.botShare.findMany({ where: { triggerMessageId: msg.id, status: "PENDING" }, select: { id: true } });
    for (const p of pend) {
      const now = new Date();
      const row = await prisma.$transaction(async (tx) => {
        const r = await lockShare(tx, p.id);
        if (!r || r.status !== "PENDING") return null;
        return applyTx(tx, r, { status: "EXPIRED", endedAt: now, endReason: "question_deleted" });
      });
      await afterEnd(row, "question_deleted", false);
    }
  } catch (error) {
    logger.warn({ error, messageId: msg.id }, "share: delete hook failed");
  }
}

/** Спросивший вышел из беседы: ожидание → истекло, доступ → отозван. Не бросает. */
export async function shareOnParticipantLeft(conversationId: string, userId: string): Promise<void> {
  try {
    const rows = await prisma.botShare.findMany({ where: { conversationId, askerId: userId, status: { in: ["PENDING", "GRANTED"] } }, select: { id: true } });
    for (const r of rows) await revokeShare(r.id, userId, "asker_left").catch(() => undefined);
  } catch (error) {
    logger.warn({ error, conversationId }, "share: leave hook failed");
  }
}
