import { useMemo } from 'react'
import { computeMultiSourceForwardBundles } from '../forwardBundles'

export type PreparedChatMessageList = {
  fullList: any[]
  fwdBundles: Array<{ start: number; end: number }>
  fwdSkip: Set<number>
}

export function usePreparedChatMessageList(
  displayedMessages: any[] | undefined,
  activePendingMessages: any[],
): PreparedChatMessageList {
  return useMemo(() => {
    const list = (displayedMessages ?? []).filter((m: any) => !m?.deletedAt)
    const fullList = [...list, ...activePendingMessages].sort(
      (a: any, b: any) => new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime(),
    )
    const fwdBundles = computeMultiSourceForwardBundles(fullList)
    const fwdSkip = new Set<number>()
    for (const b of fwdBundles) {
      for (let k = b.start + 1; k <= b.end; k++) fwdSkip.add(k)
    }
    return { fullList, fwdBundles, fwdSkip }
  }, [displayedMessages, activePendingMessages])
}
