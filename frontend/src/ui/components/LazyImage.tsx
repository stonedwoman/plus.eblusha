import { useEffect, useRef, useState } from 'react'

type LazyImageProps = Omit<React.ImgHTMLAttributes<HTMLImageElement>, 'src'> & {
  src: string | null | undefined
  rootRef?: React.RefObject<Element | null>
  rootMargin?: string
  priority?: 'high' | 'low' | 'auto'
  /**
   * Проявлять картинку по onLoad ЛОКАЛЬНО (opacity 0 → целевая, с transition), НЕ поднимая
   * «загрузилось» в состояние родителя. Бабл раскладывается по мете один раз, а фото
   * просто проявляется внутри — без ре-рендера строки на каждую догруженную картинку.
   * Целевую opacity берём из style.opacity (по умолчанию 1).
   */
  fade?: boolean
}

export function LazyImage({
  src,
  rootRef,
  rootMargin = '600px 0px',
  priority = 'auto',
  loading,
  decoding,
  fade,
  style,
  onLoad,
  ...rest
}: LazyImageProps) {
  const imgRef = useRef<HTMLImageElement | null>(null)
  const [shouldLoad, setShouldLoad] = useState<boolean>(false)
  const [loaded, setLoaded] = useState<boolean>(false)

  useEffect(() => {
    // Reset visibility when src changes.
    setShouldLoad(false)
    setLoaded(false)
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

  // Кэшированная картинка может НЕ выстрелить onLoad (декодирована мгновенно) — тогда
  // при fade она осталась бы с opacity 0. Проверяем complete, когда включили загрузку.
  useEffect(() => {
    if (!fade || !shouldLoad) return
    const el = imgRef.current
    if (el && el.complete && el.naturalWidth > 0) setLoaded(true)
  }, [fade, shouldLoad, src])

  const fadeStyle = fade
    ? {
        ...style,
        opacity: loaded ? ((style as React.CSSProperties | undefined)?.opacity ?? 1) : 0,
        transition: 'opacity 0.2s ease',
      }
    : style

  return (
    <img
      ref={imgRef}
      src={shouldLoad ? (src ?? undefined) : undefined}
      loading={loading ?? 'lazy'}
      decoding={decoding ?? 'async'}
      fetchPriority={priority}
      style={fadeStyle}
      onLoad={(e) => {
        if (fade) setLoaded(true)
        onLoad?.(e)
      }}
      {...rest}
    />
  )
}

