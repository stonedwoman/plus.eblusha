/**
 * Таймер обещания — карточка бота (SPEC.md §10; конверт SPEC-share.md §2). Вид считает
 * domain/cards/promiseCard.ts, здесь — только разметка, кольцо, тиканье и кнопки.
 *
 *  - Секунды тикают на клиенте от deadlineAt (одни часы на приложение, только пока карточка на экране).
 *  - Кольцо убывает ОДНОЙ CSS-анимацией на весь остаток (отрицательная задержка) — React его не трогает;
 *    при «меньше движения» — шаг раз в секунду.
 *  - «Пришёл» / «Отменить» / «Вернуть» — сразу оптимистично, ответ сервера заменяет по rev; ошибка —
 *    откат и тост; 409 — молча перерисовать.
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { Check } from 'lucide-react'
import { Avatar } from '../Avatar'
import { systemToast } from '../../../domain/store/systemUiStore'
import { nextActionExpiry, type BotCard } from '../../../domain/cards/cardEnvelope'
import { serverNowMs, useCardClock } from '../../../domain/cards/cardClock'
import { refreshCardOnce, runCardAction } from '../../../domain/cards/cardActions'
import {
  buildPromiseCard,
  optimisticPromise,
  promiseAnnouncement,
  promiseButtonText,
  promiseData,
  promiseFailureToast,
  type PromiseButton,
  type PromiseView,
} from '../../../domain/cards/promiseCard'
import { useInViewport, usePrefersReducedMotion } from './cardHooks'
import type { BotCardEnv } from './botCardEnv'
import './botCards.css'
import './promiseCard.css'

const C = 175.93 // 2π·28

const depletes = (v: PromiseView) => v === 'running' || v === 'final'

export function PromiseTimerCard({ messageId, card, env }: { messageId: string; card: BotCard; env: BotCardEnv }) {
  const rootRef = useRef<HTMLDivElement>(null)
  const inView = useInViewport(rootRef)
  const sysReduced = usePrefersReducedMotion()
  const reduced = env.reducedMotion ?? sysReduced
  const viewerId = env.viewer.id

  // Тикаем раз в секунду, пока таймер идёт или пока не истекло «Вернуть»; вне экрана — стоим.
  const probe = serverNowMs()
  const needsTick = card.state === 'running' || nextActionExpiry(card, viewerId, probe) != null
  const now = useCardClock(inView && needsTick ? 'sec' : null)

  const model = buildPromiseCard(card, now, {
    id: viewerId,
    zone: env.zone,
    resolveName: env.resolveName,
    resolveAvatar: env.resolveAvatar,
  })
  const d = promiseData(card)

  // Перечитать незакрытую карточку один раз (смещение часов, свежая версия).
  useEffect(() => {
    refreshCardOnce({ transport: env.transport, messageId, card, client: env.client, conversationId: env.conversationId })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messageId])

  // Кольцо: одна анимация на весь остаток срока; пересоздаётся только при смене срока/режима.
  const depleting = depletes(model.view) && !reduced
  const ringKey = `${d.startAt ?? ''}|${d.deadlineAt ?? ''}|${depleting ? 'run' : 'static'}`
  const arcAnim = useMemo(() => {
    if (!depleting) return null
    const start = Date.parse(String(d.startAt ?? '')) || serverNowMs()
    const deadline = Date.parse(String(d.deadlineAt ?? '')) || start
    const total = Math.max(1, deadline - start)
    const elapsed = Math.max(0, Math.min(total, serverNowMs() - start))
    return { animationDuration: `${total}ms`, animationDelay: `${-elapsed}ms` }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ringKey])

  // Смена режима «вживую» (не при первой отрисовке): дозаполнить кольцо, показать ✓ с «пружинкой».
  // Решаем в той же отрисовке, где сменился режим (эффект дал бы кадр полного кольца до анимации).
  const viewRef = useRef<{ view: PromiseView; fill: boolean } | null>(null)
  if (viewRef.current?.view !== model.view) {
    const prev = viewRef.current?.view
    const filled = model.view === 'late' || model.view === 'onTime' || model.view === 'lateArrived'
    viewRef.current = { view: model.view, fill: !!prev && filled && (depletes(prev) || prev === 'late') }
  }
  const fillNow = viewRef.current.fill

  // Вежливая живая область: только смена режима и пороги (не каждую секунду).
  const announceRef = useRef<{ view: PromiseView; minutesLeft: number | null } | null>(null)
  const [announce, setAnnounce] = useState('')
  useEffect(() => {
    const text = promiseAnnouncement(announceRef.current, model)
    announceRef.current = { view: model.view, minutesLeft: model.minutesLeft }
    if (text) setAnnounce(text)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model.view, model.minutesLeft])

  const [busy, setBusy] = useState<PromiseButton | null>(null)
  const act = async (action: PromiseButton) => {
    if (busy) return
    setBusy(action)
    const me = viewerId ? { id: viewerId, displayName: env.viewer.displayName } : null
    const optimistic = me ? optimisticPromise(card, action, me, serverNowMs()) : null
    const res = await runCardAction({
      transport: env.transport,
      messageId,
      card,
      action,
      optimistic,
      client: env.client,
      conversationId: env.conversationId,
    })
    setBusy(null)
    if (!res.ok) {
      const text = promiseFailureToast(action, res.failure)
      if (text) (env.toast ?? ((t: string) => systemToast.error(t)))(text)
    }
  }

  const arcClass = `eb-pt-arc${depleting ? ' eb-pt-arc--deplete' : ''}${fillNow ? ' eb-pt-arc--fill' : ''}`
  const arcStyle: CSSProperties | undefined = depleting
    ? (arcAnim ?? undefined)
    : depletes(model.view)
      ? { strokeDashoffset: C * (1 - model.ringFraction) } // «меньше движения»: шаг раз в секунду
      : undefined

  return (
    <div
      ref={rootRef}
      className={`eb-card eb-pt${reduced ? ' eb-rm' : ''}`}
      data-view={model.view}
      data-card-type="promise"
      data-card-rev={card.rev}
      role="group"
      aria-label={model.a11yLabel}
    >
      <div className="eb-pt-head">
        <span className="eb-card-tag">
          <span aria-hidden>⏱</span>ТАЙМЕР
        </span>
        <span className="eb-pt-req">{model.requesterLine}</span>
      </div>
      <div className="eb-pt-who">
        <div className="eb-pt-ring" aria-hidden>
          <svg viewBox="0 0 60 60">
            <circle className="eb-pt-trk" r="28" cx="30" cy="30" />
            <circle key={ringKey} className={arcClass} r="28" cx="30" cy="30" style={arcStyle} />
          </svg>
          <div className="eb-pt-ava">
            <Avatar name={model.promiserName} id={model.promiserId ?? 'promiser'} avatarUrl={model.promiserAvatarUrl} size={48} />
          </div>
          {model.view === 'onTime' ? <div className={`eb-pt-badge${fillNow ? ' eb-pt-badge--pop' : ''}`}>✓</div> : null}
        </div>
        <div className="eb-pt-meta">
          <div className="eb-pt-name">{model.promiserName}</div>
          <div className={`eb-pt-quote${model.quoteDeleted ? ' eb-pt-quote--deleted' : ''}`}>{model.quote}</div>
          <div className="eb-pt-sub">
            <span>{model.promisedAt}</span>
            {model.quoteBy ? <span>· {model.quoteBy}</span> : null}
            {model.localDeadline ? <span>· {model.localDeadline}</span> : null}
            {model.extensions ? <span className="eb-pt-chip">{model.extensions}</span> : null}
          </div>
        </div>
      </div>
      <div className="eb-pt-clock">
        <div className="eb-pt-left">
          <div className={`eb-pt-digits${model.digitsWide && depletes(model.view) ? ' eb-pt-digits--wide' : ''}`} aria-hidden>
            {model.digits}
          </div>
          {model.result ? (
            <>
              <div className="eb-pt-result">{model.result}</div>
              {model.resultSub ? <div className="eb-pt-cap">{model.resultSub}</div> : null}
            </>
          ) : (
            <div className="eb-pt-cap">{model.caption}</div>
          )}
        </div>
        <div className="eb-pt-right">
          <div className="eb-pt-until">{model.right}</div>
          {model.label ? <div className="eb-pt-label">{model.label}</div> : null}
        </div>
      </div>
      {model.buttons.length ? (
        <div className="eb-card-actions" onClick={(e) => e.stopPropagation()}>
          {model.buttons.map((b) => {
            const t = promiseButtonText(b, model.promiserName)
            if (b === 'reopen') {
              return (
                <button key={b} type="button" className="eb-card-link" aria-label={t.aria} disabled={!!busy} onClick={() => void act(b)}>
                  {t.label}
                </button>
              )
            }
            return (
              <button
                key={b}
                type="button"
                className={`eb-bot-action eb-card-btn${b === 'arrived' ? ' eb-bot-action--yes' : ''}`}
                aria-label={t.aria}
                aria-busy={busy === b}
                disabled={!!busy}
                onClick={() => void act(b)}
              >
                {busy === b ? <span className="eb-card-spin" aria-hidden /> : b === 'arrived' ? <Check size={14} strokeWidth={2.8} aria-hidden /> : null}
                {t.label}
              </button>
            )
          })}
        </div>
      ) : null}
      <span className="eb-card-sr" aria-live="polite">
        {announce}
      </span>
    </div>
  )
}
