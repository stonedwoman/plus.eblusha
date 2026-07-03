/**
 * Рендер-функция renderConversationList, вынесена из ChatsPage. Обычная функция (не компонент);
 * значения компонента получает через объект ctx.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, lazy, Suspense, Fragment, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import { api, getUploadUrl } from '../../../../utils/api'
import type { AxiosError } from 'axios'
import { socket, connectSocket, onConversationNew, onConversationDeleted, onConversationUpdated, onConversationMemberRemoved, onSecretChatAccepted, inviteCall, onIncomingCall, onCallAccepted, onCallDeclined, onCallEnded, onCallGlare, acceptCall, declineCall, endCall, onReceiptsUpdate, onPresenceUpdate, onPresenceGame, onPresenceGameSnapshot, onPresenceGameSnapshotBatch, subscribePresenceGame, helloPresenceGame, onContactRequest, onContactAccepted, onContactRejected, onContactRemoved, onProfileUpdate, onCallStatus, onCallStatusBulk, requestCallStatuses, joinConversation, joinCallRoom, leaveCallRoom, type PresenceGamePayload, type PresenceGameSnapshotBatchPayload } from '../../../../core/realtime'
import { Phone, Video, X, PlusCircle, Users, UserPlus, BellRing, Copy, UploadCloud, CheckCircle, ArrowLeft, Paperclip, PhoneOff, Trash2, Maximize2, Minus, LogOut, Lock, Unlock, MoreVertical, Mic, Send, Bold, Italic, Strikethrough, Code, Quote, Link2, Monitor, Smartphone, Tablet, ImagePlus, MessageCircle, Loader2, ChevronUp, RefreshCw, Check, Forward, Pencil } from 'lucide-react'
import { AvailabilityButton } from '../../../../features/availability/AvailabilityButton'
import { AvailabilityOverlay } from '../../../../features/availability/AvailabilityOverlay'
import { getFallbackTimeZone } from '../../../../features/availability/availability.time'
const CallOverlay = lazy(() => import('../../../components/CallOverlay').then(m => ({ default: m.CallOverlay })))
const preloadCallOverlay = () => import('../../../components/CallOverlay')
import { useAppStore } from '../../../../domain/store/appStore'
import { Avatar } from '../../../components/Avatar'
import { UserProfileCard, UserProfileHero } from '../../../components/UserProfileCard'
import { ImageEditorModal } from '../../../components/ImageEditorModal'
import { ImageLightbox } from '../../../components/ImageLightbox'
import { VideoViewer } from '../../../components/VideoViewer'
import { VideoMessageBubble } from '../../../components/VideoMessageBubble'
import { LazyImage } from '../../../components/LazyImage'
import { LinkDeviceModal } from '../../../components/LinkDeviceModal'
import LoadingSpinner from '../../../components/LoadingSpinner'
import { systemConfirm, systemToast } from '../../../../domain/store/systemUiStore'
import { useCallStore } from '../../../../domain/store/callStore'
import { ensureDeviceBootstrap, getStoredDeviceInfo, rebootstrapDevice, isElectron } from '../../../../domain/device/deviceManager'
import { wipeLocalDeviceData } from '../../../../domain/device/deviceWipe'
import { e2eeManager } from '../../../../domain/e2ee/e2eeManager'
import { hasSecretThreadKey, ensureSecretThreadKey } from '../../../../domain/secret/secretThreadKeyStore'
import { shareSecretThreadKeyToDevice } from '../../../../domain/secret/secretThreadSetup'
import { fetchSecretHistory, sendSecretThreadText, transformSecretHistoryItemToMessage } from '../../../../domain/secret/secretThreadMessaging'
import { getLastPendingShareAt, getPendingDeviceIds, getReceiptDeviceIds } from '../../../../domain/secret/secretKeyShareState'
import { isSecretEngineV2Enabled } from '../../../../domain/secretV2/featureFlag'
import { ensureReady as ensureSecretEngineReady, getThreadView as getSecretEngineThreadView, refreshKeysAndRetry, subscribeSecretThreadState, type SecretReasonCode } from '../../../../domain/secretV2'
import { ensureMediaPermissions, convertToProxyUrl, extractObjectKeyFromUrl } from '../../../../utils/media'
import { VoiceRecorder } from '../../../../utils/voiceRecorder'
import { extractFirstPreviewableUrl } from '../../../../js/link-detect'
import { renderChatMarkdownToHtml, htmlToMarkdown } from '../../../lib/chatMarkdown'
import { renderMessageText } from '../chatsTextRender'
import { openUrlSystemBrowser } from '../chatsEmbeds'
import { LinkPreviewCard } from '../components/LinkPreviewCard'
import { MessageReactionRail } from '../components/MessageReactionRail'
import { isChatsRoute, withAppRoutePrefix } from '../../../../core/navigation/routes'
import { signalApkIncomingAccepted, signalApkOutgoingStarted } from '../../../../utils/apkCallSignal'
import { shouldShowAudioUnlockPrompt } from '../../../../utils/audioUnlock'
import { copyImageFromUrl, copyPlainText } from '../../../../utils/clipboard'
import { formatRegistrationInviteCodeForDisplay } from '../../../../utils/formatRegistrationInviteCode'
import { VoiceMessagePlayer } from '../components/VoiceMessagePlayer'
import { DeviceLinkInline } from '../components/DeviceLinkInline'
import { useChatAudio } from '../hooks/useChatAudio'
import { useChatSocketSubscriptions } from '../hooks/useChatSocketSubscriptions'
import { useChatTyping } from '../hooks/useChatTyping'
import { useChatsResponsive } from '../hooks/useChatsResponsive'
import { useChatUiStore } from '../../../../core/chat-sync/chatUiStore'
import { renderActiveCallOverlay } from '../render/CallOverlayHost'
import {
  EBLO_MIN_ROWS,
  EBLO_INITIAL_ROWS,
  EBLO_OVERSCAN_PX,
  EBLO_INDEX_OVERSCAN,
  EBLO_DEFAULT_ROW_HEIGHT,
  EBLO_FORWARD_ROW_HEIGHT,
  EBLO_SYSTEM_ROW_HEIGHT,
  EbloMeasuredRow,
  type EbloRange,
  type EbloRowMeta,
} from '../chatsEblo'
import {
  acceptIncomingCallAction,
  declineIncomingCallAction,
  endActiveCallAction,
  registerActiveCallRuntime,
  registerIncomingCallRuntime,
  type ResolvedActiveCall,
  type ResolvedIncomingCall,
} from '../../../../core/call-state/incomingCallActions'
import {
  NAME_COLOR_PALETTE_13,
  NAME_COLOR_PALETTE_26,
  BUBBLE_BG_BASES,
} from '../chatsColors'
import {
  LAST_ACTIVE_CONVERSATION_KEY,
  MIN_OUTGOING_CALL_DURATION_MS,
  MAX_PENDING_IMAGES,
  MAX_PENDING_FILES,
  MESSAGES_PAGE_SIZE,
  EMPTY_EBLID_DIGITS,
} from '../chatsConstants'
import {
  FILE_KIND_UI,
  FILE_EXTENSION_INFO,
  formatAttachmentFileSize,
  VIDEO_EXTS,
  AUDIO_EXTS,
  ATTACH_PROCESSING_MESSAGES,
  formatUploadSpeed,
  isUploadAbortError,
  getMediaKind,
  inferAttachmentRenderType,
  extractFilenameFromUrl,
  resolveAttachmentFileName,
  getAttachmentFilePresentation,
  parseContentDispositionFilename,
  describeCopyableAttachment,
  type AttachmentFileKind,
  type AttachmentFileInfo,
  type PendingAttachment,
  type AttachmentDecryptionEntry,
  type AttachmentHeadInfo,
  type PendingComposerImage,
  type PendingComposerFile,
  type PendingMessage,
} from '../chatsAttachments'
import {
  formatMessageClockLabel,
  formatRuRelativeSendDay,
  ruPluralDaysAgo,
  formatSmallBubbleTimeLabel,
} from '../chatsTime'
import {
  ruPluralSoobsheniya,
  formatReplyBundleHeader,
  formatSenderReplyActionPhrase,
  formatSenderReplySingleActionPhrase,
  formatForwardSourcePhraseAfterName,
  buildMessageCopyText,
  renderSystemMessageContent,
  previewTextForReplyDraft,
  firstImageAttachmentStubForQuote,
  replySnippetIsGenericRu,
  buildReplyDraftFromMessages,
  buildReplyQuoteMetadataForSend,
  MULTI_FWD_MAX_SPAN_MS,
  MULTI_FWD_GAP_MS,
  forwardFromAuthorKeyForBundle,
  hasForwardFromMeta,
  forwardSourceFingerprintForBundle,
  computeMultiSourceForwardBundles,
  formatMultiSourceForwardBundleSourceHeader,
  parseMessageMetadata,
  parseReplyQuoteBundleEntries,
  FORWARD_COMPOSER_CAPTION_META_KEY,
  extractForwardComposerCaption,
  directChatPeerDisplayForForwardHeader,
  coerceParsedMessageInstant,
  normalizeForwardFromRecord,
  extractOriginalForwardedInstantFromMessage,
  buildForwardSourceContextForSend,
  cloneAttachmentForForward,
  recencyTimestampForConversationRow,
  buildForwardSendPayload,
  type ReplyDraftQuotedEntry,
  type ReplyDraftState,
  type ForwardComposerDraftState,
  type ForwardAttachment,
  type ForwardFromMeta,
  type ForwardSourceContext,
} from '../chatsMessages'






export interface ConversationListPaneCtx {
  activeCalls: any
  activeId: any
  avatarPresenceForUser: any
  callConvId: any
  callStore: any
  contactsQuery: any
  convHasBottomFade: any
  convHasTopFade: any
  convScrollRef: any
  conversationsQuery: any
  currentUserId: any
  effectiveUserStatus: any
  formatDuration: any
  formatPresence: any
  incomingContactsQuery: any
  isSocketOnline: any
  me: any
  meInfoQuery: any
  minimizedCallConvId: any
  myPresence: any
  openContactsOverlay: any
  openUserCard: any
  outgoingCall: any
  presenceGameByUserId: any
  selectConversation: any
  setConvMenu: any
  setMePopupOpen: any
  setNewGroupOpen: any
  typingByConversationId: any
}

export function renderConversationList(mobile: boolean, ctx: ConversationListPaneCtx) {
  const { activeCalls, activeId, avatarPresenceForUser, callConvId, callStore, contactsQuery, convHasBottomFade, convHasTopFade, convScrollRef, conversationsQuery, currentUserId, effectiveUserStatus, formatDuration, formatPresence, incomingContactsQuery, isSocketOnline, me, meInfoQuery, minimizedCallConvId, myPresence, openContactsOverlay, openUserCard, outgoingCall, presenceGameByUserId, selectConversation, setConvMenu, setMePopupOpen, setNewGroupOpen, typingByConversationId } = ctx
    const className = mobile ? 'conversations-list slider-panel' : 'conversations-list'
    return (
      <aside className={className}>
        <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'center' }}>
            <div className="logo">
              <span>Е</span>
              <span className="b">Б</span>
              <span>луша</span>
            </div>
            <div className="subtitle">Здесь мы общаемся</div>
          </div>
        </header>
        <div style={{ position: 'relative', flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <div
            ref={convScrollRef}
            className="conversations-scroll-container"
            style={{ display: 'flex', flexDirection: 'column', gap: 8, flex: 1, overflow: 'auto', paddingTop: '10px' }}
          >
          {(() => {
            const rows = (conversationsQuery.data || []) as any[]
            const visible = rows.filter((row: any) => {
              const conv = row.conversation
              if (!conv.isSecret) return true
              const status = String(conv.secretStatus ?? 'ACTIVE').toUpperCase()
              if (status === 'CANCELLED') return false
              // V2 secret threads: PENDING is visible to BOTH sides — the peer sees the invite
              // card, the creator sees the chat blocked by the "ждём подтверждения" card.
              if (String(conv.type ?? '').toUpperCase() === 'SECRET') return true
              // Legacy secret chats only show when ACTIVE.
              return status === 'ACTIVE'
            })

            const tsOf = (row: any): number => {
              // Fallback to the conversation's createdAt: a just-accepted secret thread has no
              // messages yet and would otherwise sink to the very bottom of the list.
              const t = row?.conversation?.messages?.[0]?.createdAt ?? row?.conversation?.createdAt
              return t ? new Date(t).getTime() : 0
            }

            const isGroupConv = (conv: any): boolean => !!(conv?.isGroup || (conv?.participants?.length ?? 0) > 2)

            const peerKeyOf = (conv: any): string | null => {
              try {
                if (isGroupConv(conv)) return null
                const othersArr = (conv.participants || [])
                  .filter((p: any) => (currentUserId ? p.user.id !== currentUserId : true))
                  .map((p: any) => p.user)
                const peer = othersArr[0]
                const pid = peer?.id ? String(peer.id) : ''
                return pid ? `peer:${pid}` : null
              } catch {
                return null
              }
            }

            type Group = {
              key: string
              cloud: any | null
              secret: any | null
              other: any[]
              sortTs: number
            }

            const byKey = new Map<string, Group>()
            for (const row of visible) {
              const conv = row?.conversation
              if (!conv) continue
              const peerKey = peerKeyOf(conv)
              const key = peerKey ?? `conv:${String(conv.id)}`
              const g =
                byKey.get(key) ??
                ({
                  key,
                  cloud: null,
                  secret: null,
                  other: [],
                  sortTs: 0,
                } as Group)

              const isSecretV2 = String(conv?.type ?? '').toUpperCase() === 'SECRET'
              if (peerKey && isSecretV2) g.secret = row
              else if (peerKey && !isSecretV2) g.cloud = row
              else g.other.push(row)

              g.sortTs = Math.max(g.sortTs, tsOf(row))
              byKey.set(key, g)
            }

            const groups = Array.from(byKey.values()).sort((a, b) => {
              if (b.sortTs !== a.sortTs) return b.sortTs - a.sortTs
              // Prefer groups that have a secret chat when timestamps tie.
              const as = a.secret ? 1 : 0
              const bs = b.secret ? 1 : 0
              return bs - as
            })

            const flatten: Array<{ row: any; sub: 'cloud' | 'secret' | 'other'; hasCloud?: boolean }> = []
            for (const g of groups) {
              if (g.cloud) flatten.push({ row: g.cloud, sub: 'cloud' })
              if (g.secret) flatten.push({ row: g.secret, sub: 'secret', hasCloud: !!g.cloud })
              for (const r of g.other) flatten.push({ row: r, sub: 'other' })
            }

            return flatten.map(({ row, sub, hasCloud }) => {
              const c = row.conversation
            const othersArr = c.participants
              .filter((p: any) => (currentUserId ? p.user.id !== currentUserId : true))
              .map((p: any) => p.user)
            const fallbackName = othersArr.map((u: any) => u.displayName ?? u.username).join(', ') || 'Диалог'
            const title = c.title ?? fallbackName
            const isGroup = c.isGroup || c.participants.length > 2
            const isSecret = !!c.isSecret
            const isSecretV2 = String(c?.type ?? '').toUpperCase() === 'SECRET'
            const participantsText = othersArr.map((u: any) => u.displayName ?? u.username).join(', ')
            const isActive = activeId === c.id
            const callEntry = activeCalls[c.id]
            const isCallActive = !!callEntry?.active
            const isLocalConnectedToCall =
              callConvId === c.id ||
              minimizedCallConvId === c.id ||
              (!!callEntry?.active && callStore.activeConvId === c.id)
            const isDialingThisConversation = outgoingCall?.conversationId === c.id && !callEntry?.active
            const isCallActiveByState =
              isCallActive ||
              isLocalConnectedToCall ||
              (isGroup && isDialingThisConversation)
            const isConnectedToCall = callConvId === c.id
            return (
              <div
                key={c.id}
                onContextMenu={(e) => {
                  // Desktop: open the same conversation menu as right-click.
                  // Mobile: disable long-press context menu entirely (we provide the "⋯" button instead).
                  e.preventDefault()
                  e.stopPropagation()
                  if (mobile) return
                  setConvMenu({ open: true, x: e.clientX, y: e.clientY, conversationId: c.id })
                }}
                onClick={() => selectConversation(c.id)}
                className="tile"
                style={{
                  ...(sub === 'secret'
                    ? {
                        marginTop: -6,
                        marginLeft: 14,
                        background: 'linear-gradient(135deg, rgba(34,197,94,0.07) 0%, rgba(34,197,94,0.03) 100%)',
                        borderColor: 'rgba(34,197,94,0.22)',
                      }
                    : {}),
                  ...(row.unreadCount > 0 ? { borderColor: 'var(--brand-600)', boxShadow: '0 3px 10px rgba(227,139,10,0.15)' } : {}),
                  ...(isActive ? { borderColor: 'var(--brand-600)', boxShadow: '0 4px 12px rgba(227,139,10,0.14)' } : {}),
                  ...(isCallActive
                    ? {
                        background: isConnectedToCall
                          ? 'linear-gradient(135deg, rgba(217, 119, 6, 0.15) 0%, rgba(227, 139, 10, 0.2) 100%)'
                          : 'linear-gradient(135deg, rgba(217, 119, 6, 0.10) 0%, rgba(227, 139, 10, 0.12) 100%)',
                        borderColor: 'var(--brand-600)',
                        ...(isConnectedToCall
                          ? isActive
                            ? {}
                            : { boxShadow: '0 0 0 1px rgba(227,139,10,0.22), 0 6px 16px rgba(227,139,10,0.14)' }
                          : isActive
                            ? {}
                            : { boxShadow: '0 0 0 1px rgba(227,139,10,0.16)' }),
                      }
                    : {}),
                }}
              >
                {sub === 'secret' ? (
                  <div
                    style={{
                      width: 44,
                      height: 44,
                      borderRadius: 999,
                      background: 'rgba(34,197,94,0.12)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      flex: '0 0 auto',
                    }}
                  >
                    <Lock size={20} color="#22c55e" />
                  </div>
                ) : isGroup ? (
                  (() => {
                    return (
                      <Avatar 
                        name={title?.trim()?.charAt(0) || 'Г'} 
                        id={c.id} 
                        avatarUrl={c.avatarUrl && c.avatarUrl.trim() ? c.avatarUrl : undefined}
                        presence={isCallActive ? 'IN_CALL' : undefined}
                        inCall={isCallActiveByState}
                      />
                    )
                  })()
                ) : (
                  (() => {
                    const peerUser = othersArr[0]
                    const peerInCallByPresence = peerUser ? effectiveUserStatus(peerUser) === 'IN_CALL' : false
                    // For 1:1 the avatar represents the PEER, so the red dot must reflect the peer's
                    // real presence (server-authoritative IN_CALL), not our local dialing/optimistic state.
                    // Otherwise simply opening "звонок" UI would paint the peer red while we're only ringing.
                    return (
                      <Avatar
                        name={peerUser?.displayName ?? peerUser?.username ?? 'D'}
                        id={peerUser?.id ?? c.id}
                        presence={avatarPresenceForUser(peerUser)}
                        inCall={peerInCallByPresence}
                        avatarUrl={peerUser?.avatarUrl && peerUser.avatarUrl.trim() ? peerUser.avatarUrl : undefined}
                        onClick={peerUser?.id ? () => openUserCard(peerUser) : undefined}
                      />
                    )
                  })()
                )}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span>{sub === 'secret' ? (hasCloud ? 'СЕКРЕТНЫЙ ЧАТ' : `СЕКРЕТНЫЙ ЧАТ · ${title}`) : title}</span>
                    {!isGroup && isSecret && !isSecretV2 && (
                      <span
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          width: 18,
                          height: 18,
                          borderRadius: 999,
                          background: 'rgba(34,197,94,0.12)',
                        }}
                      >
                        <Lock size={12} color="#22c55e" />
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: 12, color: row.unreadCount > 0 ? 'var(--brand-600)' : 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 6 }}>
                    {(() => {
                            // Secret tile: lock + caps label only — no status line at all.
                            if (sub === 'secret') return null
                            const typingIds = typingByConversationId[c.id] ? Object.keys(typingByConversationId[c.id]).filter((uid) => uid !== me?.id) : []
                            const typingCount = typingIds.length
                            if (typingCount > 0) {
                              return (
                                <span className="chat-list-typing" style={isActive ? { opacity: 0.85 } : undefined}>
                                  {typingCount === 1 ? 'печатает' : 'печатают'}
                                  <span className="chat-typing-bubble chat-typing-bubble--list" aria-hidden>
                                    <span className="chat-typing-bubble__dot" />
                                    <span className="chat-typing-bubble__dot" />
                                    <span className="chat-typing-bubble__dot" />
                                  </span>
                                </span>
                              )
                            }
                            if (row.unreadCount > 0) return `${row.unreadCount} непрочитанных`
                            return (() => {
                            const entry = activeCalls[c.id]
                            const peer = othersArr[0]
                            const uid = typeof peer?.id === 'string' ? peer.id : null
                            const g = uid ? presenceGameByUserId[uid]?.game : undefined
                            const base = peer ? effectiveUserStatus(peer) : 'OFFLINE'
                            const gameSuffix = g?.name ? ` И В ${g.name}` : ''

                            // Call may be active in this conversation, but duration should be shown
                            // ONLY to actual call participants (confidential).
                            const myId = me?.id
                            const isParticipantByServer =
                              !!(myId && entry?.active && Array.isArray(entry.participants) && entry.participants.includes(myId))
                            const isParticipantByLocalState =
                              callConvId === c.id ||
                              minimizedCallConvId === c.id ||
                              (!!entry?.active && callStore.activeConvId === c.id)
                            const isParticipant = isParticipantByServer || isParticipantByLocalState
                            const isCallOngoing = !!entry?.active || isParticipant

                            if (isDialingThisConversation && !isCallOngoing) {
                              return <span>Звоним...</span>
                            }

                            if (isParticipant) {
                              // Use startedAt from entry or outgoingCall as a fallback.
                              const startedAt =
                                (typeof entry?.startedAt === 'number' && entry.startedAt > 0)
                                  ? entry.startedAt
                                  : null
                              const elapsedMs = startedAt ? (Date.now() - startedAt) : (typeof entry?.elapsedMs === 'number' ? entry.elapsedMs : 0)
                              return <span>В ЗВОНКЕ: {formatDuration(elapsedMs)}{gameSuffix}</span>
                            }

                            if (isCallOngoing) {
                              // Not a participant: do NOT show duration.
                              if (g?.name) return <span>В ЗВОНКЕ{gameSuffix}</span>
                              return <span>В ЗВОНКЕ</span>
                            }

                            if (entry && entry.endedAt) {
                            // Звонок завершен
                            const endedAt = entry.endedAt
                            const now = Date.now()
                            const diffMs = now - endedAt
                            const diffMin = Math.floor(diffMs / 60000)
                            if (diffMin < 1) return <span>Завершён только что</span>
                            if (diffMin < 60) return <span>Завершён {diffMin} мин назад</span>
                            const diffH = Math.floor(diffMin / 60)
                            if (diffH < 24) return <span>Завершён {diffH} ч назад</span>
                            const endedDate = new Date(endedAt)
                            const dateStr = endedDate.toLocaleDateString()
                            const timeStr = endedDate.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', hour12: false })
                            return <span>Завершён {dateStr} в {timeStr}</span>
                            }
                          // Для групповых бесед показываем null, для личных - статус
                          return isGroup ? null : formatPresence(othersArr[0] ?? {})
                        })()
                            })()}
                  </div>
                </div>
                {mobile && (
                  <button
                    type="button"
                    aria-label="Меню беседы"
                    title="Меню"
                    onClick={(e) => {
                      e.preventDefault()
                      e.stopPropagation()
                      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
                      setConvMenu({
                        open: true,
                        x: Math.round(rect.right - 8),
                        y: Math.round(rect.bottom + 6),
                        conversationId: c.id,
                      })
                    }}
                    style={{
                      flexShrink: 0,
                      width: 36,
                      height: 36,
                      borderRadius: 10,
                      border: '1px solid transparent',
                      background: 'transparent',
                      color: 'var(--text-muted)',
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      marginLeft: 8,
                      WebkitTapHighlightColor: 'transparent',
                    }}
                  >
                    <MoreVertical size={20} />
                  </button>
                )}
              </div>
            )
            })
          })()}
          </div>
          {convHasTopFade && (
            <div
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                right: 0,
                height: '24px',
                background: 'linear-gradient(to bottom, var(--surface-200) 0%, rgba(35, 39, 49, 0) 100%)',
                pointerEvents: 'none',
                zIndex: 10,
              }}
            />
          )}
          {convHasBottomFade && (
            <div
              style={{
                position: 'absolute',
                bottom: 0,
                left: 0,
                right: 0,
                height: '24px',
                background: 'linear-gradient(to top, var(--surface-200) 0%, rgba(35, 39, 49, 0) 100%)',
                pointerEvents: 'none',
                zIndex: 10,
              }}
            />
          )}
        </div>
        <div className="conv-footer">
          <div style={{ borderTop: '1px solid var(--surface-border)', marginTop: 8, marginBottom: 8 }} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ display: 'flex', gap: 12 }}>
              <div onClick={() => setNewGroupOpen(true)} className="tile" style={{ marginTop: 0, flex: 1 }}>
            <div style={{ width: 40, height: 40, borderRadius: '50%', background: '#10b981', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <PlusCircle size={22} />
            </div>
            <div>
                  <div style={{ fontWeight: 600 }}>Беседа</div>
                  <div style={{ fontSize: 12, color: '#6b7280' }}>Групповой разговор</div>
            </div>
          </div>
              <div onClick={openContactsOverlay} className="tile" style={{ marginTop: 0, flex: 1 }}>
            <div style={{ width: 40, height: 40, borderRadius: '50%', background: '#6366f1', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              {incomingContactsQuery.data && incomingContactsQuery.data.length > 0 ? (
                <BellRing size={22} />
              ) : (contactsQuery.data && contactsQuery.data.length > 0 ? <Users size={22} /> : <UserPlus size={22} />)}
            </div>
            <div>
              <div style={{ fontWeight: 600 }}>Контакты</div>
              <div style={{ fontSize: 12, color: '#6b7280' }}>
                {incomingContactsQuery.data && incomingContactsQuery.data.length > 0
                  ? 'Новый запрос в друзья'
                  : (contactsQuery.data && contactsQuery.data.length > 0 ? 'Список контактов' : 'Добавить контакт')}
              </div>
            </div>
          </div>
            </div>
            <div className="tile" onClick={() => setMePopupOpen(true)} style={{ cursor: 'pointer', marginTop: 0 }}>
            {(() => {
              // Force red presence while we are participating in ANY call type (1:1 or group),
              // even if server presence lags behind.
              const isMeInAnyCall = (() => {
                const myId = me?.id
                if (outgoingCall?.conversationId) return true
                if (callConvId) return true
                if (minimizedCallConvId) return true
                if (callStore.activeConvId) return true
                if (myId) {
                  try {
                    for (const entry of Object.values<any>(activeCalls || {})) {
                      if (entry?.active && Array.isArray(entry.participants) && entry.participants.includes(myId)) {
                        return true
                      }
                    }
                  } catch {
                    // ignore
                  }
                }
                return false
              })()

              const directStatus = isMeInAnyCall ? 'IN_CALL' : (myPresence ?? (meInfoQuery.data as any)?.status)
              // Socket connection alone means "connected/online", but NOT necessarily "active/in-focus".
              // Until we receive a presence:update derived from presence:state, treat connected as "BACKGROUND".
              const fallbackStatus = isSocketOnline ? 'BACKGROUND' : 'OFFLINE'
              const normalized = (directStatus ?? fallbackStatus ?? 'OFFLINE').toString().toUpperCase()
              const allowedPresence = ['ONLINE', 'AWAY', 'BACKGROUND', 'IN_CALL', 'OFFLINE'] as const
              type KnownPresence = (typeof allowedPresence)[number]
              const normalizedPresence = normalized as KnownPresence
              const fallbackPresence = fallbackStatus as KnownPresence
              const presenceValue: KnownPresence = allowedPresence.includes(normalizedPresence) ? normalizedPresence : fallbackPresence
              const myId = me?.id
              const myGame = myId ? presenceGameByUserId[myId]?.game : undefined
              const presenceWithGame: any =
                myGame?.name && (presenceValue === 'ONLINE' || presenceValue === 'BACKGROUND' || presenceValue === 'IN_CALL')
                  ? 'PLAYING'
                  : presenceValue
              const avatarUrl = (meInfoQuery.data as any)?.avatarUrl ?? me?.avatarUrl ?? undefined
              return (
                <Avatar
                  name={me?.displayName ?? me?.username ?? 'Me'}
                  id={me?.id ?? 'me'}
                  presence={presenceWithGame}
                  inCall={isMeInAnyCall}
                  avatarUrl={avatarUrl}
                />
              )
            })()}
            <div>
              <div style={{ fontWeight: 700 }}>{me?.displayName ?? me?.username ?? 'Я'}</div>
              {(() => {
                const myId = me?.id
                const g = myId ? presenceGameByUserId[myId]?.game : undefined
                if (g?.name) {
                  return (
                    <div style={{ fontSize: 12, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span>Играю в {g.name}</span>
                    </div>
                  )
                }
                return <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>EBLID: {meInfoQuery.data?.eblid ?? '— — — —'}</div>
              })()}
              </div>
            </div>
          </div>
        </div>
      </aside>
    )
}
