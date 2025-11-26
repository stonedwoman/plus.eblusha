import { useEffect } from 'react'
import { socket } from '../../utils/socket'

const FOCUS_DEBOUNCE_MS = 50

export function PresenceReporter() {
  useEffect(() => {
    if (typeof window === 'undefined' || typeof document === 'undefined') return

    const computeFocused = () => {
      const hasFocus = typeof document.hasFocus === 'function' ? document.hasFocus() : true
      return !document.hidden && hasFocus
    }

    let currentFocused = computeFocused()

    const emitFocus = (next: boolean, force = false) => {
      if (!force && next === currentFocused) {
        return
      }
      currentFocused = next
      if (socket.connected) {
        socket.emit('presence:focus', { focused: next })
      }
    }

    const syncFocus = (force = false) => {
      const next = computeFocused()
      emitFocus(next, force)
    }

    let blurTimer: number | null = null

    const handleVisibility = () => syncFocus()
    const handleFocus = () => syncFocus()
    const handleBlur = () => {
      if (typeof window === 'undefined') return
      if (blurTimer) {
        window.clearTimeout(blurTimer)
      }
      blurTimer = window.setTimeout(() => {
        blurTimer = null
        syncFocus()
      }, FOCUS_DEBOUNCE_MS)
    }

    const handlePageHide = () => emitFocus(false)
    const handleBeforeUnload = () => emitFocus(false, true)
    const handleSocketConnect = () => emitFocus(currentFocused, true)

    syncFocus(true)
    document.addEventListener('visibilitychange', handleVisibility)
    window.addEventListener('focus', handleFocus)
    window.addEventListener('blur', handleBlur)
    window.addEventListener('pagehide', handlePageHide)
    window.addEventListener('beforeunload', handleBeforeUnload)
    socket.on('connect', handleSocketConnect)

    return () => {
      if (blurTimer && typeof window !== 'undefined') {
        window.clearTimeout(blurTimer)
      }
      document.removeEventListener('visibilitychange', handleVisibility)
      window.removeEventListener('focus', handleFocus)
      window.removeEventListener('blur', handleBlur)
      window.removeEventListener('pagehide', handlePageHide)
      window.removeEventListener('beforeunload', handleBeforeUnload)
      socket.off('connect', handleSocketConnect)
    }
  }, [])

  return null
}

