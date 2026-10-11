/**
 * HTTP-транспорт действий по карточкам бота (отдельно от чистого cardActions.ts: модуль api ставит
 * перехватчики сессии при импорте, тестам он не нужен).
 */
import { api } from '../../utils/api'
import { noteServerNow } from './cardClock'
import { cardFromBody, classifyCardError, type CardTransport } from './cardActions'

const LEGACY_PROMISE_ACTIONS = new Set(['arrived', 'cancel', 'reopen'])

function httpError(err: unknown): { status?: number; body: any } {
  const r = (err as { response?: { status?: number; data?: any } } | null)?.response
  return { status: r?.status, body: r?.data }
}

/** HTTP-транспорт приложения. */
export const httpCardTransport: CardTransport = {
  async act(messageId, card, action, input) {
    try {
      const res =
        card.source === 'legacy-promise'
          ? LEGACY_PROMISE_ACTIONS.has(action)
            ? await api.post(`/promises/${encodeURIComponent(card.id)}/${action}`, {})
            : null
          : await api.post(`/cards/${encodeURIComponent(messageId)}/act`, input === undefined ? { action } : { action, input })
      if (!res) return { ok: false, failure: 'bad_input', card: null }
      noteServerNow(res.data?.serverNow)
      return { ok: true, card: cardFromBody(res.data), message: res.data?.message ?? null }
    } catch (err) {
      const { status, body } = httpError(err)
      if (body?.serverNow) noteServerNow(body.serverNow)
      return { ok: false, failure: classifyCardError(status, body), card: cardFromBody(body) }
    }
  },
  async fetch(messageId, card) {
    try {
      const res =
        card.source === 'legacy-promise'
          ? await api.get(`/promises/${encodeURIComponent(card.id)}`)
          : await api.get(`/cards/${encodeURIComponent(messageId)}`)
      noteServerNow(res.data?.serverNow)
      return { ok: true, card: cardFromBody(res.data), message: res.data?.message ?? null }
    } catch (err) {
      const { status, body } = httpError(err)
      return { ok: false, failure: classifyCardError(status, body), card: cardFromBody(body) }
    }
  },
}
