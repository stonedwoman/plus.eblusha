/**
 * «Без звука» для бесед в ChatsPage: состояние (domain/mute/muteSync.ts), действие и подписки.
 *
 *  - setConversationMute(id, preset | null) → POST /conversations/:id/mute ({for} или {until:null}),
 *    ответ сразу в хранилище, тост «Без звука на 1 час» / «Звук включён», ошибка — «Не удалось изменить
 *    звук беседы». Своё же событие conversation:mute придёт следом и ничего не изменит (тот же asOf).
 *  - useConversationMute() — перерисовка ChatsPage при смене «Без звука» и на истечении срока; геттеры
 *    для плитки (серое непрочитанное, рамка) и звука уведомления.
 *  - Сокет браузера/Electron подписан на уровне модуля (utils/socket.ts → installMuteSync); здесь —
 *    только нативный сокет Capacitor, у него свой клиент событий.
 */
import { useCallback, useEffect } from 'react'
import { api } from '../../../../utils/api'
import { getRealtimeClient } from '../../../../core/realtime'
import { systemToast } from '../../../../domain/store/systemUiStore'
import { muteToastText, MUTE_TEXT, type MutePreset } from '../../../../domain/mute/muteRules'
import { MUTE_EVENT, MUTE_SNAPSHOT_EVENT, muteStore, useMuteVersion } from '../../../../domain/mute/muteSync'

const inFlight = new Map<string, number>()

/** Поставить/снять «Без звука» (preset null — «Включить звук»). true — получилось. */
export async function setConversationMute(conversationId: string, preset: MutePreset | null): Promise<boolean> {
  const id = String(conversationId || '').trim()
  if (!id) return false
  const seq = (inFlight.get(id) ?? 0) + 1
  inFlight.set(id, seq)
  const sentAt = Date.now()
  try {
    const resp = await api.post(`/conversations/${encodeURIComponent(id)}/mute`, preset ? { for: preset } : { until: null })
    muteStore.applyMuteResponse(resp?.data, sentAt)
    // Тост — только по последнему нажатию (двойной клик по разным срокам не даёт двух тостов).
    if (inFlight.get(id) === seq) systemToast.success(muteToastText(preset))
    return true
  } catch {
    if (inFlight.get(id) === seq) systemToast.error(MUTE_TEXT.error)
    return false
  } finally {
    if (inFlight.get(id) === seq) inFlight.delete(id)
  }
}

function isNativeRealtime(): boolean {
  try {
    return getRealtimeClient().mode === 'native'
  } catch {
    return false
  }
}

export function useConversationMute() {
  const version = useMuteVersion()

  useEffect(() => {
    if (!isNativeRealtime()) return
    const client = getRealtimeClient()
    const offMute = client.on('conversation:mute', (p) => muteStore.applyEvent(p))
    const offSnapshot = client.on('conversation:mute:snapshot', (p) => muteStore.applySnapshot(p))
    return () => {
      offMute()
      offSnapshot()
    }
  }, [])

  // Геттеры пересоздаются на каждой смене версии — так рендер-функции (плитка, шапка) видят свежее.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const isConversationMuted = useCallback((conversationId: string | null | undefined) => muteStore.isMuted(conversationId), [version])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const mutedUntilOf = useCallback((conversationId: string | null | undefined) => muteStore.mutedUntil(conversationId), [version])

  return { muteVersion: version, isConversationMuted, mutedUntilOf, setConversationMute }
}
