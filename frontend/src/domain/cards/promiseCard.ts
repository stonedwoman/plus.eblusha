/**
 * Таймер обещания — вид карточки по данным (SPEC.md §4.2–4.3, §10; конверт — SPEC-share.md §2.8).
 * Чистые функции: данные карточки + «сейчас» (часы сервера) + зритель → всё, что рисует карточка.
 *
 * Данные (metadata.card.data при type "promise"):
 *   promiser {id, displayName, avatarUrl}, requester {id, displayName}, quote {messageId, text, at, by, deleted},
 *   label, upperBound, startAt, deadlineAt, originalDeadlineAt, extensions[], extensionCount?, promiserZone,
 *   closedAt, outcome {kind onTime|late, arrivedAt, deltaSec, deltaVsOriginalSec, via, by}, cancelledBy, reminders.
 * Состояния (card.state): running | arrived | cancelled | unresolved. Действия: arrived (любой), cancel
 * (кто попросил + владелец бота), reopen (2 мин после ручного закрытия).
 */
import { canAct, type BotCard } from './cardEnvelope'
import {
  formatCountdown,
  formatDayTime,
  formatDuration,
  formatHm,
  freshName,
  minutesWords,
  plural,
  zoneOffsetMinutes,
} from './cardFormat'

export type PromiseView = 'running' | 'final' | 'late' | 'onTime' | 'lateArrived' | 'cancelled' | 'unresolved'
export type PromiseButton = 'arrived' | 'cancel' | 'reopen'

export type PromiseOutcome = {
  kind: 'onTime' | 'late'
  arrivedAt: string
  deltaSec: number
  deltaVsOriginalSec?: number | null
  via: 'button' | 'self' | 'call' | 'valheim' | 'phrase' | string
  by?: { id: string; displayName: string } | null
}

export type PromiseData = {
  promiser?: { id?: string; displayName?: string; avatarUrl?: string | null } | null
  requester?: { id?: string; displayName?: string } | null
  quote?: { messageId?: string | null; text?: string | null; at?: string | null; by?: unknown; deleted?: boolean } | null
  label?: string | null
  upperBound?: boolean
  startAt?: string
  deadlineAt?: string
  originalDeadlineAt?: string | null
  extensions?: unknown[]
  extensionCount?: number
  promiserZone?: string | null
  cancelBy?: string[]
  closedAt?: string | null
  outcome?: PromiseOutcome | null
  cancelledBy?: { id?: string; displayName?: string } | null
  reminders?: number[]
}

export const FINAL_MS = 60_000

const num = (s: unknown): number | null => {
  if (typeof s !== 'string') return null
  const t = Date.parse(s)
  return Number.isFinite(t) ? t : null
}

export function promiseData(card: BotCard): PromiseData {
  return (card.data ?? {}) as PromiseData
}

/** Режим карточки сейчас (SPEC.md §4.3). */
export function promiseViewOf(card: BotCard, nowMs: number): PromiseView {
  const d = promiseData(card)
  if (card.state === 'arrived') {
    const k = d.outcome?.kind
    if (k === 'late') return 'lateArrived'
    if (k === 'onTime') return 'onTime'
    return (Number(d.outcome?.deltaSec) || 0) > 0 ? 'lateArrived' : 'onTime'
  }
  if (card.state === 'cancelled') return 'cancelled'
  if (card.state === 'unresolved') return 'unresolved'
  const deadline = num(d.deadlineAt)
  if (deadline == null) return 'running'
  const left = deadline - nowMs
  if (left <= 0) return 'late'
  if (left <= FINAL_MS) return 'final'
  return 'running'
}

export const isLiveView = (v: PromiseView): boolean => v === 'running' || v === 'final' || v === 'late'

const extCount = (d: PromiseData): number =>
  typeof d.extensionCount === 'number' && d.extensionCount >= 0 ? d.extensionCount : Array.isArray(d.extensions) ? d.extensions.length : 0

export const extensionsText = (n: number): string => `продлевал ${n} ${plural(n, 'раз', 'раза', 'раз')}`

/** «Пришёл вовремя, запас 3 мин» / «Секунда в секунду» / «Опоздал на 7 мин». */
export function promiseResultText(o: PromiseOutcome | null | undefined): string {
  if (!o) return 'Пришёл'
  const delta = Number(o.deltaSec) || 0
  if (o.kind === 'late' || (o.kind !== 'onTime' && delta > 0)) return delta < 60 && delta >= 0 ? `Опоздал на ${Math.max(1, Math.floor(delta))} с` : `Опоздал на ${formatDuration(Math.max(0, delta))}`
  const spare = Math.max(0, -delta)
  if (spare < 1) return 'Секунда в секунду'
  if (spare < 60) return 'Пришёл вовремя, запас меньше минуты'
  return `Пришёл вовремя, запас ${formatDuration(spare)}`
}

/** Как отметили: «зашёл в звонок», «зашёл в Valheim», «отметил сам», «отметил Рома». */
export function promiseViaText(o: PromiseOutcome | null | undefined, resolveName?: (id: string) => string | null | undefined): string {
  if (!o) return ''
  switch (o.via) {
    case 'call':
      return 'зашёл в звонок'
    case 'valheim':
      return 'зашёл в Valheim'
    case 'self':
      return 'отметил сам'
    default: {
      const by = o.by && typeof o.by === 'object' ? o.by : null
      return by ? `отметил ${freshName(by.id, by.displayName, resolveName)}` : 'отметили'
    }
  }
}

function quoteByText(by: unknown, resolveName?: (id: string) => string | null | undefined): string | null {
  if (!by) return null
  if (typeof by === 'string') return by.trim() ? `со слов: ${by.trim()}` : null
  const o = by as { id?: string; displayName?: string }
  const name = freshName(o.id, o.displayName, resolveName)
  return `со слов: ${name}`
}

export type PromiseCardModel = {
  view: PromiseView
  /** Нужен ли секундный тик (идёт / последняя минута / опаздывает). */
  live: boolean
  requesterLine: string
  promiserId: string | null
  promiserName: string
  promiserAvatarUrl: string | null
  quote: string
  quoteDeleted: boolean
  quoteBy: string | null
  promisedAt: string
  localDeadline: string | null
  extensions: string | null
  digits: string
  /** Под цифры зарезервирована ширина «ч:мм:сс» (полный срок ≥ 1 ч). */
  digitsWide: boolean
  caption: string
  result: string | null
  resultSub: string | null
  right: string
  label: string
  /** Оставшаяся доля кольца 0…1 (для «меньше движения» и первой отрисовки). */
  ringFraction: number
  buttons: PromiseButton[]
  /** Имя группы для скринридера — меняется не чаще раза в минуту. */
  a11yLabel: string
  /** Минут до срока (для порогов объявлений); null — не идёт. */
  minutesLeft: number | null
}

export type PromiseViewer = {
  id: string | null | undefined
  /** Пояс зрителя; undefined — пояс браузера. */
  zone?: string
  resolveName?: (id: string) => string | null | undefined
  resolveAvatar?: (id: string) => string | null | undefined
}

/** Всё, что рисует карточка таймера, на момент nowMs. */
export function buildPromiseCard(card: BotCard, nowMs: number, viewer: PromiseViewer): PromiseCardModel {
  const d = promiseData(card)
  const zone = viewer.zone
  const view = promiseViewOf(card, nowMs)
  const deadline = num(d.deadlineAt) ?? nowMs
  const start = num(d.startAt) ?? deadline
  const totalMs = Math.max(0, deadline - start)
  const digitsWide = totalMs >= 3_600_000

  const promiserId = d.promiser?.id ? String(d.promiser.id) : null
  const promiserName = freshName(promiserId, d.promiser?.displayName, viewer.resolveName)
  const avatarFresh = promiserId && viewer.resolveAvatar ? viewer.resolveAvatar(promiserId) : null
  const promiserAvatarUrl = (avatarFresh && String(avatarFresh).trim()) || (d.promiser?.avatarUrl ? String(d.promiser.avatarUrl) : null)
  const requesterName = freshName(d.requester?.id, d.requester?.displayName, viewer.resolveName)

  const q = d.quote ?? null
  const quoteDeleted = !!q?.deleted || !q?.text
  const quote = quoteDeleted ? '(сообщение удалено)' : `«${String(q!.text)}»`
  const quoteBy = quoteByText(q?.by, viewer.resolveName)
  const promisedMs = num(q?.at ?? null) ?? start
  const promisedDay = formatDayTime(promisedMs, nowMs, zone, 'in')
  const promisedAt = promisedDay.includes(' в ') ? `обещал ${promisedDay}` : `обещал в ${promisedDay}`

  let localDeadline: string | null = null
  const pz = typeof d.promiserZone === 'string' && d.promiserZone.trim() ? d.promiserZone.trim() : null
  if (pz) {
    try {
      if (zoneOffsetMinutes(deadline, pz) !== zoneOffsetMinutes(deadline, zone)) localDeadline = `по местному ${formatHm(deadline, pz)}`
    } catch {
      localDeadline = null
    }
  }
  const n = extCount(d)
  const extensions = n > 0 ? extensionsText(n) : null
  const label = (d.label && String(d.label)) || ''
  const deadlineHm = formatHm(deadline, zone)

  let digits = ''
  let caption = ''
  let result: string | null = null
  let resultSub: string | null = null
  let right = ''
  let ringFraction = 1
  let minutesLeft: number | null = null
  let a11yTail = ''

  switch (view) {
    case 'running':
    case 'final': {
      const leftMs = deadline - nowMs
      digits = formatCountdown(Math.ceil(leftMs / 1000), digitsWide)
      caption = view === 'final' ? 'последняя минута!' : 'осталось'
      right = `до ${formatDayTime(deadline, nowMs, zone)}`
      ringFraction = totalMs > 0 ? Math.max(0, Math.min(1, leftMs / totalMs)) : 0
      minutesLeft = Math.ceil(leftMs / 60_000)
      a11yTail = `осталось ${minutesWords(Math.max(1, Math.floor(leftMs / 60_000)))}`
      break
    }
    case 'late': {
      const lateSec = Math.floor((nowMs - deadline) / 1000)
      digits = `+${formatCountdown(lateSec, false)}`
      caption = 'опаздывает'
      right = `обещал к ${formatDayTime(deadline, nowMs, zone)}`
      const lateMin = Math.floor(lateSec / 60)
      a11yTail = lateMin < 1 ? 'опаздывает меньше минуты' : `опаздывает на ${minutesWords(lateMin)}`
      break
    }
    case 'onTime':
    case 'lateArrived': {
      const o = d.outcome ?? null
      const arrived = num(o?.arrivedAt ?? null) ?? nowMs
      digits = view === 'onTime' ? `✓ ${formatHm(arrived, zone)}` : `+${formatDuration(Math.max(0, Number(o?.deltaSec) || 0))}`
      result = promiseResultText(o)
      const parts = [promiseViaText(o, viewer.resolveName)].filter(Boolean)
      if (n > 0) {
        parts.push(extensionsText(n))
        const dvo = typeof o?.deltaVsOriginalSec === 'number' ? o.deltaVsOriginalSec : null
        if (dvo != null && dvo !== (Number(o?.deltaSec) || 0)) {
          parts.push(dvo > 0 ? `от первого срока +${formatDuration(dvo)}` : `от первого срока запас ${formatDuration(-dvo)}`)
        }
      }
      resultSub = parts.join(' · ') || null
      right = `срок ${deadlineHm}`
      a11yTail = result.charAt(0).toLowerCase() + result.slice(1)
      break
    }
    case 'cancelled': {
      digits = '—'
      const by = d.cancelledBy && typeof d.cancelledBy === 'object' ? d.cancelledBy : null
      caption = by ? `Таймер отменён · отменил ${freshName(by.id, by.displayName, viewer.resolveName)}` : 'Таймер отменён'
      right = `срок был ${deadlineHm}`
      a11yTail = 'таймер отменён'
      break
    }
    case 'unresolved': {
      digits = '?'
      caption = 'Никто не отметил приход'
      right = `срок был ${deadlineHm}`
      a11yTail = 'никто не отметил приход'
      break
    }
  }

  const buttons: PromiseButton[] = []
  if (card.state === 'running' && canAct(card, 'arrived', viewer.id, nowMs)) buttons.push('arrived')
  if (card.state === 'running' && canAct(card, 'cancel', viewer.id, nowMs)) buttons.push('cancel')
  if (card.state !== 'running' && canAct(card, 'reopen', viewer.id, nowMs)) buttons.push('reopen')

  const a11yHead = quoteDeleted ? `Таймер: ${promiserName}, обещание удалено` : `Таймер: ${promiserName} обещал «${String(q!.text)}»`
  const a11yLabel = `${a11yHead}, до ${deadlineHm}, ${a11yTail}`

  return {
    view,
    live: isLiveView(view),
    requesterLine: `попросил ${requesterName}`,
    promiserId,
    promiserName,
    promiserAvatarUrl,
    quote,
    quoteDeleted,
    quoteBy,
    promisedAt,
    localDeadline,
    extensions,
    digits,
    digitsWide,
    caption,
    result,
    resultSub,
    right,
    label,
    ringFraction,
    buttons,
    a11yLabel,
    minutesLeft,
  }
}

/**
 * Что сказать вежливой живой области при смене (SPEC.md §10.4): смена режима и пороги 5 мин, 1 мин,
 * срок. null — молчим (каждую секунду ничего не объявляем).
 */
export function promiseAnnouncement(prev: { view: PromiseView; minutesLeft: number | null } | null, cur: PromiseCardModel): string | null {
  if (!prev) return null
  if (prev.view !== cur.view) {
    switch (cur.view) {
      case 'final':
        return 'Осталась минута'
      case 'late':
        return `${cur.promiserName} опаздывает`
      case 'onTime':
      case 'lateArrived':
        return cur.result
      case 'cancelled':
        return 'Таймер отменён'
      case 'unresolved':
        return 'Никто не отметил приход'
      case 'running':
        return prev.view === 'cancelled' || prev.view === 'onTime' || prev.view === 'lateArrived' ? 'Таймер снова идёт' : null
    }
  }
  if (cur.view === 'running' && prev.minutesLeft != null && cur.minutesLeft != null && prev.minutesLeft > 5 && cur.minutesLeft <= 5) {
    return 'Осталось 5 минут'
  }
  return null
}

/** Подписи кнопок и имена для скринридера. */
export function promiseButtonText(b: PromiseButton, promiserName: string): { label: string; aria: string } {
  if (b === 'arrived') return { label: 'Пришёл', aria: `Отметить, что ${promiserName} пришёл` }
  if (b === 'cancel') return { label: 'Отменить', aria: 'Отменить таймер' }
  return { label: 'Вернуть', aria: 'Вернуть таймер' }
}

/** Тост при неудаче действия. */
export function promiseFailureToast(action: string, failure: string): string | null {
  if (failure === 'closed' || failure === 'expired' || failure === 'not_found') return null // молча перерисовать
  if (failure === 'disabled') return 'Сейчас недоступно'
  if (failure === 'rate_limited') return 'Слишком часто'
  if (failure === 'forbidden') return action === 'cancel' ? 'Отменить может тот, кто попросил' : 'Нельзя'
  if (action === 'cancel') return 'Не удалось отменить'
  if (action === 'reopen') return 'Не удалось вернуть'
  return 'Не удалось отметить'
}

/** Оптимистичный вид после нажатия (сервер всё равно пришлёт свою версию). */
export function optimisticPromise(card: BotCard, action: string, me: { id: string; displayName: string }, nowMs: number): BotCard | null {
  const d = promiseData(card)
  const nowIso = new Date(nowMs).toISOString()
  const reopenWho = Array.from(new Set([me.id, d.requester?.id].filter(Boolean) as string[]))
  const reopenAction = { id: 'reopen', who: { ids: reopenWho }, until: new Date(nowMs + 120_000).toISOString() }
  if (action === 'arrived' && card.state === 'running') {
    const deadline = num(d.deadlineAt) ?? nowMs
    const original = num(d.originalDeadlineAt ?? null) ?? deadline
    const deltaSec = Math.round((nowMs - deadline) / 1000)
    const self = !!d.promiser?.id && String(d.promiser.id) === me.id
    const outcome: PromiseOutcome = {
      kind: deltaSec > 0 ? 'late' : 'onTime',
      arrivedAt: nowIso,
      deltaSec,
      deltaVsOriginalSec: Math.round((nowMs - original) / 1000),
      via: self ? 'self' : 'button',
      by: self ? null : { id: me.id, displayName: me.displayName },
    }
    return { ...card, state: 'arrived', closed: true, actions: [reopenAction], data: { ...d, outcome, closedAt: nowIso } }
  }
  if (action === 'cancel' && card.state === 'running') {
    return { ...card, state: 'cancelled', closed: true, actions: [reopenAction], data: { ...d, cancelledBy: { id: me.id, displayName: me.displayName }, closedAt: nowIso } }
  }
  if (action === 'reopen' && card.state !== 'running') {
    const cancelIds = Array.isArray(d.cancelBy) ? d.cancelBy : d.requester?.id ? [String(d.requester.id)] : []
    return {
      ...card,
      state: 'running',
      closed: false,
      actions: [
        { id: 'arrived', who: { any: true }, until: null },
        { id: 'cancel', who: { ids: cancelIds }, until: null },
      ],
      data: { ...d, outcome: null, cancelledBy: null, closedAt: null },
    }
  }
  return null
}
