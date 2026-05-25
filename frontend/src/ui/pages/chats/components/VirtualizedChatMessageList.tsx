import { forwardRef, useCallback, useEffect, useMemo, useRef, type ReactNode, type RefObject } from 'react'
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso'

export const VIRTUOSO_INDEX_BASE = 1_000_000

export type VirtualizedChatMessageListProps = {
  count: number
  itemContent: (index: number) => ReactNode
  scrollerRef: RefObject<HTMLDivElement | null>
  /** Updated synchronously each render; use for scrollToIndex with firstItemIndex offset. */
  firstItemIndexRef: RefObject<number>
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

    // Per-conversation Virtuoso state. We compute firstItemIndex below so it
    // updates only when count grows AND the previous-first-key now appears later
    // in the list (true prepend) — never on equal-count re-renders or appends.
    const stateRef = useRef<{
      convKey: string | null | undefined
      prevCount: number
      prevFirstKey: string | number | undefined
      firstItemIndex: number
      initialTopMostItemIndex: number
    }>({
      convKey: undefined,
      prevCount: 0,
      prevFirstKey: undefined,
      firstItemIndex: VIRTUOSO_INDEX_BASE,
      initialTopMostItemIndex: 0,
    })

    const nextFirstKey = count > 0 ? getItemKey?.(0) : undefined
    const s = stateRef.current

    // On conversation switch — fully reset state.
    if (s.convKey !== conversationKey) {
      s.convKey = conversationKey
      s.prevCount = 0
      s.prevFirstKey = undefined
      s.firstItemIndex = VIRTUOSO_INDEX_BASE
      s.initialTopMostItemIndex = count > 0 ? s.firstItemIndex + count - 1 : 0
    }

    // Detect prepend: count grew AND the previously-first key now appears at a
    // later index (i.e. new items inserted before it). This is more robust than
    // just comparing first keys, because the first message can also change due
    // to delete/transform without an actual prepend happening.
    if (
      count > s.prevCount &&
      s.prevFirstKey !== undefined &&
      nextFirstKey !== undefined &&
      nextFirstKey !== s.prevFirstKey
    ) {
      const delta = count - s.prevCount
      // Look up prevFirstKey at exactly `delta` to confirm it's a clean prepend.
      let isPrepend = false
      if (getItemKey) {
        const probed = getItemKey(delta)
        if (probed !== undefined && probed === s.prevFirstKey) isPrepend = true
      } else {
        isPrepend = true
      }
      if (isPrepend) {
        s.firstItemIndex -= delta
      }
    }

    // First-time render with items: lock initial topmost (only once).
    if (s.prevCount === 0 && count > 0) {
      s.initialTopMostItemIndex = s.firstItemIndex + count - 1
    }

    s.prevCount = count
    s.prevFirstKey = nextFirstKey

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

    // followOutput stable — reads via ref.
    const followOutput = useCallback(
      (atBottom: boolean) => {
        if (suppressFollowOutputRef?.current) return false
        return atBottom ? 'auto' : false
      },
      [suppressFollowOutputRef],
    )

    // Initial topmost is captured once per conversation; don't change after.
    const initialTopMostItemIndex = useMemo(
      () => s.initialTopMostItemIndex,
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [conversationKey, s.initialTopMostItemIndex > 0 ? 'set' : 'unset'],
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
        initialTopMostItemIndex={initialTopMostItemIndex}
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
