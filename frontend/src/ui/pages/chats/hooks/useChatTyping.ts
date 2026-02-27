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

  const TYPING_STOP_IDLE_MS = 1100
  const TYPING_PING_INTERVAL_MS = 2000
  const TYPING_START_DEBOUNCE_MS = 300

  // Outgoing: start on first input after pause, ping ≤1/2s, stop after idle 1100ms
  const typingEmitRef = useRef<{
    convId: string | null
    startTimer: number | null
    stopTimer: number | null
    pingTimer: number | null
    lastSentAt: number
    sentStart: boolean
  }>({ convId: null, startTimer: null, stopTimer: null, pingTimer: null, lastSentAt: 0, sentStart: false })

  // Incoming typing cleanup (expire stale entries)
  const typingCleanupTimerRef = useRef<number | null>(null)

  const LAZY_EXPIRE_MS = 6500

  const onIncomingTyping = useCallback((p: any) => {
    if (!p) return
    const convId = typeof p.conversationId === 'string' ? p.conversationId : null
    const uid = typeof p.userId === 'string' ? p.userId : null
    if (!convId || !uid) return
    if (uid === meId) return
    const isTyping = p.isTyping === true || (p.typing === true && p.isTyping !== false)
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

  const emitStart = useCallback((conversationId: string) => {
    if (!conversationId) return
    try {
      if (!socket.connected) connectSocket()
    } catch {}
    socket.emit('typing_start', conversationId)
    if (import.meta.env?.DEV) console.log('[typing] start', conversationId)
  }, [])

  const emitPing = useCallback((conversationId: string) => {
    if (!conversationId) return
    socket.emit('typing_ping', conversationId)
    if (import.meta.env?.DEV) console.log('[typing] ping', conversationId)
  }, [])

  const emitStop = useCallback((conversationId: string) => {
    if (!conversationId) return
    socket.emit('typing_stop', conversationId)
    if (import.meta.env?.DEV) console.log('[typing] stop', conversationId)
  }, [])

  const stopTyping = useCallback((conversationId: string | null) => {
    const st = typingEmitRef.current
    if (st.startTimer) window.clearTimeout(st.startTimer)
    if (st.stopTimer) window.clearTimeout(st.stopTimer)
    if (st.pingTimer) window.clearTimeout(st.pingTimer)
    st.startTimer = null
    st.stopTimer = null
    st.pingTimer = null
    if (conversationId && st.sentStart) {
      emitStop(conversationId)
    }
    st.sentStart = false
    st.lastSentAt = 0
    st.convId = conversationId
  }, [emitStop])

  const notifyTyping = useCallback(() => {
    if (!activeId) return
    const st = typingEmitRef.current
    if (st.convId && st.convId !== activeId && st.sentStart) {
      emitStop(st.convId)
      st.sentStart = false
    }
    st.convId = activeId

    if (st.startTimer) window.clearTimeout(st.startTimer)
    st.startTimer = window.setTimeout(() => {
      const now = Date.now()
      if (!st.sentStart) {
        emitStart(activeId)
        st.sentStart = true
        st.lastSentAt = now
        if (st.pingTimer) window.clearTimeout(st.pingTimer)
        const schedulePing = () => {
          if (st.convId !== activeId || !st.sentStart) return
          if (Date.now() - st.lastSentAt >= TYPING_PING_INTERVAL_MS) {
            emitPing(activeId)
            st.lastSentAt = Date.now()
          }
          st.pingTimer = window.setTimeout(schedulePing, TYPING_PING_INTERVAL_MS)
        }
        st.pingTimer = window.setTimeout(schedulePing, TYPING_PING_INTERVAL_MS)
      } else if (now - st.lastSentAt >= TYPING_PING_INTERVAL_MS) {
        emitPing(activeId)
        st.lastSentAt = now
      }
    }, TYPING_START_DEBOUNCE_MS)

    if (st.stopTimer) window.clearTimeout(st.stopTimer)
    st.stopTimer = window.setTimeout(() => {
      if (!st.convId) return
      if (st.sentStart) emitStop(st.convId)
      st.sentStart = false
      st.lastSentAt = 0
      if (st.pingTimer) window.clearTimeout(st.pingTimer)
      st.pingTimer = null
    }, TYPING_STOP_IDLE_MS)
  }, [activeId, emitStart, emitPing, emitStop])

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
            if (typeof ts === 'number' && now - ts < LAZY_EXPIRE_MS) {
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

