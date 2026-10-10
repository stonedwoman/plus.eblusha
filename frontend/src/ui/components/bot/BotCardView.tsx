/**
 * Карточка бота в ленте: выбирает рисовалку по типу (SPEC-share.md §2.7). Тип неизвестен / версия не та —
 * null, и строка ленты рисует обычный пузырь с запасным текстом `content`.
 *
 * Карточка подписана на своё значение сама (хранилище по rev + часы), поэтому memo-строке ленты
 * перерисовываться на каждый тик не нужно.
 */
import { useMemo } from 'react'
import { botCardOfMessage } from '../../../domain/cards/cardEnvelope'
import { useBotCard } from '../../../domain/cards/cardStore'
import type { BotCardEnv } from './botCardEnv'
import { PromiseTimerCard } from './PromiseTimerCard'
import { ShareCard } from './ShareCard'

export function BotCardView({ message, env }: { message: any; env: BotCardEnv }) {
  const messageId = String(message?.id ?? '')
  const fromMessage = useMemo(() => botCardOfMessage(message), [message])
  const card = useBotCard(messageId, fromMessage)
  if (!card || !messageId) return null
  if (card.type === 'promise') return <PromiseTimerCard messageId={messageId} card={card} env={env} />
  if (card.type === 'share') return <ShareCard messageId={messageId} card={card} env={env} />
  return null
}
