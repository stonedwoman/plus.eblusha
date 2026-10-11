/**
 * Тексты таймера обещания (docs/promise-timer.md): запасной текст карточки для старых клиентов (время — по Москве с
 * «МСК»: текст один на всех зрителей и ничей пояс не раскрывает) и напоминания бота в срок / +15 / +30.
 * Имена людей не склоняем (это их displayName), глаголы — в мужском роде, как во всём приложении.
 */
import { hmIn } from "./promiseTime";

export const FALLBACK_ZONE = "Europe/Moscow";

/** «запас 3 мин» / «1 ч 12 мин» / «42 с». */
export function durationRu(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  if (s < 60) return `${s} с`;
  const min = Math.floor(s / 60);
  if (min < 60) return `${min} мин`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} ч ${m} мин` : `${h} ч`;
}

export function plural(n: number, one: string, few: string, many: string): string {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}

export const timesRu = (n: number) => `${n} ${plural(n, "раз", "раза", "раз")}`;

/** Цитата для запасного текста: ≤ 60 знаков, без переводов строк; удалённая — «(сообщение удалено)». */
export function quoteShort(quote: string | null | undefined): string {
  if (!quote) return "(сообщение удалено)";
  const q = quote.replace(/\s+/g, " ").replace(/[«»]/g, "\"").trim();
  return `«${q.length > 60 ? `${q.slice(0, 59).trimEnd()}…` : q}»`;
}

const hm = (d: Date) => hmIn(d.getTime(), FALLBACK_ZONE);
const bold = (name: string) => `**${name.replace(/\*/g, "")}**`;

export interface FallbackInput {
  status: "RUNNING" | "ARRIVED" | "CANCELLED" | "UNRESOLVED";
  promiserName: string;
  quote: string | null;
  deadlineAt: Date;
  extensionCount: number;
  arrivedAt: Date | null;
  lateSec: number | null;
  now: Date;
}

/** Запасной текст карточки (первая строка — превью в списке бесед). */
export function promiseFallbackText(i: FallbackInput): string {
  const name = bold(i.promiserName);
  const q = quoteShort(i.quote);
  const ext = i.extensionCount > 0 ? ` (продлевал ${timesRu(i.extensionCount)})` : "";
  switch (i.status) {
    case "RUNNING":
      if (i.now.getTime() >= i.deadlineAt.getTime()) return `⏰ ${name} опаздывает — срок был ${hm(i.deadlineAt)} МСК. Обещал ${q}.`;
      if (i.extensionCount > 0) return `⏱ Таймер: ${name} — жду до ${hm(i.deadlineAt)} МСК${ext}. Обещал ${q}.`;
      return `⏱ Таймер: ${name} обещал ${q} — жду до ${hm(i.deadlineAt)} МСК.\nЖивой таймер — в новой версии Еблуши.`;
    case "ARRIVED": {
      const late = i.lateSec ?? 0;
      const at = i.arrivedAt ?? i.now;
      if (late > 0) {
        return `⌛ ${name} опоздал на ${durationRu(late)} — пришёл в ${hm(at)} МСК (срок ${hm(i.deadlineAt)}).${i.extensionCount > 0 ? ` Продлевал ${timesRu(i.extensionCount)}.` : ""}`;
      }
      const spare = -late;
      const tail = spare < 1 ? "секунда в секунду" : spare < 60 ? "запас меньше минуты" : `запас ${durationRu(spare)}`;
      return `✅ ${name} пришёл вовремя — ${hm(at)} МСК, ${tail}. Обещал ${q}.`;
    }
    case "CANCELLED":
      return `Таймер для ${name} отменён.`;
    case "UNRESOLVED":
      return `Таймер для ${name} остановлен: никто не отметил приход (срок был ${hm(i.deadlineAt)} МСК).`;
  }
}

/** Напоминания (по кругу, без повторов подряд в одной беседе). {name} — жирное имя, {label} — метка срока. */
export const REMINDER_TEMPLATES: Record<number, string[]> = {
  0: ["{name}, время вышло ⏰ Ждём!", "Тик-так, {name}. Обещанные {label} истекли 👀", "{name}, срок! Таймер уже считает в обратную сторону."],
  15: ["{name}, уже +15 минут. Мы начинаем сомневаться 🤔", "+15. {name}, ты там жив?", "{name}, четверть часа сверху. Всё записано."],
  30: ["{name}, +30 минут. Записываю в летопись опозданий 📜", "Полчаса сверху, {name}. Таймер всё помнит.", "{name}, +30. Больше не напоминаю — просто жду."],
};

export function reminderText(offset: number, index: number, promiserName: string, label: string): string {
  const list = REMINDER_TEMPLATES[offset] ?? REMINDER_TEMPLATES[0]!;
  const t = list[((index % list.length) + list.length) % list.length]!;
  return t.replace("{name}", bold(promiserName)).replace("{label}", label);
}
