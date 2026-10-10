/**
 * Контекст для модели — цепочка ответов из задачи очереди (сервер собрал её сам: триггер и его
 * предки по replyTo в этой беседе, src/lib/systemBot.ts → loadReplyChain). Остальную переписку бот
 * не видит и не запрашивает. Текст сообщений бот на диск не пишет.
 */
import type { ChatApi } from "../api/eblusha";
import type { BotJob, BotJobMessage } from "../api/types";
import type { LlmImage, LlmTurn } from "../llm/types";
import { sniffImage } from "./images";
import { invocationText } from "./invoke";

/** Цепочка от самого старого к триггеру (включительно), не длиннее max. */
export function jobChain(job: BotJob, max: number): BotJobMessage[] {
  const all = [...job.chain, job.message];
  return all.slice(Math.max(0, all.length - Math.max(1, max)));
}

export function messageText(m: BotJobMessage): string {
  const stripped = invocationText(m.content);
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
  nameOf(m: BotJobMessage): string;
  /** Загрузить картинки сообщения (для триггера и того, на что он отвечает). */
  loadImages?(m: BotJobMessage): Promise<LlmImage[]>;
}

export async function chainToTurns(chain: BotJobMessage[], o: TurnOptions): Promise<LlmTurn[]> {
  const turns: LlmTurn[] = [];
  const trigger = chain[chain.length - 1];
  const triggerParent = chain.length > 1 ? chain[chain.length - 2] : undefined;
  for (const m of chain) {
    if (m.isBot) {
      turns.push({ role: "assistant", text: m.content?.trim() || (m.attachments?.length ? "[картинка]" : "…") });
      continue;
    }
    const t: LlmTurn = { role: "user", text: `${o.nameOf(m)}: ${messageText(m) || "(без текста)"}` };
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
export async function loadMessageImages(api: Pick<ChatApi, "fetchFile">, m: BotJobMessage): Promise<LlmImage[]> {
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
