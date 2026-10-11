/**
 * Таймер обещания «Еблуша, проконтролируй» (решение владельца 2026-10-11; docs/promise-timer.md, docs/bot-cards.md).
 *
 * Таймером владеет СЕРВЕР: строка PromiseTimer + карточка (сообщение бота, metadata.card type "promise"). Бот
 * только понимает слова и зовёт /api/bot/promises* (src/routes/botCards.ts). Переходы — под замком строки
 * (SELECT … FOR UPDATE), каждый — rev + 1, новая версия карточки и запасного текста в той же транзакции, после
 * фиксации — message:update {reason:"card"}. Секунды тикают на клиентах — сервер раз в секунду ничего не шлёт.
 *
 *   RUNNING ──«Пришёл»/звонок/Valheim/фраза──► ARRIVED (2 мин «Вернуть» — только ручные отметки)
 *   RUNNING ──«Отменить» (кто попросил, владелец бота)──► CANCELLED (2 мин «Вернуть»)
 *   RUNNING ──срок + 6 ч, никто не отметил──► UNRESOLVED
 *   RUNNING ──«ещё 10 минут» обещавшего──► RUNNING (новый срок, продлевал N раз)
 *
 * Напоминания (в срок, +15, +30; ≤ 5 на таймер) пишет сервер от имени бота — отложенные задачи BullMQ `cards`
 * (src/jobs/workers/cards.worker.ts), переживают перезапуск; sweep раз в 5 мин догоняет потерянное.
 */
import crypto from "node:crypto";
import { Prisma, type PromiseTimer } from "@prisma/client";
import env from "../config/env";
import logger from "../config/logger";
import prisma from "./prisma";
import { getRedisClient } from "./redis";
import { getEffectiveTimeZone, getShareState } from "./localTime";
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
import {
  isValidZone,
  parsePromiseText,
  resolveDeadline,
  type PromiseSpec,
  type ResolvedDeadline,
} from "./promiseTime";
import { promiseFallbackText, reminderText } from "./promiseTexts";
import { createBotMessage, getSystemBot } from "./systemBot";
import { enqueueCardsJob, removeCardsJob } from "../jobs/queue";
import { isUserInConversationCall, registerCallJoinListener } from "../realtime/socket";

// ───────────────────────────── пределы ─────────────────────────────

export const PROMISE_REOPEN_MS = 120_000;
export const PROMISE_AUTOCLOSE_MS = 6 * 3600_000;
export const PROMISE_REMINDER_OFFSETS = [0, 15, 30] as const;
export const PROMISE_MAX_REMINDERS = 5;
export const PROMISE_MAX_RUNNING_PER_CONVERSATION = 3;
export const PROMISE_MAX_PER_REQUESTER_DAY = 10;
export const PROMISE_MAX_EXTENSIONS = 10;
export const PROMISE_CORRECT_MS = 5 * 60_000;
/** Кандидаты «без ответа» — сообщения других участников за этот срок до обращения. */
export const PROMISE_CANDIDATES_WINDOW_MS = 60 * 60_000;
export const PROMISE_CANDIDATES_MAX = 5;
/** Опоздание напоминания, при котором sweep его ещё догоняет. */
export const PROMISE_SWEEP_CATCHUP_MS = 5 * 60_000;
const QUOTE_MAX = 200;

/** Выключатель PROMISE_TIMERS=off (в .env backend): новые таймеры и напоминания — нет, закрыть идущие — можно. */
export function promiseTimersEnabled(): boolean {
  return (process.env.PROMISE_TIMERS ?? "on").trim().toLowerCase() !== "off";
}

const ownerId = (): string | null => env.BOT_OWNER_USER_ID ?? null;

// ───────────────────────────── карточка ─────────────────────────────

type Tx = Prisma.TransactionClient;
type Db = Tx | typeof prisma;

const STATE: Record<PromiseTimer["status"], string> = { RUNNING: "running", ARRIVED: "arrived", CANCELLED: "cancelled", UNRESOLVED: "unresolved" };

/** Пояс обещавшего для «по местному 21:00» — только если он сам показывает местное время. */
async function promiserZoneFor(userId: string): Promise<string | null> {
  try {
    const share = await getShareState(userId);
    if (!share.shareLocalTime) return null;
    return await getEffectiveTimeZone(userId);
  } catch {
    return null;
  }
}

interface People {
  names: Map<string, string>;
  avatar: string | null;
  promiserZone: string | null;
}

async function peopleFor(db: Db, row: PromiseTimer): Promise<People> {
  const ids = [row.promiserId, row.requesterId, row.quoteById, row.arrivedById, row.cancelledById];
  const names = await displayNames(ids);
  const u = await db.user.findUnique({ where: { id: row.promiserId }, select: { avatarUrl: true } });
  return { names, avatar: u?.avatarUrl ?? null, promiserZone: await promiserZoneFor(row.promiserId) };
}

const person = (p: People, id: string | null | undefined) => (id ? { id, displayName: p.names.get(id) ?? "Участник" } : null);

/** Конверт карточки по строке (docs/promise-timer.md «Данные карточки»). */
export function buildPromiseCard(row: PromiseTimer, p: People, now: Date = new Date()): CardEnvelope {
  const state = STATE[row.status];
  const actions: CardAction[] = [];
  if (row.status === "RUNNING") {
    actions.push({ id: "arrived", who: { any: true }, until: null });
    actions.push({ id: "cancel", who: { ids: [...row.cancelAllowedIds] }, until: null });
  } else if (row.reopenUntil && row.reopenUntil.getTime() > now.getTime() - 1000) {
    actions.push({ id: "reopen", who: { ids: [...row.reopenBy] }, until: row.reopenUntil.toISOString() });
  }
  const extensions = (Array.isArray(row.extensions) ? row.extensions : []) as Array<Record<string, unknown>>;
  const outcome =
    row.status === "ARRIVED" && row.arrivedAt
      ? {
          kind: (row.lateSec ?? 0) > 0 ? "late" : "onTime",
          arrivedAt: row.arrivedAt.toISOString(),
          deltaSec: row.lateSec ?? 0,
          deltaVsOriginalSec: row.lateVsOriginalSec ?? row.lateSec ?? 0,
          via: row.arrivedVia ?? "button",
          by: row.arrivedVia === "button" || row.arrivedVia === "phrase" ? person(p, row.arrivedById) : null,
          detail: null,
        }
      : null;
  return {
    v: 1,
    type: "promise",
    id: row.id,
    rev: row.rev,
    state,
    closed: row.status !== "RUNNING",
    actions,
    data: {
      promiser: { id: row.promiserId, displayName: p.names.get(row.promiserId) ?? "Участник", avatarUrl: p.avatar },
      requester: person(p, row.requesterId),
      quote: {
        messageId: row.promiseMessageId,
        text: row.quote,
        at: iso(row.quoteAt) ?? row.startAt.toISOString(),
        by: row.quoteById ? person(p, row.quoteById) : null,
        deleted: row.quote === null,
      },
      label: row.label,
      upperBound: row.upperBound,
      startAt: row.startAt.toISOString(),
      deadlineAt: row.deadlineAt.toISOString(),
      originalDeadlineAt: row.originalDeadlineAt.toISOString(),
      extensions: extensions.map((e) => ({ at: e.at ?? null, from: e.from ?? null, to: e.to ?? null, label: e.label ?? null })),
      extensionCount: row.extensionCount,
      promiserZone: p.promiserZone,
      cancelBy: [...row.cancelAllowedIds],
      closedAt: iso(row.closedAt),
      outcome,
      cancelledBy: row.status === "CANCELLED" ? person(p, row.cancelledById) : null,
      reopen: row.status !== "RUNNING" && row.reopenUntil ? { until: row.reopenUntil.toISOString(), by: [...row.reopenBy] } : null,
      reminders: [...row.remindersSent],
    },
  };
}

function fallbackOf(row: PromiseTimer, p: People, now: Date): string {
  return promiseFallbackText({
    status: row.status,
    promiserName: p.names.get(row.promiserId) ?? "Участник",
    quote: row.quote,
    deadlineAt: row.deadlineAt,
    extensionCount: row.extensionCount,
    arrivedAt: row.arrivedAt,
    lateSec: row.lateSec,
    now,
  });
}

/** Обновить строку (rev + 1) и записать новую версию карточки в той же транзакции. */
async function applyTx(tx: Tx, row: PromiseTimer, data: Prisma.PromiseTimerUpdateInput, now: Date): Promise<PromiseTimer> {
  const next = await tx.promiseTimer.update({ where: { id: row.id }, data: { ...data, rev: { increment: 1 } } });
  if (next.cardMessageId) {
    const p = await peopleFor(tx, next);
    await writeCardTx(tx, next.cardMessageId, buildPromiseCard(next, p, now), fallbackOf(next, p, now));
  }
  return next;
}

/** Замок строки таймера на время транзакции. null — строки нет. */
async function lockTimer(tx: Tx, id: string): Promise<PromiseTimer | null> {
  const r = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM "PromiseTimer" WHERE id = ${id} FOR UPDATE`;
  if (!r.length) return null;
  return tx.promiseTimer.findUnique({ where: { id } });
}

/** После фиксации: событие карточки. */
async function published(row: PromiseTimer | null): Promise<void> {
  if (row?.cardMessageId) await publishCardUpdate(row.cardMessageId);
}

// ───────────────────────────── задачи очереди ─────────────────────────────

/** Поставить напоминания и авто-закрытие по текущему сроку (идемпотентно: jobId от срока). Не бросает. */
export async function schedulePromiseJobs(row: Pick<PromiseTimer, "id" | "deadlineAt" | "remindersSent" | "createdLate" | "status">): Promise<void> {
  if (row.status !== "RUNNING") return;
  const d = row.deadlineAt.getTime();
  try {
    for (const offset of PROMISE_REMINDER_OFFSETS) {
      if (row.remindersSent.includes(offset)) continue;
      await enqueueCardsJob({ kind: "promise.remind", id: row.id, deadlineMs: d, offset }, d + offset * 60_000);
    }
    await enqueueCardsJob({ kind: "promise.autoclose", id: row.id, deadlineMs: d }, d + PROMISE_AUTOCLOSE_MS);
  } catch (error) {
    logger.warn({ error, promiseId: row.id }, "promise: schedule failed (sweep will catch up)");
  }
}

/** Снять задачи старого срока (продление, поправка, закрытие). Не бросает. */
async function unschedule(id: string, deadlineMs: number): Promise<void> {
  for (const offset of PROMISE_REMINDER_OFFSETS) await removeCardsJob({ kind: "promise.remind", id, deadlineMs, offset });
  await removeCardsJob({ kind: "promise.autoclose", id, deadlineMs });
}

// ───────────────────────────── создание ─────────────────────────────

export type PromiseCreateError =
  | { status: 400; code: "PROMISE_BAD"; message: string }
  | { status: 403; code: "PROMISE_NOT_PARTICIPANT"; message: string }
  | { status: 409; code: "PROMISE_NO_TIME" | "PROMISE_TOO_FAR"; message: string }
  | { status: 409; code: "PROMISE_AMBIGUOUS"; message: string; deadlineAt: string; alt: string | null; label: string | null }
  | { status: 409; code: "PROMISE_PAST"; message: string; deadlineAt: string | null }
  | { status: 409; code: "PROMISE_EXISTS"; message: string; promise: PromiseSummary }
  | { status: 409; code: "PROMISE_ALREADY_HERE"; message: string; where: "call" }
  | { status: 409; code: "PROMISE_LIMIT"; message: string; scope: "conversation" | "requester" };

export interface PromiseSummary {
  id: string;
  conversationId: string;
  promiserId: string;
  promiserName: string | null;
  requesterId: string;
  cardMessageId: string | null;
  status: string;
  label: string;
  upperBound: boolean;
  startAt: string;
  deadlineAt: string;
  originalDeadlineAt: string;
  extensionCount: number;
  zone: string;
  zoneSource: string;
  parseSource: string;
}

export async function summaryOf(row: PromiseTimer, names?: Map<string, string>): Promise<PromiseSummary> {
  const n = names ?? (await displayNames([row.promiserId]));
  return {
    id: row.id,
    conversationId: row.conversationId,
    promiserId: row.promiserId,
    promiserName: n.get(row.promiserId) ?? null,
    requesterId: row.requesterId,
    cardMessageId: row.cardMessageId,
    status: STATE[row.status],
    label: row.label,
    upperBound: row.upperBound,
    startAt: row.startAt.toISOString(),
    deadlineAt: row.deadlineAt.toISOString(),
    originalDeadlineAt: row.originalDeadlineAt.toISOString(),
    extensionCount: row.extensionCount,
    zone: row.zone,
    zoneSource: row.zoneSource,
    parseSource: row.parseSource,
  };
}

/** Пояс, по которому понимаем слова: из текста > обещавшего > спросившего > МСК. */
async function zoneForWords(promiserId: string, requesterId: string): Promise<{ zone: string; source: "promiser" | "requester" | "default" }> {
  const pz = await getEffectiveTimeZone(promiserId);
  if (isValidZone(pz)) return { zone: pz, source: "promiser" };
  const rz = await getEffectiveTimeZone(requesterId);
  if (isValidZone(rz)) return { zone: rz, source: "requester" };
  return { zone: "Europe/Moscow", source: "default" };
}

function deadlineError(r: Extract<ResolvedDeadline, { ok: false }>): PromiseCreateError {
  switch (r.code) {
    case "AMBIGUOUS":
      return {
        status: 409,
        code: "PROMISE_AMBIGUOUS",
        message: "The time is ambiguous",
        deadlineAt: r.deadlineAt!.toISOString(),
        alt: r.alt ? r.alt.toISOString() : null,
        label: r.label ?? null,
      };
    case "PAST":
      return { status: 409, code: "PROMISE_PAST", message: "That time has long passed", deadlineAt: r.deadlineAt ? r.deadlineAt.toISOString() : null };
    case "TOO_FAR":
      return { status: 409, code: "PROMISE_TOO_FAR", message: "Too far ahead" };
    default:
      return { status: 409, code: "PROMISE_NO_TIME", message: "No time in the promise" };
  }
}

export interface CreatePromiseInput {
  conversationId: string;
  triggerMessageId: string;
  requesterId: string;
  promiserId: string;
  promiseMessageId?: string | null;
  text?: string | null;
  spec?: PromiseSpec | null;
  cancelAllowedIds: string[];
  confirmAmbiguous?: boolean;
  dryRun?: boolean;
  now?: Date;
}

/**
 * Создать таймер (бот, по разрешению задачи). Проверки — здесь, разрешение и беседа — у маршрута. Успех — строка
 * и карточка (ответом на обращение) уже в беседе, задачи поставлены.
 */
export async function createPromiseTimer(
  i: CreatePromiseInput,
): Promise<{ ok: true; dryRun: true; preview: { deadlineAt: string; label: string; upperBound: boolean } } | { ok: true; dryRun: false; row: PromiseTimer } | { ok: false; error: PromiseCreateError }> {
  const now = i.now ?? new Date();
  const bot = await getSystemBot();
  if (!bot) return { ok: false, error: { status: 400, code: "PROMISE_BAD", message: "Bot is not configured" } };
  const part = await prisma.conversationParticipant.findUnique({
    where: { conversationId_userId: { conversationId: i.conversationId, userId: i.promiserId } },
    select: { user: { select: { id: true, isBot: true, deletedAt: true } } },
  });
  if (!part || part.user.isBot || part.user.deletedAt) return { ok: false, error: { status: 403, code: "PROMISE_NOT_PARTICIPANT", message: "The promiser is not in this conversation" } };

  // Откуда слова и база. С promiseMessageId цитата — само обещание, а разбираем переданный текст (ответ на
  // переспрос «во сколько?») или, если его нет, само обещание.
  let text = (i.text ?? "").trim();
  let quoteText: string | null = null;
  let base: Date;
  let quoteById: string | null = null;
  let promiseMessageId: string | null = null;
  if (i.promiseMessageId) {
    const m = await prisma.message.findUnique({
      where: { id: i.promiseMessageId },
      select: { id: true, conversationId: true, senderId: true, content: true, createdAt: true, deletedAt: true, isBot: true, type: true, contentEncV: true },
    });
    if (!m || m.conversationId !== i.conversationId || m.deletedAt || m.isBot || m.type !== "TEXT" || m.contentEncV !== 0) {
      return { ok: false, error: { status: 400, code: "PROMISE_BAD", message: "promiseMessageId is not a promise in this conversation" } };
    }
    promiseMessageId = m.id;
    quoteText = (m.content ?? "").trim() || null;
    if (!text) text = (m.content ?? "").trim();
    base = m.createdAt;
    if (m.senderId !== i.promiserId) quoteById = m.senderId;
  } else {
    const t = await prisma.message.findUnique({ where: { id: i.triggerMessageId }, select: { createdAt: true } });
    base = t?.createdAt ?? now;
    if (i.requesterId !== i.promiserId) quoteById = i.requesterId;
  }
  if (!text && !i.spec) return { ok: false, error: { status: 409, code: "PROMISE_NO_TIME", message: "No time in the promise" } };

  const wz = await zoneForWords(i.promiserId, i.requesterId);
  let parseSource: "code" | "model" = "code";
  let spec: PromiseSpec;
  if (i.spec) {
    spec = i.spec;
    parseSource = "model";
  } else {
    spec = parsePromiseText(text).spec;
  }
  const r = resolveDeadline(spec, { base, zone: wz.zone, now, confirmAmbiguous: i.confirmAmbiguous === true });
  if (!r.ok) return { ok: false, error: deadlineError(r) };
  const zoneSource = r.zoneFromText ? "text" : wz.source;

  if (i.dryRun) return { ok: true, dryRun: true, preview: { deadlineAt: r.deadlineAt.toISOString(), label: r.label, upperBound: r.upperBound } };

  // Уже в звонке этой беседы — засекать нечего.
  if (isUserInConversationCall(i.conversationId, i.promiserId)) {
    return { ok: false, error: { status: 409, code: "PROMISE_ALREADY_HERE", message: "Already in the call", where: "call" } };
  }

  const cancelIds = [...new Set([i.requesterId, ...(ownerId() ? [ownerId()!] : []), ...i.cancelAllowedIds.filter((x) => typeof x === "string" && x.length <= 64)])].slice(0, 5);
  const quoteSrc = quoteText ?? text;
  const quote = quoteSrc ? quoteSrc.replace(/\s+/g, " ").slice(0, QUOTE_MAX) : null;

  const created = await prisma.$transaction(async (tx) => {
    // Один замок на беседу: две просьбы подряд не создадут два таймера одному человеку.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`promise:${i.conversationId}`}))`;
    const running = await tx.promiseTimer.findMany({ where: { conversationId: i.conversationId, status: "RUNNING" } });
    const mine = running.find((x) => x.promiserId === i.promiserId);
    if (mine) return { error: { status: 409, code: "PROMISE_EXISTS", message: "Already watching", promise: await summaryOf(mine) } as PromiseCreateError };
    if (running.length >= PROMISE_MAX_RUNNING_PER_CONVERSATION) {
      return { error: { status: 409, code: "PROMISE_LIMIT", message: "Too many timers", scope: "conversation" } as PromiseCreateError };
    }
    if (i.requesterId !== ownerId()) {
      const day = await tx.promiseTimer.count({ where: { requesterId: i.requesterId, createdAt: { gte: new Date(now.getTime() - 86_400_000) } } });
      if (day >= PROMISE_MAX_PER_REQUESTER_DAY) return { error: { status: 409, code: "PROMISE_LIMIT", message: "Too many timers today", scope: "requester" } as PromiseCreateError };
    }
    const row0 = await tx.promiseTimer.create({
      data: {
        conversationId: i.conversationId,
        promiseMessageId,
        triggerMessageId: i.triggerMessageId,
        promiserId: i.promiserId,
        requesterId: i.requesterId,
        cancelAllowedIds: cancelIds,
        quote,
        quoteById,
        quoteAt: base,
        label: r.label,
        upperBound: r.upperBound,
        parseSource,
        zone: r.zone,
        zoneSource,
        startAt: base,
        deadlineAt: r.deadlineAt,
        originalDeadlineAt: r.deadlineAt,
        createdLate: r.deadlineAt.getTime() <= now.getTime(),
      },
    });
    const p = await peopleFor(tx, row0);
    const msg = await insertCardMessage(tx, {
      botId: bot.id,
      conversationId: i.conversationId,
      replyToId: i.triggerMessageId,
      triggerMessageId: i.triggerMessageId,
      askerId: i.requesterId,
      card: buildPromiseCard(row0, p, now),
      content: fallbackOf(row0, p, now),
    });
    const row = await tx.promiseTimer.update({ where: { id: row0.id }, data: { cardMessageId: msg.id } });
    return { row, msg, content: fallbackOf(row0, p, now) };
  });
  if ("error" in created) return { ok: false, error: created.error };
  await announceCardMessage({ conversationId: i.conversationId, botId: bot.id, message: created.msg, content: created.content });
  await schedulePromiseJobs(created.row);
  logger.info(
    { promiseId: created.row.id, conversationId: i.conversationId, parse: parseSource, zone: zoneSource, upper: r.upperBound, late: created.row.createdLate },
    "promise: created",
  );
  return { ok: true, dryRun: false, row: created.row };
}

// ───────────────────────────── переходы ─────────────────────────────

export type ArriveVia = "button" | "self" | "call" | "valheim" | "phrase";

/** «Пришёл»: кнопкой, фразой, звонком, Valheim. Только RUNNING; at ≥ startAt. Возвращает строку или ошибку. */
async function arriveTx(tx: Tx, row: PromiseTimer, o: { via: ArriveVia; at: Date; byId: string | null; detail?: string | null; now: Date }): Promise<PromiseTimer> {
  const lateSec = Math.round((o.at.getTime() - row.deadlineAt.getTime()) / 1000);
  const lateVsOriginalSec = Math.round((o.at.getTime() - row.originalDeadlineAt.getTime()) / 1000);
  const manual = o.via === "button" || o.via === "self" || o.via === "phrase";
  const reopenBy = manual ? [...new Set([o.byId, row.requesterId, ownerId()].filter((x): x is string => !!x))] : [];
  return applyTx(
    tx,
    row,
    {
      status: "ARRIVED",
      closedAt: o.now,
      arrivedAt: o.at,
      arrivedVia: o.via,
      arrivedById: o.byId,
      arrivedDetail: o.detail ?? null,
      lateSec,
      lateVsOriginalSec,
      reopenUntil: manual ? new Date(o.now.getTime() + PROMISE_REOPEN_MS) : null,
      reopenBy,
      reopenPrev: { status: "RUNNING" },
    },
    o.now,
  );
}

/** Отметить приход (общий путь для кнопки, бота, звонка). Ошибки — CardError с текущей карточкой. */
export async function markArrived(id: string, o: { via: ArriveVia; at?: Date; byId: string | null; detail?: string | null }): Promise<PromiseTimer> {
  const now = new Date();
  const at = o.at ?? now;
  const row = await prisma.$transaction(async (tx) => {
    const r = await lockTimer(tx, id);
    if (!r) throw new CardError(404, "PROMISE_NOT_FOUND", "No such timer");
    if (r.status !== "RUNNING") throw new CardError(409, "PROMISE_CLOSED", "The timer is already closed", await cardFor(tx, r, now));
    if (at.getTime() < r.startAt.getTime() - 1000) throw new CardError(409, "PROMISE_TOO_EARLY", "Arrived before the promise");
    return arriveTx(tx, r, { via: o.via, at, byId: o.byId, detail: o.detail ?? null, now });
  });
  await published(row);
  await unschedule(row.id, row.deadlineAt.getTime());
  logger.info({ promiseId: id, via: o.via, lateSec: row.lateSec }, "promise: arrived");
  return row;
}

async function cardFor(db: Db, row: PromiseTimer, now: Date): Promise<CardEnvelope> {
  return buildPromiseCard(row, await peopleFor(db, row), now);
}

export async function cancelTimer(id: string, byId: string, opts: { reason?: string; silentReopen?: boolean } = {}): Promise<PromiseTimer> {
  const now = new Date();
  const row = await prisma.$transaction(async (tx) => {
    const r = await lockTimer(tx, id);
    if (!r) throw new CardError(404, "PROMISE_NOT_FOUND", "No such timer");
    if (r.status !== "RUNNING") throw new CardError(409, "PROMISE_CLOSED", "The timer is already closed", await cardFor(tx, r, now));
    const reopen = !opts.silentReopen;
    return applyTx(
      tx,
      r,
      {
        status: "CANCELLED",
        closedAt: now,
        cancelledById: byId,
        closeReason: opts.reason ?? "cancelled",
        reopenUntil: reopen ? new Date(now.getTime() + PROMISE_REOPEN_MS) : null,
        reopenBy: reopen ? [...new Set([byId, r.requesterId, ownerId()].filter((x): x is string => !!x))] : [],
        reopenPrev: { status: "RUNNING" },
      },
      now,
    );
  });
  await published(row);
  await unschedule(row.id, row.deadlineAt.getTime());
  logger.info({ promiseId: id, reason: opts.reason ?? "cancelled" }, "promise: cancelled");
  return row;
}

/** Продление словами обещавшего: новый срок (позже текущего), ≤ 10 раз, ≤ начало + 36 ч. */
export async function extendTimer(
  id: string,
  o: { byId: string; newDeadline: Date; label: string; byMessageId: string | null; correct?: boolean },
): Promise<PromiseTimer> {
  const now = new Date();
  let oldDeadline = 0;
  const row = await prisma.$transaction(async (tx) => {
    const r = await lockTimer(tx, id);
    if (!r) throw new CardError(404, "PROMISE_NOT_FOUND", "No such timer");
    if (r.status !== "RUNNING") throw new CardError(409, "PROMISE_CLOSED", "The timer is already closed", await cardFor(tx, r, now));
    oldDeadline = r.deadlineAt.getTime();
    if (o.newDeadline.getTime() > r.startAt.getTime() + 36 * 3600_000) throw new CardError(409, "PROMISE_TOO_FAR", "Too far ahead");
    if (o.correct) {
      return applyTx(tx, r, { deadlineAt: o.newDeadline, originalDeadlineAt: o.newDeadline, label: o.label, remindersSent: [], createdLate: o.newDeadline.getTime() <= now.getTime() }, now);
    }
    if (o.newDeadline.getTime() <= r.deadlineAt.getTime()) throw new CardError(409, "PROMISE_NOT_LATER", "The new time is not later", await cardFor(tx, r, now));
    if (r.extensionCount >= PROMISE_MAX_EXTENSIONS) throw new CardError(409, "PROMISE_EXTEND_LIMIT", "Too many extensions");
    const ext = (Array.isArray(r.extensions) ? (r.extensions as unknown[]) : []).slice(-(PROMISE_MAX_EXTENSIONS - 1));
    ext.push({ at: now.toISOString(), from: r.deadlineAt.toISOString(), to: o.newDeadline.toISOString(), label: o.label, byMessageId: o.byMessageId });
    return applyTx(
      tx,
      r,
      {
        deadlineAt: o.newDeadline,
        extensionCount: { increment: 1 },
        extensions: ext as Prisma.InputJsonValue,
        remindersSent: [],
        createdLate: false,
      },
      now,
    );
  });
  await published(row);
  await unschedule(row.id, oldDeadline);
  await schedulePromiseJobs(row);
  logger.info({ promiseId: id, correct: !!o.correct, extensions: row.extensionCount }, "promise: extended");
  return row;
}

export async function reopenTimer(id: string, byId: string): Promise<PromiseTimer> {
  const now = new Date();
  const row = await prisma.$transaction(async (tx) => {
    const r = await lockTimer(tx, id);
    if (!r) throw new CardError(404, "PROMISE_NOT_FOUND", "No such timer");
    if (r.status === "RUNNING" || r.status === "UNRESOLVED") throw new CardError(409, "CARD_CLOSED", "Nothing to reopen", await cardFor(tx, r, now));
    if (!r.reopenUntil || r.reopenUntil.getTime() <= now.getTime()) throw new CardError(409, "CARD_ACTION_EXPIRED", "Too late to reopen", await cardFor(tx, r, now));
    if (!r.reopenBy.includes(byId)) throw new CardError(403, "CARD_FORBIDDEN", "Not yours to reopen", await cardFor(tx, r, now));
    return applyTx(
      tx,
      r,
      {
        status: "RUNNING",
        closedAt: null,
        closeReason: null,
        arrivedAt: null,
        arrivedVia: null,
        arrivedById: null,
        arrivedDetail: null,
        lateSec: null,
        lateVsOriginalSec: null,
        cancelledById: null,
        reopenUntil: null,
        reopenBy: [],
        reopenPrev: Prisma.DbNull,
      },
      now,
    );
  });
  await published(row);
  await schedulePromiseJobs(row);
  logger.info({ promiseId: id }, "promise: reopened");
  return row;
}

// ───────────────────────────── клиентские действия (общий маршрут карточек) ─────────────────────────────

registerCardType("promise", {
  // Закрыть идущие можно и при PROMISE_TIMERS=off.
  enabled: () => true,
  async act({ message, card, userId, action, now }) {
    const id = card.id;
    const fresh = await prisma.promiseTimer.findUnique({ where: { id } });
    if (!fresh || fresh.cardMessageId !== message.id) throw new CardError(404, "CARD_NOT_FOUND", "No such card");
    const cur = await cardFor(prisma, fresh, now);
    if (action === "arrived") {
      assertCanAct(cur, "arrived", userId, now.getTime());
      await markArrived(id, { via: userId === fresh.promiserId ? "self" : "button", byId: userId }).catch(rethrowCard);
    } else if (action === "cancel") {
      assertCanAct(cur, "cancel", userId, now.getTime());
      await cancelTimer(id, userId).catch(rethrowCard);
    } else if (action === "reopen") {
      assertCanAct(cur, "reopen", userId, now.getTime());
      await reopenTimer(id, userId).catch(rethrowCard);
    } else {
      throw new CardError(400, "CARD_BAD_INPUT", "Unknown action");
    }
    return { messageId: message.id, conversationId: message.conversationId };
  },
});

/** Ошибки переходов → коды общего маршрута (CARD_CLOSED и т. п.) для клиентов. */
function rethrowCard(e: unknown): never {
  if (e instanceof CardError) {
    const map: Record<string, string> = { PROMISE_CLOSED: "CARD_CLOSED", PROMISE_NOT_FOUND: "CARD_NOT_FOUND" };
    throw new CardError(e.status, map[e.code] ?? e.code, e.message, e.card);
  }
  throw e;
}

// ───────────────────────────── звонок ─────────────────────────────

/**
 * Обещавший вошёл в звонок этой беседы (сокет: call:invite/accept/room:join; вебхук LiveKit participant_joined) —
 * «пришёл», via "call". Первый выигрывает (замок), второй ничего не меняет. Не бросает.
 */
export async function promiseOnCallJoin(conversationId: string, userId: string, at: Date): Promise<void> {
  try {
    const rows = await prisma.promiseTimer.findMany({ where: { conversationId, promiserId: userId, status: "RUNNING" }, select: { id: true, startAt: true } });
    for (const r of rows) {
      if (at.getTime() < r.startAt.getTime() - 1000) continue;
      await markArrived(r.id, { via: "call", at, byId: null }).catch((e) => {
        if (!(e instanceof CardError)) throw e;
      });
    }
  } catch (error) {
    logger.warn({ error, conversationId }, "promise: call join failed");
  }
}

registerCallJoinListener((conversationId, userId, at) => {
  void promiseOnCallJoin(conversationId, userId, at);
});

// ───────────────────────────── напоминания, авто-закрытие, sweep ─────────────────────────────

async function nextTemplateIndex(conversationId: string, offset: number): Promise<number> {
  try {
    const redis = await getRedisClient();
    const n = await redis.incr(`promise:tpl:${conversationId}:${offset}`);
    if (n === 1) await redis.expire(`promise:tpl:${conversationId}:${offset}`, 30 * 86_400);
    return n - 1;
  } catch {
    return crypto.randomInt(3);
  }
}

/**
 * Напоминание по сроку (offset мин после него). silent — только отметить и обновить текст (sweep: опоздали с ним
 * больше чем на 5 мин). Сбой отправки — снять отметку и бросить (BullMQ повторит).
 */
export async function processPromiseReminder(id: string, deadlineMs: number, offset: number, opts: { silent?: boolean } = {}): Promise<"sent" | "skipped" | "marked"> {
  const now = new Date();
  const res = await prisma.$transaction(async (tx) => {
    const r = await lockTimer(tx, id);
    if (!r || r.status !== "RUNNING" || r.deadlineAt.getTime() !== deadlineMs) return { kind: "skip" as const, row: null };
    if (r.remindersSent.includes(offset)) return { kind: "skip" as const, row: null };
    const quiet = opts.silent || (offset === 0 && r.createdLate) || r.remindersTotal >= PROMISE_MAX_REMINDERS || !promiseTimersEnabled();
    const row = await applyTx(
      tx,
      r,
      { remindersSent: [...r.remindersSent, offset], ...(quiet ? {} : { remindersTotal: { increment: 1 } }) },
      now,
    );
    return { kind: quiet ? ("mark" as const) : ("send" as const), row };
  });
  if (res.kind === "skip" || !res.row) return "skipped";
  await published(res.row);
  if (res.kind === "mark") return "marked";
  const row = res.row;
  try {
    const bot = await getSystemBot();
    if (!bot) throw new Error("bot is not configured");
    const names = await displayNames([row.promiserId]);
    const name = names.get(row.promiserId) ?? "Участник";
    // Ответом на само обещание (если оно живо и его автор — обещавший): так оно пробивает «Без звука» обещавшего
    // в группе по правилу мьюта «ответ на моё сообщение». Иначе — ответом на карточку.
    let replyToId: string | null = row.cardMessageId;
    if (row.promiseMessageId) {
      const pm = await prisma.message.findUnique({ where: { id: row.promiseMessageId }, select: { deletedAt: true, senderId: true, conversationId: true } });
      if (pm && !pm.deletedAt && pm.senderId === row.promiserId && pm.conversationId === row.conversationId) replyToId = row.promiseMessageId;
    }
    const conv = await prisma.conversation.findUnique({ where: { id: row.conversationId }, select: { id: true, isSecret: true, type: true } });
    if (!conv || conv.isSecret || conv.type === "SECRET") return "skipped";
    const idx = await nextTemplateIndex(row.conversationId, offset);
    await createBotMessage({
      botId: bot.id,
      conversationId: row.conversationId,
      type: "TEXT",
      content: reminderText(offset, idx, name, row.label),
      replyToId,
      kind: "notice",
      askerId: row.requesterId,
      extraBot: { promiseId: row.id, mentions: [row.promiserId] },
    });
    logger.info({ promiseId: id, offset }, "promise: reminder sent");
    return "sent";
  } catch (error) {
    // Снять отметку: BullMQ повторит задачу.
    await prisma.promiseTimer
      .update({ where: { id }, data: { remindersSent: row.remindersSent.filter((o) => o !== offset), remindersTotal: { decrement: 1 } } })
      .catch(() => undefined);
    throw error;
  }
}

/** Срок + 6 ч, никто не отметил — UNRESOLVED (без «Вернуть»; в статистике отдельно). */
export async function processPromiseAutoclose(id: string, deadlineMs: number): Promise<boolean> {
  const now = new Date();
  const row = await prisma.$transaction(async (tx) => {
    const r = await lockTimer(tx, id);
    if (!r || r.status !== "RUNNING" || r.deadlineAt.getTime() !== deadlineMs) return null;
    return applyTx(tx, r, { status: "UNRESOLVED", closedAt: now, closeReason: "unresolved", reopenUntil: null, reopenBy: [] }, now);
  });
  if (!row) return false;
  await published(row);
  logger.info({ promiseId: id }, "promise: unresolved");
  return true;
}

/** Страховка (раз в 5 мин): догнать напоминания и авто-закрытия, которых очередь не выполнила, перепоставить задачи. */
export async function sweepPromises(now: Date = new Date()): Promise<{ reminded: number; closed: number }> {
  let reminded = 0;
  let closed = 0;
  const rows = await prisma.promiseTimer.findMany({ where: { status: "RUNNING" }, take: 500, orderBy: { deadlineAt: "asc" } });
  for (const r of rows) {
    const d = r.deadlineAt.getTime();
    if (now.getTime() >= d + PROMISE_AUTOCLOSE_MS) {
      if (await processPromiseAutoclose(r.id, d).catch(() => false)) closed++;
      continue;
    }
    for (const offset of PROMISE_REMINDER_OFFSETS) {
      const due = d + offset * 60_000;
      if (now.getTime() < due || r.remindersSent.includes(offset)) continue;
      const silent = now.getTime() - due > PROMISE_SWEEP_CATCHUP_MS;
      const out = await processPromiseReminder(r.id, d, offset, { silent }).catch((e) => {
        logger.warn({ error: e, promiseId: r.id, offset }, "promise: sweep reminder failed");
        return "skipped" as const;
      });
      if (out === "sent") reminded++;
    }
    await schedulePromiseJobs(r);
  }
  return { reminded, closed };
}

// ───────────────────────────── удаления и выход из беседы ─────────────────────────────

/**
 * Крючок удаления сообщения (POST /api/messages/delete): карточка → таймер отменён тихо (задачи сняты); обещание →
 * цитата убрана (таймер идёт: обещание было, слова человек убрал). Не бросает.
 */
export async function promiseOnMessageDeleted(msg: { id: string; conversationId: string; isBot: boolean }, byUserId: string): Promise<void> {
  try {
    if (msg.isBot) {
      const t = await prisma.promiseTimer.findUnique({ where: { cardMessageId: msg.id } });
      if (t && t.status === "RUNNING") {
        const now = new Date();
        await prisma.$transaction(async (tx) => {
          const r = await lockTimer(tx, t.id);
          if (!r || r.status !== "RUNNING") return;
          await tx.promiseTimer.update({
            where: { id: r.id },
            data: { status: "CANCELLED", closedAt: now, cancelledById: byUserId, closeReason: "card_deleted", rev: { increment: 1 } },
          });
        });
        await unschedule(t.id, t.deadlineAt.getTime());
        logger.info({ promiseId: t.id }, "promise: cancelled (card deleted)");
      }
      return;
    }
    const rows = await prisma.promiseTimer.findMany({ where: { promiseMessageId: msg.id, quote: { not: null } }, select: { id: true } });
    for (const x of rows) {
      const now = new Date();
      const row = await prisma.$transaction(async (tx) => {
        const r = await lockTimer(tx, x.id);
        if (!r || r.quote === null) return null;
        return applyTx(tx, r, { quote: null }, now);
      });
      await published(row);
    }
  } catch (error) {
    logger.warn({ error, messageId: msg.id }, "promise: delete hook failed");
  }
}

/** Человек вышел из беседы: его идущие таймеры (он обещавший) — отменены тихо. Не бросает. */
export async function promiseOnParticipantLeft(conversationId: string, userId: string): Promise<void> {
  try {
    const rows = await prisma.promiseTimer.findMany({ where: { conversationId, promiserId: userId, status: "RUNNING" }, select: { id: true } });
    for (const r of rows) await cancelTimer(r.id, userId, { reason: "promiser_left", silentReopen: true }).catch(() => undefined);
  } catch (error) {
    logger.warn({ error, conversationId }, "promise: leave hook failed");
  }
}

// ───────────────────────────── для бота: кандидаты, списки, статистика ─────────────────────────────

export interface PromiseCandidate {
  messageId: string;
  senderId: string;
  senderName: string | null;
  text: string;
  createdAt: string;
  parsed: { deadlineAt: string; label: string; upperBound: boolean } | { ambiguous: true; deadlineAt: string; label: string | null };
}

/**
 * Кандидаты «без ответа»: сообщения ДРУГИХ участников (не автора обращения, не бота) за час до обращения, TEXT,
 * не удалённые/истёкшие, не взятые в таймер, которые разборщик признал обещанием времени. ≤ 5, новые первыми.
 * Остальная переписка боту не отдаётся.
 */
export async function promiseCandidates(conversationId: string, triggerMessageId: string, authorId: string, botId: string): Promise<PromiseCandidate[]> {
  const trig = await prisma.message.findUnique({ where: { id: triggerMessageId }, select: { createdAt: true } });
  const until = trig?.createdAt ?? new Date();
  const now = new Date();
  const rows = await prisma.message.findMany({
    where: {
      conversationId,
      deletedAt: null,
      isBot: false,
      type: "TEXT",
      contentEncV: 0,
      senderId: { notIn: [authorId, botId] },
      createdAt: { gte: new Date(until.getTime() - PROMISE_CANDIDATES_WINDOW_MS), lte: until },
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    },
    orderBy: { createdAt: "desc" },
    take: 200,
    select: { id: true, senderId: true, content: true, createdAt: true, sender: { select: { displayName: true } } },
  });
  const taken = new Set(
    (await prisma.promiseTimer.findMany({ where: { conversationId, promiseMessageId: { in: rows.map((r) => r.id) } }, select: { promiseMessageId: true } })).map((t) => t.promiseMessageId),
  );
  const out: PromiseCandidate[] = [];
  const zones = new Map<string, string>();
  for (const m of rows) {
    if (out.length >= PROMISE_CANDIDATES_MAX) break;
    if (taken.has(m.id) || !m.content) continue;
    const parsed = parsePromiseText(m.content);
    if (parsed.spec.kind === "none") continue;
    let zone = zones.get(m.senderId);
    if (!zone) {
      zone = (await zoneForWords(m.senderId, authorId)).zone;
      zones.set(m.senderId, zone);
    }
    const r = resolveDeadline(parsed.spec, { base: m.createdAt, zone, now });
    let p: PromiseCandidate["parsed"] | null = null;
    if (r.ok) p = { deadlineAt: r.deadlineAt.toISOString(), label: r.label, upperBound: r.upperBound };
    else if (r.code === "AMBIGUOUS" && r.deadlineAt) p = { ambiguous: true, deadlineAt: r.deadlineAt.toISOString(), label: r.label ?? null };
    if (!p) continue;
    out.push({ messageId: m.id, senderId: m.senderId, senderName: m.sender?.displayName ?? null, text: m.content.slice(0, 300), createdAt: m.createdAt.toISOString(), parsed: p });
  }
  return out;
}

/** Идущие таймеры (для бота: Valheim-наблюдатель) — без текстов. */
export async function activePromises(): Promise<Array<{ id: string; conversationId: string; promiserId: string; startAt: string; deadlineAt: string }>> {
  const rows = await prisma.promiseTimer.findMany({
    where: { status: "RUNNING" },
    take: 200,
    select: { id: true, conversationId: true, promiserId: true, startAt: true, deadlineAt: true },
  });
  return rows.map((r) => ({ id: r.id, conversationId: r.conversationId, promiserId: r.promiserId, startAt: r.startAt.toISOString(), deadlineAt: r.deadlineAt.toISOString() }));
}

export interface PunctualityStats {
  userId: string;
  displayName: string | null;
  scope: "shared";
  total: number;
  onTime: number;
  late: number;
  unresolved: number;
  cancelled: number;
  onTimeRate: number | null;
  avgDeltaSec: number | null;
  avgLateSec: number | null;
  medianDeltaSec: number | null;
  worst: { deltaSec: number; at: string } | null;
  best: { deltaSec: number; at: string } | null;
  extensions: number;
  timersExtended: number;
  streakOnTime: number;
  last: Array<{ deltaSec: number; at: string; via: string | null }>;
}

/** Пунктуальность человека — только по беседам, где спрашивающий сейчас участник (чужие беседы — не наше дело). */
export async function punctualityStats(userId: string, askerId: string): Promise<PunctualityStats> {
  const convs = await prisma.conversationParticipant.findMany({ where: { userId: askerId }, select: { conversationId: true } });
  const rows = await prisma.promiseTimer.findMany({
    where: { promiserId: userId, conversationId: { in: convs.map((c) => c.conversationId) }, status: { not: "RUNNING" } },
    orderBy: { createdAt: "asc" },
    take: 2000,
  });
  const names = await displayNames([userId]);
  const arrived = rows.filter((r) => r.status === "ARRIVED" && r.lateSec !== null);
  const deltas = arrived.map((r) => r.lateSec!);
  const onTime = arrived.filter((r) => r.lateSec! <= 0);
  const late = arrived.filter((r) => r.lateSec! > 0);
  const sorted = [...deltas].sort((a, b) => a - b);
  const median = sorted.length ? (sorted.length % 2 ? sorted[(sorted.length - 1) / 2]! : Math.round((sorted[sorted.length / 2 - 1]! + sorted[sorted.length / 2]!) / 2)) : null;
  let worst: PunctualityStats["worst"] = null;
  let best: PunctualityStats["best"] = null;
  for (const r of arrived) {
    const at = (r.arrivedAt ?? r.closedAt ?? r.createdAt).toISOString();
    if (!worst || r.lateSec! > worst.deltaSec) worst = { deltaSec: r.lateSec!, at };
    if (!best || r.lateSec! < best.deltaSec) best = { deltaSec: r.lateSec!, at };
  }
  let streak = 0;
  for (let i = arrived.length - 1; i >= 0; i--) {
    if (arrived[i]!.lateSec! <= 0) streak++;
    else break;
  }
  const decided = onTime.length + late.length;
  return {
    userId,
    displayName: names.get(userId) ?? null,
    scope: "shared",
    total: rows.filter((r) => r.status !== "CANCELLED").length,
    onTime: onTime.length,
    late: late.length,
    unresolved: rows.filter((r) => r.status === "UNRESOLVED").length,
    cancelled: rows.filter((r) => r.status === "CANCELLED").length,
    onTimeRate: decided ? Math.round((onTime.length / decided) * 100) / 100 : null,
    avgDeltaSec: deltas.length ? Math.round(deltas.reduce((a, b) => a + b, 0) / deltas.length) : null,
    avgLateSec: late.length ? Math.round(late.reduce((a, r) => a + r.lateSec!, 0) / late.length) : null,
    medianDeltaSec: median,
    worst,
    best,
    extensions: rows.reduce((a, r) => a + r.extensionCount, 0),
    timersExtended: rows.filter((r) => r.extensionCount > 0).length,
    streakOnTime: streak,
    last: arrived
      .slice(-5)
      .reverse()
      .map((r) => ({ deltaSec: r.lateSec!, at: (r.arrivedAt ?? r.createdAt).toISOString(), via: r.arrivedVia })),
  };
}

/** Таблица пунктуальности по участникам беседы (у кого ≥ 1 исход): доля вовремя, потом среднее. */
export async function punctualityBoard(conversationId: string, askerId: string, botId: string): Promise<PunctualityStats[]> {
  const parts = await prisma.conversationParticipant.findMany({ where: { conversationId }, select: { userId: true } });
  const out: PunctualityStats[] = [];
  for (const p of parts) {
    if (p.userId === botId) continue;
    const s = await punctualityStats(p.userId, askerId);
    if (s.onTime + s.late > 0) out.push(s);
  }
  return out.sort((a, b) => (b.onTimeRate ?? 0) - (a.onTimeRate ?? 0) || (a.avgDeltaSec ?? 0) - (b.avgDeltaSec ?? 0)).slice(0, 25);
}

const normName = (s: string) => s.toLowerCase().replace(/ё/g, "е").replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();

/**
 * Участник беседы по имени, как его назвали в обращении («Вася», «Козёл Ебаный», «Васи» — основа слова).
 * found — ровно один; ambiguous — несколько (имена — для переспроса); none — никого.
 */
export async function participantByName(
  conversationId: string,
  name: string,
  botId: string,
): Promise<{ kind: "found"; userId: string; displayName: string } | { kind: "ambiguous"; names: string[] } | { kind: "none" }> {
  const q = normName(name).slice(0, 64);
  if (!q) return { kind: "none" };
  const parts = await prisma.conversationParticipant.findMany({
    where: { conversationId },
    select: { user: { select: { id: true, displayName: true, username: true, isBot: true, deletedAt: true } } },
  });
  const people = parts.map((p) => p.user).filter((u) => !u.isBot && !u.deletedAt && u.id !== botId);
  const stems = q.split(" ").map((w) => (w.length >= 4 ? w.slice(0, Math.max(3, w.length - 2)) : w));
  const score = (u: { displayName: string | null; username: string }) => {
    const dn = normName(u.displayName ?? "");
    if (dn === q || u.username.toLowerCase() === q) return 3;
    if (dn.startsWith(q) || dn.split(" ").includes(q)) return 2;
    if (stems.every((s) => dn.split(" ").some((w) => w.startsWith(s)))) return 1;
    return 0;
  };
  const ranked = people.map((u) => ({ u, s: score(u) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s);
  if (!ranked.length) return { kind: "none" };
  const top = ranked.filter((x) => x.s === ranked[0]!.s);
  if (top.length > 1) return { kind: "ambiguous", names: top.slice(0, 5).map((x) => (x.u.displayName ?? x.u.username).trim()) };
  return { kind: "found", userId: top[0]!.u.id, displayName: (top[0]!.u.displayName ?? top[0]!.u.username).trim() };
}

/** Пересчитать срок по словам продления/поправки (база — время сообщения со словами). */
export async function deadlineFromWords(o: {
  row: PromiseTimer;
  text?: string | null;
  spec?: PromiseSpec | null;
  base: Date;
}): Promise<{ ok: true; deadlineAt: Date; label: string } | { ok: false; code: string; deadlineAt?: string }> {
  const spec = o.spec ?? (o.text ? parsePromiseText(o.text).spec : null);
  if (!spec) return { ok: false, code: "PROMISE_NO_TIME" };
  const r = resolveDeadline(spec, { base: o.base, zone: o.row.zone, now: new Date(), confirmAmbiguous: true });
  if (!r.ok) return { ok: false, code: `PROMISE_${r.code}`, ...(r.deadlineAt ? { deadlineAt: r.deadlineAt.toISOString() } : {}) };
  return { ok: true, deadlineAt: r.deadlineAt, label: r.label };
}
