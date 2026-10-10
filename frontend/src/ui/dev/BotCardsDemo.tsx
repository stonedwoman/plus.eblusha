/**
 * Dev-стенд карточек бота: /__dev/bot-cards (и /__dev/promise-timer). Только dev-сборка — в production
 * маршрута и чанка нет.
 *
 * Все состояния таймера обещания (SPEC.md §10) и «поделиться перепиской» (SPEC-share.md §6) настоящими
 * компонентами ленты (BotCardView в пузыре бота), «Подумай лучше» под ответом бота, запасной текст для
 * неизвестной версии. Действия идут в ПОДДЕЛЬНЫЙ сервер (задержка, rev+1, ошибка по заказу).
 *
 * Параметры адреса (для снимков и smoke без окон): viewer=roma|vasya|petya, rm=1 (меньше движения),
 * narrow=1 (колонка 360 px — как лента телефона), only=<id карточки>, smoke=1 (сценарий проверок → #eb-smoke: «SMOKE OK» / «SMOKE FAIL»).
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { BotCardView } from '../components/bot/BotCardView'
import { BotAnswerActions } from '../components/bot/BotAnswerActions'
import type { BotCardEnv } from '../components/bot/botCardEnv'
import { BotTag } from '../components/bot/BotUi'
import { botCardOfMessage, type BotCard } from '../../domain/cards/cardEnvelope'
import type { CardFailure, CardTransport } from '../../domain/cards/cardActions'
import { getStoredCard, offerCard } from '../../domain/cards/cardStore'
import { optimisticPromise } from '../../domain/cards/promiseCard'
import { optimisticShare, type SharePeriod } from '../../domain/cards/shareCard'
import { botClarifyTarget, botThinkBetterTarget, botThinkBetterText } from '../../domain/bot/systemBot'
import { renderMessageText } from '../pages/chats/chatsTextRender'

const T0 = Date.now()
const MIN = 60_000
const iso = (ms: number) => new Date(ms).toISOString()

const PEOPLE: Record<string, { id: string; displayName: string }> = {
  roma: { id: 'roma', displayName: 'Рома' },
  vasya: { id: 'vasya', displayName: 'Козёл Ебаный' },
  petya: { id: 'petya', displayName: 'Петя' },
}
const OWNER = 'roma'

// ───────────────────────── Данные таймера (metadata.card, type "promise") ─────────────────────────

function promise(id: string, state: string, data: Record<string, any>, extra?: { actions?: BotCard['actions']; rev?: number }): BotCard {
  const running = state === 'running'
  return {
    v: 1,
    type: 'promise',
    id,
    rev: extra?.rev ?? 1,
    state,
    closed: !running,
    actions:
      extra?.actions ??
      (running
        ? [
            { id: 'arrived', who: { any: true }, until: null },
            { id: 'cancel', who: { ids: ['roma', OWNER] }, until: null },
          ]
        : []),
    data: {
      promiser: PEOPLE.vasya,
      requester: PEOPLE.roma,
      quote: { messageId: 'm1', text: '15мин', at: iso(T0 - 2 * MIN), by: null, deleted: false },
      label: '15 мин',
      upperBound: false,
      extensions: [],
      extensionCount: 0,
      promiserZone: null,
      cancelBy: ['roma', OWNER],
      closedAt: null,
      outcome: null,
      cancelledBy: null,
      reminders: [],
      ...data,
    },
    source: 'card',
  }
}

const ext1 = [{ at: iso(T0 - 14 * MIN), from: iso(T0 - 13 * MIN), to: iso(T0 - 3 * MIN), label: 'ещё 10 мин' }]

const PROMISE_CARDS: Array<{ key: string; title: string; card: BotCard }> = [
  { key: 'p-running', title: 'идёт', card: promise('a', 'running', { startAt: iso(T0 - 2 * MIN - 13_000), deadlineAt: iso(T0 + 12 * MIN + 47_000), originalDeadlineAt: iso(T0 + 12 * MIN + 47_000) }) },
  {
    key: 'p-final',
    title: 'последние 60 с (через 42 с — «опаздывает»), «по местному»',
    card: promise('b', 'running', {
      quote: { messageId: 'm2', text: 'в два часа давай', at: iso(T0 - 14 * MIN), by: null, deleted: false },
      label: 'в 14:00',
      startAt: iso(T0 - 14 * MIN - 18_000),
      deadlineAt: iso(T0 + 42_000),
      promiserZone: 'Asia/Krasnoyarsk',
    }),
  },
  {
    key: 'p-long',
    title: 'идёт, больше часа, верхняя граница',
    card: promise('c', 'running', {
      quote: { messageId: 'm3', text: 'час-полтора и я ваш', at: iso(T0 - 17 * MIN), by: null, deleted: false },
      label: 'час-полтора → 1,5 ч',
      upperBound: true,
      startAt: iso(T0 - 17 * MIN - 13_000),
      deadlineAt: iso(T0 + 72 * MIN + 47_000),
    }),
  },
  {
    key: 'p-late',
    title: 'опаздывает, продлевал',
    card: promise('d', 'running', {
      startAt: iso(T0 - 28 * MIN),
      deadlineAt: iso(T0 - 3 * MIN - 12_000),
      originalDeadlineAt: iso(T0 - 13 * MIN),
      extensions: ext1,
      extensionCount: 1,
      reminders: [0],
    }),
  },
  {
    key: 'p-ontime',
    title: 'пришёл вовремя (звонок)',
    card: promise('e', 'arrived', {
      startAt: iso(T0 - 40 * MIN),
      deadlineAt: iso(T0 - 25 * MIN),
      closedAt: iso(T0 - 28 * MIN),
      outcome: { kind: 'onTime', arrivedAt: iso(T0 - 28 * MIN), deltaSec: -180, deltaVsOriginalSec: -180, via: 'call', by: null },
    }),
  },
  {
    key: 'p-latearrived',
    title: 'опоздал (Valheim), продлевал',
    card: promise('f', 'arrived', {
      startAt: iso(T0 - 60 * MIN),
      deadlineAt: iso(T0 - 35 * MIN),
      originalDeadlineAt: iso(T0 - 45 * MIN),
      extensions: ext1,
      extensionCount: 1,
      closedAt: iso(T0 - 28 * MIN),
      outcome: { kind: 'late', arrivedAt: iso(T0 - 28 * MIN), deltaSec: 420, deltaVsOriginalSec: 1020, via: 'valheim', by: null },
    }),
  },
  {
    key: 'p-cancelled',
    title: 'отменён (можно «Вернуть» 2 мин)',
    card: promise(
      'g',
      'cancelled',
      { startAt: iso(T0 - 5 * MIN), deadlineAt: iso(T0 + 10 * MIN), closedAt: iso(T0 - 10_000), cancelledBy: PEOPLE.roma },
      { actions: [{ id: 'reopen', who: { ids: ['roma', OWNER] }, until: iso(T0 + 110_000) }] },
    ),
  },
  {
    key: 'p-unresolved',
    title: 'никто не отметил',
    card: promise('h', 'unresolved', { startAt: iso(T0 - 7 * 60 * MIN), deadlineAt: iso(T0 - 6 * 60 * MIN - 2 * MIN), closedAt: iso(T0 - 2 * MIN) }),
  },
  {
    key: 'p-marked',
    title: 'пришёл вовремя — отметил Петя, запас меньше минуты',
    card: promise(
      'i',
      'arrived',
      {
        startAt: iso(T0 - 20 * MIN),
        deadlineAt: iso(T0 - 4 * MIN),
        closedAt: iso(T0 - 4 * MIN - 20_000),
        outcome: { kind: 'onTime', arrivedAt: iso(T0 - 4 * MIN - 20_000), deltaSec: -20, deltaVsOriginalSec: -20, via: 'button', by: PEOPLE.petya },
      },
      { actions: [{ id: 'reopen', who: { ids: ['petya', 'roma', OWNER] }, until: iso(T0 + 100_000) }] },
    ),
  },
  {
    key: 'p-deleted',
    title: 'обещание удалено, со слов Ромы',
    card: promise('j', 'running', {
      quote: { messageId: 'm9', text: null, at: iso(T0 - 6 * MIN), by: { id: 'roma', displayName: 'Рома' }, deleted: true },
      label: '30 мин',
      startAt: iso(T0 - 6 * MIN),
      deadlineAt: iso(T0 + 24 * MIN),
    }),
  },
]

// ───────────────────────── Данные «поделиться перепиской» (type "share") ─────────────────────────

const OPTIONS = [
  { period: 'today', messages: 34, photos: 3, enabled: true },
  { period: 'week', messages: 128, photos: 18, enabled: true },
  { period: 'all', messages: 1738, photos: 337, photosUsed: 60, enabled: true },
]
const PENDING_ACTIONS = (until: number): BotCard['actions'] => [
  { id: 'share', who: { ids: ['roma'] }, until: iso(until) },
  { id: 'decline', who: { ids: ['roma'] }, until: iso(until) },
]
function share(id: string, state: string, data: Record<string, any>, actions: BotCard['actions'] = []): BotCard {
  return {
    v: 1,
    type: 'share',
    id,
    rev: 1,
    state,
    closed: !['pending', 'granted'].includes(state),
    actions,
    data: {
      asker: PEOPLE.roma,
      suggest: { period: 'today', photos: false },
      options: OPTIONS,
      note: null,
      choice: null,
      until: null,
      answerMessageId: null,
      read: null,
      endedBy: null,
      ...data,
    },
    source: 'card',
  }
}
const choice = (period: SharePeriod, photos: boolean) => ({ period, photos, by: PEOPLE.roma, at: iso(T0 - 2 * MIN) })

const SHARE_CARDS: Array<{ key: string; title: string; card: BotCard }> = [
  { key: 's-pending', title: 'ожидает выбора', card: share('s1', 'pending', {}, PENDING_ACTIONS(T0 + 28 * MIN)) },
  {
    key: 's-toobig',
    title: 'ожидает, «всё время» неподъёмно (бот вернул карточку)',
    card: share(
      's2',
      'pending',
      { note: 'too_big', suggest: { period: 'week', photos: true }, options: OPTIONS.map((o) => (o.period === 'all' ? { ...o, enabled: false, off: 'too_big' } : o)) },
      PENDING_ACTIONS(T0 + 25 * MIN),
    ),
  },
  {
    key: 's-empty',
    title: 'ожидает: сегодня пусто, неделя без фото, лимит на сегодня',
    card: share(
      's3',
      'pending',
      {
        options: [
          { period: 'today', messages: 0, photos: 0, enabled: false },
          { period: 'week', messages: 12, photos: 0, enabled: true },
          { period: 'all', messages: 492, photos: 41, enabled: false, off: 'budget' },
        ],
      },
      PENDING_ACTIONS(T0 + 29 * MIN),
    ),
  },
  { key: 's-reading', title: 'дано, читаю', card: share('s4', 'granted', { choice: choice('today', true), until: iso(T0 + 58 * MIN) }, [{ id: 'forget', who: { any: true }, until: iso(T0 + 58 * MIN) }]) },
  {
    key: 's-answered',
    title: 'дано, ответ есть',
    card: share('s5', 'granted', { choice: choice('today', true), until: iso(T0 + 42 * MIN), answerMessageId: 'demo-answer', read: { messages: 34, photos: 3 } }, [
      { id: 'forget', who: { any: true }, until: iso(T0 + 42 * MIN) },
    ]),
  },
  { key: 's-ended', title: 'доступ закончился', card: share('s6', 'ended', { choice: choice('week', false), endedBy: { reason: 'ended', by: null, at: iso(T0 - 5 * MIN) }, read: { messages: 128, photos: 0 } }) },
  { key: 's-declined', title: 'отказ', card: share('s7', 'declined', { endedBy: { reason: 'declined', by: PEOPLE.roma, at: iso(T0 - MIN) } }) },
  { key: 's-expired', title: 'не ответил', card: share('s8', 'expired', { endedBy: { reason: 'expired', by: null, at: iso(T0 - MIN) } }) },
  { key: 's-qdeleted', title: 'вопрос удалили', card: share('s9', 'expired', { endedBy: { reason: 'question_deleted', by: null, at: iso(T0 - MIN) } }) },
  { key: 's-revoked-other', title: 'забыта (попросил другой)', card: share('s10', 'revoked', { choice: choice('all', false), endedBy: { reason: 'revoked', by: PEOPLE.petya, at: iso(T0 - MIN) } }) },
  { key: 's-revoked-self', title: 'забыта (сам спросивший)', card: share('s11', 'revoked', { choice: choice('today', false), endedBy: { reason: 'revoked', by: PEOPLE.roma, at: iso(T0 - MIN) } }) },
]

/** Сценарий smoke — один раз на загрузку страницы (StrictMode в dev запускает эффекты дважды). */
let smokeStarted = false

const FALLBACK_TEXT = '⏱ Таймер: **Козёл Ебаный** обещал «15мин» — жду до 14:15 МСК.\nЖивой таймер — в новой версии Еблуши.'

function cardMessage(key: string, card: BotCard | null, raw?: Record<string, any>): any {
  return {
    id: `demo-${key}`,
    isBot: true,
    senderId: 'bot',
    conversationId: 'demo-conv',
    createdAt: iso(T0 - 2 * MIN),
    content: FALLBACK_TEXT,
    metadata: raw ?? { bot: { v: 1, kind: 'card', triggerMessageId: 'q1', askerId: 'roma' }, card },
  }
}

// ───────────────────────── Поддельный сервер ─────────────────────────

type ServerLog = { messageId: string; action: string; input?: unknown }

function useFakeServer(viewerRef: { current: string }, failNextRef: { current: CardFailure | null }, log: (e: ServerLog) => void): CardTransport {
  return useMemo<CardTransport>(
    () => ({
      async act(messageId, card, action, input) {
        log({ messageId, action, input })
        await new Promise((r) => setTimeout(r, 350))
        const fail = failNextRef.current
        if (fail) {
          failNextRef.current = null
          return { ok: false, failure: fail, card: null }
        }
        const cur = getStoredCard(messageId) ?? card
        const me = PEOPLE[viewerRef.current] ?? PEOPLE.roma
        const now = Date.now()
        const next =
          cur.type === 'promise'
            ? optimisticPromise(cur, action, me, now)
            : optimisticShare(cur, action, me, now, (input as { period: SharePeriod; photos: boolean } | undefined) ?? null)
        if (!next) return { ok: false, failure: 'closed', card: cur }
        const served: BotCard = { ...next, rev: cur.rev + 1 }
        if (served.type === 'share' && action === 'share') {
          // «Бот ответил» через 2.5 с — как событие message:update с rev+1.
          setTimeout(() => {
            const latest = getStoredCard(messageId)
            if (!latest || latest.state !== 'granted') return
            const d = latest.data as any
            const opt = (d.options || []).find((o: any) => o.period === d.choice?.period)
            offerCard(messageId, {
              ...latest,
              rev: latest.rev + 1,
              data: { ...d, answerMessageId: 'demo-answer', read: { messages: opt?.messages ?? 0, photos: d.choice?.photos ? Math.min(opt?.photos ?? 0, opt?.photosUsed ?? opt?.photos ?? 0) : 0 } },
            })
          }, 2500)
        }
        return { ok: true, card: served, message: null }
      },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )
}

// ───────────────────────── Разметка стенда ─────────────────────────

const page: CSSProperties = { minHeight: '100vh', background: 'var(--paper, #0f1217)', color: 'var(--text-primary, #f1f3f6)', padding: '24px 16px 64px', boxSizing: 'border-box' }
const grid = (narrow: boolean): CSSProperties => ({
  display: 'grid',
  // Ширина колонки ≈ ширина строки ленты: пузырь бота ограничен 70 % строки (70cqi у .msg), карточке нужно 360.
  gridTemplateColumns: narrow ? '360px' : 'repeat(auto-fill, minmax(540px, 1fr))',
  gap: '20px 24px',
  alignItems: 'start',
})
const slotTitle: CSSProperties = { fontSize: 12, color: 'var(--text-muted, #9aa0a8)', margin: '0 0 6px 4px' }

function BotBubble({ children, quote, demoId }: { children: ReactNode; quote?: string; demoId: string }) {
  return (
    <div className="msg them gap" data-demo-id={demoId} style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
      <div className="eb-bot-avatar" style={{ width: 32, height: 32, fontSize: 19 }} aria-hidden>
        <span>Б</span>
      </div>
      <div className="msg-bubble them msg-bubble--bot msg-bubble--reactions-inline" style={{ ['--bubble-bg' as string]: '#221c19', ['--bubble-fg' as string]: '#f1f3f6' }}>
        <div className="msg-bubble-body">
          <div style={{ display: 'inline-flex', gap: 5, alignItems: 'center', fontSize: 14, fontWeight: 700, marginBottom: quote ? 6 : 4, color: '#E25C2A' }}>
            Еблуша <BotTag />
          </div>
          {quote ? (
            <div style={{ fontSize: 12, color: 'var(--text-muted)', borderLeft: '2px solid rgba(255,255,255,0.15)', padding: '1px 0 1px 8px', marginBottom: 8, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 340 }}>
              <b style={{ color: '#cfd3d9' }}>Рома</b>: {quote}
            </div>
          ) : null}
          {children}
          <div className="msg-meta" style={{ color: '#9aa0a8' }}>
            <span>14:02</span>
          </div>
        </div>
      </div>
    </div>
  )
}

export default function BotCardsDemo() {
  const qs = useMemo(() => new URLSearchParams(typeof window !== 'undefined' ? window.location.search : ''), [])
  const [viewer, setViewer] = useState<string>(() => (PEOPLE[qs.get('viewer') ?? ''] ? (qs.get('viewer') as string) : 'roma'))
  const [rm, setRm] = useState(qs.get('rm') === '1')
  const [narrow, setNarrow] = useState(qs.get('narrow') === '1')
  const only = qs.get('only')
  const smoke = qs.get('smoke') === '1'
  const viewerRef = useRef(viewer)
  viewerRef.current = viewer
  const failNextRef = useRef<CardFailure | null>(null)
  const [failNext, setFailNext] = useState(false)
  const [serverLog, setServerLog] = useState<ServerLog[]>([])
  const serverLogRef = useRef<ServerLog[]>([])
  const [toasts, setToasts] = useState<string[]>([])
  const toastsRef = useRef<string[]>([])
  const [sent, setSent] = useState<Array<{ text: string; replyToId: string }>>([])
  const sentRef = useRef<Array<{ text: string; replyToId: string }>>([])
  const [scrolledTo, setScrolledTo] = useState<string | null>(null)
  const scrolledRef = useRef<string | null>(null)

  const transport = useFakeServer(viewerRef, failNextRef, (e) => {
    serverLogRef.current = [...serverLogRef.current, e]
    setServerLog(serverLogRef.current)
  })
  useEffect(() => {
    failNextRef.current = failNext ? 'error' : null
  }, [failNext])

  const env: BotCardEnv = {
    viewer: PEOPLE[viewer],
    transport,
    resolveName: (id) => PEOPLE[id]?.displayName ?? null,
    onScrollToMessage: (id) => {
      scrolledRef.current = id
      setScrolledTo(id)
    },
    reducedMotion: rm,
    toast: (t) => {
      toastsRef.current = [...toastsRef.current, t]
      setToasts(toastsRef.current)
    },
  }

  // «Подумай лучше»: лента из двух частей ответа, ответ «подумал лучше» (depth deep) и карточка.
  const thinkList = useMemo(
    () => [
      { id: 'q1', senderId: viewer, content: 'Еблуша, сколько дерева надо на драккар?', createdAt: iso(T0 - 5 * MIN) },
      { id: 'a1', isBot: true, senderId: 'bot', replyTo: { id: 'q1' }, content: 'Драккар: 40 мелкого дерева, 10 смолистого…', metadata: { bot: { v: 1, kind: 'answer', triggerMessageId: 'q1' } }, createdAt: iso(T0 - 4 * MIN) },
      { id: 'a2', isBot: true, senderId: 'bot', content: '…и 20 бронзовых гвоздей.', metadata: { bot: { v: 1, kind: 'answer', triggerMessageId: 'q1' } }, createdAt: iso(T0 - 4 * MIN) },
      { id: 'q2', senderId: viewer, content: 'Еблуша, а железо где брать?', createdAt: iso(T0 - 3 * MIN) },
      { id: 'a3', isBot: true, senderId: 'bot', replyTo: { id: 'q2' }, content: '🧠 Подумал лучше\n\nЖелезо — в затопленных склепах Болот…', metadata: { bot: { v: 1, kind: 'answer', triggerMessageId: 'q2', depth: 'deep', model: 'claude-fable-5-1' } }, createdAt: iso(T0 - 2 * MIN) },
    ],
    [viewer],
  )
  const [thinkBusy, setThinkBusy] = useState<string | null>(null)
  const sendThink = (target: any) => {
    setThinkBusy(String(target.id))
    setTimeout(() => {
      const rec = { text: botThinkBetterText(false), replyToId: String(target.id) }
      sentRef.current = [...sentRef.current, rec]
      setSent(sentRef.current)
      setThinkBusy(null)
    }, 300)
  }

  // ───── smoke: сценарий проверок настоящими компонентами ─────
  const [smokeOut, setSmokeOut] = useState<string[]>([])
  useEffect(() => {
    if (!smoke || smokeStarted) return
    smokeStarted = true
    const out: string[] = []
    const ok = (name: string, cond: boolean, extra = '') => {
      out.push(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`)
      setSmokeOut([...out])
    }
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
    const q = (demoId: string, sel: string) => document.querySelector(`[data-demo-id="${demoId}"] ${sel}`) as HTMLElement | null
    const qa = (demoId: string, sel: string) => Array.from(document.querySelectorAll(`[data-demo-id="${demoId}"] ${sel}`)) as HTMLElement[]
    const btn = (demoId: string, text: string) => qa(demoId, 'button').find((b) => b.textContent?.trim().endsWith(text)) ?? null
    const run = async () => {
      await wait(400)
      // 1. Таймер идёт: цифры и кнопки у спросившего
      const digits = q('p-running', '.eb-pt-digits')?.textContent ?? ''
      ok('таймер: «идёт» — мм:сс', /^\d\d:\d\d$/.test(digits), digits)
      ok('таймер: у спросившего «Пришёл» и «Отменить»', !!btn('p-running', 'Пришёл') && !!btn('p-running', 'Отменить'))
      ok('таймер: > 1 ч — ч:мм:сс', /^\d:\d\d:\d\d$/.test(q('p-long', '.eb-pt-digits')?.textContent ?? ''), q('p-long', '.eb-pt-digits')?.textContent ?? '')
      ok('таймер: опаздывает — +мм:сс', /^\+\d\d:\d\d$/.test(q('p-late', '.eb-pt-digits')?.textContent ?? ''), q('p-late', '.eb-pt-digits')?.textContent ?? '')
      ok('таймер: «по местному» у пояса обещавшего', /по местному \d\d:\d\d/.test(q('p-final', '.eb-pt-sub')?.textContent ?? '') || Intl.DateTimeFormat().resolvedOptions().timeZone === 'Asia/Krasnoyarsk')
      ok('таймер: reopen — «Вернуть» у отменившего', !!btn('p-cancelled', 'Вернуть'))
      // 2. Пришёл → оптимистично «вовремя» → ответ сервера rev 2 → «Вернуть» → снова идёт
      const before = Number(q('p-running', '[data-card-rev]')?.getAttribute('data-card-rev'))
      btn('p-running', 'Пришёл')?.click()
      await wait(60)
      ok('«Пришёл»: сразу оптимистично', q('p-running', '.eb-pt')?.getAttribute('data-view') === 'onTime')
      await wait(600)
      const after = Number(q('p-running', '[data-card-rev]')?.getAttribute('data-card-rev'))
      ok('«Пришёл»: ответ сервера принят по rev', after === before + 1, `${before} → ${after}`)
      ok('«Пришёл»: «отметил Рома»', (q('p-running', '.eb-pt-cap')?.textContent ?? '').includes('отметил Рома'))
      btn('p-running', 'Вернуть')?.click()
      await wait(600)
      ok('«Вернуть»: таймер снова идёт', q('p-running', '.eb-pt')?.getAttribute('data-view') === 'running')
      // 3. Старое событие (rev меньше) не откатывает
      const stored = getStoredCard('demo-p-running')
      if (stored) offerCard('demo-p-running', { ...stored, rev: 1, state: 'cancelled', closed: true })
      await wait(80)
      ok('rev: событие со старым rev игнорируется', q('p-running', '.eb-pt')?.getAttribute('data-view') === 'running')
      // 4. Ошибка сервера → откат + тост
      failNextRef.current = 'error'
      btn('p-late', 'Отменить')?.click()
      await wait(60)
      ok('ошибка: оптимистично «отменён»', q('p-late', '.eb-pt')?.getAttribute('data-view') === 'cancelled')
      await wait(600)
      ok('ошибка: откат к «опаздывает»', q('p-late', '.eb-pt')?.getAttribute('data-view') === 'late')
      ok('ошибка: тост «Не удалось отменить»', toastsRef.current.includes('Не удалось отменить'), toastsRef.current.join(' | '))
      // 5. Срок наступает вживую: последние секунды → «опаздывает»
      const soon = getStoredCard('demo-p-final') ?? PROMISE_CARDS[1].card
      const d0 = Date.now()
      offerCard('demo-p-final', { ...soon, rev: soon.rev + 1, data: { ...soon.data, startAt: iso(d0 - 60_000), deadlineAt: iso(d0 + 1500) } })
      await wait(150)
      ok('переход: «последняя минута»', q('p-final', '.eb-pt')?.getAttribute('data-view') === 'final')
      await wait(2200)
      ok('переход: «опаздывает» сам по часам', q('p-final', '.eb-pt')?.getAttribute('data-view') === 'late', q('p-final', '.eb-pt-digits')?.textContent ?? '')
      // 6. Переписка: выбор периода и фото → «Поделиться» → читаю → ответ ниже
      const week = q('s-pending', '[data-period="week"]')
      week?.click()
      await wait(50)
      ok('переписка: чип «Эта неделя» выбран', week?.getAttribute('aria-checked') === 'true')
      const box = q('s-pending', 'input[type="checkbox"]') as HTMLInputElement | null
      box?.click()
      await wait(50)
      ok('переписка: галка фото включается', !!box?.checked, (q('s-pending', '.eb-sc-photos small')?.textContent ?? ''))
      btn('s-pending', 'Поделиться')?.click()
      await wait(60)
      ok('переписка: сразу «поделился … за эту неделю, с фото»', (q('s-pending', '.eb-sc')?.textContent ?? '').includes('поделился перепиской за эту неделю, с фото'))
      const last = serverLogRef.current[serverLogRef.current.length - 1]
      ok('переписка: на сервер ушло {period:"week", photos:true}', last?.action === 'share' && JSON.stringify(last.input) === '{"period":"week","photos":true}', JSON.stringify(last))
      await wait(3200)
      ok('переписка: «Ответ ниже ↓» после ответа бота', !!btn('s-pending', 'Ответ ниже ↓'))
      btn('s-pending', 'Ответ ниже ↓')?.click()
      await wait(50)
      ok('переписка: «Ответ ниже» ведёт к ответу', scrolledRef.current === 'demo-answer', String(scrolledRef.current))
      btn('s-pending', 'Забыть переписку')?.click()
      await wait(600)
      ok('переписка: «Забыть переписку» → «забрал разрешение»', (q('s-pending', '.eb-sc')?.textContent ?? '').includes('забрал разрешение'))
      ok('переписка: неподъёмный период погашен', q('s-toobig', '[data-period="all"]')?.getAttribute('aria-disabled') === 'true' && !!q('s-toobig', '.eb-sc-warn'))
      ok('переписка: без фото — галка недоступна', !!(q('s-empty', 'input[type="checkbox"]') as HTMLInputElement | null)?.disabled)
      // 7. Другой зритель: Петя видит «Решает Рома», без кнопок
      setViewer('petya')
      await wait(150)
      ok('переписка у Пети: «Решает Рома», без кнопок', (q('s-toobig', '.eb-sc')?.textContent ?? '').includes('Решает Рома') && !btn('s-toobig', 'Поделиться'))
      ok('таймер у Пети: «Пришёл» есть, «Отменить» нет', !!btn('p-long', 'Пришёл') && !btn('p-long', 'Отменить'))
      setViewer('roma')
      await wait(150)
      // 8. «Подумай лучше»
      ok('«Подумай лучше»: под обычным ответом есть', !!btn('think-a', 'Подумай лучше'))
      ok('«Подумай лучше»: под ответом depth=deep нет', !btn('think-deep', 'Подумай лучше') && !!btn('think-deep', 'Уточнить'))
      btn('think-a', 'Подумай лучше')?.click()
      await wait(500)
      const s0 = sentRef.current[0]
      ok('«Подумай лучше»: ответом на первую часть уходит «Еблуша, подумай лучше»', s0?.text === 'Еблуша, подумай лучше' && s0?.replyToId === 'a1', JSON.stringify(s0))
      // 9. Запасной текст
      ok('запасной текст: неизвестная версия → content', (q('fallback-v2', '.msg-bubble-body')?.textContent ?? '').includes('Таймер: Козёл Ебаный'))
      ok('запасной текст: подделка у человека → content', (q('fallback-human', '.msg-bubble-body')?.textContent ?? '').includes('Таймер: Козёл Ебаный'))
      const failed = out.filter((l) => l.startsWith('FAIL')).length
      out.push(failed ? `SMOKE FAIL (${failed})` : `SMOKE OK (${out.length} проверок)`)
      setSmokeOut([...out])
    }
    void run()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [smoke])

  const show = (key: string) => !only || only === key || key.startsWith(only)

  // Тот же выбор, что в ChatMessageRow: карточка → BotCardView, иначе — запасной текст content.
  const renderBody = (m: any) =>
    botCardOfMessage(m) ? <BotCardView message={m} env={env} /> : <div style={{ wordBreak: 'break-word' }}>{renderMessageText(m.content, { forceMarkdown: true })}</div>

  const thinkRow = (demoId: string, index: number, quote: string) => {
    const m = thinkList[index]
    const clarify = botClarifyTarget(thinkList, index, 'bot')
    const think = botThinkBetterTarget(thinkList, index, 'bot', viewer)
    return (
      <div key={demoId}>
        <p style={slotTitle}>{demoId === 'think-a' ? 'ответ из двух частей: кнопки под последней, ответ — на первую' : 'ответ «подумал лучше» (depth=deep): только «Уточнить»'}</p>
        <BotBubble demoId={demoId} quote={quote}>
          <div style={{ wordBreak: 'break-word' }}>{renderMessageText(m.content, { forceMarkdown: true })}</div>
          <BotAnswerActions clarify={clarify ? () => {} : null} think={think ? { busy: thinkBusy === String(think.id), onThink: () => sendThink(think) } : null} />
        </BotBubble>
      </div>
    )
  }

  return (
    <div style={page} className={rm ? 'eb-rm' : undefined}>
      <h1 style={{ fontSize: 18, margin: '0 0 4px' }}>Карточки бота — стенд</h1>
      <p style={{ color: 'var(--text-muted)', margin: '0 0 12px', fontSize: 13 }}>
        Таймер обещания (SPEC.md §10), «поделиться перепиской» (SPEC-share.md §6), «Подумай лучше». Настоящие компоненты ленты, поддельный сервер.
      </p>
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 20, color: 'var(--text-muted)', fontSize: 13 }}>
        <label>
          зритель:{' '}
          <select value={viewer} onChange={(e) => setViewer(e.target.value)}>
            <option value="roma">Рома (попросил / спросил)</option>
            <option value="vasya">Козёл Ебаный (обещал)</option>
            <option value="petya">Петя (участник)</option>
          </select>
        </label>
        <label>
          <input type="checkbox" checked={rm} onChange={(e) => setRm(e.target.checked)} /> меньше движения
        </label>
        <label>
          <input type="checkbox" checked={narrow} onChange={(e) => setNarrow(e.target.checked)} /> узко (как телефон)
        </label>
        <label>
          <input type="checkbox" checked={failNext} onChange={(e) => setFailNext(e.target.checked)} /> следующее действие — ошибка сервера
        </label>
        <span>сервер: {serverLog.length} действ.{serverLog.length ? ` (последнее ${serverLog[serverLog.length - 1].action})` : ''}</span>
        {scrolledTo ? <span>прокрутка к: {scrolledTo}</span> : null}
      </div>

      {smoke ? (
        <pre id="eb-smoke" style={{ background: '#1b1f27', padding: 10, borderRadius: 8, fontSize: 12, whiteSpace: 'pre-wrap' }}>
          {smokeOut.join('\n') || 'smoke…'}
        </pre>
      ) : null}

      <h2 style={{ fontSize: 15, margin: '8px 0 10px' }}>Таймер обещания</h2>
      <div style={grid(narrow)}>
        {PROMISE_CARDS.filter((c) => show(c.key)).map((c) => (
          <div key={c.key}>
            <p style={slotTitle}>{c.title}</p>
            <BotBubble demoId={c.key}>{renderBody(cardMessage(c.key, c.card))}</BotBubble>
          </div>
        ))}
      </div>

      <h2 style={{ fontSize: 15, margin: '28px 0 10px' }}>Поделиться перепиской</h2>
      <div style={grid(narrow)}>
        {SHARE_CARDS.filter((c) => show(c.key)).map((c) => (
          <div key={c.key}>
            <p style={slotTitle}>{c.title}</p>
            <BotBubble demoId={c.key} quote="Еблуша, о чём мы тут договорились на субботу?">
              {renderBody(cardMessage(c.key, c.card))}
            </BotBubble>
          </div>
        ))}
      </div>

      {show('think') || show('fallback') ? (
        <>
          <h2 style={{ fontSize: 15, margin: '28px 0 10px' }}>«Подумай лучше» и запасной текст</h2>
          <div style={grid(narrow)}>
            {show('think') ? thinkRow('think-a', 2, 'Еблуша, сколько дерева надо на драккар?') : null}
            {show('think') ? thinkRow('think-deep', 4, 'Еблуша, подумай лучше') : null}
            {show('fallback') ? (
              <div>
                <p style={slotTitle}>карточка v:2 (неизвестная версия) — запасной текст</p>
                <BotBubble demoId="fallback-v2">
                  {renderBody(cardMessage('fallback-v2', null, { bot: { v: 1, kind: 'card' }, card: { ...PROMISE_CARDS[0].card, v: 2 } }))}
                </BotBubble>
              </div>
            ) : null}
            {show('fallback') ? (
              <div>
                <p style={slotTitle}>«карточка» в сообщении человека (подделка) — обычный текст</p>
                <BotBubble demoId="fallback-human">
                  {renderBody({ ...cardMessage('fallback-human', PROMISE_CARDS[0].card), isBot: false, senderId: 'vasya' })}
                </BotBubble>
              </div>
            ) : null}
          </div>
        </>
      ) : null}

      {sent.length ? (
        <p style={{ marginTop: 16, fontSize: 13, color: 'var(--text-muted)' }}>
          Отправлено: {sent.map((s) => `«${s.text}» → ответ на ${s.replyToId}`).join('; ')}
        </p>
      ) : null}
      {toasts.length ? (
        <div style={{ position: 'fixed', right: 16, bottom: 16, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {toasts.slice(-3).map((t, i) => (
            <div key={i} style={{ background: '#3b1d1d', border: '1px solid #ef4444', color: '#fca5a5', padding: '6px 10px', borderRadius: 8, fontSize: 13 }}>
              {t}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}
