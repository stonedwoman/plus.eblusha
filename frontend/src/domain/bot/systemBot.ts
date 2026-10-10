/**
 * Бот «Еблуша» — часть системы мессенджера (контракт сервера: docs/bot-system.md, v1).
 *
 * Бот НЕ участник бесед: он отвечает в любой обычной беседе, если к нему обратились, от системного
 * пользователя (isBot), которого нет в participants. Здесь — чистые функции (без React и сети),
 * их же гоняют юнит-тесты (systemBot.test.ts):
 *   - узнать бота и его сообщения (верим только серверному isBot, не metadata);
 *   - распознать обращение в начале текста — ТЕ ЖЕ правила, что у сервера (src/lib/systemBot.ts:
 *     stripBotNamePrefix / stripBotCommandPrefix), чтобы плашка «Спросить» в поле ввода не врала;
 *   - режим «Спросить» в композере: когда показывать плашку и что слать в metadata.botAsk;
 *   - «Уточнить» под многочастным ответом, «Да/Нет» под подтверждением, карточка карты.
 * Загрузка профиля бота и подписка на bot:settings — useSystemBot.ts.
 */

/** Фирменный оранжевый «Б» (логотип сайта, иконка Android). */
export const BOT_BRAND_ORANGE = '#E25C2A'
export const BOT_DEFAULT_NAME = 'Еблуша'
/** Запасной текст отказа, если GET /api/bot не ответил (сервер отдаёт свой secretChatRefusal). */
export const BOT_SECRET_REFUSAL_FALLBACK =
  'Еблуша не работает в секретных чатах: их сообщения не видит даже сервер, и боту они не уходят.'
/** Живая карта сервера Valheim (bot/src/modules/valheim/config.ts: VALHEIM_PUBLIC_MAP_URL). */
export const BOT_LIVE_MAP_URL = 'https://v.koban.uk/map/'

export type SystemBotProfile = {
  id: string
  displayName: string
  avatarUrl: string | null
  eblid: string | null
  bio: string | null
  isBot: true
}

export type BotChatState = { botChatEnabled: boolean; conversationId: string | null }

export type SystemBotInfo = {
  bot: SystemBotProfile
  botChat: BotChatState
  secretChatRefusal: string
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)

export function normalizeBotChatState(raw: unknown): BotChatState {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const enabled = r.botChatEnabled === true
  return { botChatEnabled: enabled, conversationId: enabled ? str(r.conversationId) : null }
}

/** Ответ GET /api/bot → SystemBotInfo; null, если ответ не похож на профиль бота. */
export function normalizeSystemBotInfo(raw: unknown): SystemBotInfo | null {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const b = (r.bot && typeof r.bot === 'object' ? r.bot : null) as Record<string, unknown> | null
  const id = b ? str(b.id) : null
  if (!b || !id) return null
  return {
    bot: {
      id,
      displayName: str(b.displayName) ?? BOT_DEFAULT_NAME,
      avatarUrl: str(b.avatarUrl),
      eblid: str(b.eblid),
      bio: str(b.bio),
      isBot: true,
    },
    botChat: normalizeBotChatState(r.botChat),
    secretChatRefusal: str(r.secretChatRefusal) ?? BOT_SECRET_REFUSAL_FALLBACK,
  }
}

// ───────────────────────────── Кто бот ─────────────────────────────

export function isBotUser(u: any, botId?: string | null): boolean {
  if (!u || typeof u !== 'object') return false
  if (u.isBot === true) return true
  return !!botId && u.id != null && String(u.id) === botId
}

/** Сообщение от бота: Message.isBot / sender.isBot (столбцы БД); запасной признак — id бота. */
export function isBotMessage(m: any, botId?: string | null): boolean {
  if (!m || typeof m !== 'object') return false
  if (m.isBot === true || m.sender?.isBot === true) return true
  return !!botId && m.senderId != null && String(m.senderId) === botId
}

export type BotMessageKind = 'answer' | 'command' | 'notice' | 'confirm' | 'welcome'
const KINDS: readonly BotMessageKind[] = ['answer', 'command', 'notice', 'confirm', 'welcome']

/** metadata.bot = {v:1, kind, triggerMessageId?} — подсказка сервера (кнопки), не признак бота. */
export function botMessageInfo(m: any): { kind: BotMessageKind | null; triggerMessageId: string | null } {
  let md: any = m?.metadata
  if (typeof md === 'string') {
    try {
      md = JSON.parse(md)
    } catch {
      md = null
    }
  }
  const b = md && typeof md === 'object' ? md.bot : null
  const kind = b && typeof b === 'object' && KINDS.includes(b.kind) ? (b.kind as BotMessageKind) : null
  const triggerMessageId = b && typeof b === 'object' ? str(b.triggerMessageId) : null
  return { kind, triggerMessageId }
}

export function isSecretConversation(conv: any): boolean {
  return !!conv && (String(conv.type ?? '').toUpperCase() === 'SECRET' || conv.isSecret === true)
}

/** «Чат с Еблушей»: признак сервера isBotChat, иначе — 1:1 облачная беседа, где бот среди участников. */
export function isBotChatConversation(conv: any, botId?: string | null): boolean {
  if (!conv || typeof conv !== 'object') return false
  if (conv.isBotChat === true) return true
  if (conv.isGroup || isSecretConversation(conv)) return false
  const parts = Array.isArray(conv.participants) ? conv.participants : []
  return parts.some((p: any) => isBotUser(p?.user, botId))
}

/** Собеседник-бот в «Чате с Еблушей» (участник беседы) или null. */
export function botPeerOf(conv: any, botId?: string | null): any | null {
  if (!isBotChatConversation(conv, botId)) return null
  const parts = Array.isArray(conv.participants) ? conv.participants : []
  return parts.find((p: any) => isBotUser(p?.user, botId))?.user ?? null
}

// ───────────────────────────── Обращение в начале текста ─────────────────────────────

const NAME = 'еблуша'
const FOLD: Record<string, string> = { e: 'е', a: 'а', y: 'у', '6': 'б', b: 'б', w: 'ш', ё: 'е' }

/** Свернуть к виду «еблуша»: регистр, ё, похожая латиница — как foldHead на сервере. */
function foldHead(s: string): string {
  return Array.from(s.toLowerCase())
    .map((ch) => FOLD[ch] ?? ch)
    .join('')
}

/** «Еблуша,» / «Еблуша:» / «Еблуша!» в начале (можно с @ и пробелами впереди). */
export function startsWithBotName(text: string): boolean {
  const content = String(text ?? '')
  const m = /^\s*@?/.exec(content)
  const start = m ? m[0].length : 0
  const head = content.slice(start, start + NAME.length)
  if (foldHead(head) !== NAME) return false
  return /^\s*[,:!]/.test(content.slice(start + NAME.length))
}

/** «/eb …» или «/еб …» (любой регистр), дальше пробел или конец. */
export function startsWithBotCommand(text: string): boolean {
  return /^\s*\/(?:eb|еб)(?=$|\s)/iu.test(String(text ?? ''))
}

/** Текст начинается с обращения к боту (п. 5 и 6 правил сервера). */
export function detectBotAddressPrefix(text: string): boolean {
  return startsWithBotName(text) || startsWithBotCommand(text)
}

// ───────────────────────────── Режим «Спросить» ─────────────────────────────

type ReplyDraftLike = {
  replyToId: string
  quoted: Array<{ id: string; senderId?: string; isBot?: boolean }>
} | null | undefined

/** Черновик ответа указывает на сообщение бота (сервер смотрит именно на replyToId). */
export function replyDraftTargetsBot(draft: ReplyDraftLike, botId?: string | null): boolean {
  if (!draft || !draft.replyToId) return false
  const q = (draft.quoted || []).find((x) => x && String(x.id) === String(draft.replyToId))
  if (!q) return false
  return q.isBot === true || (!!botId && !!q.senderId && String(q.senderId) === botId)
}

export type BotAskInput = {
  /** Бот заведён на сервере (GET /api/bot ответил профилем). */
  botAvailable: boolean
  /** Есть открытая беседа. */
  hasConversation: boolean
  isSecret: boolean
  isBotChat: boolean
  /** Правка сообщения: бота не зовёт. */
  editing: boolean
  /** Пересылка с комментарием: пересланное боту не уходит. */
  forwarding: boolean
  /** Текст в поле начинается с обращения. */
  prefix: boolean
  /** Ответ (reply) на сообщение бота — в том числе после «Уточнить». */
  replyToBot: boolean
  /** Плашку убрали (Backspace в начале поля или щелчок по ней). */
  dismissed: boolean
}

export type BotAskState = {
  /** Здесь режим «Спросить» вообще возможен. */
  eligible: boolean
  /** Есть повод для плашки (обращение в тексте или ответ боту). */
  trigger: boolean
  /** Плашка «Спросить Еблушу» видна. */
  active: boolean
  /** Что добавить в metadata отправляемого сообщения (null — ничего). */
  meta: { botAsk: boolean } | null
  /** Секретный чат + обращение: показать ЛОКАЛЬНЫЙ отказ (на сервер ничего не уходит). */
  secretRefusal: boolean
}

export function computeBotAsk(i: BotAskInput): BotAskState {
  const eligible =
    i.botAvailable && i.hasConversation && !i.isSecret && !i.isBotChat && !i.editing && !i.forwarding
  const trigger = i.prefix || i.replyToBot
  const active = eligible && trigger && !i.dismissed
  // Плашку убрали, а повод был → явно «не боту» (сервер иначе сам поймал бы «Еблуша,» или ответ боту).
  // В «Чате с Еблушей» botAsk:false не шлём никогда: там всё — боту (правило 2 сервера идёт ПОСЛЕ 1).
  const meta = active ? { botAsk: true } : eligible && trigger && i.dismissed ? { botAsk: false } : null
  const secretRefusal = i.botAvailable && i.hasConversation && i.isSecret && i.prefix && !i.editing
  return { eligible, trigger, active, meta, secretRefusal }
}

/** Добавить botAsk к metadata отправки (undefined, если добавлять нечего и metadata не было). */
export function withBotAskMeta(
  meta: Record<string, unknown> | undefined,
  botMeta: { botAsk: boolean } | null | undefined,
): Record<string, unknown> | undefined {
  if (!botMeta) return meta
  return { ...(meta ?? {}), botAsk: botMeta.botAsk }
}

// ───────────────────────────── Кнопки под сообщениями бота ─────────────────────────────

/**
 * Ответ бота может прийти несколькими сообщениями подряд (длинный текст частями, потом картинки) —
 * у всех один triggerMessageId. «Уточнить» показываем один раз, под последней частью, а ответ
 * ставим на ПЕРВУЮ часть: только у неё replyToId → вопрос, и сервер соберёт цепочку для бота.
 * Вернёт null, если под этим сообщением кнопки нет.
 */
export function botClarifyTarget(list: any[], index: number, botId?: string | null): any | null {
  const m = list?.[index]
  if (!m || m.deletedAt || !isBotMessage(m, botId)) return null
  const { kind, triggerMessageId } = botMessageInfo(m)
  if (kind !== 'answer' && kind !== 'command') return null
  if (typeof m.id === 'string' && m.id.startsWith('tmp-')) return null
  const sameAnswer = (x: any) =>
    !!x && !x.deletedAt && isBotMessage(x, botId) && !!triggerMessageId && botMessageInfo(x).triggerMessageId === triggerMessageId
  // Не последняя часть — кнопка будет ниже.
  for (let j = index + 1; j < list.length; j++) {
    const x = list[j]
    if (!x || x.deletedAt) continue
    if (sameAnswer(x)) return null
    break
  }
  let first = m
  for (let j = index - 1; j >= 0; j--) {
    const x = list[j]
    if (!x || x.deletedAt) continue
    if (!sameAnswer(x)) break
    first = x
  }
  return first
}

/** На вопрос-подтверждение бота уже ответили (своим сообщением в ответ на него). */
export function isBotConfirmAnswered(list: any[], index: number, meId?: string | null): boolean {
  const m = list?.[index]
  if (!m || !meId) return false
  for (let j = index + 1; j < list.length; j++) {
    const x = list[j]
    if (!x || x.deletedAt) continue
    if (String(x.senderId ?? '') !== meId) continue
    const rid = x.replyTo?.id ?? x.replyToId
    if (rid != null && String(rid) === String(m.id)) return true
  }
  return false
}

/**
 * Картинка-карточка карты Valheim от бота: щелчок открывает живую карту, а не просмотрщик.
 * Ссылку берём из вложения (metadata.link, только https), иначе — карточка узнаётся по имени файла
 * «karta-….png» (bot/src/modules/valheim/tools.ts) и ведёт на BOT_LIVE_MAP_URL.
 */
export function botMapCardLink(att: any, m: any, botId?: string | null): string | null {
  if (!att || att.type !== 'IMAGE' || !isBotMessage(m, botId)) return null
  const md = att.metadata && typeof att.metadata === 'object' ? att.metadata : {}
  const link = str(md.link)
  if (link && /^https:\/\/[^\s]+$/i.test(link)) return link
  const name = str(md.originalName) ?? ''
  if (/^karta-[^/\\]*\.(png|jpe?g|webp)$/i.test(name)) return BOT_LIVE_MAP_URL
  return null
}

/**
 * Ответы бота всегда размечены, а цитата / превью ответа показывают текст как есть — там «**Ответ**»
 * и «[живая карта](https://…)» выглядели бы мусором. Снимаем маркеры безопасного подмножества,
 * оставляя слова (списки «- » остаются читаемыми и так).
 */
export function stripMarkdownForPreview(text: string): string {
  return String(text ?? '')
    .replace(/^\s{0,3}```[^\n]*$/gm, '')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/\[([^\]\n]+)\]\((?:https?:\/\/|\/)[^)\s]+\)/g, '$1')
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '$2')
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '$1')
    .replace(/(^|[\s(«"])([*_])(?=\S)([^*_\n]*?\S)\2(?=$|[\s.,!?:;)»"])/gm, '$1$3')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Подпись для цитаты / уведомления: имя бота из сообщения или профиля. */
export function botDisplayName(m: any, profile?: { displayName?: string | null } | null): string {
  return str(m?.sender?.displayName) ?? str(profile?.displayName) ?? BOT_DEFAULT_NAME
}
