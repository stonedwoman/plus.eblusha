import { useEffect, type Dispatch, type SetStateAction } from 'react'
import { socket } from '../../../../utils/socket'

export function useChatSocketSubscriptions(opts: {
  activeId: string | null
  meId: string | null | undefined
  client: any
  messagesQuery: any
  appendMessageToCache: (conversationId: string, incoming: any) => void
  updateMessageInCache: (conversationId: string, message: any, opts?: any) => void
  setPendingByConv: Dispatch<SetStateAction<Record<string, any[]>>>
  isSecretBlockedForDevice: (conversationId: string) => boolean
  onIncomingTyping: (p: any) => void
  playNotifySoundIfAllowed: () => void
}) {
  const {
    activeId,
    meId,
    client,
    messagesQuery,
    appendMessageToCache,
    updateMessageInCache,
    setPendingByConv,
    isSecretBlockedForDevice,
    onIncomingTyping,
    playNotifySoundIfAllowed,
  } = opts

  // Унифицированная логика обновления сообщений для всех типов бесед (1:1 и группы)
  useEffect(() => {
    const onNew = async (payload: any) => {
      const conversationId = payload.conversationId
      const isActive = conversationId === activeId

      // Для неактивных чатов: инвалидируем список бесед, чтобы получить актуальный unreadCount с сервера
      if (!isActive) {
        client.invalidateQueries({ queryKey: ['conversations'] })
        return
      }

      // Для активного чата: обновляем сообщения
      if (!activeId) return
      const incoming = payload.message ?? payload
      if (incoming && incoming.id) {
        // Remove any pending messages that might match this one (by sender and attachments)
        setPendingByConv((prev) => {
          const convPending = prev[activeId] || []
          if (convPending.length === 0) return prev
          // Check if this message matches any pending by comparing attachments
          const incomingAttachments = (incoming.attachments || []).map((a: any) => a.url).sort()
          const filtered = convPending.filter((pending: any) => {
            if (pending.senderId !== incoming.senderId) return true
            const pendingAttachments = pending.attachments.map((a: any) => a.url).sort()
            // If attachments match (or both have same number), remove pending
            if (pendingAttachments.length === incomingAttachments.length) {
              // If pending has blob URL and incoming has real URL, it's likely the same message
              const match = pendingAttachments.every((pUrl: string, idx: number) => {
                const iUrl = incomingAttachments[idx]
                return pUrl === iUrl || (pUrl.startsWith('blob:') && iUrl && !iUrl.startsWith('blob:'))
              })
              return !match
            }
            return true
          })
          if (filtered.length === convPending.length) return prev
          if (filtered.length === 0) {
            const { [activeId]: _, ...rest } = prev
            return rest
          }
          return { ...prev, [activeId]: filtered }
        })
        // Оптимистичное обновление кэша (работает для всех типов бесед)
        appendMessageToCache(activeId, incoming)
      }
      // Всегда делаем refetch для получения актуальных данных (как для 1:1, так и для групп)
      messagesQuery.refetch()
    }

    const onTyping = (p: any) => {
      onIncomingTyping(p)
    }

    const onReaction = (payload: { conversationId: string; messageId: string; message?: any }) => {
      if (!activeId || payload.conversationId !== activeId) {
        client.invalidateQueries({ queryKey: ['conversations'] })
        return
      }
      if (payload.message) {
        updateMessageInCache(activeId, payload.message)
      } else {
        messagesQuery.refetch()
      }
    }

    const onUpdate = (payload: any) => {
      if (!payload) return
      const conversationId = payload.conversationId
      if (!activeId || conversationId !== activeId) return
      if (payload.message && payload.message.id) {
        updateMessageInCache(activeId, payload.message, { preserveScroll: payload.reason === 'link_preview' })
      } else if (payload.messageId) {
        messagesQuery.refetch().catch(() => {})
      }
    }

    socket.on('message:new', onNew)
    socket.on('conversation:typing', onTyping)
    socket.on('message:reaction', onReaction)
    socket.on('message:update', onUpdate)
    return () => {
      socket.off('message:new', onNew as any)
      socket.off('conversation:typing', onTyping as any)
      socket.off('message:reaction', onReaction as any)
      socket.off('message:update', onUpdate as any)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, meId])

  // Unified handler for message:notify - handles both active and inactive chats
  useEffect(() => {
    const handler = async (p: { conversationId: string; messageId: string; senderId: string; message?: any }) => {
      if (isSecretBlockedForDevice(p.conversationId)) {
        return
      }
      const isMine = p.senderId === meId
      const isViewing = p.conversationId === activeId
      const visible = document.visibilityState === 'visible'

      // Воспроизводим звук уведомления, если нужно
      if (!isMine && (!isViewing || !visible)) {
        playNotifySoundIfAllowed()
      }

      // Если это текущий чат, обновляем сообщения немедленно
      if (isViewing) {
        // Если есть полное сообщение в payload, используем оптимистичное обновление
        if (p.message && p.message.id && activeId) {
          appendMessageToCache(activeId, p.message)
        }
        // Всегда делаем refetch для получения актуальных данных
        messagesQuery.refetch().catch(() => {})
        return
      }

      // Для неактивных чатов: НЕ увеличиваем счетчик локально
      // Вместо этого полагаемся на refetch из message:new события
      // Это предотвращает двойное увеличение счетчика
    }
    socket.on('message:notify', handler)
    return () => { socket.off('message:notify', handler) }
  }, [activeId, meId, messagesQuery, isSecretBlockedForDevice, appendMessageToCache, playNotifySoundIfAllowed])
}

