/**
 * Реестр модулей: инструменты модели, команды, справочник персонажей.
 * Здесь же — проверка входа инструмента по схеме (strict tool use не проверяет
 * minimum/maximum, а с eager_input_streaming сервер вход не проверяет вовсе) и
 * проверка доступа до вызова run().
 */
import type { Access, BotModule, BotTool, ChatCommand, ChatInfo, CharacterDirectory, JsonSchemaObject, JsonSchemaProp, Requester } from "../modules/api";

const NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;
const RESERVED = new Set(["web_search", "web_fetch", "code_execution", "attach_image"]);

export class Registry {
  readonly tools = new Map<string, BotTool<any>>();
  readonly commands: ChatCommand<any>[] = [];
  readonly prompts: string[] = [];
  readonly modules: BotModule[] = [];
  characters: CharacterDirectory | null = null;

  add(m: BotModule): void {
    for (const t of m.tools ?? []) {
      if (!NAME_RE.test(t.name)) throw new Error(`модуль ${m.name}: имя инструмента ${t.name} не подходит`);
      if (RESERVED.has(t.name) || this.tools.has(t.name)) throw new Error(`модуль ${m.name}: инструмент ${t.name} уже есть`);
      validateSchemaShape(t.inputSchema, `${m.name}.${t.name}`);
      this.tools.set(t.name, t);
    }
    for (const c of m.commands ?? []) {
      if (c.confirm && c.access !== "owner") throw new Error(`модуль ${m.name}: confirm только для команд владельца (${c.name})`);
      this.commands.push(c);
    }
    if (m.systemPrompt) this.prompts.push(m.systemPrompt.trim());
    if (m.characters) {
      if (this.characters) throw new Error(`второй справочник персонажей (${m.name})`);
      this.characters = m.characters;
    }
    this.modules.push(m);
  }
}

function validateSchemaShape(s: JsonSchemaObject, where: string): void {
  if (s.type !== "object" || s.additionalProperties !== false) throw new Error(`${where}: схема должна быть object с additionalProperties:false`);
  for (const r of s.required) if (!(r in s.properties)) throw new Error(`${where}: required ${r} нет в properties`);
}

/** Схема для API: без minimum/maximum (strict их не принимает). */
export function apiSchema(s: JsonSchemaObject): Record<string, unknown> {
  const prop = (p: JsonSchemaProp): Record<string, unknown> => {
    if (p.type === "array") return { type: "array", items: prop(p.items), ...(p.description ? { description: p.description } : {}) };
    const { ...rest } = p as Record<string, unknown>;
    delete rest.minimum;
    delete rest.maximum;
    return rest;
  };
  return {
    type: "object",
    properties: Object.fromEntries(Object.entries(s.properties).map(([k, v]) => [k, prop(v)])),
    required: s.required,
    additionalProperties: false,
  };
}

function checkProp(v: unknown, p: JsonSchemaProp, path: string): string | null {
  switch (p.type) {
    case "string":
      if (typeof v !== "string") return `${path}: ждём строку`;
      if (p.enum && !p.enum.includes(v)) return `${path}: одно из ${p.enum.join(", ")}`;
      if (v.length > 2000) return `${path}: слишком длинно`;
      return null;
    case "integer":
    case "number":
      if (typeof v !== "number" || !Number.isFinite(v)) return `${path}: ждём число`;
      if (p.type === "integer" && !Number.isInteger(v)) return `${path}: ждём целое`;
      if (p.minimum !== undefined && v < p.minimum) return `${path}: не меньше ${p.minimum}`;
      if (p.maximum !== undefined && v > p.maximum) return `${path}: не больше ${p.maximum}`;
      return null;
    case "boolean":
      return typeof v === "boolean" ? null : `${path}: ждём true/false`;
    case "array":
      if (!Array.isArray(v)) return `${path}: ждём список`;
      if (v.length > 50) return `${path}: слишком длинный список`;
      for (let i = 0; i < v.length; i++) {
        const e = checkProp(v[i], p.items, `${path}[${i}]`);
        if (e) return e;
      }
      return null;
  }
}

/** null — вход годен; иначе текст ошибки для модели. */
export function validateInput(input: unknown, s: JsonSchemaObject): string | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return "вход должен быть объектом";
  const obj = input as Record<string, unknown>;
  for (const k of Object.keys(obj)) if (!(k in s.properties)) return `лишнее поле ${k}`;
  for (const r of s.required) if (!(r in obj)) return `нет поля ${r}`;
  for (const [k, v] of Object.entries(obj)) {
    const e = checkProp(v, s.properties[k]!, k);
    if (e) return e;
  }
  return null;
}

/**
 * Доступ к команде/инструменту. playerDataOk — можно ли показывать данные игроков в этой беседе
 * (ChatInfo.playerDataOk: в группе с непривязанными участниками — нельзя, ответ увидят все).
 */
export function hasAccess(access: Access, r: Requester, isDm: boolean, playerDataOk = true): boolean {
  if (access === "anyone") return true;
  if (access === "player") return r.isPlayer && (isDm || playerDataOk);
  return r.isOwner && isDm;
}

/** Данные игроков видны: спрашивает игрок, и ответ не уйдёт непривязанным людям. */
export function playerDataVisible(ctx: { requester: Requester; chat: Pick<ChatInfo, "kind" | "playerDataOk"> }): boolean {
  return ctx.requester.isPlayer && (ctx.chat.kind === "dm" || ctx.chat.playerDataOk);
}

export const GROUP_AUDIENCE_TEXT =
  "В этой группе есть люди, не привязанные к игровому персонажу, а ответ увидят все. Данные игроков покажу в личке с ботом (или в группе, где привязаны все).";

export function accessDeniedText(access: Access, r?: Requester): string {
  if (access === "player") {
    if (r?.isPlayer) return GROUP_AUDIENCE_TEXT;
    return "Это видят только игроки сервера. Привяжи свой ник: «Еблуша, мой ник в игре …».";
  }
  return "Это может только владелец, и только в личке с ботом.";
}
