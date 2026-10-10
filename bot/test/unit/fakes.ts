/**
 * Заглушки для юнит-тестов ядра: API Еблуши (/api/bot/*), «сервер» (кто адресован боту, цепочка
 * ответов, разрешения), модель. Ни одного сетевого вызова.
 */
import { ApiError, type ChatApi } from "../../src/api/eblusha";
import type { BotConversationKind, BotJob, BotJobMessage, BotPostInput, EbMessage } from "../../src/api/types";
import { loadConfig, type BotConfig } from "../../src/config";
import { Bot } from "../../src/core/bot";
import { ZERO_COST, type CostBreakdown } from "../../src/core/budget";
import { stripCommandPrefix, stripNamePrefix } from "../../src/core/invoke";
import { Registry } from "../../src/core/registry";
import { Store } from "../../src/core/store";
import type { AnswerRequest, AnswerResult, LlmEngine } from "../../src/llm/types";
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

export const NAMES: Record<string, string> = { [BOT]: "Еблуша", [OWNER]: "Стон", [ALICE]: "Алиса", [BOB]: "Боб" };

export const CONVS: Record<string, { kind: BotConversationKind; title: string | null; participantIds: string[] }> = {
  [DM_ALICE]: { kind: "bot", title: null, participantIds: [ALICE] },
  [DM_OWNER]: { kind: "bot", title: null, participantIds: [OWNER] },
  [GROUP]: { kind: "group", title: "Кобаны", participantIds: [ALICE, BOB, OWNER] },
  [PAIR]: { kind: "dm", title: null, participantIds: [ALICE, BOB] },
};
const BOT_CHAT_OF: Record<string, string> = { [ALICE]: DM_ALICE, [OWNER]: DM_OWNER };

let seq = 0;
export function cuid(prefix = "cmsg"): string {
  seq++;
  return `${prefix}${String(seq).padStart(25 - prefix.length, "0")}`;
}

export type Sent = BotPostInput & { conversationId: string };

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
  /** У кого включён «Чат с Еблушей». */
  botChatOn = new Set<string>([ALICE, OWNER]);
  history = new Map<string, EbMessage>();
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
    if (input.grant) conversationId = this.convOf(input.grant);
    else {
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
      createdAt: new Date().toISOString(),
      replyToId: input.replyToId ?? null,
      attachments: (input.attachments ?? []).map((a) => ({ ...a })),
      isBot: true,
    };
    this.sentMessages.push(m);
    this.history.set(m.id, m);
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
}

export class FakeLlm implements LlmEngine {
  readonly model = "claude-opus-5-5";
  calls: AnswerRequest[] = [];
  reply: (req: AnswerRequest) => Promise<Partial<AnswerResult>> | Partial<AnswerResult> = () => ({ text: "Ответ модели **жирный**." });
  matchCalls: Array<{ input: string; known: string[] }> = [];
  matchReply: string | null = null;
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
    createdAt: new Date().toISOString(),
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

export async function harness(opts: { cfg?: Partial<BotConfig>; modules?: BotModule[]; llm?: FakeLlm | null; now?: () => number } = {}): Promise<Harness> {
  const api = new FakeApi();
  const llm = opts.llm === undefined ? new FakeLlm() : opts.llm;
  const store = new Store(":memory:");
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
      api.history.set(m.id, m);
      const conv = CONVS[m.conversationId];
      if (!conv) return null;
      const parent = m.replyToId ? api.history.get(m.replyToId) : undefined;
      const text = m.content ?? "";
      const via =
        conv.kind === "bot"
          ? "botchat"
          : stripNamePrefix(text) !== null
            ? "name"
            : stripCommandPrefix(text) !== null
              ? "command"
              : parent && parent.conversationId === m.conversationId && (parent.isBot || parent.senderId === BOT)
                ? "reply"
                : null;
      if (!via) return null;
      const chain: BotJobMessage[] = [];
      let pid = m.replyToId ?? null;
      while (pid && chain.length < 11) {
        const p = api.history.get(pid);
        if (!p || p.conversationId !== m.conversationId) break;
        chain.unshift(jobMessage(p));
        pid = p.replyToId ?? null;
      }
      const grant = `grant_${++grantSeq}_xxxxxxxxxxxxxxxx`;
      api.grants.set(grant, m.conversationId);
      const t = now();
      const job: BotJob = {
        v: 1,
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
