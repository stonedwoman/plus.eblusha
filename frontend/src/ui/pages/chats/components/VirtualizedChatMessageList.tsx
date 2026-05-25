import { forwardRef, useCallback, useEffect, useRef, type ReactNode, type RefObject } from 'react'
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso'

export const VIRTUOSO_INDEX_BASE = 1_000_000

export type VirtualizedChatMessageListProps = {
  count: number
  itemContent: (index: number) => ReactNode
  scrollerRef: RefObject<HTMLDivElement | null>
  /** Updated synchronously each render; use for scrollToIndex with firstItemIndex offset. */
  firstItemIndexRef: RefObject<number>
  /**
   * Monotonic counter incremented by the parent whenever it actually prepends
   * older messages to the head of the list. Used as the SOLE trigger for
   * shifting firstItemIndex — this is more reliable than guessing from
   * count/first-key heuristics, which break when visibility filtering changes.
   */
  prependTick?: number
  getItemKey?: (index: number) => string | number
  onStartReached?: () => void
  onAtBottomChange?: (atBottom: boolean) => void
  /** When true, followOutput is suppressed (e.g. while prepending older messages). */
  suppressFollowOutputRef?: RefObject<boolean>
  onScrollerScroll?: () => void
  conversationKey?: string | null
}

export const VirtualizedChatMessageList = forwardRef<VirtuosoHandle, VirtualizedChatMessageListProps>(
  function VirtualizedChatMessageList(
    {
      count,
      itemContent,
      scrollerRef,
      firstItemIndexRef,
      prependTick = 0,
      getItemKey,
      onStartReached,
      onAtBottomChange,
      suppressFollowOutputRef,
      onScrollerScroll,
      conversationKey,
    },
    ref,
  ) {
    // Latest callbacks/values stored in refs so they don't invalidate Virtuoso props.
    const itemContentRef = useRef(itemContent)
    itemContentRef.current = itemContent
    const getItemKeyRef = useRef(getItemKey)
    getItemKeyRef.current = getItemKey
    const onScrollerScrollRef = useRef(onScrollerScroll)
    onScrollerScrollRef.current = onScrollerScroll
    const countRef = useRef(count)
    countRef.current = count

    // Per-conversation Virtuoso state.
    const stateRef = useRef<{
      convKey: string | null | undefined
      prevCount: number
      prevPrependTick: number
      firstItemIndex: number
      initialTopMostItemIndex: number
    }>({
      convKey: undefined,
      prevCount: 0,
      prevPrependTick: 0,
      firstItemIndex: VIRTUOSO_INDEX_BASE,
      initialTopMostItemIndex: 0,
    })

    const s = stateRef.current

    // On conversation switch — fully reset state.
    if (s.convKey !== conversationKey) {
      s.convKey = conversationKey
      s.prevCount = 0
      s.prevPrependTick = prependTick
      s.firstItemIndex = VIRTUOSO_INDEX_BASE
      s.initialTopMostItemIndex = count > 0 ? s.firstItemIndex + count - 1 : 0
    }

    // Detect prepend via the parent's prependTick signal. The parent increments
    // it once per loadOlderMessages merge; we shift firstItemIndex by the count
    // delta so Virtuoso preserves the user's visual scroll position.
    if (prependTick !== s.prevPrependTick) {
      const delta = count - s.prevCount
      if (delta > 0) s.firstItemIndex -= delta
      s.prevPrependTick = prependTick
    }

    // First-time render with items: lock initial topmost (only once).
    if (s.prevCount === 0 && count > 0) {
      s.initialTopMostItemIndex = s.firstItemIndex + count - 1
    }

    s.prevCount = count

    const firstItemIndex = s.firstItemIndex
    firstItemIndexRef.current = firstItemIndex
    const firstItemIndexLocalRef = useRef(firstItemIndex)
    firstItemIndexLocalRef.current = firstItemIndex

    const scrollerRefCallback = useCallback(
      (el: HTMLElement | Window | null) => {
        const node = (el as HTMLDivElement | null) ?? null
        scrollerRef.current = node
      },
      [scrollerRef],
    )

    useEffect(() => {
      const el = scrollerRef.current
      if (!el) return
      const onScroll = () => onScrollerScrollRef.current?.()
      el.addEventListener('scroll', onScroll, { passive: true })
      return () => el.removeEventListener('scroll', onScroll)
    }, [conversationKey, scrollerRef])

    // Stable forever — read latest values via refs.
    const renderItem = useCallback((virtuosoIndex: number) => {
      const listIndex = virtuosoIndex - firstItemIndexLocalRef.current
      if (listIndex < 0 || listIndex >= countRef.current) {
        return <div aria-hidden style={{ minHeight: 1 }} />
      }
      const node = itemContentRef.current(listIndex)
      if (node == null) {
        return <div aria-hidden style={{ minHeight: 1 }} />
      }
      return node
    }, [])

    const computeItemKey = useCallback((virtuosoIndex: number) => {
      const listIndex = virtuosoIndex - firstItemIndexLocalRef.current
      const k = getItemKeyRef.current?.(listIndex)
      return k ?? virtuosoIndex
    }, [])

    const followOutput = useCallback(
      (atBottom: boolean) => {
        if (suppressFollowOutputRef?.current) return false
        return atBottom ? 'auto' : false
      },
      [suppressFollowOutputRef],
    )

    if (count === 0) {
      return <div className="messages-empty">Сообщения появятся здесь</div>
    }

    return (
      <Virtuoso
        key={conversationKey ?? 'chat'}
        ref={ref}
        style={{ flex: 1, minHeight: 0 }}
        scrollerRef={scrollerRefCallback}
        firstItemIndex={firstItemIndex}
        totalCount={count}
        itemContent={renderItem}
        computeItemKey={computeItemKey}
        initialTopMostItemIndex={s.initialTopMostItemIndex}
        followOutput={followOutput}
        startReached={onStartReached}
        atBottomStateChange={onAtBottomChange}
        atBottomThreshold={32}
        atTopThreshold={300}
        increaseViewportBy={{ top: 600, bottom: 600 }}
        overscan={400}
      />
    )
  },
)

export type { VirtuosoHandle }
