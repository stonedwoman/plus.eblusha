/**
 * Заглушки для юнит-тестов ядра: API Еблуши (/api/bot/*), «сервер» (кто адресован боту, цепочка
 * ответов, разрешения, память — POST /api/bot/history с журналом изменений), модель. Ни одного сетевого вызова.
 */
import { ApiError, type ChatApi, type HistoryQuery } from "../../src/api/eblusha";
import type {
  BotConversationKind,
  BotHistoryMessage,
  BotHistoryPage,
  BotMemoryChange,
  BotJob,
  BotJobMessage,
  BotPeople,
  BotPerson,
  BotPostInput,
  EbMessage,
} from "../../src/api/types";
import { loadConfig, type BotConfig } from "../../src/config";
import { Bot } from "../../src/core/bot";
import { ZERO_COST, type CostBreakdown } from "../../src/core/budget";
import { formatWhen } from "../../src/core/context";
import { stripCommandPrefix, stripNamePrefix } from "../../src/core/invoke";
import { Registry } from "../../src/core/registry";
import { Store } from "../../src/core/store";
import type { AnswerRequest, AnswerResult, LlmEngine, SummarizeRequest, SummarizeResult } from "../../src/llm/types";
import { silentLogger } from "../../src/log";
import type { BotModule, OutgoingImage } from "../../src/modules/api";

export const BOT = "cbot0000000000000000000001";
export const OWNER = "cowner00000000000000000001";
export const ALICE = "calice00000000000000000001";
export const BOB = "cbob0000000000000000000001";
/** Личный «Чат с Еблушей» Алисы (kind "bot"). */
export const DM_ALICE = "cdmalice000000000000000001";
/** Личный «Чат с Еблушей» владельца (kind "bot"). */
export const DM_OWNER = "cdmowner000000000000000001";
/** Группа «Кобаны»: Алиса, Боб, владелец (бот — не участник). */
export const GROUP = "cgroup00000000000000000001";
/** Личка Алисы и Боба (kind "dm"): ответ бота видят оба. */
export const PAIR = "cpair000000000000000000001";
/** Саня Петров (EBLID 1111) — участник группы «Игроки»; Саня Иванов (EBLID 2222) — ни в одной беседе с ботом. */
export const SANYA = "csanya00000000000000000001";
export const SANYA2 = "csanya00000000000000000002";
/** Группа «Игроки»: владелец, Алиса, Саня Петров. */
export const GAMERS = "cgamers0000000000000000001";

export const NAMES: Record<string, string> = {
  [BOT]: "Еблуша",
  [OWNER]: "Стон",
  [ALICE]: "Алиса",
  [BOB]: "Боб",
  [SANYA]: "Саня Петров",
  [SANYA2]: "Саня Иванов",
};
/** Люди мессенджера (для POST /api/bot/people): имя и EBLID. */
export const DIRECTORY: Array<{ id: string; displayName: string; eblid: string; username?: string }> = [
  { id: OWNER, displayName: "Стон", eblid: "7001", username: "ston" },
  { id: ALICE, displayName: "Алиса", eblid: "7002", username: "alice" },
  { id: BOB, displayName: "Боб", eblid: "7003", username: "bob" },
  { id: SANYA, displayName: "Саня Петров", eblid: "1111", username: "sanya_p" },
  { id: SANYA2, displayName: "Саня Иванов", eblid: "2222", username: "sanya_i" },
];

export const CONVS: Record<string, { kind: BotConversationKind; title: string | null; participantIds: string[] }> = {
  [DM_ALICE]: { kind: "bot", title: null, participantIds: [ALICE] },
  [DM_OWNER]: { kind: "bot", title: null, participantIds: [OWNER] },
  [GROUP]: { kind: "group", title: "Кобаны", participantIds: [ALICE, BOB, OWNER] },
  [PAIR]: { kind: "dm", title: null, participantIds: [ALICE, BOB] },
  [GAMERS]: { kind: "group", title: "Игроки", participantIds: [OWNER, ALICE, SANYA] },
};
const BOT_CHAT_OF: Record<string, string> = { [ALICE]: DM_ALICE, [OWNER]: DM_OWNER };

/** Часовой пояс бота в тестах (BOT_TIME_ZONE по умолчанию). */
export const TZ = "Europe/Moscow";

let seq = 0;
export function cuid(prefix = "cmsg"): string {
  seq++;
  return `${prefix}${String(seq).padStart(25 - prefix.length, "0")}`;
}

/** Ожидаемая реплика человека: «⟦Имя · дд.мм.гг чч:мм⟧» и текст (как core/context.ts → humanText). */
export function said(m: { senderId: string; createdAt: string; sender?: { displayName?: string | null } | null }, body: string, note = ""): string {
  const name = m.sender?.displayName ?? NAMES[m.senderId] ?? "Участник";
  const owner = m.senderId === OWNER ? " (владелец)" : "";
  return `⟦${name}${owner} · ${formatWhen(m.createdAt, TZ)}${note}⟧\n${body}`;
}

/** Часы «сервера»: время строго растёт (порядок истории — по времени, как на сервере). */
let lastAt = 0;
export function nextAt(): string {
  lastAt = Math.max(Date.now(), lastAt + 1);
  return new Date(lastAt).toISOString();
}

export type Sent = BotPostInput & { conversationId: string };

const triggerOf = (m: EbMessage): string | null => {
  const b = (m.metadata as { bot?: { triggerMessageId?: unknown } } | null | undefined)?.bot;
  return typeof b?.triggerMessageId === "string" ? b.triggerMessageId : null;
};

export class FakeApi implements ChatApi {
  readonly baseUrl = "http://fake";
  readonly userId = BOT;
  sent: Sent[] = [];
  sentMessages: EbMessage[] = [];
  reactions: Array<{ conversationId: string; messageId: string; emoji: string }> = [];
  typingEvents: string[] = [];
  uploads: Array<{ name: string; mime: string; size: number }> = [];
  /** grant → беседа (как Redis на сервере). */
  grants = new Map<string, string>();
  /** grant → обращение (metadata.bot.triggerMessageId ответа; удалено — 409). */
  grantTrigger = new Map<string, string>();
  /** У кого включён «Чат с Еблушей». */
  botChatOn = new Set<string>([ALICE, OWNER]);
  /** Все сообщения «сервера» в порядке создания. */
  all = new Map<string, EbMessage>();
  /** Обращения к боту (metadata.botAsk на сервере). */
  addressed = new Set<string>();
  /** Сервер отказывает в любой отправке (например, 409 BOT_TRIGGER_DELETED — вопрос удалили). */
  postError: ApiError | null = null;
  rejected = 0;

  async me() {
    return { id: BOT, displayName: "Еблуша", avatarUrl: "/api/files/a.eblusha", bio: "бот" };
  }
  async updateMe() {}
  private convOf(grant: string): string {
    const c = this.grants.get(grant);
    if (!c) throw new ApiError(410, "/api/bot/messages", "BOT_GRANT_EXPIRED", "HTTP 410");
    return c;
  }
  async postMessage(input: BotPostInput): Promise<EbMessage> {
    if (this.postError) {
      this.rejected++;
      throw this.postError;
    }
    let conversationId: string;
    let trigger: string | null = null;
    if (input.grant) {
      conversationId = this.convOf(input.grant);
      trigger = this.grantTrigger.get(input.grant) ?? null;
      if (trigger && this.all.get(trigger)?.deletedAt) {
        this.rejected++;
        throw new ApiError(409, "/api/bot/messages", "BOT_TRIGGER_DELETED", "HTTP 409 (BOT_TRIGGER_DELETED)");
      }
    } else {
      const chat = input.userId ? BOT_CHAT_OF[input.userId] : undefined;
      if (!chat || !this.botChatOn.has(input.userId!)) throw new ApiError(409, "/api/bot/messages", "BOT_CHAT_DISABLED", "HTTP 409 (BOT_CHAT_DISABLED)");
      conversationId = chat;
    }
    this.sent.push({ ...input, conversationId });
    const m: EbMessage = {
      id: cuid("cbotmsg"),
      conversationId,
      senderId: BOT,
      type: input.type,
      content: input.content ?? null,
      createdAt: nextAt(),
      replyToId: input.replyToId ?? null,
      attachments: (input.attachments ?? []).map((a) => ({ ...a })),
      isBot: true,
      metadata: { bot: { v: 1, kind: input.kind ?? "answer", ...(trigger ? { triggerMessageId: trigger } : {}) } },
    };
    this.sentMessages.push(m);
    this.all.set(m.id, m);
    return m;
  }
  async typing(grant: string, typing: boolean) {
    this.typingEvents.push(`${typing ? "on" : "off"}:${this.convOf(grant)}`);
  }
  async react(grant: string, messageId: string, emoji: string) {
    this.reactions.push({ conversationId: this.convOf(grant), messageId, emoji });
  }
  async upload(data: Buffer, name: string, mime: string) {
    this.uploads.push({ name, mime, size: data.length });
    return { url: `/api/files/up${this.uploads.length}.eblusha`, path: `up${this.uploads.length}.eblusha` };
  }
  async fetchFile() {
    return null;
  }
  /** Сервер без POST /api/bot/people (старый) — 404. */
  peopleAvailable = true;
  peopleCalls: Array<{ query?: string; ids?: string[] }> = [];
  /** Как lookupBotPeople сервера: участники беседы, поиск по имени (и основе слова)/логину/EBLID, имена по id. */
  async people(grant: string, input: { query?: string; ids?: string[] }): Promise<BotPeople> {
    if (!this.peopleAvailable) throw new ApiError(404, "/api/bot/people", null, "HTTP 404 POST /api/bot/people");
    const conversationId = this.convOf(grant);
    this.peopleCalls.push({ ...input });
    const parts = new Set(CONVS[conversationId]?.participantIds ?? []);
    const person = (u: { id: string; displayName: string; eblid: string }): BotPerson => ({ id: u.id, displayName: u.displayName, eblid: u.eblid, inConversation: parts.has(u.id) });
    const q = (input.query ?? "").trim().toLowerCase().replace(/ё/g, "е");
    const variants = q ? [q, ...q.split(/\s+/).filter((w) => w.length >= 4).map((w) => w.slice(0, Math.max(3, w.length - 2)))] : [];
    const matches: BotPerson[] = [];
    for (const u of [...DIRECTORY, ...this.extraPeople]) {
      const by = u.eblid === q ? "eblid" : u.username && u.username === q ? "username" : variants.some((v) => u.displayName.toLowerCase().replace(/ё/g, "е").includes(v)) ? "name" : null;
      if (by) matches.push({ ...person(u), matchedBy: by });
    }
    return {
      participants: DIRECTORY.filter((u) => parts.has(u.id)).map(person),
      matches: q ? matches : [],
      users: DIRECTORY.filter((u) => (input.ids ?? []).includes(u.id)).map(person),
    };
  }
  /** Ещё люди мессенджера (тесты поиска: «Оксана» по основе «Сан»). */
  extraPeople: Array<{ id: string; displayName: string; eblid: string; username?: string }> = [];

  // ---------------------------------------------------------------- память (POST /api/bot/history)
  /** Сервер без маршрута (старый) — 404. */
  historyAvailable = true;
  historyCalls: HistoryQuery[] = [];
  /** Журнал изменений: когда изменено и createdAt изменённого (как таблица BotMemoryChange сервера). */
  memlog: Array<{ id: string; conversationId: string; messageId: string; kind: "deleted" | "edited"; changedAt: number; at: number }> = [];
  epoch = "epoch-1";
  /** Как сервер: журнал отдаётся с запасом по времени до changesSince (BOT_MEMLOG_OVERLAP_MS). */
  memlogOverlapMs = 10_000;
  /** Сервер не присылает список изменений (только changedFrom) — проверка запасного пути бота. */
  memlogListOff = false;
  /** Часы журнала: строго растут (на сервере удаление записывается до следующей проверки — без совпадений в мс). */
  private clock = 0;
  private tick(): number {
    this.clock = Math.max(Date.now(), this.clock + 1);
    return this.clock;
  }

  private relevant(m: EbMessage, mode: "botchat" | "recent"): boolean {
    return mode === "botchat" || m.isBot === true || m.senderId === BOT || this.addressed.has(m.id);
  }

  /** Как loadBotHistoryPage + botMemoryStatus сервера, в порядке создания. */
  async history(grant: string, input: HistoryQuery): Promise<BotHistoryPage> {
    if (!this.historyAvailable) throw new ApiError(404, "/api/bot/history", null, "HTTP 404 POST /api/bot/history");
    const conversationId = this.convOf(grant);
    const trigger = this.grantTrigger.get(grant);
    if (trigger && this.all.get(trigger)?.deletedAt) throw new ApiError(409, "/api/bot/history", "BOT_TRIGGER_DELETED", "HTTP 409");
    this.historyCalls.push({ ...input });
    const checkedAt = this.tick();
    let reset = false;
    let changedFrom: string | null = null;
    let changes: BotMemoryChange[] = [];
    if (input.changesSince !== undefined && input.changesSince !== null) {
      if (input.epoch !== this.epoch) reset = true;
      else {
        const ch = this.memlog.filter((c) => c.conversationId === conversationId && c.changedAt > input.changesSince! - this.memlogOverlapMs);
        if (ch.length) changedFrom = new Date(Math.min(...ch.map((c) => c.at))).toISOString();
        changes = ch.map((c) => ({ id: c.id, messageId: c.messageId, at: new Date(c.at).toISOString(), kind: c.kind, loggedAt: c.changedAt }));
      }
    }
    const mode = CONVS[conversationId]?.kind === "bot" ? "botchat" : "recent";
    const seqAll = [...this.all.values()].filter((m) => m.conversationId === conversationId);
    let start = 0;
    if (input.after) {
      const idx = input.after.id ? seqAll.findIndex((m) => m.id === input.after!.id) : -1;
      if (idx >= 0) start = idx + 1;
      else {
        const a = Date.parse(input.after.at);
        start = seqAll.findIndex((m) => (input.after!.id ? Date.parse(m.createdAt) > a : Date.parse(m.createdAt) >= a));
        if (start < 0) start = seqAll.length;
      }
    }
    const limit = input.limit ?? 200;
    const rest = seqAll.slice(start).filter((m) => !m.deletedAt && this.relevant(m, mode));
    const page = limit > 0 ? rest.slice(0, limit) : [];
    const messages: BotHistoryMessage[] = page
      .filter((m) => {
        if (!(m.isBot || m.senderId === BOT)) return true;
        const t = triggerOf(m);
        if (!t) return true;
        const tm = this.all.get(t);
        return !!tm && !tm.deletedAt && (mode === "botchat" || this.addressed.has(t));
      })
      .map((m) => ({ ...jobMessage(m), ...(triggerOf(m) ? { triggerId: triggerOf(m)! } : {}) }));
    const last = page[page.length - 1];
    return {
      mode,
      messages,
      next: limit > 0 && rest.length > page.length && last ? { at: last.createdAt, id: last.id } : null,
      memory: { epoch: this.epoch, checkedAt, reset, changedFrom, changes: this.memlogListOff ? null : changes, truncated: false },
    };
  }

  private logChange(m: EbMessage, kind: "deleted" | "edited"): void {
    const mode = CONVS[m.conversationId]?.kind === "bot" ? "botchat" : "recent";
    if (!this.relevant(m, mode)) return;
    this.memlog.push({ id: `chg${this.memlog.length + 1}`, conversationId: m.conversationId, messageId: m.id, kind, changedAt: this.tick(), at: Date.parse(m.createdAt) });
  }

  /**
   * Человек поправил сообщение: как POST /messages/update — журнал, если бот мог его запомнить; «Еблуша, …»,
   * исправленное в текст без обращения, перестаёт быть обращением (keepAddress: false).
   */
  editMessage(id: string, content: string, opts: { keepAddress?: boolean } = {}): void {
    const m = this.all.get(id);
    if (!m) throw new Error(`нет сообщения ${id}`);
    this.logChange(m, "edited");
    m.content = content;
    if (opts.keepAddress === false) this.addressed.delete(id);
  }

  /** Человек удалил сообщение («Удалить»): сервер пишет журнал, если бот мог его запомнить. */
  deleteMessage(id: string): void {
    const m = this.all.get(id);
    if (!m) throw new Error(`нет сообщения ${id}`);
    m.deletedAt = new Date().toISOString();
    this.logChange(m, "deleted");
  }
}

export class FakeLlm implements LlmEngine {
  readonly model = "claude-opus-5-5";
  calls: AnswerRequest[] = [];
  reply: (req: AnswerRequest) => Promise<Partial<AnswerResult>> | Partial<AnswerResult> = () => ({ text: "Ответ модели **жирный**." });
  matchCalls: Array<{ input: string; known: string[] }> = [];
  matchReply: string | null = null;
  /** Сжатие памяти: по умолчанию сводка = прежняя + новые реплики (тесты ищут в ней факты). */
  summarizeCalls: SummarizeRequest[] = [];
  summarizeReply: ((req: SummarizeRequest) => Partial<SummarizeResult> | Promise<Partial<SummarizeResult>>) | null = null;
  async answer(req: AnswerRequest): Promise<AnswerResult> {
    this.calls.push(req);
    const r = await this.reply(req);
    const cost: CostBreakdown = r.cost ?? { ...ZERO_COST, usd: 0.05, inputTokens: 1000, outputTokens: 200, models: [this.model] };
    return { text: r.text ?? "", sources: r.sources ?? [], cost, stop: r.stop ?? "end_turn", servedBy: this.model, ...(r.refusalCategory !== undefined ? { refusalCategory: r.refusalCategory } : {}) };
  }
  async matchCharacter(input: string, known: string[]) {
    this.matchCalls.push({ input, known });
    return { character: this.matchReply, cost: { ...ZERO_COST, usd: 0.001, inputTokens: 100, models: [this.model] } };
  }
  async summarize(req: SummarizeRequest): Promise<SummarizeResult> {
    this.summarizeCalls.push(req);
    const r = (await this.summarizeReply?.(req)) ?? {};
    return {
      text: r.text ?? `${req.previous ? `${req.previous}\n` : ""}${req.transcript}`,
      cost: r.cost ?? { ...ZERO_COST, usd: 0.002, inputTokens: 500, outputTokens: 100, models: ["claude-sonnet-5-5"] },
      model: "claude-sonnet-5-5",
      stop: r.stop ?? "end_turn",
    };
  }
}

export function testConfig(over: Partial<BotConfig> = {}): BotConfig {
  return {
    ...loadConfig({ BOT_USERNAME: "eblusha_bot", BOT_PASSWORD: "x", BOT_DATA_DIR: ":memory:" } as NodeJS.ProcessEnv),
    ownerUserId: OWNER,
    anthropicApiKey: "test",
    ...over,
  };
}

export function msg(p: Partial<EbMessage> & { conversationId: string; senderId: string; content: string | null }): EbMessage {
  return {
    id: p.id ?? cuid(),
    type: p.type ?? "TEXT",
    createdAt: nextAt(),
    replyToId: p.replyToId ?? null,
    attachments: p.attachments ?? [],
    ...p,
  } as EbMessage;
}

export function jobMessage(m: EbMessage): BotJobMessage {
  return {
    id: m.id,
    senderId: m.senderId,
    senderName: m.sender?.displayName ?? NAMES[m.senderId] ?? null,
    isBot: m.isBot === true || m.senderId === BOT,
    type: m.type === "SYSTEM" || m.type === "CALL" ? "TEXT" : m.type,
    content: m.content,
    createdAt: m.createdAt,
    replyToId: m.replyToId ?? null,
    attachments: (m.attachments ?? []).map((a) => ({ url: a.url, type: a.type, size: a.size ?? null, metadata: a.metadata ?? null })),
  };
}

export interface Harness {
  bot: Bot;
  api: FakeApi;
  llm: FakeLlm;
  store: Store;
  images: OutgoingImage[];
  /**
   * «Отправить» сообщение в беседу, как это делает сервер: сохранить, решить, адресовано ли оно боту
   * (те же правила, что detectBotAddress), и если да — отдать боту задачу с цепочкой и разрешением.
   * Возвращает задачу (или null — боту не досталось) после того, как бот её обработал.
   */
  deliver(m: EbMessage, over?: Partial<BotJob>): Promise<BotJob | null>;
}

export const PNG_1x1 = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000400000003008060000000000000000",
  "hex"
);

export async function harness(
  opts: {
    cfg?: Partial<BotConfig>;
    modules?: BotModule[];
    llm?: FakeLlm | null;
    now?: () => number;
    /** Сервер с памятью (контракт rev 3: есть POST /api/bot/history); без этого — задача как у старого (rev 1). */
    memory?: boolean;
    /** API без people() вовсе (совсем старый клиент). */
    noPeopleApi?: boolean;
    /** Общие «сервер» и хранилище (перезапуск бота: тот же сервер, та же SQLite). */
    api?: FakeApi;
    store?: Store;
  } = {}
): Promise<Harness> {
  const api = opts.api ?? new FakeApi();
  if (opts.noPeopleApi) (api as { people?: unknown }).people = undefined;
  const llm = opts.llm === undefined ? new FakeLlm() : opts.llm;
  const store = opts.store ?? new Store(":memory:");
  const registry = new Registry();
  for (const m of opts.modules ?? []) registry.add(m);
  const images: OutgoingImage[] = [];
  const now = opts.now ?? Date.now;
  const bot = new Bot({
    cfg: testConfig(opts.cfg),
    api,
    store,
    llm: llm ?? null,
    registry,
    log: silentLogger,
    ...(opts.now ? { now: opts.now } : {}),
    typingIntervalMs: 5,
    downloadImage: async (url) => {
      if (url.includes("broken")) throw new Error("nope");
      const img: OutgoingImage = { data: PNG_1x1, mime: "image/png", width: 64, height: 48, name: "pic.png" };
      images.push(img);
      return img;
    },
  });
  await bot.start();
  let grantSeq = 0;
  return {
    bot,
    api,
    llm: llm ?? new FakeLlm(),
    store,
    images,
    async deliver(m: EbMessage, over: Partial<BotJob> = {}) {
      api.all.set(m.id, m);
      const conv = CONVS[m.conversationId];
      if (!conv) return null;
      const parent = m.replyToId ? api.all.get(m.replyToId) : undefined;
      const text = m.content ?? "";
      const via =
        conv.kind === "bot"
          ? "botchat"
          : m.type === "AUDIO"
            ? null // голосовое вне «Чата с Еблушей» — людям (detectBotAddress сервера)
            : stripNamePrefix(text) !== null
            ? "name"
            : stripCommandPrefix(text) !== null
              ? "command"
              : parent && parent.conversationId === m.conversationId && (parent.isBot || parent.senderId === BOT)
                ? "reply"
                : null;
      if (!via) return null;
      api.addressed.add(m.id);
      const chain: BotJobMessage[] = [];
      let pid = m.replyToId ?? null;
      while (pid && chain.length < 11) {
        const p = api.all.get(pid);
        if (!p || p.conversationId !== m.conversationId || p.deletedAt) break;
        chain.unshift(jobMessage(p));
        pid = p.replyToId ?? null;
      }
      const grant = `grant_${grantSeq++}_${Math.random().toString(36).slice(2)}_xxxxxxxx`;
      api.grants.set(grant, m.conversationId);
      api.grantTrigger.set(grant, m.id);
      const t = now();
      const job: BotJob = {
        v: 1,
        ...(opts.memory ? { rev: 3 } : {}),
        kind: "message",
        enqueuedAt: t,
        grant,
        grantExpiresAt: t + 20 * 60_000,
        via,
        conversation: { id: m.conversationId, ...conv },
        author: { id: m.senderId, displayName: m.sender?.displayName ?? NAMES[m.senderId] ?? null },
        message: jobMessage(m),
        chain,
        ...over,
      };
      await bot.handleJob(job);
      await bot.idle();
      return job;
    },
  };
}
