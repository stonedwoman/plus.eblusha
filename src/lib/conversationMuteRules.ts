/**
 * «Без звука» для бесед — чистые правила, без БД и сокетов (их можно гонять в юнит-тесте где угодно).
 * Хранение, REST, события и фильтр пушей — src/lib/conversationMute.ts. Контракт клиентам —
 * docs/conversation-mute.md. Клиенты (веб, натив, Android, iOS) повторяют ровно эти правила.
 *
 * Хранится одно поле — ConversationParticipant.mutedUntil (момент по часам СЕРВЕРА, UTC):
 *   null           — звук включён;
 *   > now          — заглушено до этого момента;
 *   ≤ now          — истекло, то же, что null (сервер ничего не стирает: истечение = сравнение с now);
 *   MUTE_FOREVER   — «Навсегда» (2100-01-01T00:00:00.000Z).
 */

/** «Навсегда». Всё, что дальше now + MUTE_MAX_SPAN_MS, сервер записывает этим значением. */
export const MUTE_FOREVER = new Date("2100-01-01T00:00:00.000Z");
/** С этого момента срок считается «навсегда» (запас на часы клиентов, которые сравнивают сами). */
export const MUTE_FOREVER_FROM_MS = Date.parse("2099-12-31T00:00:00.000Z");
/** Самый дальний конкретный срок (366 суток); дальше — «Навсегда». */
export const MUTE_MAX_SPAN_MS = 366 * 86_400_000;

/** Длительности пресетов, по часам СЕРВЕРА. */
export const MUTE_PRESETS = {
  "1h": 3_600_000,
  "8h": 28_800_000,
  "1d": 86_400_000,
  "1w": 604_800_000,
} as const;
export type MutePreset = keyof typeof MUTE_PRESETS | "forever";
export const MUTE_PRESET_NAMES: readonly MutePreset[] = ["1h", "8h", "1d", "1w", "forever"];

function ms(until: Date | null | undefined): number | null {
  if (!until) return null;
  const t = until.getTime();
  return Number.isFinite(t) ? t : null;
}

/** Заглушено ли в момент nowMs: until > now (строго). */
export function isMutedAt(until: Date | null | undefined, nowMs: number = Date.now()): boolean {
  const t = ms(until);
  return t !== null && t > nowMs;
}

/** «Навсегда» (until ≥ 2099-12-31T00:00Z). */
export function isForever(until: Date | null | undefined): boolean {
  const t = ms(until);
  return t !== null && t >= MUTE_FOREVER_FROM_MS;
}

/**
 * Что записать по запросу «до until»: ≤ now (или мусор) → null (включить звук);
 * дальше now + 366 суток → MUTE_FOREVER; иначе — как есть.
 */
export function normalizeUntil(until: Date | null | undefined, nowMs: number): Date | null {
  const t = ms(until);
  if (t === null || t <= nowMs) return null;
  if (t > nowMs + MUTE_MAX_SPAN_MS) return MUTE_FOREVER;
  return new Date(t);
}

/** Срок пресета от nowMs (часы сервера). */
export function untilForPreset(preset: MutePreset, nowMs: number): Date {
  if (preset === "forever") return MUTE_FOREVER;
  return new Date(nowMs + MUTE_PRESETS[preset]);
}

/** Действующий срок: истёкший → null. */
export function effectiveUntil(until: Date | null | undefined, nowMs: number): Date | null {
  return isMutedAt(until, nowMs) ? new Date(ms(until)!) : null;
}

/** Как срок уходит клиенту (список бесед, событие, снапшот, ответ REST). */
export type MuteView = { mutedUntil: string | null; mutedForever: boolean };
export function muteView(until: Date | null | undefined, nowMs: number): MuteView {
  const eff = effectiveUntil(until, nowMs);
  return { mutedUntil: eff ? eff.toISOString() : null, mutedForever: eff ? isForever(eff) : false };
}

/** Системная запись о звонке 1:1, которая пробивает «Без звука»: «Пропущенный звонок», «Звонок продлился…». */
export function isCallSystemMessage(msg: { type?: unknown; metadata?: unknown } | null | undefined): boolean {
  if (!msg || msg.type !== "SYSTEM") return false;
  const m = msg.metadata;
  if (!m || typeof m !== "object" || Array.isArray(m)) return false;
  const md = m as Record<string, unknown>;
  return md.missed === true || md.ended === true;
}

/**
 * Будить ли получателя этим событием (пуш, звук, плашка, уведомление). Отправитель сюда не попадает —
 * его отсекают выше. Правило как в Telegram:
 *   - не заглушено → да;
 *   - группа: ответ на МОЁ сообщение (в т.ч. ответ бота на мой вопрос) или @упоминание меня → да;
 *   - 1:1 (обычная, секретная, «Чат с Еблушей»): только записи о звонке (пропущенный, «продлился») → да,
 *     звонок 1:1 не глушится;
 *   - остальное → нет.
 * «Группа» — только серверный флаг Conversation.isGroup.
 */
export function shouldAlert(opts: {
  mutedUntil: Date | null | undefined;
  nowMs: number;
  isGroup: boolean;
  recipientId: string;
  /** message.replyTo?.senderId */
  replyToSenderId?: string | null;
  /** isCallSystemMessage(message) */
  callSystem?: boolean;
  /** Кого упомянули (@) — когда упоминания появятся; сейчас их нет ни на сервере, ни в клиентах. */
  mentionedUserIds?: readonly string[] | null;
}): boolean {
  if (!isMutedAt(opts.mutedUntil, opts.nowMs)) return true;
  if (opts.isGroup) {
    if (opts.replyToSenderId && opts.replyToSenderId === opts.recipientId) return true;
    if (opts.mentionedUserIds && opts.mentionedUserIds.includes(opts.recipientId)) return true;
    return false;
  }
  return opts.callSystem === true;
}

/** Разобранное тело POST /api/conversations/:id/mute. until: null — «Включить звук». */
export type MuteRequest = { kind: "preset"; preset: MutePreset } | { kind: "until"; until: Date | null };

/**
 * Разбор тела: ровно одно из {for: "1h"|"8h"|"1d"|"1w"|"forever"} или {until: ISO-8601 | null}.
 * Посторонние поля (например deviceId) не мешают. null — тело не годится (400 MUTE_BAD_BODY).
 */
export function parseMuteBody(body: unknown): MuteRequest | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  const hasFor = Object.prototype.hasOwnProperty.call(b, "for") && b.for !== undefined;
  const hasUntil = Object.prototype.hasOwnProperty.call(b, "until") && b.until !== undefined;
  if (hasFor === hasUntil) return null;
  if (hasFor) {
    return typeof b.for === "string" && (MUTE_PRESET_NAMES as readonly string[]).includes(b.for)
      ? { kind: "preset", preset: b.for as MutePreset }
      : null;
  }
  if (b.until === null) return { kind: "until", until: null };
  if (typeof b.until !== "string" || b.until.length > 64) return null;
  // Только полный ISO-8601 с датой, временем и поясом (Z или ±hh:mm): «2026-10-11T18:30:00Z».
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})$/.test(b.until)) return null;
  const t = Date.parse(b.until);
  if (!Number.isFinite(t)) return null;
  return { kind: "until", until: new Date(t) };
}

/** Что записать в mutedUntil по разобранному запросу (nowMs — часы сервера в момент запроса). */
export function resolveMuteRequest(req: MuteRequest, nowMs: number): Date | null {
  if (req.kind === "preset") return untilForPreset(req.preset, nowMs);
  return normalizeUntil(req.until, nowMs);
}
