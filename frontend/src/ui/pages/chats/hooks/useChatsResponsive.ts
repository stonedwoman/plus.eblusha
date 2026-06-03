import { useEffect, useRef, useState } from 'react'
import { useChatUiStore } from '../../../../core/chat-sync/chatUiStore'

export function useChatsResponsive(activeId: string | null) {
  const initialIsMobile = typeof window !== 'undefined' ? window.innerWidth <= 768 : false
  const initialIsNarrowHeaderButtons =
    typeof window !== 'undefined' ? (!initialIsMobile && window.innerWidth <= 1300) : false

  const [isMobile, setIsMobile] = useState(initialIsMobile)
  const isMobileRef = useRef(initialIsMobile)
  const [isNarrowHeaderButtons, setIsNarrowHeaderButtons] = useState(initialIsNarrowHeaderButtons)
  const mobileView = useChatUiStore((state) => state.mobileView)
  const setMobileView = useChatUiStore((state) => state.setMobileView)

  useEffect(() => {
    isMobileRef.current = isMobile
  }, [isMobile])

  useEffect(() => {
    const update = (isResizeEvent: boolean) => {
      const mobile = window.innerWidth <= 768
      setIsMobile(mobile)
      isMobileRef.current = mobile
      // Narrow desktop header: shrink ONLY call buttons to icons.
      setIsNarrowHeaderButtons(!mobile && window.innerWidth <= 1300)
      // Only adjust mobileView on an ACTUAL resize (crossing the breakpoint), never on the initial
      // mount: on boot activeId still lags the URL, so forcing 'list' here would fight the URL -> view
      // sync and start the router ping-pong. Boot view-state comes from the store init + AppRuntimeCoordinator.
      if (isResizeEvent) {
        if (!mobile) {
          setMobileView('conversation')
        } else if (!activeId) {
          setMobileView('list')
        }
      }
    }
    update(false)
    const onResize = () => update(true)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId])

  // NOTE: mobileView is intentionally NOT derived from activeId here. activeId lags the URL on boot
  // (it is null until the route effect reads it), so forcing 'list'/'conversation' from it fought the
  // URL -> view-state sync in AppRuntimeCoordinator and ping-ponged the router ~50x/s. The view is now
  // driven by explicit actions (selectConversation / backToList) and the URL (AppRuntimeCoordinator).

  return {
    isMobile,
    isMobileRef,
    isNarrowHeaderButtons,
    mobileView,
    setMobileView,
  }
}

