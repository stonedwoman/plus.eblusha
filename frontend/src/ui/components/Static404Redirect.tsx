import { useEffect } from 'react'
import { useLocation } from 'react-router-dom'

/** Уводит на статический public/404.html (ваш HTML/CSS), т.к. SPA иначе отдаёт index.html для любых путей. */
export function Static404Redirect() {
  const { pathname } = useLocation()

  useEffect(() => {
    if (pathname === '/404.html') return
    window.location.replace('/404.html')
  }, [pathname])

  return null
}
