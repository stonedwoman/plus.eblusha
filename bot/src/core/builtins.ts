/**
 * Встроенное в ядро (без модулей): «что ты умеешь» (без модели) и расход на модель.
 *
 * Решение владельца (2026-10-10): от команд /eb … уходим к свободной форме. Расход владелец
 * спрашивает фразой («сколько потратили?») — это инструмент модели bot_spending; старое «/eb расход»
 * в его «Чате с Еблушей» работает молча (синоним), но нигде не упоминается.
 */
import type { BotTool, ChatCommand } from "../modules/api";
import type { Budget } from "./budget";
import type { Registry } from "./registry";

const HELP_RE = /^(?:помощь|help|справка|что\s+(?:ты\s+)?умеешь\??|команды)$/i;
const SPEND_RE = /^(?:расход|траты|бюджет|сколько\s+потратил[аи]?\??)$/i;

function spendText(budget: Budget): string {
  const s = budget.summary();
  return [
    `**Расход на модель, ${s.month}:** $${s.spentUsd.toFixed(2)} из $${s.capUsd.toFixed(0)}`,
    `- сегодня: $${s.todayUsd.toFixed(2)} из $${s.dayCapUsd.toFixed(0)}`,
    `- обращений к модели: ${s.requests}, людей: ${s.users}, поисков: ${s.webSearches}`,
  ].join("\n");
}

export function builtinCommands(budget: Budget, registry: Registry): ChatCommand<any>[] {
  const help: ChatCommand<true> = {
    name: "help",
    access: "anyone",
    match: (t) => (HELP_RE.test(t.trim()) ? true : null),
    async run(_a, ctx) {
      const lines = [
        "**Я — Еблуша.** Отвечаю на что угодно, умею искать в интернете и давать ссылки на источники. Команды не нужны — пиши как человеку.",
        "",
        "- Позвать в любой беседе: начни сообщение с «Еблуша,» (или «Еблуша:», «Еблуша!»).",
        "- Продолжить разговор: ответь (reply) на моё сообщение.",
        "- Остальную переписку я не вижу — только то, что адресовано мне, и цепочку ответов.",
        "- Личный «Чат с Еблушей» (включается в настройках): там можно без обращения.",
        "- «Спасибо» в ответ — поставлю 👍.",
        "- В секретных чатах я не работаю.",
      ];
      if (registry.characters) {
        lines.push(
          "",
          "**Сервер Valheim:**",
          "- «Как там сервер?», «кто в игре?», «где Саня?», «что лежит в сундуках дома?» — спрашивай словами.",
          "- Привязать свой ник: «Еблуша, мой ник в игре Парасюха».",
          "- Поменять что-то на сервере: «включи бесплатный крафт», «перезапусти, когда все выйдут», «сделай бэкап». Я покажу план, и любой привязанный игрок ответит на него «да». Передумали — ответьте на отчёт «верни как было»."
        );
        if (ctx.requester.isOwner) {
          lines.push("- Владельцу: привязать другого — «Еблуша, его ник …» ответом на его сообщение; снять чужую привязку — «Еблуша, отвяжи персонажа …»; расход — «сколько потратили?».");
        }
      } else if (ctx.requester.isOwner) {
        lines.push("- Владельцу: расход — «сколько потратили?».");
      }
      return { text: lines.join("\n") };
    },
  };

  // Молчаливый синоним «/eb расход» (владелец в своём «Чате с Еблушей»); в остальных местах — bot_spending.
  const spend: ChatCommand<true> = {
    name: "spend",
    access: "owner",
    match: (t) => (SPEND_RE.test(t.trim()) ? true : null),
    async run() {
      return { text: spendText(budget) };
    },
  };
  return [help, spend];
}

/** Инструменты модели ядра. */
export function builtinTools(budget: Budget): BotTool<any>[] {
  const spending: BotTool<Record<string, never>> = {
    name: "bot_spending",
    description:
      "Расход на модель бота «Еблуша» за месяц и за сегодня (в долларах, с потолками). Вызывай, когда ВЛАДЕЛЕЦ спрашивает, сколько потрачено, какие траты, сколько осталось бюджета. Другим людям расходы не показываются (инструмент откажет). Расходы агента сервера Valheim — в server_status.",
    access: "anyone",
    inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
    async run(_i, ctx) {
      if (!ctx.requester.isOwner) return { content: "Расходы бота показываю только владельцу.", isError: false };
      return { content: spendText(budget) };
    },
  };
  return [spending];
}
