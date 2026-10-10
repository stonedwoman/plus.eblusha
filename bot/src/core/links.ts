/**
 * Привязка персонажей Valheim к людям мессенджера — инструмент модели character_link.
 *
 * Решение владельца 2026-10-10: ВЛАДЕЛЕЦ (BOT_OWNER_USER_ID) привязывает и отвязывает любых людей
 * свободной фразой в любой обычной беседе и в своём «Чате с Еблушей»: «Еблуша, Парасюха — это Саня»,
 * «РомаH — это я», «привяжи IiApaCiOxa к Сане», «отвяжи Парасюху». Остальные — только себя (как и
 * детерминированная самопривязка «мой ник в игре …» в bot.ts). Команд нет: смысл фразы понимает модель,
 * а все проверки — здесь, в коде:
 *   - человек: «я» → тот, кто пишет; иначе сначала участники беседы, потом все люди мессенджера
 *     (POST /api/bot/people — по имени, логину, EBLID); несколько подходящих — варианты модели, она
 *     переспрашивает; не владельцу людей не ищем вовсе (только он сам);
 *   - персонаж: по списку известных серверу (нормализатор похожих букв, nick.ts: IiApaCiOxa = Парасюха);
 *     не нашёлся — список модели (она выберет точный ник или переспросит);
 *   - перепривязка (персонаж был за другим) — в ответе, у кого забрали; отвязка — у кого был.
 * Владельцу — привязка без снятия прежних персонажей человека (их может быть несколько); не владельцу —
 * как раньше: своя новая привязка заменяет прежнюю, чужого персонажа не отобрать, владельцу — уведомление.
 */
import type { BotPeople, BotPerson } from "../api/types";
import type { BotTool, CharacterDirectory, ToolContext, ToolResult } from "../modules/api";
import { cleanNick, fuzzyCharacter, matchCharacter, readableName } from "./nick";
import type { Store } from "./store";

export const LINK_TOOL_NAME = "character_link";

/** Имя человека для текста: без переводов строк и кавычек, ≤ 40 символов. */
export function cleanName(s: string | null | undefined): string {
  const v = (s ?? "").replace(/[\r\n\t]+/g, " ").replace(/[«»"]/g, "").trim().slice(0, 40);
  return v || "Участник";
}

/** «**IiApaCiOxa** (Парасюха)» — ник и как он читается по-русски. */
export function characterMarkup(character: string): string {
  const reading = readableName(character);
  return `**${character}**${reading ? ` (${reading})` : ""}`;
}

/** Уведомление владельцу о новой САМОпривязке (она открывает данные игроков — чужака надо уметь снять). */
export function selfLinkNotice(who: string, character: string, chat: { kind: string; title: string | null }): string {
  const where = chat.kind === "group" ? ` (в группе «${cleanName(chat.title ?? "без названия")}»)` : "";
  return `Новая привязка: «${cleanName(who)}» назвался персонажем ${characterMarkup(character)}${where}. Если это не он — «Еблуша, отвяжи персонажа ${character}».`;
}

const SELF_WORDS = new Set(["я", "меня", "мне", "мной", "себя", "себе", "сам", "сама", "самого", "me", "myself", "self", "i"]);

function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/^@+/, "")
    .replace(/[«»"'“”„`.,!?;:()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function isSelfWord(s: string): boolean {
  return SELF_WORDS.has(norm(s));
}

/**
 * Слово запроса — то же слово имени с другим окончанием (склонение, 1–2 буквы): общее начало от 3 букв, а
 * хвосты у обоих не длиннее 2. «Сане», «Саней», «Саню» → «Саня»; «Иванову» → «Иванов»; «Петру» → «Петр»;
 * но «Петя» ≠ «Петров» (хвост «ров» длиннее).
 */
export function sameWordInflected(qw: string, w: string): boolean {
  if (qw === w) return true;
  let p = 0;
  while (p < qw.length && p < w.length && qw[p] === w[p]) p++;
  return p >= 3 && qw.length - p <= 2 && w.length - p <= 2;
}

/**
 * Насколько человек подходит под запрос: 4 — EBLID; 3 — имя целиком; 2 — слово имени или начало имени;
 * 1 — часть имени (от 3 букв) или то же имя в другом падеже («Сане Иванову» → «Саня Иванов»); 0 — нет.
 */
export function personScore(query: string, p: Pick<BotPerson, "displayName" | "eblid">): number {
  const q = norm(query);
  if (!q) return 0;
  if (/^\d{4}$/.test(q)) return p.eblid === q ? 4 : 0;
  const name = norm(p.displayName ?? "");
  if (!name) return 0;
  if (name === q) return 3;
  const words = name.split(" ");
  if (words.includes(q) || name.startsWith(q)) return 2;
  if (q.length >= 3 && name.includes(q)) return 1;
  const qWords = q.split(" ");
  // одно слово — любое слово имени («Петрову» → «Саня Петров»); несколько — слова имени по порядку
  if (qWords.length === 1 ? words.some((w) => sameWordInflected(q, w)) : qWords.length <= words.length && qWords.every((qw, i) => sameWordInflected(qw, words[i]!))) {
    return 1;
  }
  return 0;
}

/** Лучшие по personScore (все с максимальной ненулевой оценкой). */
export function bestPeople(query: string, list: BotPerson[]): BotPerson[] {
  let best = 0;
  let out: BotPerson[] = [];
  const seen = new Set<string>();
  for (const p of list) {
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    const s = personScore(query, p);
    if (s === 0 || s < best) continue;
    if (s > best) {
      best = s;
      out = [];
    }
    out.push(p);
  }
  return out;
}

export type PersonResolution =
  | { kind: "ok"; person: BotPerson }
  | { kind: "ambiguous"; candidates: BotPerson[] }
  | { kind: "none"; participants: BotPerson[] };

/** Владелец: участники беседы → все люди (сервер нашёл по имени/логину/EBLID). */
export function resolvePerson(query: string, people: BotPeople): PersonResolution {
  const inConv = bestPeople(query, people.participants);
  if (inConv.length === 1) return { kind: "ok", person: inConv[0]! };
  if (inConv.length > 1) return { kind: "ambiguous", candidates: inConv };
  let global = bestPeople(query, people.matches);
  // Сервер находит и по точному логину — его нам не отдают, имя может быть совсем другим.
  if (global.length === 0 && people.matches.length > 0) global = people.matches;
  if (global.length === 1) return { kind: "ok", person: global[0]! };
  if (global.length > 1) return { kind: "ambiguous", candidates: global.slice(0, 8) };
  return { kind: "none", participants: people.participants };
}

function personLabel(p: BotPerson): string {
  const name = p.displayName ? cleanName(p.displayName) : "без имени";
  const bits = [p.eblid ? `EBLID ${p.eblid}` : null, p.inConversation ? "в этой беседе" : null].filter(Boolean);
  return bits.length ? `${name} (${bits.join(", ")})` : name;
}

export interface LinkToolDeps {
  store: Store;
  characters: CharacterDirectory;
  /** Поиск людей (POST /api/bot/people); нет — старый сервер. */
  people?: (grant: string, input: { query?: string; ids?: string[] }) => Promise<BotPeople>;
  /** Уведомление владельцу (в его «Чат с Еблушей»). */
  notifyOwner(text: string): Promise<void>;
  now(): number;
}

type LinkInput = { action: "link" | "unlink"; character: string; person: string };

function result(r: Record<string, unknown>): ToolResult {
  // Имена людей и ники пишут люди — это данные (ядро обернёт их как недоверенные).
  return { content: JSON.stringify(r), untrusted: true };
}

export function createLinkTool(d: LinkToolDeps): BotTool<LinkInput> {
  const grantOf = (ctx: ToolContext): string | null => ctx.conversation?.ref.grant ?? null;

  const lookup = async (ctx: ToolContext, input: { query?: string; ids?: string[] }): Promise<BotPeople | null> => {
    const grant = grantOf(ctx);
    if (!d.people || !grant) return null;
    try {
      return await d.people(grant, input);
    } catch (e) {
      ctx.log.warn("link.people_failed", { err: e as Error });
      return null;
    }
  };

  /** Имя прежнего владельца персонажа (для «забрал у …»): спрашивающий — «ты», иначе сервер. */
  const holderName = async (ctx: ToolContext, userId: string): Promise<string | null> => {
    if (userId === ctx.requester.userId) return cleanName(ctx.requester.displayName);
    const r = await lookup(ctx, { ids: [userId] });
    const p = r?.users.find((u) => u.id === userId) ?? r?.participants.find((u) => u.id === userId);
    return p?.displayName ? cleanName(p.displayName) : null;
  };

  /** Кто: «я» → спрашивающий; не владельцу — только он сам (людей не ищем). */
  const whom = async (
    ctx: ToolContext,
    raw: string
  ): Promise<{ kind: "ok"; person: BotPerson } | { kind: "reply"; res: ToolResult }> => {
    const me: BotPerson = { id: ctx.requester.userId, displayName: ctx.requester.displayName, eblid: null, inConversation: true };
    const q = raw.trim().slice(0, 64);
    if (!q || isSelfWord(q)) return { kind: "ok", person: me };
    if (!ctx.requester.isOwner) {
      if (personScore(q, me) >= 2) return { kind: "ok", person: me };
      return {
        kind: "reply",
        res: result({
          result: "denied_other_person",
          say: "Других людей привязывает только владелец. Свой ник можно привязать самому: «Еблуша, мой ник в игре …».",
        }),
      };
    }
    const people = await lookup(ctx, { query: q });
    if (!people) {
      return {
        kind: "reply",
        res: result({ result: "people_unavailable", say: "Не могу сейчас найти людей мессенджера — попробуй чуть позже." }),
      };
    }
    const r = resolvePerson(q, people);
    if (r.kind === "ok") return r;
    if (r.kind === "ambiguous") {
      return {
        kind: "reply",
        res: result({
          result: "ambiguous_person",
          query: q,
          candidates: r.candidates.map(personLabel),
          hint: "Подходят несколько людей. Переспроси, кого именно, перечислив варианты; сам не выбирай. Потом вызови снова с EBLID или полным именем.",
        }),
      };
    }
    return {
      kind: "reply",
      res: result({
        result: "person_not_found",
        query: q,
        participants: r.participants.slice(0, 15).map(personLabel),
        hint: "Такого человека не нашёл ни в этой беседе, ни среди всех. Если назвали уменьшительно (Саня) — попробуй полное имя; иначе переспроси (можно EBLID).",
      }),
    };
  };

  async function link(input: LinkInput, ctx: ToolContext): Promise<ToolResult> {
    const nick = cleanNick(input.character);
    if (!nick) return result({ result: "bad_character", say: "Не понял ник персонажа — напиши его как в игре." });
    const w = await whom(ctx, input.person);
    if (w.kind === "reply") return w.res;
    const person = w.person;

    let known: string[];
    try {
      known = await d.characters.listKnownCharacters();
    } catch (e) {
      // Не сверили — не привязываем: привязка открывает данные игроков (места, склады).
      ctx.log.warn("characters.list_failed", { err: e as Error });
      return result({ result: "server_unavailable", say: "Сервер игры сейчас не отвечает — не могу сверить ник. Попробуй чуть позже." });
    }
    const all = [...new Set([...known, ...d.store.allLinks().map((l) => l.character)])];
    let character = all.find((k) => k.toLowerCase() === nick.toLowerCase()) ?? null;
    if (!character) {
      const det = matchCharacter(nick, all);
      if (det.kind === "ambiguous") {
        return result({
          result: "ambiguous_character",
          query: nick,
          candidates: det.candidates,
          hint: "Похоже сразу на нескольких персонажей. Переспроси, какой именно; сам не выбирай.",
        });
      }
      character = det.kind === "exact" ? det.character : fuzzyCharacter(nick, all);
    }
    if (!character) {
      return result({
        result: "unknown_character",
        query: nick,
        known: all.slice(0, 40),
        hint: all.length
          ? "Такого персонажа сервер не видел. Если человек явно имел в виду одного из списка (похожие буквы, транслит, склонение) — вызови снова с точным ником оттуда; иначе переспроси."
          : "Сервер пока не видел ни одного персонажа — пусть человек зайдёт в игру и повторит.",
      });
    }

    const isOwner = ctx.requester.isOwner;
    const self = person.id === ctx.requester.userId;
    const who = self ? "ты" : cleanName(person.displayName ?? (person.eblid ? `EBLID ${person.eblid}` : "без имени"));
    const name = characterMarkup(character);
    const holder = d.store.getLinkOwner(character);
    if (holder === person.id) return result({ result: "already", say: `Уже привязано: ${who} — ${name}.` });
    if (holder && !isOwner) {
      return result({
        result: "taken",
        say: `Персонаж ${name} уже привязан к другому человеку. Если это ошибка — попроси владельца перепривязать.`,
      });
    }
    const prevName = holder ? await holderName(ctx, holder) : null;
    const before = d.store.getCharacters(person.id);
    const res = d.store.link(person.id, character, {
      linkedBy: ctx.requester.userId,
      verified: true,
      // владельцу — без снятия прежних персонажей человека; остальным — как самопривязка фразой
      replaceOwn: !isOwner,
      force: isOwner,
      now: d.now(),
    });
    if (!res.ok) {
      return result({ result: "taken", say: `Персонаж ${name} уже привязан к другому человеку. Если это ошибка — попроси владельца перепривязать.` });
    }
    ctx.log.info("link.tool_linked", { target: person.id, by: ctx.requester.userId, relinked: !!holder });
    let say = `Привязал: ${who} — ${name}.`;
    if (holder) say += prevName ? ` Раньше этот персонаж был за «${prevName}» — у него отвязал.` : " Раньше этот персонаж был за другим человеком — у него отвязал.";
    const others = isOwner ? d.store.getCharacters(person.id).filter((c) => c !== character) : [];
    if (!isOwner && !before.includes(character)) {
      await d.notifyOwner(selfLinkNotice(ctx.requester.displayName, character, { kind: ctx.chat.kind, title: ctx.chat.title }));
    }
    return result({
      result: holder ? "relinked" : "linked",
      say,
      ...(holder ? { previous: prevName ?? "другой человек" } : {}),
      ...(others.length ? { otherCharacters: others } : {}),
    });
  }

  async function unlink(input: LinkInput, ctx: ToolContext): Promise<ToolResult> {
    const isOwner = ctx.requester.isOwner;
    const nickRaw = input.character.trim();
    // «отвяжи Саню» / «отвяжи меня» — все персонажи человека
    if (!nickRaw) {
      const w = await whom(ctx, input.person);
      if (w.kind === "reply") return w.res;
      const self = w.person.id === ctx.requester.userId;
      const chars = d.store.getCharacters(w.person.id);
      if (!chars.length) {
        return result({ result: "nothing", say: self ? "Ты и так ни к кому не привязан." : `${cleanName(w.person.displayName)} и так ни к кому не привязан.` });
      }
      d.store.unlinkUser(w.person.id);
      ctx.log.info("link.tool_unlinked_user", { target: w.person.id, by: ctx.requester.userId, n: chars.length });
      const list = chars.map(characterMarkup).join(", ");
      return result({ result: "unlinked", say: self ? `Отвязал: ты больше не ${list}.` : `Отвязал от «${cleanName(w.person.displayName)}»: ${list}.` });
    }
    const nick = cleanNick(nickRaw) ?? nickRaw;
    const linked = d.store.allLinks().map((l) => l.character);
    let character = linked.find((c) => c.toLowerCase() === nick.toLowerCase()) ?? null;
    if (!character) {
      const det = matchCharacter(nick, linked);
      if (det.kind === "ambiguous") {
        return result({ result: "ambiguous_character", query: nick, candidates: det.candidates, hint: "Похоже сразу на нескольких — переспроси, какой именно." });
      }
      character = det.kind === "exact" ? det.character : fuzzyCharacter(nick, linked);
    }
    if (!character) return result({ result: "not_linked", say: `Персонаж «${nick}» ни к кому не привязан.` });
    const holder = d.store.getLinkOwner(character);
    if (!holder) return result({ result: "not_linked", say: `Персонаж ${characterMarkup(character)} ни к кому не привязан.` });
    if (!isOwner && holder !== ctx.requester.userId) {
      return result({ result: "denied_other_person", say: "Чужие привязки снимает только владелец. Свою — «Еблуша, отвяжи меня»." });
    }
    const prevName = await holderName(ctx, holder);
    d.store.unlinkCharacter(character);
    ctx.log.info("link.tool_unlinked", { from: holder, by: ctx.requester.userId });
    const name = characterMarkup(character);
    const say =
      holder === ctx.requester.userId
        ? `Отвязал: ты больше не ${name}.`
        : `Отвязал: ${name} больше ни за кем не числится${prevName ? ` (был за «${prevName}»)` : ""}.`;
    return result({ result: "unlinked", say });
  }

  return {
    name: LINK_TOOL_NAME,
    description: [
      "Привязать игрового персонажа Valheim к человеку мессенджера или снять привязку («кто есть кто в игре»).",
      "Вызывай, когда просят связать персонажа с человеком или развязать: «Парасюха — это Саня», «РомаH — это я», «привяжи IiApaCiOxa к Сане», «Саня играет за Парасюху», «отвяжи Парасюху», «отвяжи Саню».",
      "Привязывать и отвязывать ДРУГИХ людей может только владелец бота; остальным — только себя: инструмент сам откажет, перескажи отказ коротко и вежливо.",
      "action: link или unlink. character — ник персонажа, как его написали (можно по-русски: инструмент сопоставит похожие буквы); для unlink человека целиком — пустая строка.",
      "person — кого: «я» (тот, кто пишет) или имя/ник/EBLID человека в мессенджере, в именительном падеже («Саня», а не «Сане»); для unlink персонажа — пустая строка.",
      "Ответ — JSON. Есть say — передай человеку его смысл коротко (имена можно склонять, факты не меняй: кому привязал, какой персонаж, у кого забрал). candidates / known / participants — переспроси человека с вариантами, сам не выбирай.",
    ].join(" "),
    access: "anyone",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["link", "unlink"], description: "link — привязать, unlink — отвязать" },
        character: { type: "string", description: "Ник персонажа Valheim (как написали); пусто — все персонажи человека (только unlink)" },
        person: { type: "string", description: "«я» или имя/ник/EBLID человека в именительном падеже; пусто — не важно (unlink персонажа)" },
      },
      required: ["action", "character", "person"],
      additionalProperties: false,
    },
    async run(input, ctx) {
      if (input.action === "unlink") return unlink(input, ctx);
      return link(input, ctx);
    },
  };
}
