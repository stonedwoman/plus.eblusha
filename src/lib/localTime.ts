import logger from "../config/logger";
import prisma from "./prisma";
import { getRedisClient } from "./redis";
import { RU_CITY_BY_TIME_ZONE } from "./localTimeCities";

/**
 * Местное время собеседника: в открытом диалоге 1:1 под статусом собеседника клиент пишет мелкой
 * строкой «14:30, Красноярск». Здесь — серверная часть: какой у человека часовой пояс и кому его
 * можно отдавать.
 *
 * Модель.
 *  - Каждое устройство сообщает свой пояс IANA: сокет-событие "localtime:report" {timeZone} при КАЖДОМ
 *    подключении сокета и при смене пояса (или PUT /status/me/local-time {timeZone}). Хранится
 *    по устройству: Redis-хеш ltz:dev:<user>, поле = id устройства (did токена / auth.deviceId; сокет
 *    без проверенного устройства — общее поле "nodev"), значение = {tz, usedAt, active}.
 *  - Показывается пояс устройства, которым человек пользовался ПОСЛЕДНИМ (pickEffectiveDevice):
 *    «пользуется» = приложение на переднем плане (presence:state active=true). Пока устройство активно,
 *    хартбит сокета примерно раз в минуту продлевает его usedAt — так «живым» оно и остаётся. Из нескольких
 *    одновременно активных выбранное не меняется (без дребезга «телефон ↔ ПК» каждые полминуты);
 *    когда активных нет — самое свежее по usedAt. Выбранное лежит в ltz:eff:<user> {key, tz}.
 *  - Настройка «Показывать моё местное время» (по умолчанию включена): ltz:share:<user> {share, at},
 *    at — момент изменения по часам сервера. Выключена — пояс человека не уходит никому (ни в списке
 *    бесед, ни в /users, ни событием), сами пояса устройств при этом хранятся: включил — сразу виден.
 *  - Отдаётся только собеседникам по беседам 1:1 (isGroup=false, в т.ч. секретным): в списке бесед
 *    (participants[].user.localTime у собеседника), в GET /users/:id и GET /users/:id/local-time, и
 *    событием "localtime:update" {userId, localTime} в их комнаты user:<id> при смене пояса или
 *    настройки. В группах не отдаётся вовсе.
 *
 * Почему Redis, а не столбцы в БД: схема не меняется (параллельно её правят другие задачи), а данные
 * сами восстанавливаются — устройства сообщают пояс при каждом подключении. Единственное, что терять
 * нельзя, — выключенную настройку (иначе пояс снова стал бы виден). Redis пишет снимки на диск, а на
 * случай отката к старому снимку клиент вместе с поясом присылает последнее известное ему состояние
 * настройки {shareLocalTime, shareLocalTimeAt}: сервер принимает его, если оно новее своего
 * (reassertShare), — выключенная настройка восстанавливается при первом же подключении устройства.
 *
 * Всё, что зовут сокет и чужие маршруты (список бесед, /users, отзыв устройства), НИКОГДА не бросает:
 * местное время — украшение, ломать из-за него список бесед или подключение нельзя. Бросать могут
 * только setShareLocalTime/getOwnLocalTimeState — их ручка настроек отвечает ошибкой.
 */

/** Что получает собеседник. */
export type LocalTimeInfo = {
  /** Канонический идентификатор IANA (по ICU сервера; напр. "Asia/Krasnoyarsk", "Asia/Calcutta"). */
  timeZone: string;
  /** Город по-русски («Красноярск»); null — города у пояса нет (Etc/GMT-7, UTC…): клиент пишет «UTC+7». */
  city: string | null;
  /** Смещение от UTC в минутах на момент ответа сервера — запасной вариант для клиента, не знающего пояс. */
  offsetMinutes: number;
};

/** Запись устройства в ltz:dev:<user>. */
export type DeviceTzRecord = {
  /** Пояс устройства (канонический); null — устройство ещё не сообщало (старый клиент). */
  tz: string | null;
  /** Последний момент «пользования» (мс, часы сервера); 0 — ни разу не было на переднем плане. */
  usedAt: number;
  /** Приложение сейчас на переднем плане (по последнему presence:state). */
  active: boolean;
};

export type LocalTimeShareState = { shareLocalTime: boolean; shareLocalTimeAt: number };

/** Сокет-события (контракт для клиентов). */
export const LOCALTIME_REPORT_EVENT = "localtime:report" as const;
export const LOCALTIME_UPDATE_EVENT = "localtime:update" as const;
export const LOCALTIME_SETTINGS_EVENT = "localtime:settings" as const;

/** Поле хеша для сокета/запроса без проверенного устройства. */
export const NO_DEVICE_KEY = "nodev";

/** Активное устройство считается живым, пока его usedAt не старше этого (хартбит продлевает раз в минуту). */
export const LIVE_MS = 150_000;
/** Как часто хартбит продлевает usedAt активного устройства. */
export const USE_BUMP_MS = 60_000;
/** Не чаще стольких localtime:report с одного сокета в минуту (клиенту нужен один на подключение + смена пояса). */
export const LOCALTIME_REPORTS_PER_MINUTE = 20;
/** Сколько хранить пояса устройств (продлевается при каждой записи). */
export const DATA_TTL_SECONDS = 180 * 86_400;
/** Настройку, пришедшую от клиента «из будущего» дальше этого, не принимаем. */
const SHARE_FUTURE_SLACK_MS = 60_000;

const devKey = (userId: string) => `ltz:dev:${userId}`;
const effKey = (userId: string) => `ltz:eff:${userId}`;
const shareKey = (userId: string) => `ltz:share:${userId}`;

export const localTimeDeviceKey = (deviceId: string | null | undefined): string => {
  const d = typeof deviceId === "string" ? deviceId.trim() : "";
  return d || NO_DEVICE_KEY;
};

// ───────────────────────────── Чистые функции ─────────────────────────────

const TZ_SHAPE = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+){0,2}$/;

/**
 * Проверить идентификатор пояса и вернуть каноническое имя (как его понимает ICU сервера), иначе null.
 * Смещения вида "+07:00" и прочее, что не похоже на имя IANA, не принимаем.
 */
export function normalizeTimeZone(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!s || s.length > 64 || !TZ_SHAPE.test(s)) return null;
  try {
    const resolved = new Intl.DateTimeFormat("en-US", { timeZone: s }).resolvedOptions().timeZone;
    return typeof resolved === "string" && resolved.length > 0 ? resolved : null;
  } catch {
    return null;
  }
}

const hasOwn = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

/** Город пояса по-русски или null (Etc/*, UTC, неизвестный пояс). */
export function cityForTimeZone(timeZone: string): string | null {
  if (hasOwn(RU_CITY_BY_TIME_ZONE, timeZone)) return RU_CITY_BY_TIME_ZONE[timeZone] ?? null;
  const canonical = normalizeTimeZone(timeZone);
  if (canonical && hasOwn(RU_CITY_BY_TIME_ZONE, canonical)) return RU_CITY_BY_TIME_ZONE[canonical] ?? null;
  return null;
}

const offsetFormatters = new Map<string, Intl.DateTimeFormat>();

/** Смещение пояса от UTC в минутах в момент at (учитывает летнее время). */
export function offsetMinutesAt(timeZone: string, at: number = Date.now()): number {
  let f = offsetFormatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "shortOffset" });
    if (offsetFormatters.size < 2_000) offsetFormatters.set(timeZone, f);
  }
  const name = f.formatToParts(new Date(at)).find((p) => p.type === "timeZoneName")?.value ?? "GMT";
  const m = /^(?:GMT|UTC)(?:([+-])(\d{1,2})(?::?(\d{2}))?)?$/.exec(name);
  if (!m || !m[1]) return 0;
  const minutes = Number(m[2]) * 60 + Number(m[3] ?? 0);
  return m[1] === "-" ? -minutes : minutes;
}

/** То, что уходит собеседнику. null — пояс негодный. */
export function describeTimeZone(timeZone: string, at: number = Date.now()): LocalTimeInfo | null {
  const tz = normalizeTimeZone(timeZone);
  if (!tz) return null;
  return { timeZone: tz, city: cityForTimeZone(tz), offsetMinutes: offsetMinutesAt(tz, at) };
}

/**
 * Какое устройство «последнее, которым пользовались». Учитываются только устройства, сообщившие пояс.
 *  1. Есть живые активные (active и usedAt не старше LIVE_MS): текущее выбранное, если оно среди них
 *     (два активных сразу — без переключений), иначе самое свежее из них.
 *  2. Живых нет: самое свежее по usedAt; при равенстве — текущее выбранное.
 */
export function pickEffectiveDevice(
  records: Readonly<Record<string, DeviceTzRecord>>,
  currentKey: string | null,
  now: number,
): string | null {
  const keys = Object.keys(records).filter((k) => !!records[k]?.tz);
  if (keys.length === 0) return null;
  const isLive = (k: string) => {
    const r = records[k]!;
    return r.active && now - r.usedAt <= LIVE_MS;
  };
  const live = keys.filter(isLive);
  const pool = live.length > 0 ? live : keys;
  if (live.length > 0 && currentKey && live.includes(currentKey)) return currentKey;
  let best: string | null = null;
  for (const k of pool) {
    if (best === null) {
      best = k;
      continue;
    }
    const a = records[k]!.usedAt;
    const b = records[best]!.usedAt;
    if (a > b || (a === b && k === currentKey)) best = k;
  }
  return best;
}

// ───────────────────────────── Redis ─────────────────────────────

function parseRecord(raw: string | null | undefined): DeviceTzRecord | null {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as Partial<DeviceTzRecord>;
    return {
      tz: typeof o.tz === "string" && o.tz ? o.tz : null,
      usedAt: Number.isFinite(Number(o.usedAt)) ? Number(o.usedAt) : 0,
      active: o.active === true,
    };
  } catch {
    return null;
  }
}

function parseEff(raw: string | null | undefined): { key: string; tz: string } | null {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as { key?: unknown; tz?: unknown };
    if (typeof o.key === "string" && typeof o.tz === "string" && o.key && o.tz) return { key: o.key, tz: o.tz };
  } catch {
    // битая запись — как будто её нет
  }
  return null;
}

function parseShare(raw: string | null | undefined): LocalTimeShareState {
  if (!raw) return { shareLocalTime: true, shareLocalTimeAt: 0 };
  try {
    const o = JSON.parse(raw) as { share?: unknown; at?: unknown };
    const at = Number(o.at);
    return { shareLocalTime: o.share !== false, shareLocalTimeAt: Number.isFinite(at) && at > 0 ? at : 0 };
  } catch {
    // Битая запись настройки: безопаснее считать её выключенной, чем раскрыть пояс.
    return { shareLocalTime: false, shareLocalTimeAt: 0 };
  }
}

/**
 * Изменения одного человека — строго по очереди (в пределах процесса): иначе два пересчёта
 * выбранного устройства обгоняют друг друга и старший записывает устаревший результат.
 */
const chains = new Map<string, Promise<unknown>>();
function serialized<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(userId) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  chains.set(userId, tail);
  void tail.then(() => {
    if (chains.get(userId) === tail) chains.delete(userId);
  });
  return run;
}

async function emitToRooms(rooms: string[], event: string, payload: unknown): Promise<void> {
  if (rooms.length === 0) return;
  try {
    // Как в push/readSync.ts: socket.ts импортирует этот модуль, поэтому — динамически.
    const { getIO } = await import("../realtime/socket");
    const io = getIO();
    if (!io) return;
    (io.to(rooms) as any).emit(event, payload);
  } catch (error) {
    logger.warn({ error, event }, "localtime: socket emit failed");
  }
}

/** Собеседники человека по беседам 1:1 (в т.ч. секретным), без него самого. */
export async function oneToOnePeerIds(userId: string): Promise<string[]> {
  const rows = await prisma.conversationParticipant.findMany({
    where: {
      userId: { not: userId },
      conversation: { isGroup: false, participants: { some: { userId } } },
    },
    select: { userId: true },
    distinct: ["userId"],
  });
  return rows.map((r) => r.userId);
}

/** Есть ли у двух людей общая беседа 1:1. */
export async function areOneToOnePeers(a: string, b: string): Promise<boolean> {
  if (!a || !b || a === b) return false;
  const n = await prisma.conversation.count({
    where: {
      isGroup: false,
      AND: [{ participants: { some: { userId: a } } }, { participants: { some: { userId: b } } }],
    },
  });
  return n > 0;
}

export async function getShareState(userId: string): Promise<LocalTimeShareState> {
  const redis = await getRedisClient();
  return parseShare(await redis.get(shareKey(userId)));
}

/** Собственный выбранный пояс (без учёта настройки) — для экрана настроек самого человека. */
async function getOwnEffective(userId: string): Promise<LocalTimeInfo | null> {
  const redis = await getRedisClient();
  const eff = parseEff(await redis.get(effKey(userId)));
  return eff ? describeTimeZone(eff.tz) : null;
}

/** Что видят собеседники (с учётом настройки). */
export async function getPublicLocalTimes(userIds: string[]): Promise<Map<string, LocalTimeInfo | null>> {
  const out = new Map<string, LocalTimeInfo | null>();
  const ids = Array.from(new Set(userIds.filter(Boolean)));
  if (ids.length === 0) return out;
  try {
    const redis = await getRedisClient();
    const [effs, shares] = await Promise.all([
      redis.mGet(ids.map(effKey)),
      redis.mGet(ids.map(shareKey)),
    ]);
    const now = Date.now();
    ids.forEach((id, i) => {
      const eff = parseEff(effs[i] as string | null);
      const share = parseShare(shares[i] as string | null);
      out.set(id, share.shareLocalTime && eff ? describeTimeZone(eff.tz, now) : null);
    });
  } catch (error) {
    logger.warn({ error }, "localtime: read failed");
    for (const id of ids) out.set(id, null);
  }
  return out;
}

/** Местное время target для viewer: только собеседнику 1:1, иначе null. Не бросает. */
export async function getLocalTimeForViewer(viewerId: string, targetId: string): Promise<LocalTimeInfo | null> {
  try {
    if (!(await areOneToOnePeers(viewerId, targetId))) return null;
    return (await getPublicLocalTimes([targetId])).get(targetId) ?? null;
  } catch (error) {
    logger.warn({ error }, "localtime: viewer lookup failed");
    return null;
  }
}

/** Разослать собеседникам текущее состояние человека (пояс или null). */
async function broadcastToPeers(userId: string): Promise<void> {
  const info = (await getPublicLocalTimes([userId])).get(userId) ?? null;
  const peers = await oneToOnePeerIds(userId);
  await emitToRooms(
    peers.map((p) => `user:${p}`),
    LOCALTIME_UPDATE_EVENT,
    { userId, localTime: info },
  );
}

/**
 * Пересчитать выбранное устройство; при смене пояса — разослать собеседникам (если человек не скрыл
 * своё время). Вызывать только внутри serialized(userId).
 */
async function recomputeLocked(userId: string, now: number): Promise<void> {
  const redis = await getRedisClient();
  const [rawAll, rawEff] = await Promise.all([redis.hGetAll(devKey(userId)), redis.get(effKey(userId))]);
  const records: Record<string, DeviceTzRecord> = {};
  for (const [k, v] of Object.entries(rawAll ?? {})) {
    const r = parseRecord(v);
    if (r) records[k] = r;
  }
  const prev = parseEff(rawEff);
  const pick = pickEffectiveDevice(records, prev?.key ?? null, now);
  const tz = pick ? records[pick]!.tz : null;
  if (pick && tz) {
    // Пишем всегда (а не только при смене): продлевает срок жизни записи у постоянно активного человека.
    await redis.set(effKey(userId), JSON.stringify({ key: pick, tz }), { EX: DATA_TTL_SECONDS });
  } else if (prev) {
    await redis.del(effKey(userId));
  }
  if ((prev?.tz ?? null) !== tz) {
    const share = await getShareState(userId);
    if (share.shareLocalTime) await broadcastToPeers(userId);
  }
}

async function updateRecordLocked(
  userId: string,
  key: string,
  mutate: (rec: DeviceTzRecord | null) => DeviceTzRecord | null,
): Promise<{ before: DeviceTzRecord | null; after: DeviceTzRecord | null }> {
  const redis = await getRedisClient();
  const before = parseRecord(await redis.hGet(devKey(userId), key));
  const after = mutate(before);
  if (after) {
    await redis.hSet(devKey(userId), key, JSON.stringify(after));
    await redis.expire(devKey(userId), DATA_TTL_SECONDS);
  }
  return { before, after };
}

// ───────────────────────────── Вход: устройства ─────────────────────────────

export type ReportResult =
  | { ok: true; timeZone: string; shareLocalTime: boolean; shareLocalTimeAt: number }
  | { ok: false; error: "invalid_time_zone" | "error" };

/**
 * Устройство сообщило свой пояс. active — его сокет сейчас на переднем плане (тогда это и «пользование»);
 * use — засчитать сообщение как пользование, не помечая устройство активным (REST-путь: клиент зовёт его
 * с переднего плана, а «ушло с переднего плана» по HTTP не узнать). Новое устройство, не бывшее на
 * переднем плане, получает usedAt = 0: оно станет выбранным, только если других устройств с поясом нет.
 * Заодно — восстановление настройки от клиента (reassertShare).
 */
export async function reportDeviceTimeZone(opts: {
  userId: string;
  deviceKey: string;
  timeZone: unknown;
  active?: boolean;
  use?: boolean;
  shareLocalTime?: unknown;
  shareLocalTimeAt?: unknown;
  now?: number;
}): Promise<ReportResult> {
  const tz = normalizeTimeZone(opts.timeZone);
  if (!tz) return { ok: false, error: "invalid_time_zone" };
  const now = opts.now ?? Date.now();
  try {
    await serialized(opts.userId, async () => {
      await updateRecordLocked(opts.userId, opts.deviceKey, (rec) => {
        const active = opts.active === true;
        const base: DeviceTzRecord = rec ?? { tz: null, usedAt: 0, active: false };
        return {
          tz,
          usedAt: active || opts.use === true ? now : base.usedAt,
          active: active ? true : base.active,
        };
      });
      await recomputeLocked(opts.userId, now);
    });
    if (typeof opts.shareLocalTime === "boolean") {
      await reassertShare(opts.userId, opts.shareLocalTime, opts.shareLocalTimeAt, now);
    }
    const share = await getShareState(opts.userId);
    return { ok: true, timeZone: tz, ...share };
  } catch (error) {
    logger.warn({ error, userId: opts.userId }, "localtime: report failed");
    return { ok: false, error: "error" };
  }
}

/**
 * Приложение на устройстве вышло на передний план (active=true) или ушло с него (false). Уход с
 * переднего плана — тоже момент пользования: usedAt = сейчас (если до этого было активно).
 * Устройство без записи создаётся (пояс придёт следом — порядок событий при подключении любой).
 */
export async function noteDeviceActivity(opts: { userId: string; deviceKey: string; active: boolean; now?: number }): Promise<void> {
  const now = opts.now ?? Date.now();
  try {
    await serialized(opts.userId, async () => {
      const { before, after } = await updateRecordLocked(opts.userId, opts.deviceKey, (rec) => {
        if (opts.active) return { tz: rec?.tz ?? null, usedAt: now, active: true };
        if (!rec) return null; // ни разу не было активным и пояса нет — нечего записывать
        if (!rec.active) return null; // уже неактивно — без записи
        return { tz: rec.tz, usedAt: now, active: false };
      });
      if (after?.tz || before?.tz) await recomputeLocked(opts.userId, now);
    });
  } catch (error) {
    logger.warn({ error, userId: opts.userId }, "localtime: activity update failed");
  }
}

/** Хартбит активного сокета: продлить «пользование» устройства (только если у него есть пояс). */
export async function bumpDeviceUse(opts: { userId: string; deviceKey: string; now?: number }): Promise<void> {
  const now = opts.now ?? Date.now();
  try {
    await serialized(opts.userId, async () => {
      const { after } = await updateRecordLocked(opts.userId, opts.deviceKey, (rec) =>
        rec && rec.tz ? { tz: rec.tz, usedAt: now, active: true } : null,
      );
      if (after) await recomputeLocked(opts.userId, now);
    });
  } catch (error) {
    logger.warn({ error, userId: opts.userId }, "localtime: bump failed");
  }
}

/** Устройство отозвано — его пояс больше не учитывается. */
export async function forgetDevice(userId: string, deviceId: string): Promise<void> {
  try {
    await serialized(userId, async () => {
      const redis = await getRedisClient();
      await redis.hDel(devKey(userId), localTimeDeviceKey(deviceId));
      await recomputeLocked(userId, Date.now());
    });
  } catch (error) {
    logger.warn({ error, userId }, "localtime: forget device failed");
  }
}

// ───────────────────────────── Настройка ─────────────────────────────

async function writeShareAndAnnounce(userId: string, next: LocalTimeShareState, prev: LocalTimeShareState): Promise<void> {
  const redis = await getRedisClient();
  await redis.set(shareKey(userId), JSON.stringify({ share: next.shareLocalTime, at: next.shareLocalTimeAt }));
  await emitToRooms([`user:${userId}`], LOCALTIME_SETTINGS_EVENT, next);
  if (next.shareLocalTime !== prev.shareLocalTime) await broadcastToPeers(userId);
}

/** Человек переключил «Показывать моё местное время». Возвращает новое состояние. */
export async function setShareLocalTime(userId: string, share: boolean, now: number = Date.now()): Promise<LocalTimeShareState> {
  return serialized(userId, async () => {
    const prev = await getShareState(userId);
    // Момент изменения строго растёт — даже если часы сервера отстали от записанного.
    const next = { shareLocalTime: share, shareLocalTimeAt: Math.max(now, prev.shareLocalTimeAt + 1) };
    await writeShareAndAnnounce(userId, next, prev);
    return next;
  });
}

/**
 * Клиент напомнил последнее известное ему состояние настройки (вместе с поясом). Принимаем, только
 * если оно новее записанного: так настройка переживает потерю/откат Redis, а устаревшее устройство
 * не перебивает свежее изменение с другого. at — момент по часам сервера, полученный клиентом от нас.
 */
export async function reassertShare(userId: string, share: boolean, atRaw: unknown, now: number = Date.now()): Promise<void> {
  const at = Number(atRaw);
  if (!Number.isFinite(at) || at <= 0 || at > now + SHARE_FUTURE_SLACK_MS) return;
  try {
    await serialized(userId, async () => {
      const prev = await getShareState(userId);
      if (at <= prev.shareLocalTimeAt) return;
      await writeShareAndAnnounce(userId, { shareLocalTime: share, shareLocalTimeAt: Math.floor(at) }, prev);
    });
  } catch (error) {
    logger.warn({ error, userId }, "localtime: reassert failed");
  }
}

/** Экран настроек самого человека. */
export async function getOwnLocalTimeState(
  userId: string,
): Promise<LocalTimeShareState & { localTime: LocalTimeInfo | null }> {
  const [share, localTime] = await Promise.all([getShareState(userId), getOwnEffective(userId)]);
  return { ...share, localTime };
}
