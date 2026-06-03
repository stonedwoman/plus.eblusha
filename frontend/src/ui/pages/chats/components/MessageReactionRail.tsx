import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { Plus, Search } from 'lucide-react'
import { api } from '../../../../utils/api'
import {
  getQuickReactionSlots,
  getReactionFavoritesVersion,
  recordReactionChoice,
  subscribeReactionFavoritesVersion,
} from '../reactionFavoritesStore'
import { fluentReactionEmojiAsset, loadFluentReactionEmojiEntries, normalizeFluentReactionSearch } from '../fluentReactionAssets'
import type { FluentReactionEmojiEntry } from '../fluentReactionAssets'

export type MessageReactionRailReaction = {
  emoji: string
  userId?: string | null
  user?: { displayName?: string; username?: string }
}

type ParticipantLike = {
  user?: { id?: string; displayName?: string; username?: string }
}

type Props = {
  messageId: string
  reactions: MessageReactionRailReaction[] | null | undefined
  currentUserId: string | null | undefined
  /** Для подписей в title у группировки */
  participants?: ParticipantLike[] | null | undefined
  meDisplay?: { displayName?: string | null; username?: string | null; id?: string | null } | null
  isMeBubble: boolean
  /** Широкий чат: полоса справа от текста; в полосе — готовые слева, пикер справа */
  leftAlignAll?: boolean
  isMobile: boolean
  isSelectedInMulti?: boolean
  onInvalidateMessages: () => void
}

const EXTENDED_EMOJI_COLUMNS = 9
const EXTENDED_EMOJI_ROW_HEIGHT = 39
const EXTENDED_EMOJI_OVERSCAN_ROWS = 4
const EXTENDED_EMOJI_DEFAULT_VIEWPORT = 318
const POPULAR_EMOJI_COUNT = 143

type ReactionEmojiCategoryId =
  | 'popular'
  | 'smileys'
  | 'people'
  | 'nature'
  | 'food'
  | 'places'
  | 'activities'
  | 'objects'
  | 'symbols'
  | 'flags'

const REACTION_EMOJI_CATEGORIES: { id: ReactionEmojiCategoryId; emoji: string; label: string }[] = [
  { id: 'popular', emoji: '⭐', label: 'Популярные' },
  { id: 'smileys', emoji: '😀', label: 'Лица и эмоции' },
  { id: 'people', emoji: '👋', label: 'Люди и жесты' },
  { id: 'nature', emoji: '🐶', label: 'Животные и природа' },
  { id: 'food', emoji: '🍔', label: 'Еда и напитки' },
  { id: 'places', emoji: '✈️', label: 'Места и транспорт' },
  { id: 'activities', emoji: '⚽', label: 'Активности' },
  { id: 'objects', emoji: '💡', label: 'Объекты' },
  { id: 'symbols', emoji: '🔣', label: 'Символы' },
  { id: 'flags', emoji: '🏳️', label: 'Флаги' },
]

function emojiEntryMatchesCategory(entry: FluentReactionEmojiEntry, index: number, category: ReactionEmojiCategoryId): boolean {
  if (category === 'popular') return index < POPULAR_EMOJI_COUNT
  const search = entry.search
  switch (category) {
    case 'smileys':
      return search.includes('smileys emotion')
    case 'people':
      return search.includes('people body')
    case 'nature':
      return search.includes('animals nature')
    case 'food':
      return search.includes('food drink')
    case 'places':
      return search.includes('travel places')
    case 'activities':
      return search.includes('activities')
    case 'objects':
      return search.includes('objects')
    case 'symbols':
      return search.includes('symbols')
    case 'flags':
      return search.includes('flags')
  }
  return false
}

function reactionActorLabel(
  r: MessageReactionRailReaction,
  currentUserId: string | null | undefined,
  participants: ParticipantLike[] | undefined,
  meDisplay: Props['meDisplay'],
): string {
  const inline = r?.user
  if (inline && typeof inline === 'object') {
    const dn = typeof inline.displayName === 'string' ? inline.displayName.trim() : ''
    const un = typeof inline.username === 'string' ? inline.username.trim() : ''
    if (dn) return dn
    if (un) return `@${un}`
  }
  if (r.userId != null && currentUserId != null && String(r.userId) === String(currentUserId)) return 'Вы'
  const parts = participants
  const p = parts?.find((x: ParticipantLike) => x?.user?.id != null && String(x.user!.id) === String(r.userId))
  const u = p?.user
  if (u) {
    const dn = typeof u.displayName === 'string' ? u.displayName.trim() : ''
    const un = typeof u.username === 'string' ? u.username.trim() : ''
    if (dn) return dn
    if (un) return `@${un}`
  }
  const md = meDisplay
  if (md && r.userId != null && md.id != null && String(r.userId) === String(md.id)) {
    const dn = typeof md.displayName === 'string' ? md.displayName.trim() : ''
    const un = typeof md.username === 'string' ? md.username.trim() : ''
    if (dn) return dn
    if (un) return `@${un}`
  }
  return 'Участник'
}

export function MessageReactionRail({
  messageId,
  reactions,
  currentUserId,
  participants,
  meDisplay,
  isMeBubble,
  leftAlignAll = false,
  isMobile,
  isSelectedInMulti,
  onInvalidateMessages,
}: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const popoverRef = useRef<HTMLDivElement | null>(null)
  const moreBtnRef = useRef<HTMLButtonElement | null>(null)
  const emojiScrollRef = useRef<HTMLDivElement | null>(null)
  const [touchOpen, setTouchOpen] = useState(false)
  const [extendedOpen, setExtendedOpen] = useState(false)
  const [extendedPos, setExtendedPos] = useState<{ top: number; left: number } | null>(null)
  const [emojiEntries, setEmojiEntries] = useState<readonly FluentReactionEmojiEntry[]>([])
  const [emojiLoadState, setEmojiLoadState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [emojiSearch, setEmojiSearch] = useState('')
  const [activeEmojiCategory, setActiveEmojiCategory] = useState<ReactionEmojiCategoryId>('popular')
  const [emojiScrollTop, setEmojiScrollTop] = useState(0)
  const [emojiViewportHeight, setEmojiViewportHeight] = useState(EXTENDED_EMOJI_DEFAULT_VIEWPORT)

  const favVersion = useSyncExternalStore(subscribeReactionFavoritesVersion, getReactionFavoritesVersion, () => 0)

  const grouped = useMemo(() => {
    const map: Record<string, { count: number; hasMine: boolean }> = {}
    for (const r of reactions || []) {
      const emo = r.emoji
      if (!emo) continue
      if (!map[emo]) map[emo] = { count: 0, hasMine: false }
      map[emo].count++
      if (r.userId != null && currentUserId != null && String(r.userId) === String(currentUserId)) {
        map[emo].hasMine = true
      }
    }
    const entries = Object.entries(map)
    entries.sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))
    return entries
  }, [reactions, currentUserId])

  const existingEmojiKeys = useMemo(() => new Set(grouped.map(([e]) => e)), [grouped])
  const groupedMap = useMemo(() => new Map(grouped), [grouped])

  const quickSlots = useMemo(() => getQuickReactionSlots(currentUserId), [currentUserId, favVersion])

  /** До четырёх быстрых, которых ещё нет на сообщении */
  const pickerChoices = useMemo(
    () => quickSlots.filter((emo) => !existingEmojiKeys.has(emo)),
    [quickSlots, existingEmojiKeys],
  )

  const normalizedEmojiSearch = useMemo(() => normalizeFluentReactionSearch(emojiSearch), [emojiSearch])
  const categoryEmojiEntries = useMemo(
    () => emojiEntries.filter((entry, index) => emojiEntryMatchesCategory(entry, index, activeEmojiCategory)),
    [emojiEntries, activeEmojiCategory],
  )
  const filteredEmojiEntries = useMemo(() => {
    const raw = emojiSearch.trim()
    if (!normalizedEmojiSearch) {
      return raw ? emojiEntries.filter((entry) => entry.emoji.includes(raw)) : categoryEmojiEntries
    }
    const terms = normalizedEmojiSearch.split(' ')
    return emojiEntries.filter((entry) => terms.every((term) => entry.search.includes(term)))
  }, [categoryEmojiEntries, emojiEntries, emojiSearch, normalizedEmojiSearch])

  const emojiRowCount = Math.ceil(filteredEmojiEntries.length / EXTENDED_EMOJI_COLUMNS)
  const emojiStartRow = Math.max(0, Math.floor(emojiScrollTop / EXTENDED_EMOJI_ROW_HEIGHT) - EXTENDED_EMOJI_OVERSCAN_ROWS)
  const emojiVisibleRows = Math.ceil(emojiViewportHeight / EXTENDED_EMOJI_ROW_HEIGHT) + EXTENDED_EMOJI_OVERSCAN_ROWS * 2
  const emojiEndRow = Math.min(emojiRowCount, emojiStartRow + emojiVisibleRows)
  const visibleEmojiEntries = filteredEmojiEntries.slice(emojiStartRow * EXTENDED_EMOJI_COLUMNS, emojiEndRow * EXTENDED_EMOJI_COLUMNS)
  const emojiTopSpacer = emojiStartRow * EXTENDED_EMOJI_ROW_HEIGHT
  const emojiBottomSpacer = Math.max(0, (emojiRowCount - emojiEndRow) * EXTENDED_EMOJI_ROW_HEIGHT)

  const hasReactions = grouped.length > 0

  const compactLayoutClass =
    grouped.length <= 1
      ? 'msg-reaction-rail-compact--n1'
      : grouped.length === 2
        ? 'msg-reaction-rail-compact--n2'
        : 'msg-reaction-rail-compact--n3'

  const reactionTooltipForEmoji = useCallback(
    (emoji: string) => {
      const reactors = (reactions || []).filter((x) => x?.emoji === emoji)
      if (!reactors.length) return undefined
      return reactors.map((row) => reactionActorLabel(row, currentUserId, participants ?? undefined, meDisplay)).join(', ')
    },
    [reactions, currentUserId, participants, meDisplay],
  )

  const toggleEmoji = useCallback(
    async (emo: string, hasMine: boolean) => {
      if (hasMine) {
        await api.post('/messages/unreact', { messageId, emoji: emo })
      } else {
        await api.post('/messages/react', { messageId, emoji: emo })
      }
      onInvalidateMessages()
    },
    [messageId, onInvalidateMessages],
  )

  useEffect(() => {
    if (!extendedOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setExtendedOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [extendedOpen])

  useEffect(() => {
    if (!extendedOpen || emojiEntries.length > 0) return
    let cancelled = false
    setEmojiLoadState('loading')
    loadFluentReactionEmojiEntries()
      .then((entries) => {
        if (cancelled) return
        setEmojiEntries(entries)
        setEmojiLoadState('ready')
      })
      .catch((err) => {
        if (cancelled) return
        console.error('Error loading Fluent emoji index:', err)
        setEmojiLoadState('error')
      })
    return () => {
      cancelled = true
    }
  }, [extendedOpen, emojiEntries.length])

  useEffect(() => {
    if (!extendedOpen) return
    setEmojiSearch('')
    setEmojiScrollTop(0)
    const raf = requestAnimationFrame(() => {
      const scroller = emojiScrollRef.current
      if (!scroller) return
      scroller.scrollTop = 0
      setEmojiViewportHeight(scroller.clientHeight || EXTENDED_EMOJI_DEFAULT_VIEWPORT)
    })
    return () => cancelAnimationFrame(raf)
  }, [extendedOpen])

  useLayoutEffect(() => {
    const scroller = emojiScrollRef.current
    if (!scroller) return
    scroller.scrollTop = 0
    setEmojiScrollTop(0)
    setEmojiViewportHeight(scroller.clientHeight || EXTENDED_EMOJI_DEFAULT_VIEWPORT)
  }, [activeEmojiCategory, normalizedEmojiSearch])

  useEffect(() => {
    if (!touchOpen && !extendedOpen) return
    const onDoc = (e: PointerEvent) => {
      const t = e.target as Node | null
      if (!t) return
      if (hostRef.current?.contains(t) || popoverRef.current?.contains(t)) return
      setExtendedOpen(false)
      if (touchOpen) setTouchOpen(false)
    }
    document.addEventListener('pointerdown', onDoc, true)
    return () => document.removeEventListener('pointerdown', onDoc, true)
  }, [touchOpen, extendedOpen])

  const accentForEmoji = (emo: string, hasMine: boolean) => {
    const isHeart = emo === '❤️'
    const color = isHeart ? '#ef4444' : isSelectedInMulti ? '#713f12' : '#ffc46b'
    return { color, opacity: hasMine ? 1 : 0.82 }
  }

  /** В широком режиме полоса справа от текста — разделитель как у входящих (слева у полосы) */
  const hostSideClass =
    leftAlignAll ? 'msg-reaction-rail-host--them' : isMeBubble ? 'msg-reaction-rail-host--me' : 'msg-reaction-rail-host--them'
  const wideClass = leftAlignAll ? ' msg-reaction-rail-host--wide' : ''
  const touchClass = isMobile && touchOpen ? ' msg-reaction-rail-host--touch-open' : ''
  const emptyClass = !hasReactions ? ' msg-reaction-rail-host--empty' : ''

  const onRailPointerDown = (e: React.PointerEvent) => {
    if (!isMobile) return
    e.stopPropagation()
    setTouchOpen((v) => !v)
  }

  const onPickQuick = async (emo: string, e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    try {
      await toggleEmoji(emo, false)
      recordReactionChoice(currentUserId, emo)
    } catch (err) {
      console.error('Error toggling reaction:', err)
    }
  }

  const onPickExtended = async (emo: string, hasMine: boolean, e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    try {
      await toggleEmoji(emo, hasMine)
      if (!hasMine) {
        recordReactionChoice(currentUserId, emo)
      }
      setExtendedOpen(false)
    } catch (err) {
      console.error('Error toggling reaction:', err)
    }
  }

  const toggleExtended = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setExtendedOpen((v) => !v)
  }

  const updateExtendedPopoverPosition = useCallback(() => {
    const btn = moreBtnRef.current
    const pop = popoverRef.current
    if (!btn) return

    const rect = btn.getBoundingClientRect()
    const gap = 6
    const pad = 8
    const popW = pop?.offsetWidth ?? 360
    const popH = pop?.offsetHeight ?? 430
    const vw = window.innerWidth
    const vh = window.innerHeight

    /** Узкий исходящий: «+» снаружи слева — открываем влево от кнопки */
    const preferLeft = isMeBubble && !leftAlignAll

    let left = preferLeft ? rect.left - gap - popW : rect.right + gap
    if (!preferLeft && left + popW > vw - pad) {
      left = rect.left - gap - popW
    }
    if (preferLeft && left < pad) {
      left = rect.right + gap
    }
    if (left + popW > vw - pad) left = vw - pad - popW
    if (left < pad) left = pad

    let top = rect.top + rect.height / 2 - popH / 2
    if (top + popH > vh - pad) top = vh - pad - popH
    if (top < pad) top = pad

    setExtendedPos({ top, left })
  }, [isMeBubble, leftAlignAll])

  useLayoutEffect(() => {
    if (!extendedOpen) {
      setExtendedPos(null)
      return
    }
    updateExtendedPopoverPosition()
  }, [extendedOpen, updateExtendedPopoverPosition])

  useLayoutEffect(() => {
    if (!extendedOpen || emojiLoadState === 'idle' || emojiLoadState === 'loading') return
    const raf = requestAnimationFrame(updateExtendedPopoverPosition)
    return () => cancelAnimationFrame(raf)
  }, [emojiLoadState, extendedOpen, updateExtendedPopoverPosition])

  const extendedPopover =
    extendedOpen &&
    typeof document !== 'undefined' &&
    createPortal(
      <div className="msg-reaction-extended-popover-mount">
        <div
          ref={popoverRef}
          className="msg-reaction-extended-popover"
          role="dialog"
          aria-label="Выбор реакции"
          style={
            extendedPos
              ? { top: extendedPos.top, left: extendedPos.left, visibility: 'visible' }
              : { top: -9999, left: -9999, visibility: 'hidden' }
          }
          onPointerDown={(e) => e.stopPropagation()}
        >
          <label className="msg-reaction-extended-search">
            <Search className="msg-reaction-extended-search-icon" size={15} strokeWidth={2.4} aria-hidden />
            <input
              className="msg-reaction-extended-search-input"
              type="search"
              value={emojiSearch}
              placeholder="Поиск / search"
              aria-label="Поиск emoji"
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setEmojiSearch(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape' && emojiSearch) {
                  e.preventDefault()
                  e.stopPropagation()
                  setEmojiSearch('')
                }
              }}
            />
          </label>
          <div className="msg-reaction-extended-categories" role="tablist" aria-label="Категории emoji">
            {REACTION_EMOJI_CATEGORIES.map((category) => {
              const iconSrc = fluentReactionEmojiAsset(category.emoji)
              const active = activeEmojiCategory === category.id && !emojiSearch.trim()
              return (
                <button
                  key={category.id}
                  type="button"
                  className={`msg-reaction-extended-category-tab${active ? ' msg-reaction-extended-category-tab--active' : ''}`}
                  title={category.label}
                  role="tab"
                  aria-label={category.label}
                  aria-selected={active}
                  onClick={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    setActiveEmojiCategory(category.id)
                    setEmojiSearch('')
                  }}
                >
                  {iconSrc ? (
                    <img className="msg-reaction-extended-category-img" src={iconSrc} alt="" draggable={false} loading="lazy" />
                  ) : (
                    <span>{category.emoji}</span>
                  )}
                </button>
              )
            })}
          </div>
          <div
            ref={emojiScrollRef}
            className="msg-reaction-extended-popover-inner"
            onScroll={(e) => {
              setEmojiScrollTop(e.currentTarget.scrollTop)
              setEmojiViewportHeight(e.currentTarget.clientHeight || EXTENDED_EMOJI_DEFAULT_VIEWPORT)
            }}
          >
            {emojiLoadState === 'loading' && emojiEntries.length === 0 ? <div className="msg-reaction-extended-status">Загрузка</div> : null}
            {emojiLoadState === 'error' ? <div className="msg-reaction-extended-status">Ошибка</div> : null}
            {emojiLoadState === 'ready' && filteredEmojiEntries.length === 0 ? <div className="msg-reaction-extended-status">Ничего</div> : null}
            {filteredEmojiEntries.length > 0 ? (
              <>
                <div className="msg-reaction-extended-spacer" aria-hidden style={{ height: emojiTopSpacer }} />
                <div className="msg-reaction-extended-grid">
                  {visibleEmojiEntries.map(({ emoji: emo }) => {
                    const g = groupedMap.get(emo)
                    const hasMine = !!g?.hasMine
                    const { color, opacity } = accentForEmoji(emo, hasMine)
                    const fluentSrc = fluentReactionEmojiAsset(emo)
                    return (
                      <button
                        key={emo}
                        type="button"
                        className={`reaction-emoji msg-reaction-extended-cell${hasMine ? ' msg-reaction-extended-cell--mine' : ''}`}
                        title={reactionTooltipForEmoji(emo) ?? emo}
                        aria-pressed={hasMine}
                        onClick={(ev) => onPickExtended(emo, hasMine, ev)}
                      >
                        {fluentSrc ? (
                          <img className="msg-reaction-fluent-img" src={fluentSrc} alt={emo} draggable={false} loading="lazy" style={{ opacity }} />
                        ) : (
                          <span style={{ color, opacity }}>{emo}</span>
                        )}
                      </button>
                    )
                  })}
                </div>
                <div className="msg-reaction-extended-spacer" aria-hidden style={{ height: emojiBottomSpacer }} />
              </>
            ) : null}
          </div>
        </div>
      </div>,
      document.body,
    )

  return (
    <div
      ref={hostRef}
      className={`msg-reaction-rail-host msg-reaction-rail-host--inline ${hostSideClass}${wideClass}${touchClass}${emptyClass}`}
      onPointerDown={isMobile ? onRailPointerDown : undefined}
    >
      <div className="msg-reaction-rail-row">
        <div className={`msg-reaction-rail-compact ${compactLayoutClass}`}>
          {grouped.map(([emo, data], idx) => {
            const { color, opacity } = accentForEmoji(emo, data.hasMine)
            return (
              <button
                key={emo}
                type="button"
                className="reaction-emoji msg-reaction-rail-chip"
                title={reactionTooltipForEmoji(emo)}
                onClick={async (e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  try {
                    await toggleEmoji(emo, data.hasMine)
                  } catch (err) {
                    console.error('Error toggling reaction:', err)
                  }
                }}
                onPointerDown={(e) => {
                  e.stopPropagation()
                }}
                style={{
                  color,
                  opacity,
                  animation: `reactionBounce 0.6s ease ${idx * 0.08}s`,
                }}
              >
                <span className="msg-reaction-rail-chip-emoji">{emo}</span>
                {data.count > 1 ? <span className="msg-reaction-rail-chip-count">{data.count}</span> : null}
              </button>
            )
          })}
        </div>
        <>
          <span className="msg-reaction-rail-divider" aria-hidden>
            |
          </span>
          <div className="msg-reaction-rail-expand">
            {pickerChoices.map((emo) => {
              const { color, opacity } = accentForEmoji(emo, false)
              return (
                <button
                  key={emo}
                  type="button"
                  className="reaction-emoji msg-reaction-rail-picker-btn"
                  title={emo}
                  onClick={(e) => onPickQuick(emo, e)}
                  onPointerDown={(e) => {
                    e.stopPropagation()
                  }}
                  style={{ color, opacity }}
                >
                  {emo}
                </button>
              )
            })}
            <button
              ref={moreBtnRef}
              type="button"
              className="reaction-emoji msg-reaction-rail-picker-btn msg-reaction-rail-more-picker"
              title="Другие реакции"
              aria-expanded={extendedOpen}
              aria-haspopup="dialog"
              onClick={toggleExtended}
              onPointerDown={(e) => {
                e.stopPropagation()
              }}
            >
              <Plus size={22} strokeWidth={2.4} color={isSelectedInMulti ? '#713f12' : '#ffc46b'} />
            </button>
          </div>
        </>
      </div>
      {extendedPopover}
    </div>
  )
}
