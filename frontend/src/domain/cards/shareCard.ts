/**
 * «Поделиться перепиской» — вид карточки по данным (SPEC-share.md §6, §13).
 * Чистые функции: данные + «сейчас» (часы сервера) + зритель + его несохранённый выбор → что рисовать.
 *
 * Состояния: pending (выбор: share/decline — только спросивший, до until) → granted (forget — любой, до
 * data.until; подвид «читаю…» / «ответ ниже ↓») → финалы declined | expired | revoked | ended.
 * Имена людей не склоняем нигде (это их displayName): «Решает Рома», «попросил Петя».
 */
import { canAct, type BotCard } from './cardEnvelope'
import { formatHm, freshName, groupDigits, plural, type RichLine } from './cardFormat'

export type SharePeriod = 'today' | 'week' | 'all'
export const SHARE_PERIODS: readonly SharePeriod[] = ['today', 'week', 'all']
export const SHARE_PERIOD_LABEL: Record<SharePeriod, string> = { today: 'Сегодня', week: 'Эта неделя', all: 'Всё время' }
export const SHARE_PERIOD_FOR: Record<SharePeriod, string> = { today: 'за сегодня', week: 'за эту неделю', all: 'за всё время' }

export type ShareOption = {
  period: SharePeriod
  messages: number
  photos: number
  photosUsed?: number | null
  enabled: boolean
  off?: 'too_big' | 'budget' | string | null
  capped?: boolean
}

export type ShareData = {
  asker?: { id?: string; displayName?: string } | null
  suggest?: { period?: SharePeriod; photos?: boolean } | null
  options?: ShareOption[]
  note?: 'too_big' | 'budget' | string | null
  choice?: { period: SharePeriod; photos: boolean; by?: { id?: string; displayName?: string } | null; at?: string } | null
  until?: string | null
  answerMessageId?: string | null
  read?: { messages: number; photos: number } | null
  endedBy?: { reason: string; by?: { id?: string; displayName?: string } | null; at?: string | null } | null
}

export type ShareLocalChoice = { period?: SharePeriod | null; photos?: boolean | null }

const MIN = 60_000
const isPeriod = (p: unknown): p is SharePeriod => p === 'today' || p === 'week' || p === 'all'
const tms = (s: unknown): number | null => (typeof s === 'string' && Number.isFinite(Date.parse(s)) ? Date.parse(s) : null)

export const messagesText = (n: number): string => `${groupDigits(n)} ${plural(n, 'сообщение', 'сообщения', 'сообщений')}`

export function shareData(card: BotCard): ShareData {
  return (card.data ?? {}) as ShareData
}

/** Варианты в каноническом порядке (сервер может прислать не все — недостающих нет). */
export function shareOptions(d: ShareData): ShareOption[] {
  const list = Array.isArray(d.options) ? d.options : []
  const out: ShareOption[] = []
  for (const p of SHARE_PERIODS) {
    const o = list.find((x) => x && x.period === p)
    if (!o) continue
    out.push({
      period: p,
      messages: Math.max(0, Number(o.messages) || 0),
      photos: Math.max(0, Number(o.photos) || 0),
      photosUsed: typeof o.photosUsed === 'number' ? o.photosUsed : null,
      enabled: o.enabled !== false,
      off: o.off ?? null,
      capped: o.capped === true,
    })
  }
  return out
}

/** Вариант можно выбрать: включён и не пустой. */
export const optionUsable = (o: ShareOption | undefined | null): boolean => !!o && o.enabled && (o.messages > 0 || o.photos > 0)

/** Выбранный по умолчанию: подсказка бота, а если она пустая/погашена — следующий непустой, потом прежние. */
export function defaultSharePeriod(d: ShareData): SharePeriod | null {
  const opts = shareOptions(d)
  const s = isPeriod(d.suggest?.period) ? d.suggest!.period! : 'today'
  const i = SHARE_PERIODS.indexOf(s)
  const order = [...SHARE_PERIODS.slice(i), ...SHARE_PERIODS.slice(0, i).reverse()]
  for (const p of order) {
    if (optionUsable(opts.find((o) => o.period === p))) return p
  }
  return null
}

function offText(o: ShareOption): string {
  return o.off === 'budget' ? 'лимит на сегодня' : 'слишком много'
}

export type ShareChip = { period: SharePeriod; label: string; sub: string; aria: string; enabled: boolean; selected: boolean }

export type ShareCardModel = {
  state: string
  closed: boolean
  /** choose — выбор у спросившего; waiting — ждём спросившего; reading/answered — доступ дан; final — итог. */
  mode: 'choose' | 'waiting' | 'reading' | 'answered' | 'final'
  note: string | null
  chips: ShareChip[]
  selected: SharePeriod | null
  photos: { checked: boolean; disabled: boolean; note: string; aria: string }
  shareAria: string
  canDecline: boolean
  canShare: boolean
  lines: RichLine[]
  /** Строка-ссылка «Ответ ниже ↓ · доступ ещё 42 мин» (answered). */
  answer: { messageId: string; tail: string } | null
  readingDots: boolean
  canForget: boolean
  /** Нужен ли минутный тик (ждём выбора / доступ идёт). */
  live: boolean
  /** Что отправить действием share. */
  input: { period: SharePeriod; photos: boolean } | null
  /** Короткая фраза для живой области при смене состояния. */
  announce: string
}

export type ShareViewer = {
  id: string | null | undefined
  zone?: string
  resolveName?: (id: string) => string | null | undefined
}

const minsLeft = (untilMs: number | null, nowMs: number): number | null =>
  untilMs == null || untilMs <= nowMs ? null : Math.max(1, Math.ceil((untilMs - nowMs) / MIN))

function readText(messages: number, photos: number): string {
  return photos > 0 ? `${messagesText(messages)} и ${photos} фото` : messagesText(messages)
}

/** Плашка «неподъёмно»: о каком периоде — выбранный раньше, иначе меньший погашенный. */
function noteText(d: ShareData, opts: ShareOption[]): string | null {
  if (!d.note) return null
  const off = opts.filter((o) => !o.enabled && o.off)
  const chosen = d.choice && isPeriod(d.choice.period) ? opts.find((o) => o.period === d.choice!.period && !o.enabled) : undefined
  const target = chosen ?? off[0]
  const p = target ? SHARE_PERIOD_FOR[target.period] : 'за этот период'
  const head = p.charAt(0).toUpperCase() + p.slice(1)
  if (d.note === 'budget' || target?.off === 'budget') return `${head} выходит больше моего лимита на сегодня. Выбери период поменьше.`
  return `${head} выходит слишком много для моего лимита. Выбери период поменьше.`
}

/** Всё, что рисует карточка «поделиться перепиской», на момент nowMs. */
export function buildShareCard(card: BotCard, nowMs: number, viewer: ShareViewer, local: ShareLocalChoice = {}): ShareCardModel {
  const d = shareData(card)
  const opts = shareOptions(d)
  const askerName = freshName(d.asker?.id, d.asker?.displayName, viewer.resolveName)
  const A = { text: askerName, bold: true }
  const canShare = canAct(card, 'share', viewer.id, nowMs)
  const canDecline = canAct(card, 'decline', viewer.id, nowMs)
  const canForget = canAct(card, 'forget', viewer.id, nowMs)
  const choice = d.choice && isPeriod(d.choice.period) ? d.choice : null
  const withPhotos = choice?.photos ? ', с фото' : ''

  const empty = {
    note: null as string | null,
    chips: [] as ShareChip[],
    selected: null as SharePeriod | null,
    photos: { checked: false, disabled: true, note: '', aria: '' },
    shareAria: 'Поделиться перепиской',
    input: null as ShareCardModel['input'],
    answer: null as ShareCardModel['answer'],
    readingDots: false,
  }

  if (card.state === 'pending') {
    if (canShare || canDecline) {
      const def = defaultSharePeriod(d)
      const localOk = local.period && optionUsable(opts.find((o) => o.period === local.period)) ? local.period : null
      const selected = localOk ?? def
      const chips: ShareChip[] = opts.map((o) => {
        const usable = optionUsable(o)
        // Погашен ботом (слишком много / лимит) — причина; пустой — «0 сообщ.».
        const offReason = !o.enabled && o.off ? offText(o) : null
        const sub = offReason ?? `${groupDigits(o.messages)} сообщ.`
        const aria = usable
          ? `${SHARE_PERIOD_LABEL[o.period]}, ${messagesText(o.messages)}`
          : `${SHARE_PERIOD_LABEL[o.period]}, недоступно: ${offReason ?? 'нет сообщений'}`
        return { period: o.period, label: SHARE_PERIOD_LABEL[o.period], sub, aria, enabled: usable, selected: o.period === selected }
      })
      const opt = opts.find((o) => o.period === selected) ?? null
      const photoCount = opt?.photos ?? 0
      const disabled = photoCount <= 0
      const used = opt?.photosUsed != null && opt.photosUsed < photoCount ? opt.photosUsed : null
      const note = disabled ? '(нет фото)' : used != null ? `(${used} последних из ${groupDigits(photoCount)})` : `(${groupDigits(photoCount)})`
      const checked = !disabled && !!(local.photos ?? d.suggest?.photos ?? false)
      const shownPhotos = used ?? photoCount
      return {
        ...empty,
        state: card.state,
        closed: card.closed,
        mode: 'choose',
        note: noteText(d, opts),
        chips,
        selected,
        photos: { checked, disabled, note, aria: disabled ? 'Включать фото, нет фото' : `Включать фото, ${shownPhotos} фото` },
        shareAria: selected ? `Поделиться перепиской ${SHARE_PERIOD_FOR[selected]}` : 'Поделиться перепиской',
        canShare: canShare && !!selected,
        canDecline,
        canForget: false,
        lines: [[{ text: 'Чтобы ответить, мне нужно почитать переписку этой беседы. Поделиться?' }]],
        live: true,
        input: selected ? { period: selected, photos: checked } : null,
        announce: '',
      }
    }
    const share = card.actions.find((a) => a.id === 'share') ?? card.actions.find((a) => a.id === 'decline')
    const left = minsLeft(tms(share?.until ?? null), nowMs)
    return {
      ...empty,
      state: card.state,
      closed: card.closed,
      mode: 'waiting',
      canShare: false,
      canDecline: false,
      canForget: false,
      lines: [
        [{ text: 'Еблуша просит разрешения почитать переписку этой беседы, чтобы ответить.' }],
        [{ text: 'Решает ' }, A, { text: left != null ? ` · ждём ещё ${left} мин` : ' · время на выбор вышло' }],
      ],
      live: left != null,
      announce: '',
    }
  }

  if (card.state === 'granted') {
    const head: RichLine = [{ text: '✓', tone: 'ok' }, { text: ' ' }, A, { text: ` поделился перепиской ${choice ? SHARE_PERIOD_FOR[choice.period] : ''}${withPhotos}`.replace(/ $/, '') }]
    const left = minsLeft(tms(d.until ?? null), nowMs)
    if (d.answerMessageId) {
      const r = d.read ?? null
      const lines: RichLine[] = [head]
      if (r) lines.push([{ text: `Прочитал ${readText(Math.max(0, Number(r.messages) || 0), Math.max(0, Number(r.photos) || 0))}.` }])
      return {
        ...empty,
        state: card.state,
        closed: card.closed,
        mode: 'answered',
        canShare: false,
        canDecline: false,
        canForget,
        lines,
        answer: { messageId: String(d.answerMessageId), tail: left != null ? ` · доступ ещё ${left} мин` : ' · доступ заканчивается' },
        live: left != null,
        announce: 'Ответ готов',
      }
    }
    const opt = choice ? opts.find((o) => o.period === choice.period) : undefined
    const photos = choice?.photos && opt ? Math.min(opt.photos, opt.photosUsed ?? opt.photos) : 0
    return {
      ...empty,
      state: card.state,
      closed: card.closed,
      mode: 'reading',
      canShare: false,
      canDecline: false,
      canForget,
      lines: [head, [{ text: opt ? `Читаю: ${readText(opt.messages, photos)}` : 'Читаю переписку' }]],
      readingDots: true,
      live: left != null,
      announce: `${askerName} поделился перепиской ${choice ? SHARE_PERIOD_FOR[choice.period] : ''}`.trim(),
    }
  }

  // Финалы — у всех одинаково, серым, без кнопок.
  const e = d.endedBy ?? null
  const by = e?.by && typeof e.by === 'object' ? e.by : null
  const byName = by ? freshName(by.id, by.displayName, viewer.resolveName) : null
  const byIsAsker = !!by?.id && !!d.asker?.id && String(by.id) === String(d.asker.id)
  let line: RichLine
  let announce = ''
  switch (card.state) {
    case 'ended': {
      const at = tms(e?.at ?? null) ?? tms(d.until ?? null)
      line = [A, { text: ` делился перепиской ${choice ? SHARE_PERIOD_FOR[choice.period] : ''}${withPhotos}.`.replace(' .', '.') + (at != null ? ` Доступ закончился в ${formatHm(at, viewer.zone)}.` : ' Доступ закончился.') }]
      announce = 'Доступ к переписке закончился'
      break
    }
    case 'declined':
      line = [A, { text: ' не стал делиться перепиской.' }]
      announce = `${askerName} не стал делиться перепиской`
      break
    case 'expired':
      if (e?.reason === 'question_deleted') line = [{ text: 'Вопрос удалили — переписку не читаю.' }]
      else if (e?.reason === 'asker_left') line = [A, { text: ' вышел из беседы — переписку не читаю.' }]
      else if (e?.reason === 'replaced') line = [{ text: 'Вопрос сменился — по этой карточке переписку не читаю.' }]
      else line = [A, { text: ' не ответил — переписку не читаю.' }]
      announce = 'Переписку не читаю'
      break
    case 'revoked':
      if (e?.reason === 'asker_left') line = [A, { text: ' вышел из беседы — переписку забыл.' }]
      else if (by && !byIsAsker) line = [{ text: 'Переписка забыта · попросил ' }, { text: byName!, bold: true }, { text: '.' }]
      else if (by && byIsAsker) line = [A, { text: ' забрал разрешение.' }]
      else line = [{ text: 'Переписка забыта.' }]
      announce = 'Переписка забыта'
      break
    default:
      line = [{ text: 'Переписку не читаю.' }]
  }
  return {
    ...empty,
    state: card.state,
    closed: true,
    mode: 'final',
    canShare: false,
    canDecline: false,
    canForget: false,
    lines: [line],
    live: false,
    announce,
  }
}

/** Тост при неудаче действия (SPEC-share.md §13). */
export function shareFailureToast(action: string, failure: string): string | null {
  if (failure === 'not_found') return null
  if (failure === 'closed' || failure === 'expired') return 'Уже не актуально'
  if (failure === 'forbidden') return 'Решает тот, кто спросил'
  if (failure === 'disabled') return 'Сейчас недоступно'
  if (failure === 'rate_limited') return 'Слишком часто'
  if (action === 'share') return 'Не получилось поделиться'
  return 'Не получилось'
}

/** Оптимистичный вид после нажатия. */
export function optimisticShare(card: BotCard, action: string, me: { id: string; displayName: string }, nowMs: number, input?: { period: SharePeriod; photos: boolean } | null): BotCard | null {
  const d = shareData(card)
  const nowIso = new Date(nowMs).toISOString()
  if (action === 'share' && card.state === 'pending' && input) {
    const until = new Date(nowMs + 60 * MIN).toISOString()
    return {
      ...card,
      state: 'granted',
      closed: false,
      actions: [{ id: 'forget', who: { any: true }, until }],
      data: { ...d, note: null, choice: { period: input.period, photos: input.photos, by: { id: me.id, displayName: me.displayName }, at: nowIso }, until, answerMessageId: null, read: null },
    }
  }
  if (action === 'decline' && card.state === 'pending') {
    return { ...card, state: 'declined', closed: true, actions: [], data: { ...d, endedBy: { reason: 'declined', by: { id: me.id, displayName: me.displayName }, at: nowIso } } }
  }
  if (action === 'forget' && card.state === 'granted') {
    return { ...card, state: 'revoked', closed: true, actions: [], data: { ...d, endedBy: { reason: 'revoked', by: { id: me.id, displayName: me.displayName }, at: nowIso } } }
  }
  return null
}
