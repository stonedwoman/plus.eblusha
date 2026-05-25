import { useEffect, useRef, useState } from 'react'

type LazyImageProps = Omit<React.ImgHTMLAttributes<HTMLImageElement>, 'src'> & {
  src: string | null | undefined
  rootRef?: React.RefObject<Element | null>
  rootMargin?: string
  priority?: 'high' | 'low' | 'auto'
}

export function LazyImage({
  src,
  rootRef,
  rootMargin = '600px 0px',
  priority = 'auto',
  loading,
  decoding,
  ...rest
}: LazyImageProps) {
  const imgRef = useRef<HTMLImageElement | null>(null)
  const [shouldLoad, setShouldLoad] = useState<boolean>(false)

  useEffect(() => {
    // Reset visibility when src changes.
    setShouldLoad(false)
  }, [src])

  useEffect(() => {
    if (!src) return
    if (shouldLoad) return

    if (typeof window === 'undefined' || typeof window.IntersectionObserver !== 'function') {
      setShouldLoad(true)
      return
    }

    const el = imgRef.current
    if (!el) {
      setShouldLoad(true)
      return
    }

    let observer: IntersectionObserver | null = null

    const startObserver = () => {
      observer?.disconnect()
      observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (entry.isIntersecting) {
              setShouldLoad(true)
              observer?.disconnect()
              break
            }
          }
        },
        {
          root: rootRef?.current ?? null,
          rootMargin,
          threshold: 0.01,
        },
      )
      observer.observe(el)
    }

    startObserver()

    // Scroll root (Virtuoso scroller) may attach after first paint.
    if (!rootRef?.current) {
      const retryId = window.setInterval(() => {
        if (rootRef?.current) {
          window.clearInterval(retryId)
          startObserver()
        }
      }, 100)
      return () => {
        window.clearInterval(retryId)
        observer?.disconnect()
      }
    }

    return () => observer?.disconnect()
  }, [src, shouldLoad, rootMargin, rootRef])

  return (
    <img
      ref={imgRef}
      src={shouldLoad ? (src ?? undefined) : undefined}
      loading={loading ?? 'lazy'}
      decoding={decoding ?? 'async'}
      fetchPriority={priority}
      {...rest}
    />
  )
}

