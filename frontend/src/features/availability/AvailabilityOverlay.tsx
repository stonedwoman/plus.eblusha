import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { DateTime } from 'luxon'
import { CheckCircle, Eye, EyeOff, HelpCircle, Trash2, X, XCircle } from 'lucide-react'
import type { AvailabilityProposal } from './availability.types'
import { useAvailabilityStore } from './availability.store'
import { api } from '../../utils/api'
import { socket } from '../../utils/socket'
import {
  buildDayColumns,
  buildTimeSlots,
  formatDateTimeRange,
  formatDayLabel,
  formatTimeLabel,
  getCellDateTime,
  intervalKey,
  SLOT_MINUTES,
  SLOTS_PER_DAY,
  isIntervalIntersecting,
  toUtcInterval,
} from './availability.time'
import './availability.styles.css'

type AvailabilityOverlayProps = {
  isOpen: boolean
  conversationId: string
  viewerId: string
  peerId: string
  viewerTimeZone: string
  peerTimeZone: string
  peerName?: string | null
  onClose: () => void
}

type DragState = {
  active: boolean
  mode: 'add' | 'remove'
  didMove: boolean
  button: number
  startCell?: { dayIndex: number; rowIndex: number }
  paint?: boolean
}

type SelectedRange = {
  startUtcISO: string
  endUtcISO: string
}

type ProposalStatusKind = 'REQUESTED_BY_ME' | 'REQUESTED_OF_ME' | 'MAYBE' | 'DECLINED' | 'AGREED'

const emptyDragState: DragState = { active: false, mode: 'add', didMove: false, button: 0 }

export const AvailabilityOverlay = ({
  isOpen,
  conversationId,
  viewerId,
  peerId,
  viewerTimeZone,
  peerTimeZone,
  peerName,
  onClose,
}: AvailabilityOverlayProps) => {
  const [nowTick, setNowTick] = useState(0)
  const [selectedCells, setSelectedCells] = useState<Set<string>>(() => new Set())
  const [dragState, setDragState] = useState<DragState>(emptyDragState)
  const [onlyOverlap, setOnlyOverlap] = useState(false)
  const [hoveredProposalId, setHoveredProposalId] = useState<string | null>(null)
  const [hoveredCell, setHoveredCell] = useState<{ dayIndex: number; rowIndex: number } | null>(null)
  const [selectedProposalId, setSelectedProposalId] = useState<string | null>(null)
  const saveTimerRef = useRef<number | null>(null)
  const hydratingRef = useRef(false)
  const dirtyRef = useRef(false)
  const gridWrapperRef = useRef<HTMLDivElement | null>(null)
  const proposalsPaneRef = useRef<HTMLDivElement | null>(null)
  const proposalCardRefs = useRef<Record<string, HTMLDivElement | null>>({})

  const availabilityByConversation = useAvailabilityStore((s) => s.availabilityByConversation)
  const proposalsByConversation = useAvailabilityStore((s) => s.proposalsByConversation)
  const setIntervals = useAvailabilityStore((s) => s.setIntervals)
  const setProposals = useAvailabilityStore((s) => s.setProposals)
  const removeProposal = useAvailabilityStore((s) => s.removeProposal)

  const days = useMemo(() => buildDayColumns(viewerTimeZone, 5), [viewerTimeZone])
  const timeSlots = useMemo(() => buildTimeSlots(days[0]), [days])

  const viewerIntervals = availabilityByConversation[conversationId]?.[viewerId] ?? []
  const peerIntervals = availabilityByConversation[conversationId]?.[peerId] ?? []
  const proposals = proposalsByConversation[conversationId] ?? []
  const activeProposals = useMemo(() => {
    const now = Date.now()
    return proposals.filter((p) => {
      const maxEnd = Date.parse(p.maxEndUtcISO)
      return Number.isFinite(maxEnd) && maxEnd > now
    })
  }, [proposals])

  useEffect(() => {
    if (!isOpen) return
    const t = window.setInterval(() => setNowTick((v) => v + 1), 30_000)
    return () => window.clearInterval(t)
  }, [isOpen])

  useEffect(() => {
    if (!isOpen) return
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setSelectedCells(new Set())
      }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [isOpen])

  useEffect(() => {
    if (!isOpen) return
    const handleMouseUp = () => setDragState(emptyDragState)
    window.addEventListener('mouseup', handleMouseUp)
    return () => window.removeEventListener('mouseup', handleMouseUp)
  }, [isOpen])

  useEffect(() => {
    if (!isOpen) return
    hydratingRef.current = true
    api
      .get(`/conversations/${conversationId}/availability`)
      .then((resp) => {
        const intervalsByUserId = (resp as any)?.data?.intervalsByUserId ?? {}
        setIntervals(conversationId, viewerId, intervalsByUserId[viewerId] ?? [])
        setIntervals(conversationId, peerId, intervalsByUserId[peerId] ?? [])
      })
      .catch((err) => {
        console.error('[Availability] Failed to load', err)
      })
      .finally(() => {
        hydratingRef.current = false
      })
  }, [isOpen, conversationId, viewerId, peerId, setIntervals])

  const loadProposals = () => {
    return api
      .get(`/conversations/${conversationId}/availability/proposals`)
      .then((resp) => {
        const list = ((resp as any)?.data?.proposals ?? []) as any[]
        const mapped: AvailabilityProposal[] = list.map((p) => ({
          id: p.id,
          createdAt: Date.parse(p.createdAt),
          createdById: p.createdById,
          maxEndUtcISO: p.maxEndUtcISO,
          note: p.note ?? null,
          ranges: p.ranges ?? [],
          reactionsByUserId: p.reactionsByUserId ?? {},
        }))
        setProposals(conversationId, mapped)
      })
      .catch((err) => {
        console.error('[Availability] Failed to load proposals', err)
      })
  }

  useEffect(() => {
    if (!isOpen) return
    void loadProposals()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, conversationId])

  useEffect(() => {
    if (!isOpen) return
    const t = window.setInterval(() => {
      void loadProposals()
    }, 5000)
    return () => window.clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, conversationId])

  // Safety-net polling: if sockets are unavailable, still get near-realtime peer updates.
  useEffect(() => {
    if (!isOpen) return
    const t = window.setInterval(() => {
      api
        .get(`/conversations/${conversationId}/availability`)
        .then((resp) => {
          const intervalsByUserId = (resp as any)?.data?.intervalsByUserId ?? {}
          setIntervals(conversationId, peerId, intervalsByUserId[peerId] ?? [])
        })
        .catch(() => {})
    }, 3000)
    return () => window.clearInterval(t)
  }, [isOpen, conversationId, viewerId, peerId, setIntervals])

  useEffect(() => {
    if (!isOpen) return
    const handler = (payload: any) => {
      if (!payload) return
      if (payload.conversationId !== conversationId) return
      // Refetch on any update within this conversation (covers peer + my own updates across tabs)
      api
        .get(`/conversations/${conversationId}/availability`)
        .then((resp) => {
          const intervalsByUserId = (resp as any)?.data?.intervalsByUserId ?? {}
          setIntervals(conversationId, peerId, intervalsByUserId[peerId] ?? [])
        })
        .catch(() => {})
    }
    socket.on('availability:updated', handler)
    return () => {
      socket.off('availability:updated', handler)
    }
  }, [isOpen, conversationId, viewerId, peerId, setIntervals])

  useEffect(() => {
    if (!isOpen) return
    const handler = (payload: any) => {
      if (!payload) return
      if (payload.conversationId !== conversationId) return
      void loadProposals()
    }
    socket.on('availability:proposals:updated', handler)
    return () => {
      socket.off('availability:proposals:updated', handler)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, conversationId])

  useEffect(() => {
    if (!isOpen) return
    if (hydratingRef.current) return
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current)
    saveTimerRef.current = window.setTimeout(() => {
      api
        .put(`/conversations/${conversationId}/availability/me`, { intervals: viewerIntervals })
        .then(() => {
          dirtyRef.current = false
        })
        .catch((err) => console.error('[Availability] Failed to save', err))
    }, 500)
    return () => {
      if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
    }
  }, [viewerIntervals, isOpen, conversationId])

  useEffect(() => {
    if (!isOpen) return
    const nextSelection = new Set<string>()
    selectedCells.forEach((cellId) => {
      const [dayIndex, rowIndex] = cellId.split(':').map((value) => Number(value))
      if (Number.isNaN(dayIndex) || Number.isNaN(rowIndex)) return
      if (isCellOverlap(dayIndex, rowIndex)) {
        nextSelection.add(cellId)
      }
    })
    if (nextSelection.size !== selectedCells.size) {
      setSelectedCells(nextSelection)
    }
  }, [viewerIntervals, peerIntervals])

  const isCellOverlap = (dayIndex: number, rowIndex: number) => {
    const { startUtc, endUtc } = getCellUtcRange(dayIndex, rowIndex)
    const meFilled = viewerIntervals.some((interval) => isIntervalIntersecting(interval, startUtc, endUtc))
    const peerFilled = peerIntervals.some((interval) => isIntervalIntersecting(interval, startUtc, endUtc))
    return meFilled && peerFilled
  }

  const getCellUtcRange = (dayIndex: number, rowIndex: number) => {
    const { start, end } = getCellDateTime(days[dayIndex], rowIndex)
    const startUtc = start.toUTC().toMillis()
    const endUtc = end.toUTC().toMillis()
    return { startUtc, endUtc, startLocal: start, endLocal: end }
  }

  const nowLine = useMemo(() => {
    // Recompute when nowTick changes
    void nowTick
    const now = DateTime.now().setZone(viewerTimeZone)
    const dayIndex = days.findIndex((d) => d.hasSame(now, 'day'))
    if (dayIndex < 0) return null
    const minutes = now.diff(days[dayIndex].startOf('day'), 'minutes').minutes
    if (minutes < 0 || minutes > 24 * 60) return null
    const CELL_H = 28
    const HEADER_H = 36
    const top = HEADER_H + (minutes / SLOT_MINUTES) * CELL_H
    const maxTop = HEADER_H + SLOTS_PER_DAY * CELL_H
    if (top < HEADER_H || top > maxTop) return null
    return { top, label: now.setLocale('ru').toFormat('HH:mm') }
  }, [days, nowTick, viewerTimeZone])

  // Auto-scroll to current time on open (like Outlook)
  useEffect(() => {
    if (!isOpen) return
    const wrapper = gridWrapperRef.current
    if (!wrapper || !nowLine) return
    // leave some headroom above the line
    const target = Math.max(0, nowLine.top - 160)
    wrapper.scrollTop = target
  }, [isOpen, nowLine])

  const applyCellChange = (dayIndex: number, rowIndex: number, mode: 'add' | 'remove') => {
    const { startLocal, endLocal } = getCellUtcRange(dayIndex, rowIndex)
    const interval = toUtcInterval(startLocal, endLocal)
    if (mode === 'add') {
      dirtyRef.current = true
      const nextMap = new Map(viewerIntervals.map((it) => [intervalKey(it), it]))
      nextMap.set(intervalKey(interval), interval)
      setIntervals(conversationId, viewerId, Array.from(nextMap.values()))
      return
    }

    const { startUtc, endUtc } = getCellUtcRange(dayIndex, rowIndex)
    dirtyRef.current = true
    const next = viewerIntervals.filter((it) => !isIntervalIntersecting(it, startUtc, endUtc))
    setIntervals(conversationId, viewerId, next)
  }

  const toggleSelection = (dayIndex: number, rowIndex: number) => {
    const id = `${dayIndex}:${rowIndex}`
    setSelectedCells((prev) => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }

  const handleCellMouseDown = (event: React.MouseEvent, dayIndex: number, rowIndex: number) => {
    if (event.button !== 0 && event.button !== 2) return
    event.preventDefault()
    const mode = event.button === 2 ? 'remove' : 'add'
    const overlap = isCellOverlap(dayIndex, rowIndex)
    const paint = mode === 'remove' ? true : !overlap
    setDragState({ active: true, mode, didMove: false, button: event.button, startCell: { dayIndex, rowIndex }, paint })

    // Make painting feel instant: apply on mousedown (except left-click on overlap where we want selection)
    if (paint) {
      applyCellChange(dayIndex, rowIndex, mode)
    }
  }

  const handleCellMouseEnter = (dayIndex: number, rowIndex: number) => {
    if (!dragState.active) return
    if (!dragState.paint) return
    setDragState((prev) => ({ ...prev, didMove: true }))
    applyCellChange(dayIndex, rowIndex, dragState.mode)
  }

  const handleCellMouseUp = (event: React.MouseEvent, dayIndex: number, rowIndex: number) => {
    if (dragState.didMove) return
    if (event.button !== 0) return
    if (isCellOverlap(dayIndex, rowIndex)) {
      toggleSelection(dayIndex, rowIndex)
      return
    }
    // painting already handled on mousedown
  }

  const selectedRanges = useMemo(() => {
    const byDay = new Map<number, number[]>()
    selectedCells.forEach((cellId) => {
      const [dayIndex, rowIndex] = cellId.split(':').map((value) => Number(value))
      if (Number.isNaN(dayIndex) || Number.isNaN(rowIndex)) return
      if (!byDay.has(dayIndex)) byDay.set(dayIndex, [])
      byDay.get(dayIndex)?.push(rowIndex)
    })

    const ranges: SelectedRange[] = []
    for (const [dayIndex, rows] of byDay.entries()) {
      const sorted = Array.from(new Set(rows)).sort((a, b) => a - b)
      if (sorted.length === 0) continue
      let runStart = sorted[0]
      let runEnd = sorted[0]
      for (let i = 1; i < sorted.length; i += 1) {
        const current = sorted[i]
        if (current === runEnd + 1) {
          runEnd = current
        } else {
          const startDate = getCellDateTime(days[dayIndex], runStart).start
          const endDate = getCellDateTime(days[dayIndex], runEnd).end
          ranges.push(toUtcInterval(startDate, endDate))
          runStart = current
          runEnd = current
        }
      }
      const startDate = getCellDateTime(days[dayIndex], runStart).start
      const endDate = getCellDateTime(days[dayIndex], runEnd).end
      ranges.push(toUtcInterval(startDate, endDate))
    }
    return ranges.sort((a, b) => a.startUtcISO.localeCompare(b.startUtcISO))
  }, [selectedCells, days])

  const handleProposal = () => {
    if (selectedRanges.length === 0) return
    api
      .post(`/conversations/${conversationId}/availability/proposals`, { ranges: selectedRanges })
      .then(() => {
        setSelectedCells(new Set())
        void loadProposals()
      })
      .catch((err) => console.error('[Availability] Failed to create proposal', err))
  }

  const handleDeleteProposal = (proposalId: string) => {
    api
      .delete(`/conversations/${conversationId}/availability/proposals/${proposalId}`)
      .then(() => {
        removeProposal(conversationId, proposalId)
      })
      .catch((err) => console.error('[Availability] Failed to delete proposal', err))
  }

  const setMyReaction = (proposalId: string, value: 'YES' | 'MAYBE' | 'NO' | null) => {
    api
      .put(`/conversations/${conversationId}/availability/proposals/${proposalId}/reaction`, { value })
      .then(() => void loadProposals())
      .catch((err) => console.error('[Availability] Failed to react', err))
  }

  const getProposalStatus = (proposal: AvailabilityProposal): { kind: ProposalStatusKind; label: string } => {
    const my = proposal.reactionsByUserId[viewerId] ?? null
    const peer = proposal.reactionsByUserId[peerId] ?? null
    if (my === 'NO' || peer === 'NO') return { kind: 'DECLINED', label: 'отклонено' }
    if (my === 'MAYBE' || peer === 'MAYBE') return { kind: 'MAYBE', label: 'под вопросом' }
    if (my === 'YES' && peer === 'YES') return { kind: 'AGREED', label: 'договорились' }
    if (proposal.createdById === viewerId) return { kind: 'REQUESTED_BY_ME', label: 'запросили мы' }
    return { kind: 'REQUESTED_OF_ME', label: 'запросили у нас' }
  }

  type ProposalBlock = {
    proposalId: string
    dayIndex: number
    startRow: number
    endRow: number
    kind: ProposalStatusKind
    label: string
  }

  const proposalBlocks = useMemo(() => {
    const blocks: ProposalBlock[] = []
    for (const proposal of activeProposals) {
      const status = getProposalStatus(proposal)
      for (const r of proposal.ranges) {
        const start = DateTime.fromISO(r.startUtcISO, { zone: 'utc' }).setZone(viewerTimeZone)
        const end = DateTime.fromISO(r.endUtcISO, { zone: 'utc' }).setZone(viewerTimeZone)

        let cursor = start
        while (cursor < end) {
          const dayStart = cursor.startOf('day')
          const dayEnd = dayStart.plus({ days: 1 })
          const segmentEnd = end < dayEnd ? end : dayEnd
          const dayIndex = days.findIndex((d) => d.hasSame(cursor, 'day'))
          if (dayIndex >= 0) {
            const startMin = Math.max(0, Math.floor(cursor.diff(dayStart, 'minutes').minutes))
            const endMin = Math.min(24 * 60, Math.ceil(segmentEnd.diff(dayStart, 'minutes').minutes))
            const startRow = Math.max(0, Math.min(SLOTS_PER_DAY - 1, Math.floor(startMin / SLOT_MINUTES)))
            const endRow = Math.max(0, Math.min(SLOTS_PER_DAY - 1, Math.ceil(endMin / SLOT_MINUTES) - 1))
            if (endRow >= startRow) {
              blocks.push({
                proposalId: proposal.id,
                dayIndex,
                startRow,
                endRow,
                kind: status.kind,
                label: status.label,
              })
            }
          }
          cursor = segmentEnd
        }
      }
    }

    // merge contiguous blocks per proposal/day/kind
    const byKey = new Map<string, ProposalBlock[]>()
    for (const b of blocks) {
      const key = `${b.proposalId}|${b.dayIndex}|${b.kind}`
      const arr = byKey.get(key) ?? []
      arr.push(b)
      byKey.set(key, arr)
    }

    const merged: ProposalBlock[] = []
    for (const arr of byKey.values()) {
      const sorted = arr.sort((a, b) => a.startRow - b.startRow)
      let cur = { ...sorted[0] }
      for (let i = 1; i < sorted.length; i += 1) {
        const nxt = sorted[i]
        if (nxt.startRow <= cur.endRow + 1) {
          cur.endRow = Math.max(cur.endRow, nxt.endRow)
        } else {
          merged.push(cur)
          cur = { ...nxt }
        }
      }
      merged.push(cur)
    }
    return merged
  }, [activeProposals, days, viewerTimeZone, viewerId, peerId])

  const pickProposalForCell = (cellStartUtc: number, cellEndUtc: number) => {
    const priority: Record<ProposalStatusKind, number> = {
      AGREED: 5,
      DECLINED: 4,
      MAYBE: 3,
      REQUESTED_BY_ME: 2,
      REQUESTED_OF_ME: 1,
    }
    let best: { proposal: AvailabilityProposal; kind: ProposalStatusKind; score: number } | null = null
    for (const p of activeProposals) {
      const intersects = p.ranges.some((r) => isIntervalIntersecting(r, cellStartUtc, cellEndUtc))
      if (!intersects) continue
      const kind = getProposalStatus(p).kind
      const score = priority[kind] * 1_000_000 + p.createdAt
      if (!best || score > best.score) best = { proposal: p, kind, score }
    }
    return best ? { proposalId: best.proposal.id, kind: best.kind } : null
  }

  useEffect(() => {
    if (!isOpen) return
    // prevent "stuck" selection under proposals
    const next = new Set<string>()
    selectedCells.forEach((cellId) => {
      const [dayIndex, rowIndex] = cellId.split(':').map((v) => Number(v))
      if (Number.isNaN(dayIndex) || Number.isNaN(rowIndex)) return
      const { startUtc, endUtc } = getCellUtcRange(dayIndex, rowIndex)
      if (!pickProposalForCell(startUtc, endUtc)) next.add(cellId)
    })
    if (next.size !== selectedCells.size) setSelectedCells(next)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProposals])

  const renderCell = (dayIndex: number, rowIndex: number) => {
    const { startUtc, endUtc } = getCellUtcRange(dayIndex, rowIndex)
    const meFilled = viewerIntervals.some((interval) => isIntervalIntersecting(interval, startUtc, endUtc))
    const peerFilled = peerIntervals.some((interval) => isIntervalIntersecting(interval, startUtc, endUtc))
    const overlap = meFilled && peerFilled
    const proposalHit = pickProposalForCell(startUtc, endUtc)
    const hasProposal = !!proposalHit
    const isSelected = selectedCells.has(`${dayIndex}:${rowIndex}`)
    const weekend = [6, 7].includes(days[dayIndex].weekday)
    const className = [
      'availability-cell',
      weekend ? 'weekend' : '',
      meFilled ? 'filled-me' : '',
      peerFilled ? 'filled-peer' : '',
      // proposal fill overrides overlap visually
      overlap && !hasProposal ? 'overlap' : '',
      hasProposal ? 'covered-by-proposal' : '',
      isSelected ? 'selected' : '',
      onlyOverlap ? 'only-overlap' : '',
    ]
      .filter(Boolean)
      .join(' ')

    const hideCell = onlyOverlap && !overlap

    return (
      <div
        key={`cell-${dayIndex}-${rowIndex}`}
        className={className}
        data-hidden={hideCell ? 'true' : 'false'}
        onMouseDown={(event) => handleCellMouseDown(event, dayIndex, rowIndex)}
        onMouseEnter={() => handleCellMouseEnter(dayIndex, rowIndex)}
        onMouseMove={() => setHoveredCell({ dayIndex, rowIndex })}
        onMouseLeave={() => setHoveredCell(null)}
        onMouseUp={(event) => handleCellMouseUp(event, dayIndex, rowIndex)}
      />
    )
  }

  if (!isOpen) return null

  return createPortal(
    <div className="availability-overlay" onClick={onClose}>
      <div
        className="availability-panel"
        onClick={(event) => event.stopPropagation()}
        onContextMenu={(event) => event.preventDefault()}
      >
        <header className="availability-header">
          <div>
            <div className="availability-title">Календарь доступности</div>
            <div className="availability-subtitle">
              {viewerTimeZone} · {peerName ?? 'Собеседник'} ({peerTimeZone})
            </div>
          </div>
          <button className="btn btn-icon btn-ghost" type="button" onClick={onClose}>
            <X size={18} />
          </button>
        </header>

        <div className="availability-content">
          <section className="availability-left">
            <div className="availability-controls">
              <div className="availability-hints">
                <span>ЛКМ — закрасить</span>
                <span>ПКМ — стереть</span>
                <span>Шаг — 1 час</span>
                <span>Esc — очистить выбор</span>
              </div>
            </div>

            <div className="availability-legend">
              <div><span className="legend-swatch me" /> Моё</div>
              <div><span className="legend-swatch peer" /> Собеседник</div>
              <div><span className="legend-swatch overlap" /> Пересечение</div>
            </div>

            <div className="availability-grid-wrapper" ref={gridWrapperRef}>
              <div className="availability-grid-inner">
                {nowLine && (
                  <>
                    <div className="availability-now-label" style={{ top: nowLine.top }}>
                      сейчас {nowLine.label}
                    </div>
                    <div className="availability-now-line" style={{ top: nowLine.top }} />
                  </>
                )}
                <div
                  className="availability-proposal-layer"
                  style={{
                    gridTemplateColumns: `72px repeat(${days.length}, 1fr)`,
                    gridTemplateRows: `36px repeat(${SLOTS_PER_DAY}, 28px)`,
                  }}
                >
                  {proposalBlocks.map((b) => (
                    <div
                      key={`${b.proposalId}-${b.dayIndex}-${b.startRow}-${b.endRow}-${b.kind}`}
                      className={[
                        'availability-proposal-block',
                        `kind-${b.kind}`,
                        hoveredProposalId === b.proposalId || selectedProposalId === b.proposalId ? 'focus' : '',
                      ].filter(Boolean).join(' ')}
                      style={{
                        gridColumnStart: 2 + b.dayIndex,
                        gridColumnEnd: 2 + b.dayIndex + 1,
                        gridRowStart: 2 + b.startRow,
                        gridRowEnd: 2 + b.endRow + 1,
                      }}
                      onMouseEnter={() => setHoveredProposalId(b.proposalId)}
                      onMouseLeave={() => setHoveredProposalId(null)}
                      onClick={() => {
                        setSelectedProposalId(b.proposalId)
                        const el = proposalCardRefs.current[b.proposalId]
                        if (el) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
                      }}
                    >
                      <div className="availability-proposal-block-label">{b.label}</div>
                    </div>
                  ))}
                </div>
                <div
                  className="availability-grid"
                  style={{ gridTemplateColumns: `72px repeat(${days.length}, 1fr)` }}
                >
                <div className="availability-corner" />
                {days.map((day, index) => (
                  <div
                    key={`day-${index}`}
                    className={`availability-day-label ${[6, 7].includes(day.weekday) ? 'weekend' : ''}`}
                  >
                    <div>{formatDayLabel(day)}</div>
                  </div>
                ))}

                {timeSlots.map((slot, rowIndex) => (
                  <div key={`row-${rowIndex}`} className="availability-row">
                    <div className="availability-time-label">{formatTimeLabel(slot)}</div>
                    {days.map((_, dayIndex) => renderCell(dayIndex, rowIndex))}
                  </div>
                ))}
                </div>
              </div>
            </div>
          </section>

          <aside className="availability-right">
            <div className="availability-block">
              <div className="availability-block-title">Выбранное пересечение</div>
              {selectedRanges.length === 0 ? (
                <div className="availability-empty">Выберите оранжевые слоты, чтобы собрать диапазоны.</div>
              ) : (
                <div className="availability-ranges">
                  {selectedRanges.map((range) => {
                    const viewer = formatDateTimeRange(range.startUtcISO, range.endUtcISO, viewerTimeZone)
                    const peer = formatDateTimeRange(range.startUtcISO, range.endUtcISO, peerTimeZone)
                    return (
                      <div key={`${range.startUtcISO}-${range.endUtcISO}`} className="availability-range-card">
                        <div className="availability-range-main">
                          {viewer.dayLabel} · {viewer.startLabel}–{viewer.endLabel}
                        </div>
                        <div className="availability-range-sub">
                          у собеседника: {peer.startLabel}–{peer.endLabel}
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
              <button
                type="button"
                className="btn btn-secondary availability-propose"
                onClick={handleProposal}
                disabled={selectedRanges.length === 0}
              >
                Предложить слот
              </button>
            </div>

            <div className="availability-block">
              <div className="availability-block-title">История предложений</div>
              {activeProposals.length === 0 ? (
                <div className="availability-empty">Пока нет предложений.</div>
              ) : (
                <div className="availability-proposals" ref={proposalsPaneRef}>
                  {activeProposals.map((proposal) => {
                    const my = proposal.reactionsByUserId[viewerId] ?? null
                    const peer = proposal.reactionsByUserId[peerId] ?? null
                    const isMatch = my === 'YES' && peer === 'YES'
                    const isLinkedToHoveredCell =
                      hoveredCell &&
                      (() => {
                        const { startUtc, endUtc } = getCellUtcRange(hoveredCell.dayIndex, hoveredCell.rowIndex)
                        return proposal.ranges.some((r) => isIntervalIntersecting(r, startUtc, endUtc))
                      })()
                    return (
                    <div
                      key={proposal.id}
                      className={[
                        'availability-proposal-card',
                        `status-${getProposalStatus(proposal).kind}`,
                        isMatch ? 'matched' : '',
                        hoveredProposalId === proposal.id ? 'hovered' : '',
                        isLinkedToHoveredCell ? 'linked' : '',
                        selectedProposalId === proposal.id ? 'selected' : '',
                      ].filter(Boolean).join(' ')}
                      ref={(el) => { proposalCardRefs.current[proposal.id] = el }}
                      onMouseEnter={() => setHoveredProposalId(proposal.id)}
                      onMouseLeave={() => setHoveredProposalId(null)}
                      onClick={() => setSelectedProposalId(proposal.id)}
                    >
                      <div className="availability-proposal-title">
                        Предложение · {DateTime.fromMillis(proposal.createdAt).toLocaleString(DateTime.DATE_SHORT)}
                      </div>
                      <div className="availability-proposal-body">
                        {proposal.ranges.map((range) => {
                          const viewer = formatDateTimeRange(range.startUtcISO, range.endUtcISO, viewerTimeZone)
                          const peer = formatDateTimeRange(range.startUtcISO, range.endUtcISO, peerTimeZone)
                          return (
                            <div key={intervalKey(range)} className="availability-range-card">
                              <div className="availability-range-main">
                                {viewer.dayLabel} · {viewer.startLabel}–{viewer.endLabel}
                              </div>
                              <div className="availability-range-sub">
                                у собеседника: {peer.startLabel}–{peer.endLabel}
                              </div>
                            </div>
                          )
                        })}
                      </div>
                      <div className="availability-reactions">
                        <button
                          type="button"
                          className={`availability-reaction ${my === 'YES' ? 'active' : ''}`}
                          title="Могу"
                          onClick={() => setMyReaction(proposal.id, my === 'YES' ? null : 'YES')}
                        >
                          <CheckCircle size={16} />
                        </button>
                        <button
                          type="button"
                          className={`availability-reaction ${my === 'MAYBE' ? 'active' : ''}`}
                          title="Возможно"
                          onClick={() => setMyReaction(proposal.id, my === 'MAYBE' ? null : 'MAYBE')}
                        >
                          <HelpCircle size={16} />
                        </button>
                        <button
                          type="button"
                          className={`availability-reaction ${my === 'NO' ? 'active' : ''}`}
                          title="Не могу"
                          onClick={() => setMyReaction(proposal.id, my === 'NO' ? null : 'NO')}
                        >
                          <XCircle size={16} />
                        </button>
                        <span className="availability-reaction-label">
                          вы: {my ?? '—'} · {peerName ?? 'собеседник'}: {peer ?? '—'}
                        </span>
                        {proposal.createdById === viewerId && (
                          <button
                            type="button"
                            className="availability-reaction danger"
                            title="Удалить"
                            onClick={() => handleDeleteProposal(proposal.id)}
                          >
                            <Trash2 size={16} />
                          </button>
                        )}
                      </div>
                    </div>
                  )})}
                </div>
              )}
            </div>

            <div className="availability-block availability-privacy">
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => setOnlyOverlap((prev) => !prev)}
              >
                {onlyOverlap ? <EyeOff size={16} /> : <Eye size={16} />}
                {onlyOverlap ? 'Показывать все слоты' : 'Показывать только пересечения'}
              </button>
            </div>
          </aside>
        </div>
      </div>
    </div>,
    document.body,
  )
}
