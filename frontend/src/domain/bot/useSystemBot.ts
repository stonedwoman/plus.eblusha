/**
 * Профиль системного бота «Еблуша» и настройка «Чат с Еблушей» (docs/bot-system.md §1, §5).
 *
 *  GET /api/bot           → {bot, botChat, secretChatRefusal}; 404 (бот не заведён / старый сервер) →
 *                           null: всё «ботовое» в интерфейсе прячется.
 *  PUT /api/bot/settings  {botChatEnabled} → {botChatEnabled, conversationId}
 *  сокет bot:settings     — то же состояние, когда переключили на другом устройстве.
 *
 * Один кэш react-query на сессию (id бота стабилен): его читают ChatsPage, настройки и карточка бота.
 */
import { useEffect } from 'react'
import { useQuery, type QueryClient } from '@tanstack/react-query'
import { api } from '../../utils/api'
import { socket } from '../../core/realtime'
import type { BotSettingsPayload } from '../../core/realtime/events'
import { normalizeBotChatState, normalizeSystemBotInfo, type BotChatState, type SystemBotInfo } from './systemBot'

export const SYSTEM_BOT_QUERY_KEY = ['system-bot'] as const

const httpStatus = (err: unknown): number | undefined =>
  (err as { response?: { status?: number } } | null)?.response?.status

export async function fetchSystemBotInfo(): Promise<SystemBotInfo | null> {
  try {
    const res = await api.get('/bot')
    return normalizeSystemBotInfo(res?.data)
  } catch (err) {
    if (httpStatus(err) === 404) return null
    throw err
  }
}

export function useSystemBotQuery(enabled = true) {
  return useQuery({
    queryKey: SYSTEM_BOT_QUERY_KEY,
    queryFn: fetchSystemBotInfo,
    enabled,
    staleTime: 10 * 60_000,
    retry: (count, err) => httpStatus(err) !== 404 && count < 2,
  })
}

/** Положить новое состояние «Чата с Еблушей» в кэш профиля бота. */
export function applyBotChatState(client: QueryClient, raw: unknown): BotChatState {
  const state = normalizeBotChatState(raw)
  client.setQueryData<SystemBotInfo | null | undefined>(SYSTEM_BOT_QUERY_KEY, (old) => (old ? { ...old, botChat: state } : old))
  return state
}

/** PUT /api/bot/settings. Ошибку бросает дальше (вызывающий показывает тост). */
export async function setBotChatEnabled(client: QueryClient, enabled: boolean): Promise<BotChatState> {
  const res = await api.put('/bot/settings', { botChatEnabled: enabled })
  const state = applyBotChatState(client, res?.data)
  void client.invalidateQueries({ queryKey: ['conversations'] })
  return state
}

/** Сокет bot:settings → кэш профиля + список бесед (беседа появилась/пропала). Монтировать один раз. */
export function useBotSettingsSync(client: QueryClient): void {
  useEffect(() => {
    const onSettings = (payload: BotSettingsPayload) => {
      applyBotChatState(client, payload)
      void client.invalidateQueries({ queryKey: ['conversations'] })
    }
    socket.on('bot:settings', onSettings)
    return () => {
      socket.off('bot:settings', onSettings)
    }
  }, [client])
}
