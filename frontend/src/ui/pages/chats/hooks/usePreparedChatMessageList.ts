import { useMemo } from 'react'
import { computeMultiSourceForwardBundles } from '../forwardBundles'

export type PreparedChatMessageList = {
  fullList: any[]
  /** Indices into fullList that Virtuoso renders (excludes forward-bundle continuations). */
  visibleIndices: number[]
  fwdBundles: Array<{ start: number; end: number }>
  fwdSkip: Set<number>
}

export function resolveVisibleFullListIndex(
  fullIndex: number,
  visibleIndices: number[],
  fwdBundles: Array<{ start: number; end: number }>,
  fwdSkip: Set<number>,
): number {
  let idx = fullIndex
  if (fwdSkip.has(idx)) {
    const bundle = fwdBundles.find((b) => idx >= b.start && idx <= b.end)
    if (bundle) idx = bundle.start
  }
  return visibleIndices.indexOf(idx)
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
    const visibleIndices: number[] = []
    for (let i = 0; i < fullList.length; i++) {
      if (!fwdSkip.has(i)) visibleIndices.push(i)
    }
    return { fullList, visibleIndices, fwdBundles, fwdSkip }
  }, [displayedMessages, activePendingMessages])
}
