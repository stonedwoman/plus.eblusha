import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject, type RefObject } from 'react'
import { connectSocket, socket } from '../../../../utils/socket'

/** Per-conversation typing: convId -> userId -> timestamp */
export type TypingByConversationId = Record<string, Record<string, number>>

export function useChatTyping(opts: {
  activeId: string | null
  meId: string | null | undefined
  isMobileRef: MutableRefObject<boolean>
  messagesRef: RefObject<HTMLDivElement | null>
}) {
  const { activeId, meId, isMobileRef, messagesRef } = opts

  const [typingByConversationId, setTypingByConversationId] = useState<TypingByConversationId>({})
  const [typingDots, setTypingDots] = useState(1)

  // Outgoing typing emitter (per active conversation)
  const typingEmitRef = useRef<{
    convId: string | null
    startTimer: number | null
    stopTimer: number | null
    lastSentTyping: boolean
    lastSentAt: number
  }>({ convId: null, startTimer: null, stopTimer: null, lastSentTyping: false, lastSentAt: 0 })

  // Incoming typing cleanup (expire stale entries)
  const typingCleanupTimerRef = useRef<number | null>(null)

  const onIncomingTyping = useCallback((p: any) => {
    if (!p) return
    const convId = typeof p.conversationId === 'string' ? p.conversationId : null
    const uid = typeof p.userId === 'string' ? p.userId : null
    if (!convId || !uid) return
    if (uid === meId) return
    const isTyping = !!p.typing
    setTypingByConversationId((prev) => {
      const conv = { ...(prev[convId] ?? {}) }
      if (!isTyping) {
        if (!conv[uid]) return prev
        delete conv[uid]
      } else {
        conv[uid] = Date.now()
      }
      return { ...prev, [convId]: conv }
    })
  }, [meId])

  const emitTyping = useCallback((conversationId: string, typing: boolean) => {
    if (!conversationId) return
    try {
      if (!socket.connected) {
        connectSocket()
      }
    } catch {
      // ignore connect errors; emit may still succeed later
    }
    socket.emit('conversation:typing', { conversationId, typing })
  }, [])

  const stopTyping = useCallback((conversationId: string | null) => {
    const st = typingEmitRef.current
    if (st.startTimer) window.clearTimeout(st.startTimer)
    if (st.stopTimer) window.clearTimeout(st.stopTimer)
    st.startTimer = null
    st.stopTimer = null
    if (conversationId && st.lastSentTyping) {
      emitTyping(conversationId, false)
    }
    st.lastSentTyping = false
    st.lastSentAt = 0
    st.convId = conversationId
  }, [emitTyping])

  const notifyTyping = useCallback(() => {
    if (!activeId) return
    const st = typingEmitRef.current
    // If conversation changed while timers pending, best-effort stop old one.
    if (st.convId && st.convId !== activeId && st.lastSentTyping) {
      emitTyping(st.convId, false)
      st.lastSentTyping = false
    }
    st.convId = activeId

    if (st.startTimer) window.clearTimeout(st.startTimer)
    // Debounce typing_start
    st.startTimer = window.setTimeout(() => {
      const now = Date.now()
      // Throttle re-sending "typing=true" to keep remote indicator alive without spamming.
      if (!st.lastSentTyping || now - st.lastSentAt > 2000) {
        emitTyping(activeId, true)
        st.lastSentTyping = true
        st.lastSentAt = now
      }
    }, 420)

    if (st.stopTimer) window.clearTimeout(st.stopTimer)
    // Send typing_stop on idle
    st.stopTimer = window.setTimeout(() => {
      if (!st.convId) return
      if (st.lastSentTyping) {
        emitTyping(st.convId, false)
      }
      st.lastSentTyping = false
      st.lastSentAt = Date.now()
    }, 2100)
  }, [activeId, emitTyping])

  // Typing in active conversation only (exclude self), for chat pane
  const typingByUserId = useMemo(() => {
    const raw = activeId ? (typingByConversationId[activeId] ?? {}) : {}
    const next: Record<string, number> = {}
    for (const uid of Object.keys(raw)) {
      if (uid !== meId && typeof raw[uid] === 'number') next[uid] = raw[uid]
    }
    return next
  }, [typingByConversationId, activeId, meId])

  // Ensure we always send typing_stop on conversation switch/unmount.
  useEffect(() => {
    const convId = activeId
    return () => {
      stopTyping(convId)
    }
  }, [activeId, stopTyping])

  // Animate typing dots only (no scroll changes — avoid layout jump)
  useEffect(() => {
    const isSomeoneTyping = Object.keys(typingByUserId).length > 0
    if (!isSomeoneTyping) return
    const id = window.setInterval(() => {
      setTypingDots((d) => (d % 3) + 1)
    }, 500)
    return () => window.clearInterval(id)
  }, [typingByUserId])

  // Expire incoming typing users in all conversations (defense in depth)
  useEffect(() => {
    if (typingCleanupTimerRef.current) {
      window.clearInterval(typingCleanupTimerRef.current)
      typingCleanupTimerRef.current = null
    }
    typingCleanupTimerRef.current = window.setInterval(() => {
      const now = Date.now()
      setTypingByConversationId((prev) => {
        let changed = false
        const next: TypingByConversationId = {}
        for (const convId of Object.keys(prev)) {
          const conv = prev[convId]
          const nextConv: Record<string, number> = {}
          for (const uid of Object.keys(conv)) {
            const ts = conv[uid]
            if (typeof ts === 'number' && now - ts < 2600) {
              nextConv[uid] = ts
            } else {
              changed = true
            }
          }
          if (Object.keys(nextConv).length > 0) next[convId] = nextConv
          else if (Object.keys(conv).length > 0) changed = true
        }
        return changed ? next : prev
      })
    }, 800)
    return () => {
      if (typingCleanupTimerRef.current) {
        window.clearInterval(typingCleanupTimerRef.current)
        typingCleanupTimerRef.current = null
      }
    }
  }, [])

  return {
    typingByUserId,
    typingByConversationId,
    typingDots,
    onIncomingTyping,
    notifyTyping,
    stopTyping,
  }
}

