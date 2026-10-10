/**
 * «Поделиться перепиской» — карточка бота (SPEC-share.md §6). Вид считает domain/cards/shareCard.ts.
 *
 *  - Решает только тот, кто спросил (действия share/decline с who.ids); у остальных — текст без кнопок.
 *  - Выбор периода — группа переключателей (стрелки), галка «Включать фото», «Поделиться» / «Не делиться».
 *  - После выбора у всех: «Рома поделился перепиской за сегодня, с фото» → «читаю…» → «Ответ ниже ↓».
 *  - «ещё N мин» — минутный тик общих часов, только пока карточка на экране.
 */
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { systemToast } from '../../../domain/store/systemUiStore'
import type { BotCard } from '../../../domain/cards/cardEnvelope'
import { serverNowMs, useCardClock } from '../../../domain/cards/cardClock'
import { refreshCardOnce, runCardAction } from '../../../domain/cards/cardActions'
import type { RichLine } from '../../../domain/cards/cardFormat'
import {
  buildShareCard,
  optimisticShare,
  shareFailureToast,
  type ShareLocalChoice,
  type SharePeriod,
} from '../../../domain/cards/shareCard'
import { useInViewport, usePrefersReducedMotion } from './cardHooks'
import type { BotCardEnv } from './botCardEnv'
import './botCards.css'
import './shareCard.css'

function Rich({ line }: { line: RichLine }) {
  return (
    <>
      {line.map((p, i) =>
        p.bold ? (
          <b key={i}>{p.text}</b>
        ) : p.tone === 'ok' ? (
          <span key={i} className="eb-sc-ok" aria-hidden>
            {p.text}
          </span>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </>
  )
}

export function ShareCard({ messageId, card, env }: { messageId: string; card: BotCard; env: BotCardEnv }) {
  const rootRef = useRef<HTMLDivElement>(null)
  const inView = useInViewport(rootRef)
  const sysReduced = usePrefersReducedMotion()
  const reduced = env.reducedMotion ?? sysReduced
  const viewerId = env.viewer.id
  const [local, setLocal] = useState<ShareLocalChoice>({})
  const [busy, setBusy] = useState<string | null>(null)

  const ticking = card.state === 'pending' || card.state === 'granted'
  const now = useCardClock(inView && ticking ? 'min' : null)
  const model = buildShareCard(card, now, { id: viewerId, zone: env.zone, resolveName: env.resolveName }, local)

  useEffect(() => {
    refreshCardOnce({ transport: env.transport, messageId, card, client: env.client, conversationId: env.conversationId })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messageId])

  // Живая область — только на смену состояния/подвида.
  const prevRef = useRef<string | null>(null)
  const [announce, setAnnounce] = useState('')
  const stateKey = `${model.state}|${model.mode}`
  useEffect(() => {
    const prev = prevRef.current
    prevRef.current = stateKey
    if (prev && prev !== stateKey && model.announce) setAnnounce(model.announce)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stateKey])

  const toast = env.toast ?? ((t: string) => systemToast.error(t))
  const act = async (action: 'share' | 'decline' | 'forget') => {
    if (busy) return
    const input = action === 'share' ? model.input : undefined
    if (action === 'share' && !input) return
    setBusy(action)
    const me = viewerId ? { id: viewerId, displayName: env.viewer.displayName } : null
    const optimistic = me ? optimisticShare(card, action, me, serverNowMs(), input ?? null) : null
    const res = await runCardAction({
      transport: env.transport,
      messageId,
      card,
      action,
      input,
      optimistic,
      client: env.client,
      conversationId: env.conversationId,
    })
    setBusy(null)
    if (!res.ok) {
      const text = shareFailureToast(action, res.failure)
      if (text) toast(text)
      return
    }
    // Фокус после «Поделиться» — на текст карточки (кнопок больше нет).
    if (action === 'share') requestAnimationFrame(() => rootRef.current?.focus())
  }

  const select = (p: SharePeriod) => setLocal((s) => ({ ...s, period: p }))
  const chipsRef = useRef<HTMLDivElement>(null)
  const onChipKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return
    e.preventDefault()
    const enabled = model.chips.filter((c) => c.enabled)
    if (!enabled.length) return
    const k = Math.max(0, enabled.findIndex((c) => c.selected))
    const step = e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 1
    const next = enabled[(k + step + enabled.length) % enabled.length]
    select(next.period)
    requestAnimationFrame(() => chipsRef.current?.querySelector<HTMLButtonElement>(`[data-period="${next.period}"]`)?.focus())
  }

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      className={`eb-card eb-sc${reduced ? ' eb-rm' : ''}`}
      data-closed={model.closed ? 1 : 0}
      data-state={model.state}
      data-mode={model.mode}
      data-card-type="share"
      data-card-rev={card.rev}
      role="group"
      aria-label="Еблуша: переписка"
    >
      <div className="eb-card-tag" aria-hidden>
        🔒 ПЕРЕПИСКА
      </div>
      {model.mode === 'choose' ? (
        <div onClick={(e) => e.stopPropagation()}>
          {model.note ? <div className="eb-sc-warn">{model.note}</div> : null}
          <p className="eb-sc-q">
            <Rich line={model.lines[0]} />
          </p>
          <div className="eb-sc-chips" role="radiogroup" aria-label="Период переписки" ref={chipsRef}>
            {model.chips.map((c) => (
              <button
                key={c.period}
                type="button"
                role="radio"
                className="eb-sc-chip"
                data-period={c.period}
                aria-checked={c.selected}
                aria-disabled={!c.enabled}
                aria-label={c.aria}
                tabIndex={c.selected ? 0 : -1}
                onClick={() => c.enabled && select(c.period)}
                onKeyDown={onChipKey}
              >
                {c.label}
                <small>{c.sub}</small>
              </button>
            ))}
          </div>
          <label className="eb-sc-photos" data-off={model.photos.disabled ? 1 : 0}>
            <input
              type="checkbox"
              checked={model.photos.checked}
              disabled={model.photos.disabled}
              aria-label={model.photos.aria}
              onChange={(e) => setLocal((s) => ({ ...s, photos: e.target.checked }))}
            />
            <span>Включать фото</span> <small>{model.photos.note}</small>
          </label>
          <div className="eb-card-actions">
            <button
              type="button"
              className="eb-bot-action eb-card-btn eb-bot-action--yes"
              aria-label={model.shareAria}
              aria-busy={busy === 'share'}
              disabled={!!busy || !model.canShare}
              onClick={() => void act('share')}
            >
              {busy === 'share' ? <span className="eb-card-spin" aria-hidden /> : null}
              Поделиться
            </button>
            {model.canDecline ? (
              <button
                type="button"
                className="eb-bot-action eb-card-btn"
                aria-busy={busy === 'decline'}
                disabled={!!busy}
                onClick={() => void act('decline')}
              >
                {busy === 'decline' ? <span className="eb-card-spin" aria-hidden /> : null}
                Не делиться
              </button>
            ) : null}
          </div>
          <p className="eb-sc-foot">Прочитаю только для этого вопроса и уточнений к нему. Через час забуду. Решаешь только ты.</p>
        </div>
      ) : (
        <>
          {model.lines[0] ? (
            <p className="eb-sc-line">
              <Rich line={model.lines[0]} />
            </p>
          ) : null}
          {model.answer ? (
            <p className="eb-sc-line eb-sc-muted">
              <button
                type="button"
                className="eb-card-link"
                onClick={(e) => {
                  e.stopPropagation()
                  env.onScrollToMessage?.(model.answer!.messageId)
                }}
              >
                Ответ ниже ↓
              </button>
              <span>{model.answer.tail}</span>
            </p>
          ) : null}
          {model.lines.slice(1).map((line, i) => (
            <p key={i} className={`eb-sc-line eb-sc-muted${model.readingDots && i === 0 ? ' eb-sc-dots' : ''}`}>
              <Rich line={line} />
            </p>
          ))}
          {model.canForget ? (
            <div className="eb-sc-right" onClick={(e) => e.stopPropagation()}>
              <button type="button" className="eb-card-link" disabled={!!busy} onClick={() => void act('forget')}>
                Забыть переписку
              </button>
            </div>
          ) : null}
        </>
      )}
      <span className="eb-card-sr" aria-live="polite">
        {announce}
      </span>
    </div>
  )
}
