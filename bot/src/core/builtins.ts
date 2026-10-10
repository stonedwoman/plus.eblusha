/** Встроенные команды ядра (без модели). */
import type { ChatCommand } from "../modules/api";
import type { Budget } from "./budget";
import type { Registry } from "./registry";

const HELP_RE = /^(?:помощь|help|справка|что\s+(?:ты\s+)?умеешь\??|команды)$/i;
const SPEND_RE = /^(?:расход|траты|бюджет|сколько\s+потратил[аи]?\??)$/i;

export function builtinCommands(budget: Budget, registry: Registry): ChatCommand<any>[] {
  const help: ChatCommand<true> = {
    name: "help",
    access: "anyone",
    help: "`/eb помощь` — что я умею",
    match: (t) => (HELP_RE.test(t.trim()) ? true : null),
    async run(_a, ctx) {
      const lines = [
        "**Я — Еблуша.** Отвечаю на что угодно, умею искать в интернете и давать ссылки на источники.",
        "",
        "- Позвать: начни сообщение с «Еблуша,» (или «Еблуша:», «Еблуша!») или с `/eb`.",
        "- Продолжить разговор: ответь (reply) на моё сообщение.",
        "- «Спасибо» в ответ — поставлю 👍.",
        "- В секретных чатах я не работаю.",
      ];
      if (registry.characters) lines.push("- Привязать ник в игре: «Еблуша, мой ник в игре Парасюха».");
      const extra = registry.commands
        .filter((c) => c.help && (c.access !== "owner" || (ctx.requester.isOwner && ctx.chat.kind === "dm")))
        .map((c) => `- ${c.help}`);
      if (extra.length) lines.push("", "**Команды:**", ...extra);
      return { text: lines.join("\n") };
    },
  };

  const spend: ChatCommand<true> = {
    name: "spend",
    access: "owner",
    help: "`/eb расход` — сколько потрачено на модель",
    match: (t) => (SPEND_RE.test(t.trim()) ? true : null),
    async run() {
      const s = budget.summary();
      return {
        text: [
          `**Расход на модель, ${s.month}:** $${s.spentUsd.toFixed(2)} из $${s.capUsd.toFixed(0)}`,
          `- сегодня: $${s.todayUsd.toFixed(2)} из $${s.dayCapUsd.toFixed(0)}`,
          `- обращений к модели: ${s.requests}, людей: ${s.users}, поисков: ${s.webSearches}`,
        ].join("\n"),
      };
    },
  };
  return [help, spend];
}
