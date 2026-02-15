import { useEffect, useRef, useState } from 'react'

export function useChatsResponsive(activeId: string | null) {
  const initialIsMobile = typeof window !== 'undefined' ? window.innerWidth <= 768 : false
  const initialIsNarrowHeaderButtons =
    typeof window !== 'undefined' ? (!initialIsMobile && window.innerWidth <= 1300) : false

  const [isMobile, setIsMobile] = useState(initialIsMobile)
  const isMobileRef = useRef(initialIsMobile)
  const [isNarrowHeaderButtons, setIsNarrowHeaderButtons] = useState(initialIsNarrowHeaderButtons)
  const [mobileView, setMobileView] = useState<'list' | 'conversation'>(() => {
    if (!initialIsMobile) return 'conversation'
    return activeId ? 'conversation' : 'list'
  })

  useEffect(() => {
    isMobileRef.current = isMobile
  }, [isMobile])

  useEffect(() => {
    const update = () => {
      const mobile = window.innerWidth <= 768
      setIsMobile(mobile)
      isMobileRef.current = mobile
      // Narrow desktop header: shrink ONLY call buttons to icons.
      setIsNarrowHeaderButtons(!mobile && window.innerWidth <= 1300)
      if (!mobile) {
        setMobileView('conversation')
      } else if (!activeId) {
        setMobileView('list')
      }
    }
    update()
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId])

  useEffect(() => {
    if (!isMobile) return
    if (activeId) setMobileView('conversation')
    else setMobileView('list')
  }, [isMobile, activeId])

  return {
    isMobile,
    isMobileRef,
    isNarrowHeaderButtons,
    mobileView,
    setMobileView,
  }
}

