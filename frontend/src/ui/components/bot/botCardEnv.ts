/**
 * Окружение карточки бота: кто смотрит, как выполнять действия, где брать свежие имена/аватары.
 * В ленте его собирает ChatMessageRow (HTTP-транспорт, кэш пользователей беседы), на dev-стенде —
 * поддельный сервер.
 */
import type { CardTransport } from '../../../domain/cards/cardActions'

export type BotCardEnv = {
  viewer: { id: string | null; displayName: string }
  transport: CardTransport
  /** QueryClient ленты — заменить сообщение в кэше по ответу действия. */
  client?: any
  conversationId?: string | null
  resolveName?: (id: string) => string | null | undefined
  resolveAvatar?: (id: string) => string | null | undefined
  /** «Ответ ниже ↓» — прокрутить ленту к сообщению. */
  onScrollToMessage?: (messageId: string) => void
  /** Пояс зрителя (тесты/стенд); по умолчанию — пояс браузера. */
  zone?: string
  /** Принудительно «меньше движения» (стенд); по умолчанию — системная настройка. */
  reducedMotion?: boolean
  /** Тост об ошибке; по умолчанию — systemToast.error. */
  toast?: (text: string) => void
}
