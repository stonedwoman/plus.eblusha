import { forwardRef, useCallback, type ReactNode, type RefObject } from 'react'
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso'

export type VirtualizedChatMessageListProps = {
  count: number
  itemContent: (index: number) => ReactNode
  header?: ReactNode
  scrollerRef: RefObject<HTMLDivElement | null>
  getItemKey?: (index: number) => string | number
  onStartReached?: () => void
  onAtBottomChange?: (atBottom: boolean) => void
  conversationKey?: string | null
}

export const VirtualizedChatMessageList = forwardRef<VirtuosoHandle, VirtualizedChatMessageListProps>(
  function VirtualizedChatMessageList(
    {
      count,
      itemContent,
      header,
      scrollerRef,
      getItemKey,
      onStartReached,
      onAtBottomChange,
      conversationKey,
    },
    ref,
  ) {
    const Header = useCallback(() => (header ? <>{header}</> : null), [header])

    const List = useCallback(
      forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(function VirtuosoList(props, listRef) {
        return (
          <div
            {...props}
            ref={listRef}
            style={{ ...(props.style ?? {}), padding: 16, boxSizing: 'border-box' }}
          />
        )
      }),
      [],
    )

    if (count === 0) {
      return <div className="messages-empty">Сообщения появятся здесь</div>
    }

    return (
      <Virtuoso
        key={conversationKey ?? 'chat'}
        ref={ref}
        style={{ flex: 1, minHeight: 0 }}
        scrollerRef={(el) => {
          scrollerRef.current = (el as HTMLDivElement | null) ?? null
        }}
        totalCount={count}
        itemContent={itemContent}
        computeItemKey={getItemKey ? (index) => getItemKey(index) : undefined}
        components={{
          Header: header ? Header : undefined,
          List,
        }}
        alignToBottom
        initialTopMostItemIndex={Math.max(0, count - 1)}
        followOutput={(isAtBottom) => (isAtBottom ? 'auto' : false)}
        startReached={onStartReached}
        atBottomStateChange={onAtBottomChange}
        atBottomThreshold={8}
        atTopThreshold={140}
        increaseViewportBy={{ top: 600, bottom: 800 }}
        defaultItemHeight={72}
        overscan={400}
      />
    )
  },
)

export type { VirtuosoHandle }
