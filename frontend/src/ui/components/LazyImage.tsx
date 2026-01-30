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

    // If IO is missing, load immediately.
    if (typeof window === 'undefined' || typeof (window as any).IntersectionObserver !== 'function') {
      setShouldLoad(true)
      return
    }

    const el = imgRef.current
    if (!el) {
      // In case ref isn't ready yet, fallback to eager load.
      setShouldLoad(true)
      return
    }

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setShouldLoad(true)
            observer.disconnect()
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
    return () => observer.disconnect()
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

