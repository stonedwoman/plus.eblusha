/**
 * Карточки бота (Bot Cards v1) — общий конверт, права и порядок версий. Контракт:
 * scratchpad/promise-timer/SPEC-share.md §2 (+ таймер — SPEC.md с поправками §2.8).
 *
 * Карточка — обычное сообщение бота, чьё состояние меняет ТОЛЬКО сервер:
 *   metadata.bot  = { v:1, kind:"card", triggerMessageId, askerId }
 *   metadata.card = { v:1, type:"promise"|"share", id, rev, state, closed, actions:[{id, who, until}], data }
 * Клиент рисует карточку, только если message.isBot === true, kind === "card", card.v === 1 и тип
 * известен; иначе — обычный пузырь бота с запасным текстом `content` (его сервер переписывает сам).
 *
 * Запасной разбор: таймер по SPEC.md ДО поправок (metadata.bot.kind = "promise", metadata.promise v1,
 * ручки /api/promises/:id/*) приводится к тому же конверту (source: "legacy-promise") — если сервер
 * выйдет раньше поправок, веб всё равно нарисует живую карточку.
 */

export type BotCardType = 'promise' | 'share'
export const KNOWN_CARD_TYPES: readonly BotCardType[] = ['promise', 'share']

export type CardWho = { any: true } | { ids: string[] }
export type CardAction = { id: string; who: CardWho; until: string | null }

export type BotCard<D = Record<string, any>> = {
  v: 1
  type: BotCardType
  id: string
  rev: number
  state: string
  closed: boolean
  actions: CardAction[]
  data: D
  /** "card" — общий конверт; "legacy-promise" — metadata.promise по SPEC.md до поправок. */
  source: 'card' | 'legacy-promise'
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)
const obj = (v: unknown): Record<string, any> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, any>) : null)

/** metadata объектом или строкой JSON. */
export function parseMessageMeta(m: any): Record<string, any> | null {
  let md: any = m?.metadata
  if (typeof md === 'string') {
    try {
      md = JSON.parse(md)
    } catch {
      md = null
    }
  }
  return obj(md)
}

function parseWho(raw: unknown): CardWho | null {
  const w = obj(raw)
  if (!w) return null
  if (w.any === true) return { any: true }
  if (Array.isArray(w.ids)) return { ids: w.ids.filter((x: unknown) => typeof x === 'string' && x).map(String) }
  return null
}

function parseActions(raw: unknown): CardAction[] {
  if (!Array.isArray(raw)) return []
  const out: CardAction[] = []
  for (const a of raw) {
    const o = obj(a)
    const id = o ? str(o.id) : null
    const who = o ? parseWho(o.who) : null
    if (!o || !id || !who) continue
    const until = typeof o.until === 'number' && Number.isFinite(o.until) ? new Date(o.until).toISOString() : str(o.until)
    out.push({ id, who, until: until && Number.isFinite(Date.parse(until)) ? until : null })
  }
  return out
}

/** metadata.card → BotCard; null — не наш конверт (другая версия, неизвестный тип, битые поля). */
export function parseCardEnvelope(raw: unknown): BotCard | null {
  const c = obj(raw)
  if (!c || c.v !== 1) return null
  const type = c.type as BotCardType
  if (!KNOWN_CARD_TYPES.includes(type)) return null
  const id = str(c.id)
  const state = str(c.state)
  const rev = typeof c.rev === 'number' && Number.isFinite(c.rev) ? Math.trunc(c.rev) : null
  const data = obj(c.data)
  if (!id || !state || rev == null || !data) return null
  return { v: 1, type, id, rev, state, closed: c.closed === true, actions: parseActions(c.actions), data, source: 'card' }
}

const PROMISE_STATES = ['running', 'arrived', 'cancelled', 'unresolved']

/** metadata.promise v1 (SPEC.md §4.2 до поправок) → конверт: действия выводятся из cancelBy/reopen. */
export function legacyPromiseToCard(raw: unknown): BotCard | null {
  const p = obj(raw)
  if (!p || p.v !== 1) return null
  const id = str(p.id)
  const state = str(p.state)
  const rev = typeof p.rev === 'number' && Number.isFinite(p.rev) ? Math.trunc(p.rev) : null
  if (!id || !state || !PROMISE_STATES.includes(state) || rev == null) return null
  const actions: CardAction[] = []
  if (state === 'running') {
    actions.push({ id: 'arrived', who: { any: true }, until: null })
    const ids = Array.isArray(p.cancelBy) ? p.cancelBy.filter((x: unknown) => typeof x === 'string') : []
    actions.push({ id: 'cancel', who: { ids }, until: null })
  }
  const reopen = obj(p.reopen)
  if (reopen && str(reopen.until)) {
    const ids = Array.isArray(reopen.by) ? reopen.by.filter((x: unknown) => typeof x === 'string') : []
    actions.push({ id: 'reopen', who: { ids }, until: String(reopen.until) })
  }
  const { v: _v, id: _id, rev: _rev, state: _state, ...data } = p
  return { v: 1, type: 'promise', id, rev, state, closed: state !== 'running', actions, data, source: 'legacy-promise' }
}

/** Сообщение — от бота по признаку СЕРВЕРА (подделка в metadata у человека карточкой не станет). */
function isServerBotMessage(m: any): boolean {
  if (!m || typeof m !== 'object') return false
  if (m.isBot === false) return false
  return m.isBot === true || m.sender?.isBot === true
}

/** Карточка из сообщения или null (тогда — обычный пузырь с content). */
export function botCardOfMessage(m: any): BotCard | null {
  if (!isServerBotMessage(m) || m.deletedAt) return null
  const md = parseMessageMeta(m)
  const kind = obj(md?.bot)?.kind
  if (kind === 'card') return parseCardEnvelope(md?.card)
  if (kind === 'promise') return legacyPromiseToCard(md?.promise)
  return null
}

/** У сообщения бота вид «карточка» (даже если версию/тип мы не знаем — тогда рисуем запасной текст). */
export function isCardKindMessage(m: any): boolean {
  const kind = obj(parseMessageMeta(m)?.bot)?.kind
  return kind === 'card' || kind === 'promise'
}

const untilMs = (a: CardAction): number | null => (a.until ? Date.parse(a.until) : null)

/**
 * Можно ли зрителю это действие СЕЙЧАС: есть в списке, `who` выполнено, `until` не прошёл. У закрытой
 * карточки действуют только действия с `until` (вроде «Вернуть»). Права всё равно проверяет сервер.
 */
export function canAct(card: BotCard | null, actionId: string, viewerId: string | null | undefined, nowMs: number): boolean {
  if (!card || !viewerId) return false
  const a = card.actions.find((x) => x.id === actionId)
  if (!a) return false
  const u = untilMs(a)
  if (card.closed && u == null) return false
  if (u != null && !(u > nowMs)) return false
  if ('any' in a.who) return true
  return a.who.ids.includes(String(viewerId))
}

/** Все доступные зрителю действия (в порядке сервера). */
export function visibleActions(card: BotCard | null, viewerId: string | null | undefined, nowMs: number): string[] {
  if (!card) return []
  return card.actions.filter((a) => canAct(card, a.id, viewerId, nowMs)).map((a) => a.id)
}

/** Ближайший момент, когда видимое зрителю действие исчезнет само (нужна перерисовка), или null. */
export function nextActionExpiry(card: BotCard | null, viewerId: string | null | undefined, nowMs: number): number | null {
  if (!card) return null
  let best: number | null = null
  for (const a of card.actions) {
    const u = untilMs(a)
    if (u == null || !canAct(card, a.id, viewerId, nowMs)) continue
    if (best == null || u < best) best = u
  }
  return best
}

/** Порядок версий: принимаем только rev строго больше своего (REST и сокет приходят в любом порядке). */
export function isNewerCard(next: BotCard | null | undefined, prev: BotCard | null | undefined): boolean {
  if (!next) return false
  if (!prev) return true
  return next.rev > prev.rev
}

/** Из двух версий одной карточки — свежая (при равенстве — первая). */
export function newerCard(a: BotCard | null | undefined, b: BotCard | null | undefined): BotCard | null {
  if (!a) return b ?? null
  if (!b) return a
  return b.rev > a.rev ? b : a
}
