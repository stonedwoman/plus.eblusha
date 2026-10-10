/** Заглушки для юнит-тестов ядра: API Еблуши, сокет, модель. Ни одного сетевого вызова. */
import type { ChatApi } from "../../src/api/eblusha";
import type { RealtimeOut } from "../../src/api/realtime";
import type { EbConversation, EbMessage, SendMessageInput } from "../../src/api/types";
import { loadConfig, type BotConfig } from "../../src/config";
import { Bot } from "../../src/core/bot";
import { ZERO_COST, type CostBreakdown } from "../../src/core/budget";
import { Registry } from "../../src/core/registry";
import { Store } from "../../src/core/store";
import type { AnswerRequest, AnswerResult, LlmEngine } from "../../src/llm/types";
import { silentLogger } from "../../src/log";
import type { BotModule, OutgoingImage } from "../../src/modules/api";

export const BOT = "cbot0000000000000000000001";
export const OWNER = "cowner00000000000000000001";
export const ALICE = "calice00000000000000000001";
export const BOB = "cbob0000000000000000000001";
export const DM_ALICE = "cdmalice000000000000000001";
export const DM_OWNER = "cdmowner000000000000000001";
export const GROUP = "cgroup00000000000000000001";
export const SECRET = "csecret0000000000000000001";

let seq = 0;
export function cuid(prefix = "cmsg"): string {
  seq++;
  return `${prefix}${String(seq).padStart(25 - prefix.length, "0")}`;
}

export function conversations(): EbConversation[] {
  const u = (id: string, name: string) => ({ userId: id, user: { id, displayName: name } });
  return [
    { id: DM_ALICE, isGroup: false, isSecret: false, type: "CLOUD", participants: [u(BOT, "Еблуша"), u(ALICE, "Алиса")] },
    { id: DM_OWNER, isGroup: false, isSecret: false, type: "CLOUD", participants: [u(BOT, "Еблуша"), u(OWNER, "Стон")] },
    { id: GROUP, isGroup: true, isSecret: false, type: "CLOUD", title: "Кобаны", participants: [u(BOT, "Еблуша"), u(ALICE, "Алиса"), u(BOB, "Боб"), u(OWNER, "Стон")] },
    { id: SECRET, isGroup: false, isSecret: true, type: "SECRET", secretStatus: "PENDING", participants: [u(BOT, "Еблуша"), u(ALICE, "Алиса")] },
  ];
}

export class FakeApi implements ChatApi {
  readonly baseUrl = "http://fake";
  readonly userId = BOT;
  sent: SendMessageInput[] = [];
  sentMessages: EbMessage[] = [];
  reactions: Array<{ messageId: string; emoji: string }> = [];
  uploads: Array<{ name: string; mime: string; size: number }> = [];
  declined: string[] = [];
  accepted: string[] = [];
  history = new Map<string, EbMessage[]>();
  convs = conversations();

  async me() {
    return { id: BOT, displayName: "Еблуша", avatarUrl: "/api/files/a.eblusha", bio: "бот" };
  }
  async updateMe() {}
  async listConversations() {
    return this.convs;
  }
  async getMessages(conversationId: string) {
    const all = [...(this.history.get(conversationId) ?? [])].reverse();
    return { messages: all, nextCursor: null };
  }
  async sendMessage(input: SendMessageInput): Promise<EbMessage> {
    if (this.convs.find((c) => c.id === input.conversationId)?.type === "SECRET") throw new Error("409 SECRET_E2EE_ONLY");
    this.sent.push(input);
    const m: EbMessage = {
      id: cuid("cbotmsg"),
      conversationId: input.conversationId,
      senderId: BOT,
      type: input.type,
      content: input.content ?? null,
      createdAt: new Date().toISOString(),
      replyToId: input.replyToId ?? null,
      attachments: (input.attachments ?? []).map((a) => ({ ...a })),
    };
    this.sentMessages.push(m);
    this.addHistory(m);
    return m;
  }
  addHistory(m: EbMessage) {
    const list = this.history.get(m.conversationId) ?? [];
    list.push(m);
    this.history.set(m.conversationId, list);
  }
  async react(messageId: string, emoji: string) {
    this.reactions.push({ messageId, emoji });
  }
  async upload(data: Buffer, name: string, mime: string) {
    this.uploads.push({ name, mime, size: data.length });
    return { url: `/api/files/up${this.uploads.length}.eblusha`, path: `up${this.uploads.length}.eblusha` };
  }
  async declineSecretThread(id: string) {
    this.declined.push(id);
  }
  async acceptContact(id: string) {
    this.accepted.push(id);
  }
  async fetchFile() {
    return null;
  }
  async accessToken() {
    return "token";
  }
}

export class FakeRt implements RealtimeOut {
  events: string[] = [];
  typingStart(c: string) {
    this.events.push(`start:${c}`);
  }
  typingPing(c: string) {
    this.events.push(`ping:${c}`);
  }
  typingStop(c: string) {
    this.events.push(`stop:${c}`);
  }
  declineCall(c: string) {
    this.events.push(`decline:${c}`);
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

export interface Harness {
  bot: Bot;
  api: FakeApi;
  rt: FakeRt;
  llm: FakeLlm;
  store: Store;
  images: OutgoingImage[];
  /** Доставить сообщение боту (как message:notify) и дождаться обработки. */
  deliver(m: EbMessage): Promise<void>;
}

export const PNG_1x1 = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000400000003008060000000000000000",
  "hex"
);

export async function harness(opts: { cfg?: Partial<BotConfig>; modules?: BotModule[]; llm?: FakeLlm | null; now?: () => number } = {}): Promise<Harness> {
  const api = new FakeApi();
  const rt = new FakeRt();
  const llm = opts.llm === undefined ? new FakeLlm() : opts.llm;
  const store = new Store(":memory:");
  const registry = new Registry();
  for (const m of opts.modules ?? []) registry.add(m);
  const images: OutgoingImage[] = [];
  const bot = new Bot({
    cfg: testConfig(opts.cfg),
    api,
    rt,
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
  return {
    bot,
    api,
    rt,
    llm: llm ?? new FakeLlm(),
    store,
    images,
    async deliver(m: EbMessage) {
      api.addHistory(m);
      bot.onMessage({ conversationId: m.conversationId, messageId: m.id, senderId: m.senderId, message: m });
      await bot.idle();
    },
  };
}
