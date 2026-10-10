/**
 * Контекст для модели — цепочка ответов, в которой участвует бот (до N сообщений).
 *
 * message:notify приносит сообщение с replyTo {id, content, senderId}, но без вложений и без
 * replyTo самого родителя. Поэтому держим кэш недавно виденных сообщений (в памяти, с TTL —
 * текст на диск не пишем), а чего нет — дочитываем страницей истории беседы.
 */
import type { ChatApi } from "../api/eblusha";
import type { EbMessage } from "../api/types";
import type { LlmImage, LlmTurn } from "../llm/types";
import { sniffImage } from "./images";
import { stripCommandPrefix, stripNamePrefix } from "./invoke";

export class MessageCache {
  private readonly map = new Map<string, { m: EbMessage; at: number }>();

  constructor(
    private readonly api: Pick<ChatApi, "getMessages">,
    private readonly max = 3000,
    private readonly ttlMs = 24 * 3600_000,
    private readonly now: () => number = Date.now
  ) {}

  remember(m: EbMessage): void {
    this.map.delete(m.id);
    this.map.set(m.id, { m, at: this.now() });
    while (this.map.size > this.max) {
      const first = this.map.keys().next().value;
      if (first === undefined) break;
      this.map.delete(first);
    }
  }

  peek(id: string): EbMessage | null {
    const e = this.map.get(id);
    if (!e) return null;
    if (this.now() - e.at > this.ttlMs) {
      this.map.delete(id);
      return null;
    }
    return e.m;
  }

  /** Сообщение беседы по id: из кэша или из истории (до 3 страниц по 100). */
  async get(conversationId: string, id: string): Promise<EbMessage | null> {
    const hit = this.peek(id);
    if (hit && (hit.attachments !== undefined || hit.replyToId !== undefined)) return hit;
    let cursor: string | undefined;
    for (let page = 0; page < 3; page++) {
      const r = await this.api.getMessages(conversationId, 100, cursor);
      for (const m of r.messages) if (m.conversationId === conversationId) this.remember(m);
      const found = r.messages.find((m) => m.id === id);
      if (found) return found.conversationId === conversationId ? found : null;
      if (!r.nextCursor) break;
      cursor = r.nextCursor;
    }
    return hit;
  }
}

function parentId(m: EbMessage): string | null {
  return m.replyToId ?? m.replyTo?.id ?? null;
}

/** Цепочка от самого старого к триггеру (включительно), не длиннее max. */
export async function buildChain(cache: MessageCache, trigger: EbMessage, max: number): Promise<EbMessage[]> {
  const chain: EbMessage[] = [trigger];
  const seen = new Set([trigger.id]);
  let cur = trigger;
  while (chain.length < max) {
    const pid = parentId(cur);
    if (!pid || seen.has(pid)) break;
    const parent = await cache.get(trigger.conversationId, pid);
    if (!parent || parent.deletedAt) break;
    chain.unshift(parent);
    seen.add(parent.id);
    cur = parent;
  }
  return chain;
}

export function messageText(m: EbMessage): string {
  const raw = (m.content ?? "").trim();
  const stripped = stripNamePrefix(raw) ?? stripCommandPrefix(raw) ?? raw;
  const atts = m.attachments ?? [];
  const notes: string[] = [];
  const count = (t: string) => atts.filter((a) => a.type === t).length;
  if (count("IMAGE")) notes.push(`[картинок: ${count("IMAGE")}]`);
  if (count("VIDEO")) notes.push("[видео]");
  if (count("AUDIO")) notes.push("[голосовое сообщение — расшифровки нет]");
  if (count("FILE")) notes.push("[файл]");
  return [stripped, ...notes].filter(Boolean).join(" ");
}

export interface TurnOptions {
  botId: string;
  nameOf(userId: string, m: EbMessage): string;
  /** Загрузить картинки сообщения (для триггера и того, на что он отвечает). */
  loadImages?(m: EbMessage): Promise<LlmImage[]>;
}

export async function chainToTurns(chain: EbMessage[], o: TurnOptions): Promise<LlmTurn[]> {
  const turns: LlmTurn[] = [];
  const trigger = chain[chain.length - 1];
  const triggerParent = chain.length > 1 ? chain[chain.length - 2] : undefined;
  for (const m of chain) {
    if (m.senderId === o.botId) {
      turns.push({ role: "assistant", text: m.content?.trim() || (m.attachments?.length ? "[картинка]" : "…") });
      continue;
    }
    const t: LlmTurn = { role: "user", text: `${o.nameOf(m.senderId, m)}: ${messageText(m) || "(без текста)"}` };
    if (o.loadImages && (m === trigger || m === triggerParent) && (m.attachments ?? []).some((a) => a.type === "IMAGE")) {
      const imgs = await o.loadImages(m);
      if (imgs.length) t.images = imgs;
    }
    turns.push(t);
  }
  while (turns.length && turns[0]!.role !== "user") turns.shift();
  return turns;
}

/** Картинки сообщения Еблуши → блоки для модели (серверные превью, максимум 3). */
export async function loadMessageImages(api: Pick<ChatApi, "fetchFile">, m: EbMessage): Promise<LlmImage[]> {
  const out: LlmImage[] = [];
  for (const a of (m.attachments ?? []).filter((x) => x.type === "IMAGE").slice(0, 3)) {
    const f = (await api.fetchFile(a.url, { thumb: true, maxBytes: 5 * 1024 * 1024 })) ?? (await api.fetchFile(a.url, { maxBytes: 5 * 1024 * 1024 }));
    if (!f) continue;
    const info = sniffImage(f.data);
    if (!info) continue;
    out.push({ mime: info.mime, data: f.data });
  }
  return out;
}
