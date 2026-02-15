import { useCallback, useEffect, useRef, useState, type MutableRefObject, type RefObject } from 'react'
import { connectSocket, socket } from '../../../../utils/socket'

export function useChatTyping(opts: {
  activeId: string | null
  meId: string | null | undefined
  isMobileRef: MutableRefObject<boolean>
  messagesRef: RefObject<HTMLDivElement | null>
}) {
  const { activeId, meId, isMobileRef, messagesRef } = opts

  const [typingByUserId, setTypingByUserId] = useState<Record<string, number>>({})
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
    if (p.conversationId !== activeId) return
    const uid = typeof p.userId === 'string' ? p.userId : null
    if (!uid) return
    // Ignore our own typing echoes (defense-in-depth)
    if (uid === meId) return
    const isTyping = !!p.typing
    setTypingByUserId((prev) => {
      if (!isTyping) {
        if (!prev[uid]) return prev
        const next = { ...prev }
        delete next[uid]
        return next
      }
      return { ...prev, [uid]: Date.now() }
    })
  }, [activeId, meId])

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

  // Ensure we always send typing_stop on conversation switch/unmount.
  useEffect(() => {
    const convId = activeId
    return () => {
      stopTyping(convId)
    }
  }, [activeId, stopTyping])

  // animate typing dots and keep view pinned to bottom when typing shown (только на мобильных)
  useEffect(() => {
    const isSomeoneTyping = Object.keys(typingByUserId).length > 0
    if (!isSomeoneTyping || !isMobileRef.current) return
    const el = messagesRef.current
    const id = window.setInterval(() => {
      setTypingDots((d) => (d % 3) + 1)
      if (el) {
        const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80
        if (nearBottom) el.scrollTop = el.scrollHeight
      }
    }, 500)
    return () => window.clearInterval(id)
  }, [typingByUserId, isMobileRef, messagesRef])

  // Expire incoming typing users automatically (defense in depth; server doesn't send periodic stops).
  useEffect(() => {
    // Reset typing state on chat switch to avoid stale "typing..." from previous conversation.
    setTypingByUserId({})
    if (typingCleanupTimerRef.current) {
      window.clearInterval(typingCleanupTimerRef.current)
      typingCleanupTimerRef.current = null
    }
    typingCleanupTimerRef.current = window.setInterval(() => {
      const now = Date.now()
      setTypingByUserId((prev) => {
        const keys = Object.keys(prev)
        if (!keys.length) return prev
        let changed = false
        const next: Record<string, number> = {}
        for (const uid of keys) {
          const ts = prev[uid]
          if (typeof ts === 'number' && now - ts < 2600) {
            next[uid] = ts
          } else {
            changed = true
          }
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
  }, [activeId])

  return {
    typingByUserId,
    typingDots,
    onIncomingTyping,
    notifyTyping,
    stopTyping,
  }
}

