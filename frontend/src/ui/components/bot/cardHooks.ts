/**
 * Хуки карточек бота: «карточка на экране» (одни IntersectionObserver на все карточки — тикают только
 * видимые, SPEC.md §10.3) и системное «меньше движения» (SPEC.md §10.4).
 */
import { useEffect, useState, type RefObject } from 'react'

type Cb = (visible: boolean) => void
let observer: IntersectionObserver | null = null
const callbacks = new WeakMap<Element, Cb>()

function sharedObserver(): IntersectionObserver | null {
  if (observer) return observer
  if (typeof IntersectionObserver === 'undefined') return null
  observer = new IntersectionObserver(
    (entries) => {
      for (const e of entries) callbacks.get(e.target)?.(e.isIntersecting)
    },
    { rootMargin: '64px 0px' },
  )
  return observer
}

/** Элемент виден на экране (с запасом 64 px). Нет IntersectionObserver — считаем видимым. */
export function useInViewport(ref: RefObject<Element | null>): boolean {
  const [visible, setVisible] = useState(() => typeof IntersectionObserver === 'undefined')
  useEffect(() => {
    const el = ref.current
    const io = sharedObserver()
    if (!el || !io) {
      setVisible(true)
      return
    }
    callbacks.set(el, setVisible)
    io.observe(el)
    return () => {
      io.unobserve(el)
      callbacks.delete(el)
    }
  }, [ref])
  return visible
}

/** Системная настройка «уменьшить движение». */
export function usePrefersReducedMotion(): boolean {
  const [rm, setRm] = useState(() => {
    try {
      return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
    } catch {
      return false
    }
  })
  useEffect(() => {
    if (typeof matchMedia !== 'function') return
    const mq = matchMedia('(prefers-reduced-motion: reduce)')
    const on = () => setRm(mq.matches)
    try {
      mq.addEventListener('change', on)
      return () => mq.removeEventListener('change', on)
    } catch {
      return
    }
  }, [])
  return rm
}
