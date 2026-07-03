/**
 * Рендер одной строки сообщения (renderChatMessageAtIndex). Вынесено из
 * MessagesPane; обычная функция, значения получает через ctx.
 */
/**
 * Рендер-функция renderMessagesPane, вынесена из ChatsPage. Обычная функция (не компонент);
 * значения компонента получает через объект ctx.
 */

import { lazy, Fragment } from 'react'

import { api } from '../../../../utils/api'
import type { AxiosError } from 'axios'

import { Quote, Check } from 'lucide-react'
import { AvailabilityButton } from '../../../../features/availability/AvailabilityButton'
import { AvailabilityOverlay } from '../../../../features/availability/AvailabilityOverlay'

const CallOverlay = lazy(() => import('../../../components/CallOverlay').then(m => ({ default: m.CallOverlay })))
const preloadCallOverlay = () => import('../../../components/CallOverlay')

import { Avatar } from '../../../components/Avatar'
import { UserProfileCard } from '../../../components/UserProfileCard'
import { ImageEditorModal } from '../../../components/ImageEditorModal'
import { ImageLightbox } from '../../../components/ImageLightbox'
import { VideoViewer } from '../../../components/VideoViewer'
import { VideoMessageBubble } from '../../../components/VideoMessageBubble'
import { LazyImage } from '../../../components/LazyImage'
import { LinkDeviceModal } from '../../../components/LinkDeviceModal'
import LoadingSpinner from '../../../components/LoadingSpinner'

import { e2eeManager } from '../../../../domain/e2ee/e2eeManager'

import { convertToProxyUrl, extractObjectKeyFromUrl } from '../../../../utils/media'

import { extractFirstPreviewableUrl } from '../../../../js/link-detect'

import { renderMessageText } from '../chatsTextRender'

import { LinkPreviewCard } from '../components/LinkPreviewCard'
import { MessageReactionRail } from '../components/MessageReactionRail'

import { VoiceMessagePlayer } from '../components/VoiceMessagePlayer'
import { DeviceLinkInline } from '../components/DeviceLinkInline'
import { useChatAudio } from '../hooks/useChatAudio'
import { useChatSocketSubscriptions } from '../hooks/useChatSocketSubscriptions'
import { useChatTyping } from '../hooks/useChatTyping'
import { useChatsResponsive } from '../hooks/useChatsResponsive'

import { formatAttachmentFileSize, inferAttachmentRenderType, getAttachmentFilePresentation } from '../chatsAttachments'
import { formatMessageClockLabel, formatRuRelativeSendDay, formatSmallBubbleTimeLabel } from '../chatsTime'
import { formatSenderReplyActionPhrase, formatSenderReplySingleActionPhrase, parseMessageMetadata, parseReplyQuoteBundleEntries, coerceParsedMessageInstant, normalizeForwardFromRecord, extractOriginalForwardedInstantFromMessage } from '../chatsMessages'

export interface ChatMessageRowCtx {
  activeConversation: any
  activeId: any
  attachmentDecryptMap: any
  attachmentHeadInfoMap: any
  client: any
  currentUserId: any
  failedImages: any
  fullList: any
  groupIncomingBubbleBg: any
  hashToGray: any
  imageDimensions: any
  isMobile: any
  leftAlignAll: any
  loadedImages: any
  me: any
  messagesRef: any
  multiSelectMode: any
  nameColorForUser: any
  nearBottomRef: any
  nodesByMessageId: any
  openUserCard: any
  replyQuoteVisual: any
  resolveAttachmentUrl: any
  selectedMessageIds: any
  setContextMenu: any
  setFailedImages: any
  setImageDimensions: any
  setLightbox: any
  setLoadedImages: any
  setVideoViewer: any
  toggleMessageMultiSelect: any
  usersById: any
  visibleObserver: any
}

export function renderChatMessageAtIndex(
                
                  rowIndex: number,
                  forwardBundleInner?: boolean,
                  forwardBundleInnerLast?: boolean,
                  bundleForwardSenderId?: string | null,
                  /** id первого сообщения конверта пересылки: выделение только «целым конвертом», не внутренними id */
                  forwardBundleRepresentativeMessageId?: string | null,
                  /** когда пересылка свёрнута в бабл с комментарием — не дублируем галочки/время на представителе внутри */
                  forwardBundleSuppressMetaFooter?: boolean,
  ctx: ChatMessageRowCtx = {} as any,
) {
  const { activeConversation, activeId, attachmentDecryptMap, attachmentHeadInfoMap, client, currentUserId, failedImages, fullList, groupIncomingBubbleBg, hashToGray, imageDimensions, isMobile, leftAlignAll, loadedImages, me, messagesRef, multiSelectMode, nameColorForUser, nearBottomRef, nodesByMessageId, openUserCard, replyQuoteVisual, resolveAttachmentUrl, selectedMessageIds, setContextMenu, setFailedImages, setImageDimensions, setLightbox, setLoadedImages, setVideoViewer, toggleMessageMultiSelect, usersById, visibleObserver } = ctx
                  const i = rowIndex
                  const m = fullList[i]
                  const prev = fullList[i - 1]
                  const next = fullList[i + 1]
                  const isLastOfRun = !next || next.senderId !== m.senderId
                  const isPrevSame = !!prev && prev.senderId === m.senderId
                  const isMe =
                    currentUserId != null &&
                    m.senderId != null &&
                    String(m.senderId) === String(currentUserId)
                  const isPendingMessage = (() => {
                    try {
                      if (typeof (m as any)?.__pending === 'boolean') return (m as any).__pending
                      if (typeof m.id === 'string' && m.id.startsWith('tmp-')) return true
                      const atts = (m as any)?.attachments
                      if (Array.isArray(atts) && atts.some((a: any) => !!a?.__pending)) return true
                      return false
                    } catch {
                      return false
                    }
                  })()
                  const canSelectForMulti = !isPendingMessage && m.type !== 'SYSTEM'
                  const multiSelectAnchorId =
                    forwardBundleInner && forwardBundleRepresentativeMessageId
                      ? forwardBundleRepresentativeMessageId
                      : m.id
                  const suppressFwdComposeMetaFooter =
                    !!forwardBundleSuppressMetaFooter && !!forwardBundleInner
                  const skipInnerBubbleAnchorRef =
                    suppressFwdComposeMetaFooter &&
                    forwardBundleRepresentativeMessageId != null &&
                    String(m.id) === String(forwardBundleRepresentativeMessageId)
                  const baseRow = leftAlignAll ? 'msg left' : (isMe ? 'msg me' : 'msg them')
                  const spacingClass = isPrevSame ? 'compact' : 'gap'
                  const rowClass = `${baseRow} ${spacingClass}${
                    multiSelectMode && canSelectForMulti && leftAlignAll ? ' msg--multiselect-wide' : ''
                  }`
                  const baseBubble = leftAlignAll ? 'msg-bubble left' : (isMe ? 'msg-bubble me' : 'msg-bubble them')
                  const firstUrl = typeof m.content === 'string' ? extractFirstPreviewableUrl(m.content) : null
                  const hasAnyLink = !!firstUrl
                  const previewMedia = (() => {
                    const p = (m as any)?.metadata?.linkPreview
                    if (p && typeof p === 'object' && typeof p.imageUrl === 'string' && p.imageUrl.trim()) return true
                    if (!firstUrl) return false
                    try {
                      const host = new URL(firstUrl).hostname.toLowerCase()
                      return host.includes('youtube.com') || host === 'youtu.be' || host.includes('spotify.com') || host === 'spoti.fi'
                    } catch {
                      return false
                    }
                  })()
                  const senderUser = usersById[m.senderId]
                  const avatarName = senderUser?.displayName ?? senderUser?.username ?? (isMe ? (me?.displayName ?? me?.username ?? 'Me') : 'User')
                  const avatarId = senderUser?.id ?? (isMe ? (me?.id ?? 'me') : 'user')
                  const isGroupConv = !!(activeConversation?.isGroup || (activeConversation?.participants?.length ?? 0) > 2)
                  const normalizedForwardFromEarly = normalizeForwardFromRecord(parseMessageMetadata(m)?.forwardFrom)
                  const isForwardedBubble = !!(
                    normalizedForwardFromEarly &&
                    typeof normalizedForwardFromEarly.authorName === 'string' &&
                    String(normalizedForwardFromEarly.authorName).trim()
                  )
                  /** Исходный автор в пересылке (имя в метаданных): и для входящих, и для исходящих — senderId всегда «кто переслал». */
                  const forwardHueKey =
                    isForwardedBubble && normalizedForwardFromEarly
                      ? `fwd:${String(normalizedForwardFromEarly.authorName).trim()}|${
                          typeof normalizedForwardFromEarly.sourceChatTitle === 'string'
                            ? String(normalizedForwardFromEarly.sourceChatTitle).trim()
                            : ''
                        }`
                      : null
                  const bgBase =
                    forwardHueKey != null
                      ? groupIncomingBubbleBg(forwardHueKey)
                      : isMe
                        ? '#303845'
                        : isGroupConv
                          ? groupIncomingBubbleBg(m.senderId)
                          : hashToGray(m.senderId)
                  const bg = bgBase
                  const fg = isMe ? '#f1f3f6' : '#f1f3f6'
                  const bundleFw = bundleForwardSenderId != null ? String(bundleForwardSenderId) : null
                  /** Хвосты как у обычных: конец серии от того же отправителя что и m.
                   *  Внутри конверта авторы в сообщениях могут быть из исходной группы — «серия чей» для хвоста
                   *  берём у пересылающего (bundleForwardSenderId): иначе пропадает хвост, если после пачки ты пишешь снова. */
                  const forwardBundleInnerContinuationTail =
                    !!forwardBundleInner &&
                    forwardBundleInnerLast === true &&
                    !!next &&
                    bundleFw != null &&
                    String(next.senderId) === bundleFw
                  const soloForwardedContinuationTail =
                    isForwardedBubble &&
                    !forwardBundleInner &&
                    isMe &&
                    !leftAlignAll &&
                    !!next &&
                    currentUserId != null &&
                    String(next.senderId) === String(currentUserId)
                  /** Внутри общего конверта цитируемый бабл без хвостика (как в макете пачки). */
                  const wantsBubbleTail = forwardBundleInner
                    ? false
                    : isLastOfRun || forwardBundleInnerContinuationTail || soloForwardedContinuationTail
                  const bubbleClass = wantsBubbleTail
                    ? `${baseBubble} ${isMe && !leftAlignAll ? 'tail-right' : 'tail-left'}`
                    : baseBubble
                  const forwardBubbleMods = !isForwardedBubble ? '' : ' msg-bubble--forward msg-bubble--forward-quote'
                  /** Выделение рисуем только на строке-хосте конверта; внутри пачки anchor общий с хостом, но класс/bg не дублируем. */
                  const multiSelectAnchorSelected =
                    multiSelectMode && canSelectForMulti && selectedMessageIds.includes(multiSelectAnchorId)
                  const isSelectedInMulti = multiSelectAnchorSelected && !forwardBundleInner
                  const bubbleFg = isSelectedInMulti ? '#0a0a0a' : fg
                  const senderAccentColor = nameColorForUser(m.senderId)
                  const showGroupSenderName = isGroupConv && !isPrevSame
                  const replyPayload = m.replyTo as { id?: string; content?: string | null; senderId?: string } | undefined
                  const quotedSenderId = replyPayload?.senderId
                  const quotedUserForReply = quotedSenderId ? usersById[quotedSenderId] : undefined
                  const quotedAuthorLabel =
                    quotedUserForReply?.displayName?.trim() ||
                    quotedUserForReply?.username?.trim() ||
                    'Участник'
                  const quoteBarColor = quotedSenderId ? nameColorForUser(quotedSenderId) : '#8e8e93'
                  const quotedMessageForSingleReply =
                    replyPayload?.id ? fullList.find((x: any) => x && String(x.id) === String(replyPayload.id)) : undefined
                  const singleReplyQV = replyQuoteVisual(
                    quotedMessageForSingleReply,
                    typeof replyPayload?.content === 'string' ? replyPayload.content : '',
                  )
                  const singleReplyQuotedAt = quotedMessageForSingleReply?.createdAt
                    ? coerceParsedMessageInstant(quotedMessageForSingleReply.createdAt)
                    : null
                  const singleReplyInnerTimeLabel = formatSmallBubbleTimeLabel(singleReplyQuotedAt)
                  const replyBundleEntries = parseReplyQuoteBundleEntries(m)
                  const showMultiReplyQuote = !!(replyBundleEntries && replyBundleEntries.length >= 2)
                  const hasReplyUi = !!(m.replyTo || showMultiReplyQuote)
                  const replySenderActionPhrase =
                    !forwardBundleInner && hasReplyUi
                      ? showMultiReplyQuote && replyBundleEntries
                        ? formatSenderReplyActionPhrase(replyBundleEntries.length)
                        : m.replyTo
                          ? formatSenderReplySingleActionPhrase()
                          : null
                      : null
                  const showSenderContextRow =
                    !forwardBundleInner && (showGroupSenderName || replySenderActionPhrase)
                  const forwardFrom = (() => {
                    const normalized = normalizedForwardFromEarly
                    if (!normalized) return null
                    const authorName =
                      typeof normalized.authorName === 'string' ? String(normalized.authorName).trim() : ''
                    if (!authorName) return null
                    const isGroupSource = !!normalized.isGroupSource
                    const st = normalized.sourceChatTitle
                    const sourceChatTitle = typeof st === 'string' && st.trim() ? st.trim() : null
                    const originalPostedAt = extractOriginalForwardedInstantFromMessage(m)
                    return { authorName, sourceChatTitle, isGroupSource, originalPostedAt }
                  })()
                  // In wide mode all rows are left-aligned and the avatar is always on the left.
                  // In narrow mode for group chats we still want to show who sent the message,
                  // so we render the avatar on the appropriate side of the row (left for them, right for me).
                  const showAvatarBlock = leftAlignAll || isGroupConv
                  /** Аватар пересылающего у пачки — снаружи конверта на хосте, не внутри .msg-forward-bundle-outer */
                  const showAvatar =
                    showAvatarBlock && isLastOfRun && !forwardBundleInner
                  const avatarOnRight = !leftAlignAll && isGroupConv && isMe
                  const avatarOnLeft = showAvatarBlock && !avatarOnRight
                  const renderAvatarOrSpacer = () => (
                    showAvatar ? (
                      <Avatar name={avatarName} id={avatarId} onClick={usersById[m.senderId] ? () => openUserCard(usersById[m.senderId]) : undefined} avatarUrl={(() => {
                        const userAvatar = usersById[m.senderId]?.avatarUrl
                        return userAvatar && userAvatar.trim() ? userAvatar : undefined
                      })()} />
                    ) : (
                      <div className="avatar-spacer" />
                    )
                  )
                  const createdAt = m.createdAt ? new Date(m.createdAt) : null
                  const extractedOriginalPostedAt = extractOriginalForwardedInstantFromMessage(m)
                  const timeLabelDate =
                    isForwardedBubble && extractedOriginalPostedAt ? extractedOriginalPostedAt : createdAt
                  const timeLabel = formatMessageClockLabel(timeLabelDate)
                  const participantRecencyEligible =
                    !!timeLabelDate &&
                    !!timeLabel &&
                    Number.isFinite(timeLabelDate.getTime()) &&
                    (forwardBundleInner || !isMe || isForwardedBubble)
                  const participantRecencyLine = participantRecencyEligible
                    ? formatRuRelativeSendDay(timeLabelDate)
                    : null
                  const timeAndRecencyLabel =
                    participantRecencyLine != null && participantRecencyLine.trim() !== ''
                      ? `${timeLabel}, ${participantRecencyLine}`
                      : timeLabel
                  // Пересланный бабл повторяет формат карточки ответа: оригинальное время отправки
                  // показываем компактной право-выровненной строкой (и убираем его из мета-строки ниже).
                  const forwardedInnerTimeLabel = isForwardedBubble ? formatSmallBubbleTimeLabel(timeLabelDate) : null
                  const editedAtRaw = (m as any)?.metadata?.editedAt
                  const isEdited = typeof editedAtRaw === 'string' && editedAtRaw.length > 0
                  const otherIds: string[] = (activeConversation?.participants || []).map((p: any) => p.user.id).filter((id: string) => (currentUserId ? id !== currentUserId : true))
                  const receipts = (m.receipts || []) as Array<any>
                  const readByAny = isMe && otherIds.some((uid) => receipts.some((r) => r.userId === uid && (r.status === 'READ' || r.status === 'SEEN')))
                  const ackedOnServer = isMe && !!m.id && !isPendingMessage
                  const tickVariant: 'none' | 'ack' | 'read' = isMe ? (readByAny ? 'read' : (ackedOnServer ? 'ack' : 'none')) : 'none'
                  const renderTicks = (opts?: { withLeftMargin?: boolean }) => {
                    if (isForwardedBubble) return null
                    if (tickVariant === 'none') return null
                    const color = tickVariant === 'read' ? (isSelectedInMulti ? '#451a03' : '#d97706') : isSelectedInMulti ? '#27272a' : '#9aa0a8'
                    const withLeftMargin = opts?.withLeftMargin ?? false
                    const common: React.CSSProperties = {
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      color,
                      marginLeft: withLeftMargin ? 6 : 0,
                      lineHeight: 0,
                      transform: 'translateY(1px)',
                      flexShrink: 0,
                    }
                    // Match the look from the screenshot: rounded caps, slightly thicker stroke.
                    const strokeWidth = 2.2
                    return (
                      <span style={common} aria-label={tickVariant === 'read' ? 'Read' : 'Sent'}>
                        {tickVariant === 'read' ? (
                          <svg width="18" height="12" viewBox="0 0 18 12" fill="none" xmlns="http://www.w3.org/2000/svg">
                            <path d="M1 6.5L4.5 10L11.5 1" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
                            <path d="M7 6.5L10.5 10L17.5 1" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        ) : (
                          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg">
                            <path d="M1 6.5L4.5 10L11 1.5" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        )}
                      </span>
                    )
                  }
                  const isRecentMessage = i >= fullList.length - 28
                      const openMenuAt = (clientX: number, clientY: number) => {
                        setContextMenu({ open: true, x: clientX, y: clientY, messageId: m.id })
                      }
                      const onContextMenu = (e: React.MouseEvent) => {
                    e.preventDefault()
                        openMenuAt(e.clientX, e.clientY)
                  }
                  const scrollToMessageById = (qid: string | undefined) => {
                    if (!qid) return
                    const el = nodesByMessageId.current.get(qid)
                    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' })
                  }
                  const scrollToQuoted = () => scrollToMessageById((m as any).replyTo?.id as string | undefined)
                  // Lightbox should be scoped to this message (not the whole chat).
                  const imagesInMessage = (m.attachments || [])
                    .filter((a: any) => a?.type === 'IMAGE')
                    .map((a: any) => resolveAttachmentUrl(a))
                    .filter((u: string | null): u is string => !!u)
                  const openLightbox = (url: string) => {
                    if (multiSelectMode && canSelectForMulti) {
                      toggleMessageMultiSelect(multiSelectAnchorId)
                      return
                    }
                    const index = imagesInMessage.findIndex((u: string) => u === url)
                    setLightbox({ open: true, index: index >= 0 ? index : 0, items: imagesInMessage })
                  }
                      const onLongPress = {
                        onPointerDown: (e: any) => {
                          const id = window.setTimeout(() => openMenuAt(e.clientX, e.clientY), 450)
                          const clear = () => { window.clearTimeout(id); window.removeEventListener('pointerup', clear); window.removeEventListener('pointermove', cancel) }
                          const cancel = () => { window.clearTimeout(id); window.removeEventListener('pointerup', clear); window.removeEventListener('pointermove', cancel) }
                          window.addEventListener('pointerup', clear, { passive: true } as any)
                          window.addEventListener('pointermove', cancel, { passive: true } as any)
                        }
                      }
                      const rowHandlers = isMobile ? {} : { onContextMenu, ...onLongPress }
                      const multiSelectCheckboxEl =
                        multiSelectMode && canSelectForMulti ? (
                          <button
                            type="button"
                            className={
                              `msg-multi-checkbox${selectedMessageIds.includes(multiSelectAnchorId) ? ' msg-multi-checkbox--checked' : ''}`
                            }
                            aria-label={
                              selectedMessageIds.includes(multiSelectAnchorId)
                                ? 'Снять выделение'
                                : 'Выбрать сообщение'
                            }
                            aria-pressed={selectedMessageIds.includes(multiSelectAnchorId)}
                            onClick={(e) => {
                              e.preventDefault()
                              e.stopPropagation()
                              toggleMessageMultiSelect(multiSelectAnchorId)
                            }}
                          >
                            {selectedMessageIds.includes(multiSelectAnchorId) ? <Check size={16} strokeWidth={2.8} /> : null}
                          </button>
                        ) : null
                      const onRowMultiSelectClick = (e: React.MouseEvent) => {
                        if (!multiSelectMode || !canSelectForMulti) return
                        const t = e.target as HTMLElement
                        if (t.closest('a[href], button, .reaction-emoji, .msg-reaction-rail-host, img, video, .msg-media-tile, .video-message-bubble')) return
                        const sel = typeof window.getSelection === 'function' ? window.getSelection() : null
                        if (sel && sel.toString().length > 0) return
                        e.preventDefault()
                        toggleMessageMultiSelect(multiSelectAnchorId)
                      }
                      return (
                        <div
                          key={m.id}
                          className={rowClass}
                          {...rowHandlers}
                          onClick={onRowMultiSelectClick}
                        >
                      {!forwardBundleInner && !leftAlignAll && !isMe && multiSelectCheckboxEl}
                      {avatarOnLeft && !forwardBundleInner && renderAvatarOrSpacer()}
                      <div
                        className={
                          (hasAnyLink ? `${bubbleClass} has-link-preview${previewMedia ? ' has-link-preview-media' : ''}` : bubbleClass) +
                          forwardBubbleMods +
                          (isSelectedInMulti ? ' msg-bubble--selected' : '') +
                          ' msg-bubble--reactions-inline' +
                          (leftAlignAll ? ' msg-bubble--reactions-wide' : '')
                        }
                        data-mid={m.id}
                        ref={(el) => {
                          if (skipInnerBubbleAnchorRef) return
                          if (!el) {
                            nodesByMessageId.current.delete(m.id)
                            return
                          }
                          nodesByMessageId.current.set(m.id, el)
                          visibleObserver.current?.observe(el)
                        }}
                        style={{ ['--bubble-bg' as any]: bg, ['--bubble-fg' as any]: bubbleFg }}
                        onClick={(e) => {
                          if (multiSelectMode && canSelectForMulti) {
                            return
                          }
                          if (!isMobile) return
                          const target = e.target as HTMLElement
                          if (target.closest('a, button, input, textarea, img, video, .reaction-emoji, .msg-reaction-rail-host, .video-message-bubble')) return
                          const selection = typeof window.getSelection === 'function' ? window.getSelection() : null
                          if (selection && selection.toString()) return
                          openMenuAt(e.clientX, e.clientY)
                        }}
                        onContextMenu={(e) => {
                          const target = e.target as HTMLElement
                          if (target.closest('.reaction-emoji')) {
                            e.preventDefault()
                            e.stopPropagation()
                            return
                          }
                          openMenuAt(e.clientX, e.clientY)
                        }}
                      >
                        <div className="msg-bubble-body">
                        {forwardBundleInner && forwardFrom && (
                          <div
                            style={{
                              fontSize: 13,
                              fontWeight: 700,
                              lineHeight: 1.25,
                              marginBottom: hasReplyUi ? 6 : 5,
                              color: isSelectedInMulti ? '#292524' : nameColorForUser(forwardHueKey),
                            }}
                          >
                            {forwardFrom.authorName}
                          </div>
                        )}
                        {showSenderContextRow && (
                          <div
                            style={{
                              display: 'inline-flex',
                              flexWrap: 'wrap',
                              alignItems: 'center',
                              gap: 5,
                              width: 'max-content',
                              maxWidth: '100%',
                              fontSize: 14,
                              fontWeight: 700,
                              lineHeight: 1.25,
                              marginBottom: hasReplyUi ? 6 : 4,
                              color: isSelectedInMulti ? '#292524' : senderAccentColor,
                            }}
                          >
                            <span style={{ flexShrink: 0 }}>
                              {replySenderActionPhrase
                                ? `${String(avatarName).trim()} ${replySenderActionPhrase}`
                                : avatarName}
                            </span>
                            {replySenderActionPhrase ? (
                              <Quote
                                size={14}
                                strokeWidth={2.6}
                                style={{
                                  opacity: 0.9,
                                  flexShrink: 0,
                                  color: isSelectedInMulti ? '#b45309' : 'var(--brand)',
                                }}
                                aria-hidden
                              />
                            ) : null}
                          </div>
                        )}
                        {showMultiReplyQuote && replyBundleEntries ? (
                          <div className="msg-reply-quote-bundle">
                            {replyBundleEntries.map((entry) => {
                              const uid = entry.senderId
                              const label =
                                uid && usersById[uid]
                                  ? usersById[uid].displayName?.trim() || usersById[uid].username?.trim() || 'Участник'
                                  : 'Участник'
                              const barColor = uid ? nameColorForUser(uid) : '#8e8e93'
                              const innerBubbleBg = groupIncomingBubbleBg(uid || entry.id)
                              const quotedEntryMsg = fullList.find((x: any) => x && String(x.id) === String(entry.id))
                              const innerQuotedAt =
                                (entry.createdAt ? coerceParsedMessageInstant(entry.createdAt) : null) ??
                                (quotedEntryMsg?.createdAt ? coerceParsedMessageInstant(quotedEntryMsg.createdAt) : null)
                              const innerTimeLabel = formatSmallBubbleTimeLabel(innerQuotedAt)
                              const entryQV = replyQuoteVisual(quotedEntryMsg, entry.preview || '')
                              return (
                                <div key={entry.id} className="msg-forward-bundle__item">
                                  <div
                                    role="button"
                                    tabIndex={0}
                                    className="msg-bubble msg-bubble--forward msg-bubble--forward-quote msg-reply-quote-bundle__bubble"
                                    style={{
                                      ['--bubble-bg' as string]: innerBubbleBg,
                                      ['--bubble-fg' as string]: fg,
                                      cursor: 'pointer',
                                      textAlign: 'left',
                                    }}
                                    onClick={(e) => {
                                      if (multiSelectMode && canSelectForMulti) {
                                        e.preventDefault()
                                        e.stopPropagation()
                                        toggleMessageMultiSelect(multiSelectAnchorId)
                                        return
                                      }
                                      e.stopPropagation()
                                      scrollToMessageById(entry.id)
                                    }}
                                    onKeyDown={(e) => {
                                      if (e.key !== 'Enter' && e.key !== ' ') return
                                      e.preventDefault()
                                      if (multiSelectMode && canSelectForMulti) {
                                        e.stopPropagation()
                                        toggleMessageMultiSelect(multiSelectAnchorId)
                                        return
                                      }
                                      e.stopPropagation()
                                      scrollToMessageById(entry.id)
                                    }}
                                  >
                                    <div style={{ fontSize: 13, fontWeight: 700, color: barColor, lineHeight: 1.25 }}>
                                      {label}
                                    </div>
                                    {entryQV.thumbUrl ? (
                                      <div
                                        style={{
                                          marginTop: 5,
                                          lineHeight: 0,
                                          borderRadius: 8,
                                          overflow: 'hidden',
                                          maxWidth: 112,
                                          maxHeight: 72,
                                          alignSelf: 'flex-start',
                                        }}
                                      >
                                        <img
                                          src={entryQV.thumbUrl}
                                          alt=""
                                          style={{
                                            display: 'block',
                                            width: '100%',
                                            height: 'auto',
                                            maxHeight: 72,
                                            objectFit: 'cover',
                                          }}
                                        />
                                      </div>
                                    ) : null}
                                    {entryQV.showText ? (
                                      <div
                                        style={{
                                          marginTop: entryQV.thumbUrl ? 6 : 5,
                                          fontSize: 13,
                                          fontWeight: 400,
                                          color: fg,
                                          opacity: 0.95,
                                          wordBreak: 'break-word',
                                          overflowWrap: 'anywhere',
                                          whiteSpace: 'pre-wrap',
                                          lineHeight: 1.35,
                                        }}
                                      >
                                        {entryQV.line}
                                      </div>
                                    ) : null}
                                    {entryQV.showPlaceholder ? (
                                      <div
                                        style={{
                                          marginTop: 5,
                                          fontSize: 13,
                                          fontWeight: 400,
                                          color: fg,
                                          opacity: 0.95,
                                          wordBreak: 'break-word',
                                          overflowWrap: 'anywhere',
                                          whiteSpace: 'pre-wrap',
                                          lineHeight: 1.35,
                                        }}
                                      >
                                        Сообщение
                                      </div>
                                    ) : null}
                                    {innerTimeLabel ? (
                                      <div
                                        style={{
                                          marginTop: 6,
                                          fontSize: 11,
                                          fontWeight: 500,
                                          color: '#9aa0a8',
                                          textAlign: 'right',
                                          lineHeight: 1.2,
                                        }}
                                      >
                                        {innerTimeLabel}
                                      </div>
                                    ) : null}
                                  </div>
                                </div>
                              )
                            })}
                          </div>
                        ) : m.replyTo ? (
                          <div className="msg-reply-quote-bundle">
                            <div className="msg-forward-bundle__item">
                              <div
                                role="button"
                                tabIndex={0}
                                className="msg-bubble msg-bubble--forward msg-bubble--forward-quote msg-reply-quote-bundle__bubble"
                                style={{
                                  ['--bubble-bg' as string]: groupIncomingBubbleBg(
                                    quotedSenderId || replyPayload?.id || m.id || 'q',
                                  ),
                                  ['--bubble-fg' as string]: fg,
                                  cursor: 'pointer',
                                  textAlign: 'left',
                                }}
                                onClick={(e) => {
                                  if (multiSelectMode && canSelectForMulti) {
                                    e.preventDefault()
                                    e.stopPropagation()
                                    toggleMessageMultiSelect(multiSelectAnchorId)
                                    return
                                  }
                                  e.stopPropagation()
                                  scrollToQuoted()
                                }}
                                onKeyDown={(e) => {
                                  if (e.key !== 'Enter' && e.key !== ' ') return
                                  e.preventDefault()
                                  if (multiSelectMode && canSelectForMulti) {
                                    e.stopPropagation()
                                    toggleMessageMultiSelect(multiSelectAnchorId)
                                    return
                                  }
                                  e.stopPropagation()
                                  scrollToQuoted()
                                }}
                              >
                                <div style={{ fontSize: 13, fontWeight: 700, color: quoteBarColor, lineHeight: 1.25 }}>
                                  {quotedAuthorLabel}
                                </div>
                                {singleReplyQV.thumbUrl ? (
                                  <div
                                    style={{
                                      marginTop: 5,
                                      lineHeight: 0,
                                      borderRadius: 8,
                                      overflow: 'hidden',
                                      maxWidth: 112,
                                      maxHeight: 72,
                                      alignSelf: 'flex-start',
                                    }}
                                  >
                                    <img
                                      src={singleReplyQV.thumbUrl}
                                      alt=""
                                      style={{ display: 'block', width: '100%', height: 'auto', maxHeight: 72, objectFit: 'cover' }}
                                    />
                                  </div>
                                ) : null}
                                {singleReplyQV.showText ? (
                                  <div
                                    style={{
                                      marginTop: singleReplyQV.thumbUrl ? 6 : 5,
                                      fontSize: 13,
                                      fontWeight: 400,
                                      color: fg,
                                      opacity: 0.95,
                                      wordBreak: 'break-word',
                                      overflowWrap: 'anywhere',
                                      whiteSpace: 'pre-wrap',
                                      lineHeight: 1.35,
                                    }}
                                  >
                                    {singleReplyQV.line}
                                  </div>
                                ) : null}
                                {singleReplyQV.showPlaceholder ? (
                                  <div
                                    style={{
                                      marginTop: 5,
                                      fontSize: 13,
                                      fontWeight: 400,
                                      color: fg,
                                      opacity: 0.95,
                                      wordBreak: 'break-word',
                                      overflowWrap: 'anywhere',
                                      whiteSpace: 'pre-wrap',
                                      lineHeight: 1.35,
                                    }}
                                  >
                                    Сообщение
                                  </div>
                                ) : null}
                                {singleReplyInnerTimeLabel ? (
                                  <div
                                    style={{
                                      marginTop: 6,
                                      fontSize: 11,
                                      fontWeight: 500,
                                      color: '#9aa0a8',
                                      textAlign: 'right',
                                      lineHeight: 1.2,
                                    }}
                                  >
                                    {singleReplyInnerTimeLabel}
                                  </div>
                                ) : null}
                              </div>
                            </div>
                          </div>
                        ) : null}
                        <>
                          <div style={{ wordBreak: 'break-word', overflowWrap: 'anywhere' }}>
                            {renderMessageText(m.content)}
                          </div>
                          {(() => {
                            const firstUrl = extractFirstPreviewableUrl(m.content)
                            if (!firstUrl) return null
                            const preview = (m as any)?.metadata?.linkPreview
                            const attemptedAt = typeof (m as any)?.metadata?.linkPreviewAttemptedAt === 'string'
                              ? (m as any).metadata.linkPreviewAttemptedAt
                              : null
                            const attemptedUrl = typeof (m as any)?.metadata?.linkPreviewUrl === 'string'
                              ? (m as any).metadata.linkPreviewUrl
                              : null
                            const attempted = !!attemptedAt && attemptedUrl === firstUrl
                            const attemptAgeMs = (() => {
                              if (!attemptedAt) return null
                              const ts = Date.parse(attemptedAt)
                              if (!Number.isFinite(ts)) return null
                              return Date.now() - ts
                            })()
                            const isProbablyInFlight = attempted && !preview && typeof attemptAgeMs === 'number' && attemptAgeMs >= 0 && attemptAgeMs < 25_000
                            // In secret chats: show only minimal (derived from URL), never fetch/render rich metadata.
                            if (activeConversation?.isSecret) {
                              return <LinkPreviewCard preview={{ url: firstUrl }} />
                            }
                            // Non-secret: rich if available, otherwise skeleton while worker fetches, then compact fallback.
                            const placeholder =
                              isProbablyInFlight
                                ? { url: firstUrl, __loading: true }
                                : attempted
                                  ? { url: firstUrl }
                                  : { url: firstUrl, __loading: true }
                            return <LinkPreviewCard preview={preview ? { ...preview, url: preview.url || firstUrl } : placeholder} />
                          })()}
                          {(() => {
                            const attachments = (m.attachments || []) as any[]
                            const imageAtts = attachments.filter((a) => a?.type === 'IMAGE')
                            const ordered: Array<
                              | { kind: 'imageGroup'; atts: any[] }
                              | { kind: 'single'; att: any; idx: number }
                            > = []

                            let addedImages = false
                            attachments.forEach((att, idx) => {
                              if (att?.type === 'IMAGE') {
                                if (!addedImages) {
                                  ordered.push({ kind: 'imageGroup', atts: imageAtts })
                                  addedImages = true
                                }
                                return
                              }
                              ordered.push({ kind: 'single', att, idx })
                            })

                            const renderImageGroup = (atts: any[]) => {
                              if (!atts.length) return null
                              if (atts.length === 1) {
                                const att = atts[0]
                                const idx = 0
                                const metadata = att.metadata ?? {}
                                const resolvedUrl = resolveAttachmentUrl(att)
                                const needsDecrypt = Boolean(activeConversation?.isSecret && metadata?.e2ee?.kind === 'ciphertext')
                                const decryptState = needsDecrypt ? attachmentDecryptMap[att.url] : undefined
                                const decryptPending = needsDecrypt && !resolvedUrl && (!decryptState || decryptState.status === 'pending')
                                const decryptError = needsDecrypt && decryptState?.status === 'error'

                                const vw = typeof window !== 'undefined' ? window.innerWidth : 1280
                                const vh = typeof window !== 'undefined' ? window.innerHeight : 800
                                const isMobile = vw <= 768
                                const maxScreen = isMobile
                                  ? Math.max(320, Math.floor(vw / 2))
                                  : Math.min(520, Math.max(320, Math.floor(vw / 3)))
                                // Hard ceiling for image height so portrait shots never grow
                                // unbounded with the bubble width.
                                const heightBudget = isMobile
                                  ? Math.min(420, Math.round(vh * 0.55))
                                  : Math.min(520, Math.round(vh * 0.6))

                                const dimKey = `${att.url || idx}`
                                const loadedDims = imageDimensions[dimKey]
                                const baseW = loadedDims?.width || att.width || att.metadata?.width || maxScreen
                                const baseH =
                                  loadedDims?.height || att.height || att.metadata?.height || Math.round(baseW * 0.75)
                                const ratio = baseH / baseW || 0.75

                                const maxWidth = maxScreen
                                let maxHeight = heightBudget
                                if (ratio < 0.5) {
                                  maxHeight = Math.max(Math.round(maxScreen * 0.6), 200)
                                } else if (ratio < 0.7) {
                                  maxHeight = Math.max(Math.round(maxScreen * 0.75), 200)
                                }
                                if (maxHeight > heightBudget) maxHeight = heightBudget

                                const scaleByWidth = baseW > maxWidth ? maxWidth / baseW : 1
                                const scaleByHeight = baseH > maxHeight ? maxHeight / baseH : 1
                                const scale = Math.min(scaleByWidth, scaleByHeight, 1)

                                let targetW = baseW * scale
                                let targetH = baseH * scale
                                if (targetW > maxWidth) {
                                  targetW = maxWidth
                                  targetH = targetW * ratio
                                }
                                if (targetH > maxHeight) {
                                  targetH = maxHeight
                                  targetW = targetH / ratio
                                }

                                targetW = Math.round(targetW)
                                targetH = Math.round(targetH)

                                const placeholderKey = `${att.url || idx}`
                                const isLoaded = !!loadedImages[placeholderKey]
                                const isFailed = !!failedImages[placeholderKey]
                                const showPending = att.__pending || decryptPending || (!isLoaded && !isFailed)

                                return (
                                  <div
                                    key={`images-single-${att.url || idx}`}
                                    style={{
                                      maxWidth: '100%',
                                      maxHeight: targetH,
                                      width: showPending
                                        ? Math.min(targetW, typeof window !== 'undefined' ? window.innerWidth - 100 : targetW)
                                        : 'fit-content',
                                      height: showPending ? targetH : 'auto',
                                      minWidth: 0,
                                      minHeight: showPending ? targetH : 0,
                                      marginTop: 8,
                                      position: 'relative',
                                      borderRadius: 10,
                                      overflow: 'hidden',
                                      display: 'inline-block',
                                      lineHeight: 0,
                                      boxSizing: 'border-box',
                                    }}
                                  >
                                    {showPending && (
                                      <div
                                        style={{
                                          position: 'absolute',
                                          inset: 0,
                                          width: '100%',
                                          height: '100%',
                                          borderRadius: 10,
                                          background: 'var(--surface-100)',
                                          border: '1px solid var(--surface-border)',
                                          display: 'flex',
                                          alignItems: 'center',
                                          justifyContent: 'center',
                                          zIndex: 1,
                                        }}
                                      >
                                        <div
                                          style={{
                                            position: 'absolute',
                                            inset: 0,
                                            background:
                                              'linear-gradient(90deg, transparent 25%, rgba(255,255,255,0.1) 37%, transparent 63%)',
                                            backgroundSize: '400% 100%',
                                            animation: 'eb-shimmer 1.2s ease-in-out infinite',
                                          }}
                                        />
                                        {decryptPending ? (
                                          <div
                                            style={{
                                              position: 'relative',
                                              zIndex: 2,
                                              display: 'flex',
                                              flexDirection: 'column',
                                              alignItems: 'center',
                                              gap: 8,
                                              color: 'var(--text-muted)',
                                              fontSize: 12,
                                            }}
                                          >
                                            Расшифровка изображения...
                                          </div>
                                        ) : typeof att.progress === 'number' && att.progress < 100 ? (
                                          <div
                                            style={{
                                              position: 'relative',
                                              zIndex: 2,
                                              display: 'flex',
                                              flexDirection: 'column',
                                              alignItems: 'center',
                                              gap: 8,
                                            }}
                                          >
                                            <div
                                              style={{
                                                width: 40,
                                                height: 40,
                                                border: '3px solid var(--surface-border)',
                                                borderTopColor: 'var(--brand)',
                                                borderRadius: '50%',
                                                animation: 'spin 1s linear infinite',
                                              }}
                                            />
                                            <div style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 500 }}>
                                              {att.progress}%
                                            </div>
                                          </div>
                                        ) : (
                                          <div
                                            style={{
                                              position: 'relative',
                                              zIndex: 2,
                                              width: 40,
                                              height: 40,
                                              border: '3px solid var(--surface-border)',
                                              borderTopColor: 'var(--brand)',
                                              borderRadius: '50%',
                                              animation: 'spin 1s linear infinite',
                                            }}
                                          />
                                        )}
                                      </div>
                                    )}
                                    {decryptError && (
                                      <div style={{ marginTop: 8, color: '#f87171', fontSize: 12 }}>
                                        Не удалось расшифровать изображение
                                      </div>
                                    )}
                                    {isFailed && !decryptError && (
                                      <div style={{ marginTop: 8, color: '#f87171', fontSize: 12 }}>
                                        Не удалось загрузить изображение
                                      </div>
                                    )}
                                    {resolvedUrl && !decryptError && (
                                      <LazyImage
                                        src={resolvedUrl}
                                        alt="img"
                                        rootRef={messagesRef as any}
                                        rootMargin="900px 0px"
                                        priority={isRecentMessage ? 'high' : 'low'}
                                        style={{
                                          maxWidth: '100%',
                                          maxHeight: targetH,
                                          width: 'auto',
                                          height: 'auto',
                                          objectFit: 'contain',
                                          borderRadius: 10,
                                          cursor: m.id?.startsWith('tmp-') ? 'default' : 'zoom-in',
                                          // Keep element in layout so IntersectionObserver can trigger loading.
                                          // We hide visually until onLoad to avoid flashing broken image icon.
                                          opacity: isLoaded ? (att.__pending ? 0.85 : 1) : 0.001,
                                          display: 'block',
                                          position: 'relative',
                                          zIndex: 0,
                                          background: 'var(--surface-100)',
                                          verticalAlign: 'top',
                                        }}
                                        onLoad={(e) => {
                                          const img = e.target as HTMLImageElement
                                          if ((!att.width && !metadata?.width) && img.naturalWidth && img.naturalHeight) {
                                            setImageDimensions((prev: any) => ({
                                              ...prev,
                                              [placeholderKey]: { width: img.naturalWidth, height: img.naturalHeight },
                                            }))
                                          }
                                          setFailedImages((prev: any) => ({ ...prev, [placeholderKey]: false }))
                                          setLoadedImages((prev: any) => ({ ...prev, [placeholderKey]: true }))
                                          if (messagesRef.current && nearBottomRef.current) {
                                            const el = messagesRef.current
                                            el.scrollTop = el.scrollHeight
                                          }
                                        }}
                                        onError={() => {
                                          setFailedImages((prev: any) => ({ ...prev, [placeholderKey]: true }))
                                          setLoadedImages((prev: any) => ({ ...prev, [placeholderKey]: true }))
                                        }}
                                        onClick={() => {
                                          if (!att.__pending && !decryptPending && resolvedUrl) {
                                            openLightbox(resolvedUrl)
                                          }
                                        }}
                                      />
                                    )}
                                    {isLoaded && !decryptPending && typeof att.progress === 'number' && att.progress < 100 && (
                                      <div
                                        style={{
                                          position: 'absolute',
                                          left: 0,
                                          right: 0,
                                          bottom: 0,
                                          height: 6,
                                          background: 'rgba(0,0,0,0.15)',
                                          borderRadius: '0 0 10px 10px',
                                          overflow: 'hidden',
                                          zIndex: 3,
                                        }}
                                      >
                                        <div style={{ width: `${att.progress}%`, height: '100%', background: 'rgba(255,255,255,0.9)' }} />
                                      </div>
                                    )}
                                  </div>
                                )
                              }

                              // Mosaic for 2+ images:
                              // We compute a layout where each tile keeps the image's own aspect ratio (h/w),
                              // so nothing is cropped for any formats. For 2/3/4+ we pick a Telegram-like arrangement,
                              // but column widths are computed from ratios to make heights match.
                              const visible = atts.slice(0, 4)
                              const extra = atts.length - visible.length
                              const getRatio = (a: any, i: number): number => {
                                const md = a?.metadata ?? {}
                                const key = `${a?.url || i}`
                                const dims = imageDimensions[key]
                                const w = dims?.width || a?.width || md?.width
                                const h = dims?.height || a?.height || md?.height
                                const r = typeof w === 'number' && typeof h === 'number' && w > 0 && h > 0 ? h / w : 1
                                // Clamp extreme cases (panoramas / very tall scans) so bubble stays sane.
                                return Math.max(0.2, Math.min(5, Number.isFinite(r) ? r : 1))
                              }

                              // Compute a maxWidth for the whole grid so that with the current
                              // per-tile aspect-ratio layout the resulting height stays within
                              // a sensible budget (no infinite portrait stretches).
                              // Formulas derived from the flex weights used below for 2 / 3 / 4 layouts:
                              //   2 tiles : H = W * (r0*r1) / (r0+r1)
                              //   3 tiles : H = W * (r0*(r1+r2)) / (r0+r1+r2)
                              //   4 tiles : H = W * ((r0+r2)*(r1+r3)) / (r0+r1+r2+r3)
                              const gridVw = typeof window !== 'undefined' ? window.innerWidth : 1280
                              const gridVh = typeof window !== 'undefined' ? window.innerHeight : 800
                              const gridIsMobile = gridVw <= 768
                              const gridMaxW = gridIsMobile
                                ? Math.max(280, Math.floor(gridVw * 0.85))
                                : Math.min(520, Math.max(320, Math.floor(gridVw / 3)))
                              const gridMaxH = gridIsMobile
                                ? Math.min(420, Math.round(gridVh * 0.55))
                                : Math.min(520, Math.round(gridVh * 0.6))

                              let gridHeightCoef = 0
                              if (visible.length === 2) {
                                const r0 = getRatio(visible[0], 0)
                                const r1 = getRatio(visible[1], 1)
                                const denom = r0 + r1
                                gridHeightCoef = denom > 0 ? (r0 * r1) / denom : 0
                              } else if (visible.length === 3) {
                                const r0 = getRatio(visible[0], 0)
                                const r1 = getRatio(visible[1], 1)
                                const r2 = getRatio(visible[2], 2)
                                const denom = r0 + r1 + r2
                                gridHeightCoef = denom > 0 ? (r0 * (r1 + r2)) / denom : 0
                              } else if (visible.length >= 4) {
                                const r0 = getRatio(visible[0], 0)
                                const r1 = getRatio(visible[1], 1)
                                const r2 = getRatio(visible[2], 2)
                                const r3 = getRatio(visible[3], 3)
                                const denom = r0 + r1 + r2 + r3
                                gridHeightCoef = denom > 0 ? ((r0 + r2) * (r1 + r3)) / denom : 0
                              }
                              const widthByHeightBudget =
                                gridHeightCoef > 0 ? Math.floor(gridMaxH / gridHeightCoef) : gridMaxW
                              const gridMaxWidth = Math.max(220, Math.min(gridMaxW, widthByHeightBudget))

                              const renderTile = (att: any, tileIdx: number, showMore: boolean) => {
                                const metadata = att.metadata ?? {}
                                const resolvedUrl = resolveAttachmentUrl(att)
                                const needsDecrypt = Boolean(activeConversation?.isSecret && metadata?.e2ee?.kind === 'ciphertext')
                                const decryptState = needsDecrypt ? attachmentDecryptMap[att.url] : undefined
                                const decryptPending = needsDecrypt && !resolvedUrl && (!decryptState || decryptState.status === 'pending')
                                const decryptError = needsDecrypt && decryptState?.status === 'error'
                                const placeholderKey = `${att.url || tileIdx}`
                                const isLoaded = !!loadedImages[placeholderKey]
                                const isFailed = !!failedImages[placeholderKey]
                                const showPending = att.__pending || decryptPending || (!isLoaded && !isFailed)
                                const disabled = att.__pending || decryptPending || decryptError || !resolvedUrl
                                const ratio = getRatio(att, tileIdx) // h/w

                                return (
                                  <button
                                    key={`${att.url || tileIdx}`}
                                    type="button"
                                    className="msg-media-tile"
                                    style={{ aspectRatio: 1 / ratio }}
                                    disabled={disabled}
                                    onClick={() => {
                                      if (!disabled && resolvedUrl) openLightbox(resolvedUrl)
                                    }}
                                  >
                                    {resolvedUrl && (
                                      <LazyImage
                                        src={resolvedUrl}
                                        alt="img"
                                        rootRef={messagesRef as any}
                                        rootMargin="900px 0px"
                                        priority={isRecentMessage ? 'high' : 'low'}
                                        style={{ opacity: isLoaded && !showPending ? 1 : 0.001 }}
                                        onLoad={(e) => {
                                          const img = e.target as HTMLImageElement
                                          if ((!att.width && !metadata?.width) && img.naturalWidth && img.naturalHeight) {
                                            setImageDimensions((prev: any) => ({
                                              ...prev,
                                              [placeholderKey]: { width: img.naturalWidth, height: img.naturalHeight },
                                            }))
                                          }
                                          setFailedImages((prev: any) => ({ ...prev, [placeholderKey]: false }))
                                          setLoadedImages((prev: any) => ({ ...prev, [placeholderKey]: true }))
                                        }}
                                        onError={() => {
                                          setFailedImages((prev: any) => ({ ...prev, [placeholderKey]: true }))
                                          setLoadedImages((prev: any) => ({ ...prev, [placeholderKey]: true }))
                                        }}
                                      />
                                    )}
                                    {showPending && (
                                      <div className="msg-media-overlay">
                                        <div className="msg-media-overlay-shimmer" />
                                        {decryptPending ? (
                                          <div style={{ position: 'relative', zIndex: 2, color: 'var(--text-muted)', fontSize: 12 }}>
                                            Расшифровка...
                                          </div>
                                        ) : typeof att.progress === 'number' && att.progress < 100 ? (
                                          <div style={{ position: 'relative', zIndex: 2, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
                                            <div style={{ width: 34, height: 34, border: '3px solid var(--surface-border)', borderTopColor: 'var(--brand)', borderRadius: '50%', animation: 'spin 1s linear infinite' }} />
                                            <div style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 500 }}>{att.progress}%</div>
                                          </div>
                                        ) : (
                                          <div style={{ position: 'relative', zIndex: 2, width: 34, height: 34, border: '3px solid var(--surface-border)', borderTopColor: 'var(--brand)', borderRadius: '50%', animation: 'spin 1s linear infinite' }} />
                                        )}
                                      </div>
                                    )}
                                    {(decryptError || isFailed) && (
                                      <div className="msg-media-overlay" style={{ background: 'rgba(15, 23, 42, 0.55)' }}>
                                        <div style={{ position: 'relative', zIndex: 2, color: '#f87171', fontSize: 12, padding: 10, textAlign: 'center' }}>
                                          {decryptError ? 'Ошибка расшифровки' : 'Ошибка загрузки'}
                                        </div>
                                      </div>
                                    )}
                                    {showMore && <div className="msg-media-more">+{extra}</div>}
                                  </button>
                                )
                              }

                              return (
                                <div
                                  key="images-mosaic"
                                  className="msg-media-grid"
                                  style={{ maxWidth: gridMaxWidth, width: '100%' }}
                                >
                                  {visible.length === 2 && (() => {
                                    const r0 = getRatio(visible[0], 0)
                                    const r1 = getRatio(visible[1], 1)
                                    // widths proportional to the opposite ratio to equalize heights
                                    const w0 = r1
                                    const w1 = r0
                                    return (
                                      <>
                                        <div style={{ flex: `${w0} 1 0`, minWidth: 0 }}>
                                          {renderTile(visible[0], 0, false)}
                                        </div>
                                        <div style={{ flex: `${w1} 1 0`, minWidth: 0 }}>
                                          {renderTile(visible[1], 1, extra > 0 && 1 === visible.length - 1)}
                                        </div>
                                      </>
                                    )
                                  })()}

                                  {visible.length === 3 && (() => {
                                    const r0 = getRatio(visible[0], 0)
                                    const r1 = getRatio(visible[1], 1)
                                    const r2 = getRatio(visible[2], 2)
                                    // left = big (0), right = stack (1,2)
                                    const wLeft = r1 + r2
                                    const wRight = r0
                                    return (
                                      <>
                                        <div style={{ flex: `${wLeft} 1 0`, minWidth: 0 }}>
                                          {renderTile(visible[0], 0, false)}
                                        </div>
                                        <div className="msg-media-col" style={{ flex: `${wRight} 1 0` }}>
                                          {renderTile(visible[1], 1, false)}
                                          {renderTile(visible[2], 2, extra > 0 && 2 === visible.length - 1)}
                                        </div>
                                      </>
                                    )
                                  })()}

                                  {visible.length >= 4 && (() => {
                                    // 2x2: (0,2) left column; (1,3) right column
                                    const r0 = getRatio(visible[0], 0)
                                    const r1 = getRatio(visible[1], 1)
                                    const r2 = getRatio(visible[2], 2)
                                    const r3 = getRatio(visible[3], 3)
                                    const wLeft = r1 + r3
                                    const wRight = r0 + r2
                                    return (
                                      <>
                                        <div className="msg-media-col" style={{ flex: `${wLeft} 1 0` }}>
                                          {renderTile(visible[0], 0, false)}
                                          {renderTile(visible[2], 2, false)}
                                        </div>
                                        <div className="msg-media-col" style={{ flex: `${wRight} 1 0` }}>
                                          {renderTile(visible[1], 1, false)}
                                          {renderTile(visible[3], 3, extra > 0)}
                                        </div>
                                      </>
                                    )
                                  })()}
                                </div>
                              )
                            }

                            return (
                              <>
                                {ordered.map((item, renderIdx) => {
                                  if (item.kind === 'imageGroup') {
                                    return <Fragment key="images-group">{renderImageGroup(item.atts)}</Fragment>
                                  }

                                  const att = item.att
                                  const idx = item.idx
                                  const metadata = att.metadata ?? {}
                                  const headInfo = attachmentHeadInfoMap[att.url]
                                  const mergedMeta = {
                                    ...metadata,
                                    ...(headInfo?.fileName ? { originalName: headInfo.fileName } : {}),
                                    ...(headInfo?.mime ? { mime: headInfo.mime } : {}),
                                    ...(headInfo?.size ? { size: headInfo.size } : {}),
                                  }
                                  const effectiveType = inferAttachmentRenderType(att, mergedMeta)
                                  const resolvedUrl = resolveAttachmentUrl(att)
                                  const needsDecrypt = Boolean(
                                    activeConversation?.isSecret && metadata?.e2ee?.kind === 'ciphertext',
                                  )
                                  const decryptState = needsDecrypt ? attachmentDecryptMap[att.url] : undefined
                                  const decryptPending =
                                    needsDecrypt && !resolvedUrl && (!decryptState || decryptState.status === 'pending')
                                  const decryptError = needsDecrypt && decryptState?.status === 'error'
                                  if (effectiveType === 'AUDIO') {
                                    const duration = m.metadata?.duration || 0
                                    const audioUrl = resolvedUrl || att.url
                                    return (
                                      <div key={`${att.url}-${idx}-${renderIdx}`} style={{ marginTop: 8, minWidth: 200, maxWidth: 300 }}>
                                        {decryptPending ? (
                                          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '12px 16px', background: 'var(--surface-100)', borderRadius: 12, border: '1px solid var(--surface-border)', color: 'var(--text-muted)' }}>
                                            <div style={{ width: 16, height: 16, border: '2px solid var(--surface-border)', borderTopColor: 'var(--brand)', borderRadius: '50%', animation: 'spin 1s linear infinite' }} />
                                            <span style={{ fontSize: 13 }}>Расшифровка аудио...</span>
                                          </div>
                                        ) : decryptError ? (
                                          <div style={{ color: '#f87171', fontSize: 12 }}>Не удалось расшифровать аудио</div>
                                        ) : audioUrl ? (
                                          <VoiceMessagePlayer url={audioUrl} duration={duration} />
                                        ) : (
                                          <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>Голосовое сообщение</div>
                                        )}
                                      </div>
                                    )
                                  }

                                  if (effectiveType === 'VIDEO') {
                                    const videoUrl = att.__pending ? null : (activeConversation?.isSecret ? resolvedUrl : (convertToProxyUrl(att.url) || resolvedUrl || att.url))
                                    const posterKey = (mergedMeta?.posterKey as string) || null
                                    const objectKey =
                                      (mergedMeta?.objectKey as string) ??
                                      (mergedMeta?.key as string) ??
                                      (mergedMeta?.storageKey as string) ??
                                      extractObjectKeyFromUrl(att.url)
                                    const w = mergedMeta?.width ?? att?.width
                                    const h = mergedMeta?.height ?? att?.height
                                    const duration = mergedMeta?.duration ?? att?.metadata?.duration
                                    const sizeText = formatAttachmentFileSize(att?.size ?? mergedMeta?.size)
                                    const uploadInProgress = !!att?.__pending
                                    return (
                                      <VideoMessageBubble
                                        key={`${att.url}-${idx}-${renderIdx}`}
                                        attachmentId={att.id || ''}
                                        objectKey={objectKey || undefined}
                                        videoSrc={videoUrl && (videoUrl.startsWith('/') || videoUrl.startsWith('http') || videoUrl.startsWith('blob:')) ? videoUrl : null}
                                        posterKey={posterKey}
                                        width={w}
                                        height={h}
                                        duration={duration}
                                        sizeText={sizeText ?? undefined}
                                        fileName={(mergedMeta?.originalName as string) || att?.metadata?.originalName || att?.url || 'video.mp4'}
                                        decryptPending={decryptPending}
                                        decryptError={decryptError}
                                        uploadInProgress={uploadInProgress}
                                        onOpenFullscreenViewer={(url, fileName) =>
                                          setVideoViewer({ open: true, url, fileName })
                                        }
                                      />
                                    )
                                  }

                                  // Секрет: только blob (E2EE). Обычный чат: всегда прокси /api/files, чтобы сервер расшифровал хранилище
                                  const fileHref = activeConversation?.isSecret
                                    ? resolvedUrl
                                    : (convertToProxyUrl(att.url) || resolvedUrl || att.url)
                                  const filePresentation = getAttachmentFilePresentation(att, mergedMeta)
                                  const baseSubtitle = filePresentation.sizeText
                                    ? `${filePresentation.description} · ${filePresentation.sizeText}`
                                    : filePresentation.description
                                  const renderFileCard = (statusText?: string) => {
                                    const subtitle = statusText
                                      ? `${baseSubtitle}${baseSubtitle ? ' · ' : ''}${statusText}`
                                      : baseSubtitle
                                    return (
                                      <div
                                        style={{
                                          display: 'inline-flex',
                                          alignItems: 'center',
                                          gap: 10,
                                          padding: '10px 12px',
                                          borderRadius: 14,
                                          border: '1px solid var(--surface-border)',
                                          background: 'var(--surface-100)',
                                          minWidth: 220,
                                          maxWidth: 360,
                                        }}
                                      >
                                        <div
                                          style={{
                                            width: 40,
                                            height: 40,
                                            borderRadius: 999,
                                            display: 'inline-flex',
                                            alignItems: 'center',
                                            justifyContent: 'center',
                                            flexShrink: 0,
                                            fontSize: 11,
                                            fontWeight: 800,
                                            letterSpacing: 0.3,
                                            textTransform: 'uppercase',
                                            background: filePresentation.ui.bg,
                                            color: filePresentation.ui.fg,
                                          }}
                                        >
                                          {filePresentation.badge}
                                        </div>
                                        <div style={{ minWidth: 0 }}>
                                          <div
                                            style={{
                                              fontSize: 14,
                                              fontWeight: 600,
                                              color: 'var(--text)',
                                              whiteSpace: 'nowrap',
                                              overflow: 'hidden',
                                              textOverflow: 'ellipsis',
                                            }}
                                            title={filePresentation.fileName}
                                          >
                                            {filePresentation.fileName}
                                          </div>
                                          <div
                                            style={{
                                              marginTop: 3,
                                              fontSize: 12,
                                              color: 'var(--text-muted)',
                                              whiteSpace: 'nowrap',
                                              overflow: 'hidden',
                                              textOverflow: 'ellipsis',
                                            }}
                                            title={subtitle}
                                          >
                                            {subtitle}
                                          </div>
                                        </div>
                                      </div>
                                    )
                                  }

                                  return (
                                    <div key={`${att.url}-${idx}-${renderIdx}`} style={{ marginTop: 8 }}>
                                      {att.__pending || decryptPending ? (
                                        renderFileCard(decryptPending ? 'Расшифровка...' : 'Загрузка...')
                                      ) : decryptError ? (
                                        <div style={{ color: '#f87171', fontSize: 12 }}>Не удалось расшифровать файл</div>
                                      ) : fileHref ? (
                                        <a
                                          href={fileHref}
                                          target="_blank"
                                          rel="noreferrer"
                                          download={filePresentation.fileName}
                                          style={{ display: 'inline-block', textDecoration: 'none', color: 'inherit' }}
                                        >
                                          {renderFileCard()}
                                        </a>
                                      ) : (
                                        renderFileCard('Расшифровка...')
                                      )}
                                      {typeof att.progress === 'number' && att.progress < 100 && (
                                        <div style={{ height: 6, background: '#e5e7eb', borderRadius: 6, overflow: 'hidden', marginTop: 6 }}>
                                          <div style={{ width: `${att.progress}%`, height: '100%', background: 'var(--brand)' }} />
                                        </div>
                                      )}
                                    </div>
                                  )
                                })}
                              </>
                            )
                          })()}
                        </>
                        {(() => {
                          if (suppressFwdComposeMetaFooter) return null
                          return (
                            <div className="msg-meta" style={{ color: isSelectedInMulti ? '#27272a' : '#9aa0a8' }}>
                              <MessageReactionRail
                                messageId={String(m.id)}
                                reactions={m.reactions}
                                currentUserId={currentUserId}
                                participants={activeConversation?.participants as any}
                                meDisplay={me}
                                isMeBubble={!!isMe}
                                leftAlignAll={leftAlignAll}
                                isMobile={isMobile}
                                isSelectedInMulti={isSelectedInMulti}
                                onInvalidateMessages={() => {
                                  if (activeId) client.invalidateQueries({ queryKey: ['messages', activeId] })
                                }}
                              />
                              {isForwardedBubble ? null : <span>{timeAndRecencyLabel}</span>}
                              {isEdited && <span style={{ fontSize: 11, opacity: 0.9 }}>изменено</span>}
                              {renderTicks({ withLeftMargin: false })}
                            </div>
                          )
                        })()}
                        {forwardedInnerTimeLabel ? (
                          <div
                            style={{
                              marginTop: 6,
                              fontSize: 11,
                              fontWeight: 500,
                              color: '#9aa0a8',
                              textAlign: 'right',
                              lineHeight: 1.2,
                            }}
                          >
                            {forwardedInnerTimeLabel}
                          </div>
                        ) : null}
                        </div>
                      </div>
                      {avatarOnRight && !forwardBundleInner && renderAvatarOrSpacer()}
                      {(leftAlignAll || isMe) && !forwardBundleInner && multiSelectCheckboxEl}
                    </div>
                  )
}
