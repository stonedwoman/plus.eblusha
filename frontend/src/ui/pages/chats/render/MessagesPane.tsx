/**
 * Рендер-функция renderMessagesPane, вынесена из ChatsPage. Обычная функция (не компонент);
 * значения компонента получает через объект ctx.
 */

import { lazy, Fragment, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { MessageListFlat } from './MessageListFlat'

// Стабильные (модульные) пропы Virtuoso. КРИТИЧНО: объектные пропы нельзя создавать
// заново на каждый рендер — Virtuoso сравнивает по ссылке, считает их изменившимися,
// пересчитывает вьюпорт и может уйти в бесконечный ре-рендер (фриз). Поэтому
// components/style/overscan — константы модуля.
const VIRTUOSO_COMPONENTS = { Footer: () => <div style={{ height: 12 }} /> }
const VIRTUOSO_STYLE = { flex: 1, minHeight: 0 } as const
const VIRTUOSO_OVERSCAN = 1200

import { api } from '../../../../utils/api'
import type { AxiosError } from 'axios'
import { inviteCall, endCall, joinCallRoom } from '../../../../core/realtime'
import { Phone, Video, X, UploadCloud, ArrowLeft, Paperclip, PhoneOff, Maximize2, Minus, MoreVertical, Mic, Send, Quote, Loader2, Check, Forward } from 'lucide-react'
import { AvailabilityButton } from '../../../../features/availability/AvailabilityButton'
import { AvailabilityOverlay } from '../../../../features/availability/AvailabilityOverlay'
import { getFallbackTimeZone } from '../../../../features/availability/availability.time'
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
import { systemConfirm, systemToast } from '../../../../domain/store/systemUiStore'

import { e2eeManager } from '../../../../domain/e2ee/e2eeManager'

import { ensureReady as ensureSecretEngineReady, refreshKeysAndRetry } from '../../../../domain/secretV2'

import { renderMessageText } from '../chatsTextRender'
import { openUrlSystemBrowser } from '../chatsEmbeds'
import { LinkPreviewCard } from '../components/LinkPreviewCard'
import { MessageReactionRail } from '../components/MessageReactionRail'

import { signalApkOutgoingStarted } from '../../../../utils/apkCallSignal'

import { VoiceMessagePlayer } from '../components/VoiceMessagePlayer'
import { DeviceLinkInline } from '../components/DeviceLinkInline'
import { useChatAudio } from '../hooks/useChatAudio'
import { useChatSocketSubscriptions } from '../hooks/useChatSocketSubscriptions'
import { useChatTyping } from '../hooks/useChatTyping'
import { useChatsResponsive } from '../hooks/useChatsResponsive'

import { acceptIncomingCallAction, declineIncomingCallAction, endActiveCallAction } from '../../../../core/call-state/incomingCallActions'

import { formatAttachmentFileSize, ATTACH_PROCESSING_MESSAGES } from '../chatsAttachments'
import { formatMessageClockLabel, formatRuRelativeSendDay } from '../chatsTime'
import { formatReplyBundleHeader, formatForwardSourcePhraseAfterName, renderSystemMessageContent, previewTextForReplyDraft, replySnippetIsGenericRu, buildReplyDraftFromMessages, buildReplyQuoteMetadataForSend, hasForwardFromMeta, computeMultiSourceForwardBundles, extractForwardComposerCaption, parseReplyQuoteBundleEntries } from '../chatsMessages'

import { renderChatMessageAtIndex as extractedRenderChatMessageAtIndex } from './ChatMessageRow'

export interface MessagesPaneCtx {
  acceptSecretInvite: any
  activeCalls: any
  activeConversation: any
  activeId: any
  activePendingMessages: any
  activeSecretQueuedCount: any
  activeSecretUiState: any
  addComposerFile: any
  addComposerImage: any
  applyComposerImageEdit: any
  applyComposerSelectionFormat: any
  applyWysiwygFormat: any
  attachCanceling: any
  attachDragDepthRef: any
  attachDragOver: any
  attachInputRef: any
  attachProcessingMessageIndex: any
  attachProgress: any
  attachUploadSpeed: any
  attachUploadState: any
  attachUploading: any
  attachmentDecryptMap: any
  attachmentHeadInfoMap: any
  avatarPresenceForUser: any
  backToList: any
  beginOutgoingCallGuard: any
  callConvId: any
  callPermissionError: any
  callStore: any
  cancelActiveAttachUpload: any
  cancelEdit: any
  cancelSecretInviteAsCreator: any
  cancelVoiceRecording: any
  clearMessageMultiSelect: any
  client: any
  closeComposerSelectionToolbar: any
  composerBarRef: any
  composerEditorRef: any
  composerEmpty: any
  composerFocused: any
  composerSelectionAnchor: any
  composerSelectionFmt: any
  composerSelectionToolbarRef: any
  composerSelectionToolbarStyle: any
  contactsQuery: any
  conversationsQuery: any
  creatorAwaitPeerAccept: any
  currentUserId: any
  declineSecretInvite: any
  deviceLinkInviteOpen: any
  displayedMessages: any
  editBusy: any
  editState: any
  editingImage: any
  editingImageId: any
  effectiveUserStatus: any
  endSecretModalOpen: any
  eventHasFiles: any
  executeForwardPayloadDelivery: any
  failedImages: any
  formatDuration: any
  formatPresence: any
  forwardComposerDraft: any
  getComposerValue: any
  getSelectedMessagesOrdered: any
  groupIncomingBubbleBg: any
  handleChatDropFiles: any
  hasAnySecretThreadKeys: any
  hasOtherTrustedDevice: any
  hashToGray: any
  insertPlainTextIntoComposer: any
  isMobile: any
  isNarrowHeaderButtons: any
  leftAlignAll: any
  loadedImages: any
  me: any
  messagesContentRef: any
  messagesRef: any
  virtuosoRef: any
  virtuosoBaseRef: any
  virtuosoRowsRef: any
  loadOlderMessages: any
  minimizedCallConvId: any
  multiSelectMode: any
  nameColorForUser: any
  nearBottomRef: any
  nodesByMessageId: any
  notifyTyping: any
  olderLoading: any
  openUserCard: any
  outgoingCall: any
  outgoingCallTimerRef: any
  pendingFiles: any
  pendingImages: any
  playEndCallSound: any
  presenceGameByUserId: any
  releasePreviewUrl: any
  removeComposerFile: any
  removeComposerImage: any
  replyTo: any
  requireMediaAccess: any
  resizeComposer: any
  resolveAttachmentUrl: any
  resolveFirstImageAttachmentUrl: any
  secretBootDonePulse: any
  secretComposerInlineError: any
  secretEngineV2Enabled: any
  secretInviteBusy: any
  secretInviteForMe: any
  secretWaitingAsCreator: any
  selectedMessageIds: any
  sendMessageToConversation: any
  setActiveCalls: any
  setActiveId: any
  setAttachDragOver: any
  setAvailabilityContext: any
  setCallConvId: any
  setCallPermissionError: any
  setComposerEmpty: any
  setComposerFocused: any
  setComposerValue: any
  setContextMenu: any
  setDeviceLinkInviteOpen: any
  setEditBusy: any
  setEditState: any
  setEditingImageId: any
  setEndSecretModalOpen: any
  setFailedImages: any
  setForwardComposerDraft: any
  setForwardModal: any
  setGroupAvatarEditor: any
  setHeaderMenu: any
  setLightbox: any
  setLinkDeviceModalOpen: any
  setLoadedImages: any
  setMinimizedCallConvId: any
  setOutgoingCall: any
  setPendingFiles: any
  setPendingImages: any
  setReplyTo: any
  setShowJump: any
  setVideoViewer: any
  showJump: any
  startDialingSound: any
  startEdit: any
  startVoiceRecording: any
  stopDialingSound: any
  stopTyping: any
  stopVoiceRecording: any
  toggleMessageMultiSelect: any
  typingByUserId: any
  updateComposerSelectionToolbar: any
  uploadAndSendAttachments: any
  userStickyScrollRef: any
  usersById: any
  visibleObserver: any
  voiceDuration: any
  voiceRecording: any
  voiceWaveform: any
  waveformContainerRef: any
  waveformMaxBars: any
}

// Кэш отсортированного списка сообщений по ССЫЛКЕ displayedMessages. react-query держит
// ссылку стабильной, пока данные не изменились, поэтому дорогая фильтрация+сортировка (с
// парсингом дат по всему списку) не повторяется на каждый ре-рендер (скролл/тайпинг/etc),
// а только при реальном изменении данных. Снимает заметный кост на больших чатах.
let _sortedMsgsSrc: unknown = null
let _sortedMsgsRes: any[] = []
const _ts = (m: any): number => new Date(m?.createdAt || 0).getTime()
function sortedActiveMessages(displayedMessages: any): any[] {
  if (displayedMessages === _sortedMsgsSrc) return _sortedMsgsRes
  const filtered = (Array.isArray(displayedMessages) ? displayedMessages : []).filter((m: any) => !m?.deletedAt)
  // Кэш почти всегда УЖЕ отсортирован (merge старых / append новых держат порядок).
  // Дешёвая O(M)-проверка «уже ли отсортирован» вместо безусловной O(M·log M) сортировки:
  // при вставке страницы это снимает главную фикс-цену. Сортируем ТОЛЬКО если реально надо.
  let ordered = true
  for (let i = 1; i < filtered.length; i++) {
    if (_ts(filtered[i - 1]) > _ts(filtered[i])) { ordered = false; break }
  }
  const res = ordered ? filtered : [...filtered].sort((a: any, b: any) => _ts(a) - _ts(b))
  _sortedMsgsSrc = displayedMessages
  _sortedMsgsRes = res
  return res
}

export function renderMessagesPane(mobile: boolean, ctx: MessagesPaneCtx) {
  const { acceptSecretInvite, activeCalls, activeConversation, activeId, activePendingMessages, activeSecretQueuedCount, activeSecretUiState, addComposerFile, addComposerImage, applyComposerImageEdit, applyComposerSelectionFormat, applyWysiwygFormat, attachCanceling, attachDragDepthRef, attachDragOver, attachInputRef, attachProcessingMessageIndex, attachProgress, attachUploadSpeed, attachUploadState, attachUploading, attachmentDecryptMap, attachmentHeadInfoMap, avatarPresenceForUser, backToList, beginOutgoingCallGuard, callConvId, callPermissionError, callStore, cancelActiveAttachUpload, cancelEdit, cancelSecretInviteAsCreator, cancelVoiceRecording, clearMessageMultiSelect, client, closeComposerSelectionToolbar, composerBarRef, composerEditorRef, composerEmpty, composerFocused, composerSelectionAnchor, composerSelectionFmt, composerSelectionToolbarRef, composerSelectionToolbarStyle, contactsQuery, conversationsQuery, creatorAwaitPeerAccept, currentUserId, declineSecretInvite, deviceLinkInviteOpen, displayedMessages, editBusy, editState, editingImage, editingImageId, effectiveUserStatus, endSecretModalOpen, eventHasFiles, executeForwardPayloadDelivery, failedImages, formatDuration, formatPresence, forwardComposerDraft, getComposerValue, getSelectedMessagesOrdered, groupIncomingBubbleBg, handleChatDropFiles, hasAnySecretThreadKeys, hasOtherTrustedDevice, hashToGray, insertPlainTextIntoComposer, isMobile, isNarrowHeaderButtons, leftAlignAll, loadedImages, loadOlderMessages, me, messagesContentRef, messagesRef, virtuosoRef, virtuosoBaseRef, virtuosoRowsRef, minimizedCallConvId, multiSelectMode, nameColorForUser, nearBottomRef, nodesByMessageId, notifyTyping, olderLoading, openUserCard, outgoingCall, outgoingCallTimerRef, pendingFiles, pendingImages, playEndCallSound, presenceGameByUserId, releasePreviewUrl, removeComposerFile, removeComposerImage, replyTo, requireMediaAccess, resizeComposer, resolveAttachmentUrl, resolveFirstImageAttachmentUrl, secretBootDonePulse, secretComposerInlineError, secretEngineV2Enabled, secretInviteBusy, secretInviteForMe, secretWaitingAsCreator, selectedMessageIds, sendMessageToConversation, setActiveCalls, setActiveId, setAttachDragOver, setAvailabilityContext, setCallConvId, setCallPermissionError, setComposerEmpty, setComposerFocused, setComposerValue, setContextMenu, setDeviceLinkInviteOpen, setEditBusy, setEditState, setEditingImageId, setEndSecretModalOpen, setFailedImages, setForwardComposerDraft, setForwardModal, setGroupAvatarEditor, setHeaderMenu, setLightbox, setLinkDeviceModalOpen, setLoadedImages, setMinimizedCallConvId, setOutgoingCall, setPendingFiles, setPendingImages, setReplyTo, setShowJump, setVideoViewer, showJump, startDialingSound, startEdit, startVoiceRecording, stopDialingSound, stopTyping, stopVoiceRecording, toggleMessageMultiSelect, typingByUserId, updateComposerSelectionToolbar, uploadAndSendAttachments, userStickyScrollRef, usersById, visibleObserver, voiceDuration, voiceRecording, voiceWaveform, waveformContainerRef, waveformMaxBars } = ctx
    const sectionClass = mobile ? 'messages-pane slider-panel' : 'messages-pane'
    return (
      <section className={sectionClass}>
        <header
          style={{
            ...(() => {
              if (!activeId) return {}
              const callEntry = activeCalls[activeId]
              const isActive = callEntry?.active
              const isMinimized = minimizedCallConvId === activeId
              // Подсвечиваем шапку если звонок активен ИЛИ минимизирован (для всех типов звонков)
              if (isActive || isMinimized) {
                return {
                  background: 'linear-gradient(135deg, rgba(217, 119, 6, 0.15) 0%, rgba(227, 139, 10, 0.2) 100%)',
                  borderBottom: '2px solid var(--brand)',
                }
              }
              return {}
            })(),
            display: isMobile ? 'flex' : 'grid',
            // True centering: equal side columns so the image stays centered.
            gridTemplateColumns: isMobile ? undefined : 'minmax(0, 1fr) auto minmax(0, 1fr)',
            // Match spacing between call control buttons (gap: 8)
            columnGap: isMobile ? undefined : 8,
            flexDirection: isMobile ? 'column' : undefined,
            justifyContent: isMobile ? 'flex-start' : undefined,
            justifyItems: isMobile ? undefined : 'stretch',
            alignItems: isMobile ? 'stretch' : 'center',
            flexShrink: 0,
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              minWidth: 0,
              width: isMobile ? '100%' : 'auto',
              padding: isMobile ? '0 8px' : '0',
              gridColumn: isMobile ? undefined : '1 / 2',
            }}
          >
            {mobile && (
              <button type="button" className="btn btn-icon btn-ghost" onClick={backToList}>
                <ArrowLeft size={18} />
              </button>
            )}
            {activeConversation ? (
              (() => {
                const othersArr = activeConversation.participants.filter((p: any) => (currentUserId ? p.user.id !== currentUserId : true)).map((p: any) => p.user)
                const fallbackName = othersArr.map((u: any) => u.displayName ?? u.username).join(', ') || 'Диалог'
                const title = activeConversation.title ?? fallbackName
                const isGroup = activeConversation.isGroup || activeConversation.participants.length > 2
                const isSecret = !!activeConversation.isSecret && !isGroup
                const callEntry = activeCalls[activeConversation.id]
                const isActive = callEntry?.active
                return isGroup ? (
                  <>
                    <div onClick={() => setGroupAvatarEditor(true)} style={{ cursor: 'pointer' }}>
                      <Avatar 
                        name={title?.trim()?.charAt(0) || 'Г'} 
                        id={activeConversation.id} 
                        size={60} 
                        avatarUrl={activeConversation.avatarUrl && activeConversation.avatarUrl.trim() ? activeConversation.avatarUrl : undefined}
                        presence={isActive ? 'IN_CALL' : undefined}
                        inCall={!!isActive}
                      />
                    </div>
                    <div style={{ flex: 1, minWidth: 0, order: isMobile ? 1 : 2 }}>
                      <div style={{ fontWeight: 700, display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'space-between' }}>
                        <span onClick={() => setGroupAvatarEditor(true)} style={{ cursor: 'pointer' }} title="Настройки группы">{title}</span>
                        {isMobile && (
                          <button
                            className="btn btn-icon btn-ghost"
                            title="Меню"
                            onClick={(e) => {
                              setHeaderMenu({ open: true, anchor: e.currentTarget })
                            }}
                            style={{
                              display: 'inline-flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              width: 42,
                              height: 42,
                              minWidth: 42,
                              padding: 0,
                              margin: 0,
                              borderRadius: 999,
                              flexShrink: 0,
                            }}
                          >
                            <MoreVertical size={20} />
                          </button>
                        )}
                      </div>
                      <div style={{ fontSize: 12, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                        {isActive ? (
                          <>
                            {(() => {
                              const participants = callEntry.participants || []
                              const allParticipants = activeConversation.participants || []
                              // Используем elapsedMs с сервера и добавляем локальный тик для плавного обновления между событиями
                              // Re-render each second via timerTick, compute from startedAt to avoid double counting
                              const elapsedMs = callEntry.startedAt ? (Date.now() - callEntry.startedAt) : (typeof callEntry.elapsedMs === 'number' ? callEntry.elapsedMs : 0)
                              const autoEndRemainingMs =
                                typeof callEntry.autoEndAt === 'number'
                                  ? Math.max(0, callEntry.autoEndAt - Date.now())
                                  : null
                              return (
                                <>
                                  {callEntry.active && <span>{formatDuration(elapsedMs)}</span>}
                                  {participants.length === 1 && autoEndRemainingMs != null && (
                                    <span> • один участник, автоотключение через {formatDuration(autoEndRemainingMs)}</span>
                                  )}
                                  {allParticipants.length > 0 && (
                                    <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                                      {callEntry.startedAt && ' • '}
                                      {allParticipants.map((p: any, idx: number) => {
                                        const u = p.user
                                        const isInCall = participants.length > 0 && participants.includes(u.id)
                                        return (
                                          <span key={u.id} style={{ fontWeight: isInCall ? 700 : 400, color: isInCall ? 'var(--brand-600)' : 'var(--text-muted)' }}>
                                            {idx > 0 && ', '}
                                            {u.displayName ?? u.username}
                                            {isInCall && ' ✓'}
                                          </span>
                                        )
                                      })}
                                    </span>
                                  )}
                                </>
                              )
                            })()}
                          </>
                        ) : callEntry && callEntry.endedAt ? (
                          (() => {
                            // Звонок завершен
                            const endedAt = callEntry.endedAt
                            const now = Date.now()
                            const diffMs = now - endedAt
                            const diffMin = Math.floor(diffMs / 60000)
                            let timeText = ''
                            if (diffMin < 1) timeText = 'Завершён только что'
                            else if (diffMin < 60) timeText = `Завершён ${diffMin} мин назад`
                            else {
                              const diffH = Math.floor(diffMin / 60)
                              if (diffH < 24) timeText = `Завершён ${diffH} ч назад`
                              else {
                                const endedDate = new Date(endedAt)
                                const dateStr = endedDate.toLocaleDateString()
                                const timeStr = endedDate.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', hour12: false })
                                timeText = `Завершён ${dateStr} в ${timeStr}`
                              }
                            }
                            const allParticipants = activeConversation.participants || []
                            return (
                              <>
                                <span>{timeText}</span>
                                {allParticipants.length > 0 && (
                                  <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                                    {' • '}
                                    {allParticipants.map((p: any, idx: number) => {
                                      const u = p.user
                                      return (
                                        <span key={u.id}>
                                          {idx > 0 && ', '}
                                          {u.displayName ?? u.username}
                                        </span>
                                      )
                                    })}
                                  </span>
                                )}
                              </>
                            )
                          })()
                        ) : (
                          <span style={{ display: 'inline' }}>
                            {othersArr.map((u: any, i: number) => (
                              <Fragment key={u.id}>
                                {i > 0 && ', '}
                                <span className="eb-member-chip" onClick={(e) => { e.stopPropagation(); openUserCard(u) }}>
                                  <span className="eb-member-ava">
                                    <Avatar name={u.displayName ?? 'U'} id={u.id} size={18} avatarUrl={u.avatarUrl && u.avatarUrl.trim() ? u.avatarUrl : undefined} />
                                  </span>
                                  {u.displayName ?? u.username}
                                </span>
                              </Fragment>
                            ))}
                          </span>
                        )}
                      </div>
                    </div>
                  </>
                ) : (
                  (() => {
                    const peer: any = othersArr[0]
                    return (
                      <div style={{ display: 'flex', alignItems: 'center', width: '100%' }}>
                        <div style={{ marginRight: 10 }}>
                          <Avatar
                            name={peer?.displayName ?? peer?.username ?? 'D'}
                            id={peer?.id ?? activeConversation.id}
                            avatarUrl={peer?.avatarUrl && peer.avatarUrl.trim() ? peer.avatarUrl : undefined}
                            onClick={peer?.id ? () => openUserCard(peer) : undefined}
                            presence={avatarPresenceForUser(peer)}
                            // 1:1 conversation header: red dot must mean the peer is actually in a call.
                            // Local dialing / optimistic activeCalls / minimized overlay are our own state
                            // and must not paint the peer as IN_CALL during a failed dial-out.
                            inCall={effectiveUserStatus(peer) === 'IN_CALL'}
                            size={60}
                          />
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 700, display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'space-between' }}>
                          <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</span>
                            {isMobile && (
                              <button
                                className="btn btn-icon btn-ghost"
                                title="Меню"
                                onClick={(e) => {
                                  setHeaderMenu({ open: true, anchor: e.currentTarget })
                                }}
                                style={{
                                  display: 'inline-flex',
                                  alignItems: 'center',
                                  justifyContent: 'center',
                                  width: 42,
                                  height: 42,
                                  minWidth: 42,
                                  padding: 0,
                                  margin: 0,
                                  borderRadius: 999,
                                  flexShrink: 0,
                                }}
                              >
                                <MoreVertical size={20} />
                              </button>
                            )}
                          </div>
                          <div
                            style={{
                              fontSize: 12,
                              color: 'var(--text-muted)',
                              display: 'flex',
                              flexDirection: 'column',
                              alignItems: 'flex-start',
                              gap: 2,
                              lineHeight: 1.15,
                            }}
                          >
                            {isSecret && (
                              <span
                                style={{
                                  display: 'inline-flex',
                                  alignItems: 'center',
                                  gap: 6,
                                  padding: 4,
                                  borderRadius: 0,
                                  border: '1px solid rgba(245,158,11,0.24)',
                                  background: 'rgba(245,158,11,0.10)',
                                  color: 'var(--text-primary)',
                                  fontWeight: 700,
                                  letterSpacing: 0.1,
                                }}
                              >
                                {(() => {
                                  const isSecretV2 = String(activeConversation?.type ?? '').toUpperCase() === 'SECRET'
                                  if (isSecretV2) {
                                    if (activeSecretUiState.readyState === 'ready') return '🔒 Защищено'
                                    if (activeSecretUiState.readyState === 'error') return '⚠️ Ошибка ключей'
                                    return '🔒 Настраивается…'
                                  }
                                  if (activeSecretUiState.readyState !== 'ready') return '🔒 Настраивается…'
                                  return '🔒 Защищено'
                                })()}
                              </span>
                            )}
                            {/* "Добавить устройство" button removed (replaced by header SVG action). */}
                            {(() => {
                              const isMinimized = minimizedCallConvId === activeId

                              // Если звонок завершен (и не минимизирован), показываем время завершения
                              if (callEntry && callEntry.endedAt && !isMinimized) {
                                const endedAt = callEntry.endedAt
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

                              // Если звонок минимизирован или активен — показываем статус звонка (с длительностью только участникам)
                              if ((callEntry?.active || isMinimized) && callEntry) {
                                const uid = typeof peer?.id === 'string' ? peer.id : null
                                const g = uid ? presenceGameByUserId[uid]?.game : undefined
                                const myId = me?.id
                                const isParticipantByServer =
                                  !!(myId && callEntry?.active && Array.isArray(callEntry.participants) && callEntry.participants.includes(myId))
                                const isParticipantByLocalState =
                                  callConvId === activeId ||
                                  minimizedCallConvId === activeId ||
                                  (!!callEntry?.active && callStore.activeConvId === activeId)
                                const isParticipant = isParticipantByServer || isParticipantByLocalState
                                const elapsedMs = isParticipant
                                  ? (callEntry.startedAt ? (Date.now() - callEntry.startedAt) : (typeof callEntry.elapsedMs === 'number' ? callEntry.elapsedMs : 0))
                                  : null

                                return (
                                  <>
                                    <span>{elapsedMs != null ? `В ЗВОНКЕ: ${formatDuration(elapsedMs)}` : 'В ЗВОНКЕ'}</span>
                                    {g?.name ? (
                                      <span style={{ whiteSpace: 'normal', overflowWrap: 'anywhere', wordBreak: 'break-word' }}>
                                        ИГРАЕТ В {g.name}
                                      </span>
                                    ) : null}
                                  </>
                                )
                              }

                              // Иначе показываем статус пользователя (в две строки, если в игре)
                              if (!peer) return ''
                              const uid = typeof peer?.id === 'string' ? peer.id : null
                              const base = effectiveUserStatus(peer)
                              const g = uid ? presenceGameByUserId[uid]?.game : undefined

                              if (g?.name && base === 'IN_CALL') {
                                return (
                                  <>
                                    <span>В ЗВОНКЕ</span>
                                    <span style={{ whiteSpace: 'normal', overflowWrap: 'anywhere', wordBreak: 'break-word' }}>
                                      ИГРАЕТ В {g.name}
                                    </span>
                                  </>
                                )
                              }
                              if (g?.name && (base === 'ONLINE' || base === 'BACKGROUND' || base === 'IN_CALL')) {
                                return (
                                  <span style={{ whiteSpace: 'normal', overflowWrap: 'anywhere', wordBreak: 'break-word' }}>
                                    ИГРАЕТ В {g.name}
                                  </span>
                                )
                              }
                              return <span>{formatPresence(peer)}</span>
                            })()}
                          </div>
                        </div>
                      </div>
                    )
                  })()
                )
              })()
            ) : (
              <div>Выберите чат</div>
            )}
        </div>
          {/* Center game image (no bubble) */}
          {activeConversation && (() => {
            if (isMobile) return null
            const isGroup = !!(activeConversation.isGroup || (activeConversation.participants?.length ?? 0) > 2)
            if (isGroup) return null
            const othersArr = activeConversation.participants
              .filter((p: any) => (currentUserId ? p.user.id !== currentUserId : true))
              .map((p: any) => p.user)
            const peer: any = othersArr[0]
            const uid = typeof peer?.id === 'string' ? peer.id : null
            const baseStatus = peer ? effectiveUserStatus(peer) : 'OFFLINE'
            const playing = uid ? presenceGameByUserId[uid]?.game : undefined
            if (!playing?.name || !(baseStatus === 'ONLINE' || baseStatus === 'BACKGROUND' || baseStatus === 'IN_CALL')) return null
            const steamAppIdRaw = playing?.steamAppId
            const steamAppId =
              typeof steamAppIdRaw === 'number'
                ? (Number.isFinite(steamAppIdRaw) ? String(steamAppIdRaw) : null)
                : (typeof steamAppIdRaw === 'string' && steamAppIdRaw.trim() ? steamAppIdRaw.trim() : null)
            const steamUrl = steamAppId ? `https://store.steampowered.com/app/${encodeURIComponent(steamAppId)}/` : null

            return (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  padding: '0 14px',
                  gridColumn: '2 / 3',
                  justifySelf: 'center',
                  pointerEvents: 'auto',
                }}
              >
                {playing.imageUrl ? (
                  <div
                    title={
                      steamUrl
                        ? `Открыть в Steam: ${playing?.name ? playing.name : ''}`.trim()
                        : `Играет в ${playing.name}`
                    }
                    onClick={() => {
                      if (!steamUrl) return
                      void openUrlSystemBrowser(steamUrl)
                    }}
                    style={{
                      cursor: steamUrl ? 'pointer' : 'default',
                      userSelect: 'none',
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      minWidth: 0,
                      maxWidth: '100%',
                      flexShrink: 0,
                    }}
                  >
                    <img
                      src={playing.imageUrl}
                      alt=""
                      style={{
                        height: 60,
                        maxHeight: 60,
                        width: 'auto',
                        // Keep it large, but allow shrinking to prevent overflow.
                        maxWidth: '100%',
                        // Light rounding like buttons.
                        borderRadius: 10,
                        objectFit: 'contain',
                        display: 'block',
                        flexShrink: 0,
                      }}
                    />
                  </div>
                ) : (
                  <div style={{ minWidth: 0, maxWidth: 320, lineHeight: 1.1 }}>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{baseStatus === 'IN_CALL' ? 'В звонке' : 'Играет'}</div>
                    <div
                      style={{
                        fontSize: 14,
                        fontWeight: 650,
                        color: 'var(--text-primary)',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {playing.name}
                    </div>
                  </div>
                )}
              </div>
            )
          })()}
          {endSecretModalOpen &&
            activeConversation &&
            !!activeConversation.isSecret &&
            (activeConversation.participants?.length ?? 0) <= 2 &&
            typeof document !== 'undefined' &&
            createPortal(
              <div
                style={{
                  position: 'fixed',
                  inset: 0,
                  background: 'rgba(10,12,16,0.6)',
                  backdropFilter: 'blur(4px) saturate(110%)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  padding: isMobile ? '0 16px' : 0,
                  boxSizing: 'border-box',
                  zIndex: 80,
                }}
                onClick={() => setEndSecretModalOpen(false)}
              >
                <div
                  style={{
                    background: 'var(--surface-200)',
                    padding: isMobile ? 16 : 20,
                    borderRadius: isMobile ? 20 : 16,
                    width: '100%',
                    maxWidth: 420,
                    border: '1px solid var(--surface-border)',
                    boxShadow: 'var(--shadow-medium)',
                    color: 'var(--text-primary)',
                    textAlign: isMobile ? 'center' : 'left',
                  }}
                  onClick={(e) => e.stopPropagation()}
                >
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      marginBottom: 12,
                      flexDirection: isMobile ? 'column' : 'row',
                      gap: isMobile ? 8 : 0,
                    }}
                  >
                    <div style={{ fontWeight: 700, fontSize: 18, width: '100%' }}>Завершить секретный чат?</div>
                    <button
                      className="btn btn-icon btn-ghost"
                      onClick={() => setEndSecretModalOpen(false)}
                      style={{ alignSelf: isMobile ? 'flex-end' : undefined }}
                    >
                      <X size={18} />
                    </button>
                  </div>
                  <div style={{ fontSize: 14, color: 'var(--text-muted)', marginBottom: 16, lineHeight: 1.5 }}>
                    Сообщения этого секретного чата будут удалены у всех участников. Это действие необратимо.
                  </div>
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: isMobile ? 'center' : 'flex-end',
                      alignItems: 'center',
                      flexDirection: isMobile ? 'column' : 'row',
                      gap: isMobile ? 12 : 8,
                    }}
                  >
                    <button
                      className="btn btn-ghost"
                      onClick={() => setEndSecretModalOpen(false)}
                      style={isMobile ? { width: '100%' } : undefined}
                    >
                      Отменить
                    </button>
                    <button
                      className="btn btn-primary"
                      style={{
                        background: '#ef4444',
                        borderColor: '#ef4444',
                        width: isMobile ? '100%' : undefined,
                      }}
                      onClick={async () => {
                        if (!activeId) return
                        try {
                          await api.delete(`/conversations/${activeId}`)
                          client.invalidateQueries({ queryKey: ['conversations'] })
                          client.removeQueries({ queryKey: ['messages', activeId] })
                          setEndSecretModalOpen(false)
                          setActiveId(null)
                        } catch (err) {
                          // eslint-disable-next-line no-console
                          console.error('Failed to end secret conversation:', err)
                        }
                      }}
                    >
                      Завершить
                    </button>
                  </div>
                </div>
              </div>,
              document.body,
            )}
          {activeId && (() => {
                const callEntry = activeCalls[activeId]
                const isActive = callEntry?.active
                const isGroup = activeConversation?.isGroup || (activeConversation?.participants.length ?? 0) > 2
                const othersArr = activeConversation?.participants
                  ?.filter((p: any) => (currentUserId ? p.user.id !== currentUserId : true))
                  .map((p: any) => p.user) ?? []
                const peerUser = othersArr[0]
                const fallbackTimeZone = getFallbackTimeZone()
                const peerTimeZone = (peerUser as any)?.timezone ?? (peerUser as any)?.timeZone ?? fallbackTimeZone
                const peerName = peerUser?.displayName ?? peerUser?.username ?? 'Собеседник'
                const canShowAvailability = !isGroup && !!peerUser?.id
                const isSecretV2Chat = String(activeConversation?.type ?? '').toUpperCase() === 'SECRET'
                const canShowAddDeviceInHeader = isSecretV2Chat && hasAnySecretThreadKeys
                const hasHeaderGame = (() => {
                  if (isMobile) return false
                  if (isGroup) return false
                  const uid = typeof peerUser?.id === 'string' ? peerUser.id : null
                  if (!uid) return false
                  const base = effectiveUserStatus(peerUser)
                  const g = presenceGameByUserId[uid]?.game
                  return !!(g?.name && (base === 'ONLINE' || base === 'BACKGROUND' || base === 'IN_CALL'))
                })()
                // Show text labels on wide screens; icons-only on narrow desktop.
                // If no game info in header, keep labels (there's space).
                const compactButtons = !isMobile && isNarrowHeaderButtons && hasHeaderGame
                const handleOpenAvailability = () => {
                  if (!activeConversation || !peerUser?.id) return
                  setAvailabilityContext({
                    conversationId: activeConversation.id,
                    peerId: peerUser.id,
                    peerName,
                    peerTimeZone,
                  })
                }
                const isMinimized = minimizedCallConvId === activeId
                // Оверлей открыт, только если callConvId установлен И не минимизирован
                const isOverlayOpen = callConvId === activeId && !isMinimized
                // Участие в звонке
                const myId = me?.id
                // Для групповых: звонок активен И есть в participants
                const isParticipatingInGroup = isGroup && isActive && myId && callEntry?.participants?.includes(myId)
                // Для 1:1: pending-дозвон не считается участием; участвуем только
                // когда есть оверлей/минимизация или сервер уже подтвердил активный звонок.
                const isParticipatingInDialog = !isGroup && (
                  isMinimized || // Если минимизирован - точно участвуем
                  callConvId === activeId || // Если оверлей был открыт/открыт - участвуем
                  (isActive && (callStore.activeConvId === activeId || callConvId === activeId)) // Звонок активен и есть связь
                )
                const isParticipating = isParticipatingInGroup || isParticipatingInDialog
                // Показываем кнопку "Развернуть" если участвуем и оверлей не открыт (минимизирован или не развернут)
                // Кнопки управления показываются постоянно, пока пользователь участвует в звонке
                const shouldShowExpand = isParticipating && !isOverlayOpen
                const buttonBaseStyle = {
                  display: 'flex' as const,
                  alignItems: 'center' as const,
                  justifyContent: 'center' as const,
                  gap: compactButtons ? 0 : 6,
                  padding: isMobile ? '8px 12px' : (!compactButtons ? '12px 16px' : '10px'),
                  flex: isMobile ? 1 : 'auto' as const,
                  minWidth: isMobile ? 0 : (!compactButtons ? 'auto' : 44 as any),
                  width: compactButtons ? 44 : undefined,
                  fontSize: isMobile ? '14px' : '15px',
                  fontWeight: isMobile ? 500 : 600,
                  height: isMobile ? '42px' : '46px',
                  minHeight: isMobile ? '42px' : '46px',
                  boxSizing: 'border-box' as const
                }

                const headerStyle = {
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  width: isMobile ? '100%' : 'auto',
                  padding: isMobile ? '0 8px' : '0',
                  justifyContent: isMobile ? 'center' : 'flex-end',
                  marginLeft: isMobile ? 0 : 0,
                  // Desktop header uses 3-column grid; controls live in the right column.
                  gridColumn: isMobile ? undefined : '3 / 4',
                  justifySelf: isMobile ? undefined : 'end',
                }
                
                const menuButtonStyle = {
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: isMobile ? 42 : 44,
                  height: isMobile ? 42 : 44,
                  minWidth: isMobile ? 42 : 44,
                  padding: 0,
                  margin: 0,
                  borderRadius: 999,
                }

                const handleStartCall = async () => {
                  if (!activeId) return
                  if (!(await requireMediaAccess(false))) return
                  try {
                    beginOutgoingCallGuard(activeId)
                    inviteCall(activeId, false)
                    signalApkOutgoingStarted(activeId, false)
                    callStore.startOutgoing(activeId, false)
                    // Проверяем, является ли беседа групповой
                    const conv = conversationsQuery.data?.find((r: any) => r.conversation.id === activeId)?.conversation
                    const isGroup = conv?.isGroup || (conv?.participants?.length ?? 0) > 2
                    if (isGroup) {
                      setActiveCalls((prev: any) => {
                        const current = prev[activeId]
                        const myId = me?.id
                        if (!current?.active) {
                          return { ...prev, [activeId]: { startedAt: Date.now(), active: true, endedAt: null, participants: myId ? [myId] : [] } }
                        }
                        if (myId && current.participants && !current.participants.includes(myId)) {
                          return { ...prev, [activeId]: { ...current, participants: [...current.participants, myId] } }
                        }
                        return prev
                      })
                      // Для групповых бесед сразу открываем оверлей, без экрана дозвона
                      setCallConvId(activeId)
                      setMinimizedCallConvId((prev: any) => (prev === activeId ? null : prev))
                    } else {
                      // Для 1:1 бесед показываем экран дозвона
                      const convId = activeId
                      setOutgoingCall({ conversationId: convId, startedAt: Date.now(), video: false })
                      // Запускаем звук дозвона
                      startDialingSound()
                      // Автоматически закрываем через 30 секунд, если звонок не принят
                      if (outgoingCallTimerRef.current) {
                        window.clearTimeout(outgoingCallTimerRef.current)
                      }
                      outgoingCallTimerRef.current = window.setTimeout(() => {
                        setOutgoingCall((prev: any) => {
                          if (prev?.conversationId === convId) {
                            stopDialingSound()
                            playEndCallSound()
                            endCall(convId)
                            setActiveCalls((prevCalls: any) => {
                              const current = prevCalls[convId]
                              if (current?.active) {
                                return { ...prevCalls, [convId]: { ...current, active: false, endedAt: Date.now() } }
                              }
                              const { [convId]: _omit, ...rest } = prevCalls
                              return rest
                            })
                            callStore.endCall()
                            return null
                          }
                          return prev
                        })
                        outgoingCallTimerRef.current = null
                      }, 30000)
                    }
                  } catch (err) {
                    console.error('Error starting call:', err)
                  }
                }

                const handleStartVideoCall = async () => {
                  if (!activeId) return
                  if (!(await requireMediaAccess(true))) return
                  try {
                    beginOutgoingCallGuard(activeId)
                    inviteCall(activeId, true)
                    signalApkOutgoingStarted(activeId, true)
                    callStore.startOutgoing(activeId, true)
                    // Проверяем, является ли беседа групповой
                    const conv = conversationsQuery.data?.find((r: any) => r.conversation.id === activeId)?.conversation
                    const isGroup = conv?.isGroup || (conv?.participants?.length ?? 0) > 2
                    if (isGroup) {
                      setActiveCalls((prev: any) => {
                        const current = prev[activeId]
                        const myId = me?.id
                        if (!current?.active) {
                          return { ...prev, [activeId]: { startedAt: Date.now(), active: true, endedAt: null, participants: myId ? [myId] : [] } }
                        }
                        if (myId && current.participants && !current.participants.includes(myId)) {
                          return { ...prev, [activeId]: { ...current, participants: [...current.participants, myId] } }
                        }
                        return prev
                      })
                      // Для групповых бесед сразу открываем оверлей, без экрана дозвона
                      setCallConvId(activeId)
                      setMinimizedCallConvId((prev: any) => (prev === activeId ? null : prev))
                    } else {
                      // Для 1:1 бесед показываем экран дозвона
                      const convId = activeId
                      setOutgoingCall({ conversationId: convId, startedAt: Date.now(), video: true })
                      // Запускаем звук дозвона
                      startDialingSound()
                      // Автоматически закрываем через 30 секунд, если звонок не принят
                      if (outgoingCallTimerRef.current) {
                        window.clearTimeout(outgoingCallTimerRef.current)
                      }
                      outgoingCallTimerRef.current = window.setTimeout(() => {
                        setOutgoingCall((prev: any) => {
                          if (prev?.conversationId === convId) {
                            stopDialingSound()
                            playEndCallSound()
                            endCall(convId)
                            setActiveCalls((prevCalls: any) => {
                              const current = prevCalls[convId]
                              if (current?.active) {
                                return { ...prevCalls, [convId]: { ...current, active: false, endedAt: Date.now() } }
                              }
                              const { [convId]: _omit, ...rest } = prevCalls
                              return rest
                            })
                            callStore.endCall()
                            return null
                          }
                          return prev
                        })
                        outgoingCallTimerRef.current = null
                      }, 30000)
                    }
                  } catch (err) {
                    console.error('Error starting call:', err)
                  }
                }

                const handleExpandCall = () => {
                  if (!activeId) return
                  setCallConvId(activeId)
                  setMinimizedCallConvId(null)
                }

                const renderCallControls = () => {
                  // Если звонок активен ИЛИ минимизирован (минимизированный звонок все еще активен, просто скрыт)
                  if (isActive || isMinimized) {
                    if (!isParticipating) {
                      // «Мой собственный звонок, активный с другого устройства» (1:1):
                      // подписываем кнопки короче, чтобы влазило на мобилках.
                      const isMineOnAnotherDevice = !isGroup && !!myId && (callEntry?.participants?.includes(myId) ?? false)
                      const audioLabel = isMineOnAnotherDevice ? 'Тоже сюда' : 'Подключиться'
                      const videoLabel = isMineOnAnotherDevice ? 'Видео сюда' : 'Подключиться с видео'
                      return (
                        <>
                          <button 
                            className="btn btn-secondary" 
                            title={!isMobile ? audioLabel : undefined}
                            onClick={() => {
                              const isGroupCall = activeConversation?.isGroup || ((activeConversation?.participants?.length ?? 0) > 2)
                              if (isGroupCall) {
                                setCallConvId(activeId!)
                                setMinimizedCallConvId((prev: any) => (prev === activeId ? null : prev))
                                callStore.startOutgoing(activeId!, false)
                                try { joinCallRoom(activeId!, false) } catch {}
                              } else {
                                // Для 1:1 звонков устанавливаем callConvId и callStore.activeConvId для показа кнопок управления.
                                // joinCallRoom нужен, чтобы сервер зарегистрировал этот сокет в activeDirectCalls
                                // (важно для presence IN_CALL и для подключения к уже активному 1:1 звонку
                                // с другого устройства того же аккаунта).
                                setCallConvId(activeId!)
                                setMinimizedCallConvId((prev: any) => (prev === activeId ? null : prev))
                                callStore.startOutgoing(activeId!, false)
                                try { joinCallRoom(activeId!, false) } catch {}
                              }
                            }}
                            style={buttonBaseStyle}
                          >
                            <Phone size={isMobile ? 16 : 18} />
                            {isMobile ? audioLabel : (compactButtons ? null : ` ${audioLabel}`)}
                          </button>
                          <button 
                            className="btn btn-primary" 
                            title={!isMobile ? videoLabel : undefined}
                            onClick={() => {
                              const isGroupCall = activeConversation?.isGroup || ((activeConversation?.participants?.length ?? 0) > 2)
                              if (isGroupCall) {
                                setCallConvId(activeId!)
                                setMinimizedCallConvId((prev: any) => (prev === activeId ? null : prev))
                                callStore.startOutgoing(activeId!, true)
                                try { joinCallRoom(activeId!, true) } catch {}
                              } else {
                                // Для 1:1 звонков устанавливаем callConvId и callStore.activeConvId для показа кнопок управления
                                setCallConvId(activeId!)
                                setMinimizedCallConvId((prev: any) => (prev === activeId ? null : prev))
                                callStore.startOutgoing(activeId!, true)
                                try { joinCallRoom(activeId!, true) } catch {}
                              }
                            }}
                            style={buttonBaseStyle}
                          >
                            <Video size={isMobile ? 16 : 18} />
                            {isMobile ? videoLabel : (compactButtons ? null : ` ${videoLabel}`)}
                          </button>
                          {canShowAvailability && !isSecretV2Chat && (
                            <AvailabilityButton onClick={handleOpenAvailability} style={menuButtonStyle} />
                          )}
                          {canShowAvailability && canShowAddDeviceInHeader && (
                            <button
                              type="button"
                              className="btn btn-icon btn-ghost"
                              title="Добавить устройство"
                              onClick={() => setDeviceLinkInviteOpen(true)}
                              style={{
                                ...menuButtonStyle,
                                color: '#86efac',
                                border: '1px solid rgba(34,197,94,0.18)',
                                background: 'rgba(34,197,94,0.06)',
                              }}
                            >
                              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" aria-hidden="true" width={20} height={20}>
                                <rect x="2" y="2" width="9" height="9" rx="2" stroke="currentColor" strokeWidth="2" />
                                <rect x="13" y="2" width="9" height="9" rx="2" stroke="currentColor" strokeWidth="2" />
                                <rect x="2" y="13" width="9" height="9" rx="2" stroke="currentColor" strokeWidth="2" />
                                <path d="M17.5 14.5v6" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
                                <path d="M14.5 17.5h6" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
                              </svg>
                            </button>
                          )}
                          {!isMobile && (
                            <button
                              className="btn btn-icon btn-ghost"
                              title="Меню"
                              onClick={(e) => {
                                setHeaderMenu({ open: true, anchor: e.currentTarget })
                              }}
                              style={menuButtonStyle}
                            >
                              <MoreVertical size={22} />
                            </button>
                          )}
                        </>
                      )
                    }

                    return (
                      <>
                        {/* Показываем кнопку "Развернуть" если оверлей не открыт (минимизирован или не развернут) */}
                        {!isOverlayOpen && (
                          <button 
                            className="btn btn-secondary"
                            title={!isMobile ? 'Развернуть' : undefined}
                            onClick={handleExpandCall}
                            style={buttonBaseStyle}
                          >
                            <Maximize2 size={isMobile ? 16 : 18} />
                            {isMobile ? 'Развернуть' : (compactButtons ? null : ' Развернуть')}
                          </button>
                        )}
                        {/* Кнопка "Сбросить" показывается всегда, пока пользователь участвует в звонке */}
                        <button 
                          className="btn"
                          title={!isMobile ? 'Сбросить' : undefined}
                          onClick={() => {
                            if (!callConvId) return
                            void endActiveCallAction(
                              {
                                callId: callConvId,
                                conversationId: callConvId,
                              },
                              'web_ui',
                            )
                          }}
                          style={{ 
                            ...buttonBaseStyle,
                            background: '#ef4444',
                            color: '#fff'
                          }}
                        >
                          <PhoneOff size={isMobile ? 16 : 18} />
                          {isMobile ? 'Сбросить' : (compactButtons ? null : ' Сбросить')}
                        </button>
                        {canShowAvailability && !isSecretV2Chat && (
                          <AvailabilityButton onClick={handleOpenAvailability} style={menuButtonStyle} />
                        )}
                        {canShowAvailability && canShowAddDeviceInHeader && (
                          <button
                            type="button"
                            className="btn btn-icon btn-ghost"
                            title="Добавить устройство"
                            onClick={() => setDeviceLinkInviteOpen(true)}
                            style={{
                              ...menuButtonStyle,
                              color: '#86efac',
                              border: '1px solid rgba(34,197,94,0.18)',
                              background: 'rgba(34,197,94,0.06)',
                            }}
                          >
                            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" aria-hidden="true" width={20} height={20}>
                              <rect x="2" y="2" width="9" height="9" rx="2" stroke="currentColor" strokeWidth="2" />
                              <rect x="13" y="2" width="9" height="9" rx="2" stroke="currentColor" strokeWidth="2" />
                              <rect x="2" y="13" width="9" height="9" rx="2" stroke="currentColor" strokeWidth="2" />
                              <path d="M17.5 14.5v6" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
                              <path d="M14.5 17.5h6" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
                            </svg>
                          </button>
                        )}
                        {!isMobile && (
                          <button
                            className="btn btn-icon btn-ghost"
                            title="Меню"
                            onClick={(e) => {
                              setHeaderMenu({ open: true, anchor: e.currentTarget })
                            }}
                            style={menuButtonStyle}
                          >
                            <MoreVertical size={22} />
                          </button>
                        )}
                      </>
                    )
                  }

                  return (
                    <>
                      <button 
                        className="btn btn-secondary" 
                        title={!isMobile ? 'Звонок' : undefined}
                        onClick={() => { void handleStartCall() }}
                        style={buttonBaseStyle}
                      >
                        <Phone size={isMobile ? 16 : 18} />
                        {isMobile ? ' Начать звонок' : (compactButtons ? null : ' Звонок')}
                      </button>
                      <button 
                        className="btn btn-primary" 
                        title={!isMobile ? 'Видео' : undefined}
                        onClick={() => { void handleStartVideoCall() }}
                        style={buttonBaseStyle}
                      >
                        <Video size={isMobile ? 16 : 18} />
                        {isMobile ? ' Начать с видео' : (compactButtons ? null : ' Видео')}
                      </button>
                      {canShowAvailability && !isSecretV2Chat && (
                        <AvailabilityButton onClick={handleOpenAvailability} style={menuButtonStyle} />
                      )}
                      {canShowAvailability && canShowAddDeviceInHeader && (
                        <button
                          type="button"
                          className="btn btn-icon btn-ghost"
                          title="Добавить устройство"
                          onClick={() => setDeviceLinkInviteOpen(true)}
                          style={{
                            ...menuButtonStyle,
                            color: '#86efac',
                            border: '1px solid rgba(34,197,94,0.18)',
                            background: 'rgba(34,197,94,0.06)',
                          }}
                        >
                          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" aria-hidden="true" width={20} height={20}>
                            <rect x="2" y="2" width="9" height="9" rx="2" stroke="currentColor" strokeWidth="2" />
                            <rect x="13" y="2" width="9" height="9" rx="2" stroke="currentColor" strokeWidth="2" />
                            <rect x="2" y="13" width="9" height="9" rx="2" stroke="currentColor" strokeWidth="2" />
                            <path d="M17.5 14.5v6" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
                            <path d="M14.5 17.5h6" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
                          </svg>
                        </button>
                      )}
                      {!isMobile && (
                        <button
                          className="btn btn-icon btn-ghost"
                          title="Меню"
                          onClick={(e) => {
                            setHeaderMenu({ open: true, anchor: e.currentTarget })
                          }}
                          style={menuButtonStyle}
                        >
                          <MoreVertical size={22} />
                        </button>
                      )}
                    </>
                  )
                }

                return (
                  <>
                    <div style={headerStyle}>
                      {renderCallControls()}
                    </div>
                    {callPermissionError && (
                      <div
                        style={{
                          marginTop: 8,
                          padding: '8px 12px',
                          borderRadius: 10,
                          border: '1px solid var(--surface-border)',
                          background: 'rgba(239,68,68,0.08)',
                          color: '#fca5a5',
                          display: 'flex',
                          alignItems: 'center',
                          gap: 8,
                          fontSize: 13,
                          maxWidth: isMobile ? '100%' : 420,
                          width: isMobile ? '100%' : 'auto',
                        }}
                      >
                        <span style={{ flex: 1 }}>{callPermissionError}</span>
                        <button
                          type="button"
                          onClick={() => setCallPermissionError(null)}
                          style={{ background: 'transparent', border: 'none', color: 'inherit', cursor: 'pointer', padding: 4 }}
                        >
                          <X size={14} />
                        </button>
                      </div>
                    )}
                  </>
                )
          })()}
        </header>
        <div
          className="messages-container"
          style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, position: 'relative' }}
          onDragEnter={(e) => {
            if (!eventHasFiles(e)) return
            e.preventDefault()
            attachDragDepthRef.current += 1
            setAttachDragOver(true)
          }}
          onDragOver={(e) => {
            if (!eventHasFiles(e)) return
            e.preventDefault()
            e.dataTransfer.dropEffect = 'copy'
            setAttachDragOver(true)
          }}
          onDragLeave={(e) => {
            if (!eventHasFiles(e)) return
            e.preventDefault()
            attachDragDepthRef.current = Math.max(0, attachDragDepthRef.current - 1)
            if (attachDragDepthRef.current === 0) setAttachDragOver(false)
          }}
          onDrop={async (e) => {
            if (!eventHasFiles(e)) return
            e.preventDefault()
            e.stopPropagation()
            attachDragDepthRef.current = 0
            setAttachDragOver(false)
            const files = Array.from(e.dataTransfer.files || [])
            if (!files.length) return
            await handleChatDropFiles(files)
          }}
        >
          {multiSelectMode && activeId && (
            <div
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                right: 0,
                zIndex: 15,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 10,
                flexWrap: 'wrap',
                padding: '10px 14px',
                borderBottom: '1px solid var(--surface-border)',
                background: 'var(--surface-200)',
              }}
            >
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
                <button
                  type="button"
                  className="btn"
                  disabled={selectedMessageIds.length === 0}
                  style={{
                    background: selectedMessageIds.length ? 'var(--brand-600)' : 'var(--surface-border)',
                    color: '#fff',
                    fontWeight: 700,
                    fontSize: 12,
                    letterSpacing: 0.4,
                    textTransform: 'uppercase',
                    borderRadius: 10,
                    padding: '8px 14px',
                    opacity: selectedMessageIds.length ? 1 : 0.5,
                  }}
                  onClick={() => {
                    const msgs = getSelectedMessagesOrdered()
                    const draft = buildReplyDraftFromMessages(msgs)
                    if (draft) {
                      setForwardComposerDraft(null)
                      setReplyTo(draft)
                    }
                    clearMessageMultiSelect()
                  }}
                >
                  Ответить
                </button>
                <button
                  type="button"
                  className="btn"
                  disabled={selectedMessageIds.length === 0}
                  style={{
                    background: selectedMessageIds.length ? 'var(--brand-600)' : 'var(--surface-border)',
                    color: '#fff',
                    fontWeight: 700,
                    fontSize: 12,
                    letterSpacing: 0.4,
                    textTransform: 'uppercase',
                    borderRadius: 10,
                    padding: '8px 14px',
                    opacity: selectedMessageIds.length ? 1 : 0.5,
                  }}
                  onClick={() => {
                    const ids = getSelectedMessagesOrdered().map((m: any) => m.id)
                    if (!ids.length) return
                    setForwardComposerDraft(null)
                    setForwardModal({ open: true, messageIds: ids })
                  }}
                >
                  Переслать{selectedMessageIds.length > 0 ? ` ${selectedMessageIds.length}` : ''}
                </button>
                <button
                  type="button"
                  className="btn"
                  disabled={selectedMessageIds.length === 0}
                  style={{
                    background: selectedMessageIds.length ? 'var(--brand-600)' : 'var(--surface-border)',
                    color: '#fff',
                    fontWeight: 700,
                    fontSize: 12,
                    letterSpacing: 0.4,
                    textTransform: 'uppercase',
                    borderRadius: 10,
                    padding: '8px 14px',
                    opacity: selectedMessageIds.length ? 1 : 0.5,
                  }}
                  onClick={async () => {
                    const msgs = getSelectedMessagesOrdered()
                    const mine = msgs.filter((m: any) => m.senderId === me?.id)
                    if (!mine.length) {
                      systemToast.error('Среди выбранных нет ваших сообщений')
                      return
                    }
                    const ok = await systemConfirm({
                      title: 'Удалить сообщения',
                      message: `Удалить ${mine.length} ваших сообщений?`,
                      confirmText: 'Удалить',
                      cancelText: 'Отмена',
                      danger: true,
                    })
                    if (!ok) return
                    for (const m of mine) {
                      try {
                        await api.post('/messages/delete', { messageId: m.id })
                      } catch {
                        /* next */
                      }
                    }
                    if (activeId) client.invalidateQueries({ queryKey: ['messages', activeId] })
                    clearMessageMultiSelect()
                  }}
                >
                  Удалить{selectedMessageIds.length > 0 ? ` ${selectedMessageIds.length}` : ''}
                </button>
              </div>
              <button
                type="button"
                className="btn btn-ghost"
                style={{ color: 'var(--brand-600)', fontWeight: 700, fontSize: 12, textTransform: 'uppercase' }}
                onClick={() => clearMessageMultiSelect()}
              >
                Отмена
              </button>
            </div>
          )}
          {attachDragOver && !editState && (
            <div
              style={{
                position: 'absolute',
                inset: 10,
                borderRadius: 14,
                border: '2px dashed var(--surface-border-strong)',
                background: 'rgba(217,119,6,0.06)',
                zIndex: 30,
                pointerEvents: 'none',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'var(--text-muted)',
                fontSize: 13,
                fontWeight: 600,
              }}
            >
              Отпустите файлы, чтобы прикрепить
            </div>
          )}
          {Boolean(
            activeSecretUiState?.isSecret &&
              String(activeConversation?.type ?? '').toUpperCase() === 'SECRET' &&
              (activeSecretUiState.readyState === 'bootstrapping' || !!secretBootDonePulse || creatorAwaitPeerAccept) &&
              !secretInviteForMe &&
              !secretWaitingAsCreator
          ) && (
            <div
              style={{
                position: 'absolute',
                inset: 0,
                zIndex: 20,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                pointerEvents: 'none',
              }}
            >
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, opacity: 0.95 }}>
                <LoadingSpinner done={!!secretBootDonePulse && activeSecretUiState.readyState !== 'bootstrapping'} />
                <div style={{ fontSize: 13, color: 'var(--text-muted)', fontWeight: 600 }}>
                  {secretBootDonePulse ? 'Готово' : (creatorAwaitPeerAccept ? 'Ждём подтверждение…' : 'Настраиваем защиту…')}
                </div>
              </div>
            </div>
          )}

          {Boolean(secretWaitingAsCreator) && (
            <div
              style={{
                position: 'absolute',
                inset: 0,
                zIndex: 23,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: 'rgba(10,12,16,0.5)',
                backdropFilter: 'blur(8px) saturate(120%)',
                padding: 16,
              }}
            >
              <div style={{ maxWidth: 360, width: '100%', background: 'var(--surface-100, #1b1f27)', border: '1px solid var(--surface-border-strong, #3b414f)', borderRadius: 16, padding: 20, textAlign: 'center', boxShadow: '0 8px 32px rgba(0,0,0,0.4)' }}>
                <div style={{ fontSize: 34, marginBottom: 6 }}>🔒</div>
                <div style={{ fontSize: 17, fontWeight: 700, marginBottom: 6 }}>Ждём подтверждения</div>
                <div style={{ fontSize: 14, color: 'var(--text-muted)', marginBottom: 18, lineHeight: 1.4 }}>
                  Попросите {secretWaitingAsCreator?.peerName} принять приглашение — секретный чат откроется, как только его подтвердят на одном из устройств.
                </div>
                <button
                  type="button"
                  onClick={cancelSecretInviteAsCreator}
                  disabled={secretInviteBusy}
                  style={{ width: '100%', padding: '10px 12px', borderRadius: 10, border: '1px solid var(--surface-border-strong, #3b414f)', background: 'transparent', color: 'var(--text, #e5e7eb)', cursor: 'pointer', fontWeight: 600 }}
                >
                  {secretInviteBusy ? '…' : 'Отменить приглашение'}
                </button>
              </div>
            </div>
          )}
          {Boolean(secretInviteForMe) && (
            <div
              style={{
                position: 'absolute',
                inset: 0,
                zIndex: 23,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: 'rgba(10,12,16,0.5)',
                backdropFilter: 'blur(8px) saturate(120%)',
                padding: 16,
              }}
            >
              <div
                style={{
                  maxWidth: 360,
                  width: '100%',
                  background: 'var(--surface-100, #1b1f27)',
                  border: '1px solid var(--surface-border-strong, #3b414f)',
                  borderRadius: 16,
                  padding: 20,
                  textAlign: 'center',
                  boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
                }}
              >
                <div style={{ fontSize: 34, marginBottom: 6 }}>🔒</div>
                <div style={{ fontSize: 17, fontWeight: 700, marginBottom: 6 }}>Секретный чат</div>
                <div style={{ fontSize: 14, color: 'var(--text-muted)', marginBottom: 18, lineHeight: 1.4 }}>
                  {secretInviteForMe?.fromName} приглашает вас в зашифрованный чат. Примите на этом устройстве, чтобы получить ключи. Остальные устройства подключите через «Добавить устройство».
                </div>
                <div style={{ display: 'flex', gap: 10 }}>
                  <button
                    type="button"
                    onClick={declineSecretInvite}
                    disabled={secretInviteBusy}
                    style={{
                      flex: 1,
                      padding: '10px 14px',
                      borderRadius: 12,
                      border: '1px solid var(--surface-border-strong, #3b414f)',
                      background: 'transparent',
                      color: 'var(--text-primary, #f1f3f6)',
                      fontWeight: 600,
                      cursor: 'pointer',
                    }}
                  >
                    Отклонить
                  </button>
                  <button
                    type="button"
                    onClick={acceptSecretInvite}
                    disabled={secretInviteBusy}
                    style={{
                      flex: 1,
                      padding: '10px 14px',
                      borderRadius: 12,
                      border: 'none',
                      background: 'var(--brand, #d97706)',
                      color: '#fff',
                      fontWeight: 700,
                      cursor: 'pointer',
                    }}
                  >
                    {secretInviteBusy ? '…' : 'Принять'}
                  </button>
                </div>
              </div>
            </div>
          )}

          {Boolean(
            !secretInviteForMe &&
            activeSecretUiState?.isSecret &&
              String(activeConversation?.type ?? '').toUpperCase() === 'SECRET' &&
              // On a brand-new device (no stored secret keys) require linking via code/QR.
              hasOtherTrustedDevice &&
              !hasAnySecretThreadKeys
          ) && (
            <div
              style={{
                position: 'absolute',
                inset: 0,
                zIndex: 22,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: 'rgba(10,12,16,0.42)',
                backdropFilter: 'blur(8px) saturate(120%)',
                padding: 16,
              }}
            >
              <DeviceLinkInline variant="join" />
            </div>
          )}

          {Boolean(
            deviceLinkInviteOpen &&
              activeSecretUiState?.isSecret &&
              String(activeConversation?.type ?? '').toUpperCase() === 'SECRET' &&
              hasAnySecretThreadKeys
          ) && (
            <div
              style={{
                position: 'absolute',
                inset: 0,
                zIndex: 23,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: 'rgba(10,12,16,0.42)',
                backdropFilter: 'blur(8px) saturate(120%)',
                padding: 16,
              }}
              onClick={() => setDeviceLinkInviteOpen(false)}
            >
              <div onClick={(e) => e.stopPropagation()}>
                <DeviceLinkInline variant="invite" onClose={() => setDeviceLinkInviteOpen(false)} />
              </div>
            </div>
          )}
          <div style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            height: '24px',
            background: 'linear-gradient(to bottom, var(--surface-200) 0%, rgba(35, 39, 49, 0) 100%)',
            pointerEvents: 'none',
            zIndex: 10
          }} />
          {/* Спиннер подгрузки старых — плавающий overlay, а НЕ элемент в потоке скролла:
              его появление/исчезновение не меняет scrollHeight, значит не может сбить
              позицию (важно на iOS, где родной якорь ленивее). */}
          {activeId && olderLoading && (
            <div
              aria-live="polite"
              style={{
                position: 'absolute',
                top: 8,
                left: 0,
                right: 0,
                display: 'flex',
                justifyContent: 'center',
                pointerEvents: 'none',
                zIndex: 11,
              }}
            >
              <span
                style={{
                  background: 'var(--surface-100)',
                  border: '1px solid var(--surface-border)',
                  borderRadius: 999,
                  padding: '4px 12px',
                  color: 'var(--text-muted)',
                  fontSize: 13,
                  boxShadow: '0 2px 8px rgba(0,0,0,0.18)',
                }}
              >
                Загружаем…
              </span>
            </div>
          )}
          <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
            {!activeId ? (
              <div className="messages-empty">Сообщения появятся здесь</div>
            ) : (
              (() => {
                const list = sortedActiveMessages(displayedMessages)
                const pending = activePendingMessages
                const fullList = [...(list || []), ...pending]
                if (!fullList) return null
                const replyQuoteVisual = (
                  quotedMsg: any | undefined | null,
                  snippetFromApi: string,
                ) => {
                  const thumbUrl = quotedMsg ? resolveFirstImageAttachmentUrl(quotedMsg) : null
                  const apiTrim = typeof snippetFromApi === 'string' ? snippetFromApi.trim() : ''
                  let line = apiTrim
                  if (!line && quotedMsg) line = previewTextForReplyDraft(quotedMsg).trim()
                  if (line.length > 240) line = `${line.slice(0, 237)}…`
                  const hideLineForThumb = !!(thumbUrl && replySnippetIsGenericRu(line))
                  const showText = !!line && !hideLineForThumb
                  const showPlaceholder = !thumbUrl && !showText
                  return { thumbUrl, line, showText, showPlaceholder }
                }
                const __fwdBundles = computeMultiSourceForwardBundles(fullList)
                const __fwdSkip = new Set<number>()
                for (const b of __fwdBundles) {
                  for (let k = b.start + 1; k <= b.end; k++) __fwdSkip.add(k)
                }
                const __fwdBundleByStart = new Map<number, (typeof __fwdBundles)[number]>()
                for (const b of __fwdBundles) __fwdBundleByStart.set(b.start, b)
                // Виртуализация удалена: рисуем все загруженные строки реальным DOM.
                // Здесь — только стабильный ключ строки по индексу (React key + data-msg-row,
                // который служит якорем при подгрузке старых сообщений).
                const rowKeyByIndex = new Map<number, string>()
                for (let i = 0; i < fullList.length; i++) {
                  const row = fullList[i]
                  if (!row || row.deletedAt || __fwdSkip.has(i)) continue
                  const keyPrefix = __fwdBundleByStart.has(i)
                    ? 'bundle'
                    : row.type === 'SYSTEM'
                      ? 'system'
                      : hasForwardFromMeta(row)
                        ? 'forward'
                        : 'msg'
                  rowKeyByIndex.set(i, `${keyPrefix}:${row.id ?? row.tempId ?? i}`)
                }
                const repMessagePendingForMulti = (rep: any) =>
                  !!rep &&
                  (() => {
                    try {
                      if (typeof rep?.__pending === 'boolean') return rep.__pending
                      if (typeof rep.id === 'string' && rep.id.startsWith('tmp-')) return true
                      const atts = rep?.attachments
                      if (Array.isArray(atts) && atts.some((a: any) => !!a?.__pending)) return true
                      return false
                    } catch {
                      return false
                    }
                  })()
                const forwardBundleHostCanMultiSelect = (rep: any) =>
                  !!rep && !repMessagePendingForMulti(rep) && rep.type !== 'SYSTEM'
                const renderForwardBundleHostCheckbox = (rep: any) => {
                  if (!multiSelectMode || !forwardBundleHostCanMultiSelect(rep)) return null
                  const rid = String(rep.id)
                  const checked = selectedMessageIds.includes(rid)
                  return (
                    <button
                      type="button"
                      className={`msg-multi-checkbox${checked ? ' msg-multi-checkbox--checked' : ''}`}
                      aria-label={checked ? 'Снять выделение' : 'Выбрать сообщение'}
                      aria-pressed={checked}
                      onClick={(e) => {
                        e.preventDefault()
                        e.stopPropagation()
                        toggleMessageMultiSelect(rid)
                      }}
                    >
                      {checked ? <Check size={16} strokeWidth={2.8} /> : null}
                    </button>
                  )
                }
                const onForwardBundleHostMultiClick = (e: React.MouseEvent, representativeId: string) => {
                  if (!multiSelectMode) return
                  const rep = fullList.find((x: any) => x?.id === representativeId)
                  if (!forwardBundleHostCanMultiSelect(rep)) return
                  const t = e.target as HTMLElement
                  if (
                    t.closest(
                      '.msg-bubble, a[href], button, .reaction-emoji, .msg-reaction-rail-host, img, video, .msg-media-tile, .video-message-bubble',
                    )
                  )
                    return
                  const sel = typeof window.getSelection === 'function' ? window.getSelection() : null
                  if (sel && sel.toString().length > 0) return
                  e.preventDefault()
                  toggleMessageMultiSelect(representativeId)
                }
                /** Время и галочки у внешнего серого бабла: «переслано + свой комментарий» или пачка без комментария (у тел пересланого внутри конверта скрыты через suppress). */
                const renderForwardCaptionOuterBubbleMeta = (
                  repMsg: any,
                  isRepMe: boolean,
                  bubbleSelected: boolean,
                ) => {
                  if (!repMsg) return null
                  const pend = (() => {
                    try {
                      if (typeof repMsg.__pending === 'boolean') return repMsg.__pending
                      if (typeof repMsg.id === 'string' && repMsg.id.startsWith('tmp-')) return true
                      const atts = repMsg?.attachments
                      if (Array.isArray(atts) && atts.some((a: any) => !!a?.__pending)) return true
                      return false
                    } catch {
                      return false
                    }
                  })()
                  const createdOuter = repMsg.createdAt ? new Date(repMsg.createdAt) : null
                  const tlab = formatMessageClockLabel(createdOuter)
                  const recLineOuter =
                    createdOuter && Number.isFinite(createdOuter.getTime())
                      ? formatRuRelativeSendDay(createdOuter)
                      : null
                  const labelOuter =
                    recLineOuter != null && recLineOuter.trim() !== ''
                      ? `${tlab}, ${recLineOuter}`
                      : tlab
                  const editedOuter =
                    typeof (repMsg as any)?.metadata?.editedAt === 'string' && String((repMsg as any).metadata.editedAt).length > 0
                  const otherIdsR =
                    (activeConversation?.participants || [])
                      .map((p: any) => p.user.id)
                      .filter((id: string) => (currentUserId ? id !== currentUserId : true)) ?? []
                  const receiptsR = (repMsg.receipts || []) as Array<any>
                  const readByAnyR =
                    isRepMe &&
                    otherIdsR.some((uid: string) => receiptsR.some((r) => r.userId === uid && (r.status === 'READ' || r.status === 'SEEN')))
                  const ackedOnServerR = isRepMe && !!repMsg.id && !pend
                  const tickVariantR: 'none' | 'ack' | 'read' = isRepMe
                    ? readByAnyR
                      ? 'read'
                      : ackedOnServerR
                        ? 'ack'
                        : 'none'
                    : 'none'
                  const tickColorOuter =
                    tickVariantR === 'read'
                      ? bubbleSelected
                        ? '#451a03'
                        : '#d97706'
                      : bubbleSelected
                        ? '#27272a'
                        : '#9aa0a8'
                  const renderTicksOuter = (opts?: { withLeftMargin?: boolean }) => {
                    if (tickVariantR === 'none') return null
                    const withLeftMargin = opts?.withLeftMargin ?? false
                    const common: React.CSSProperties = {
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      color: tickColorOuter,
                      marginLeft: withLeftMargin ? 6 : 0,
                      lineHeight: 0,
                      transform: 'translateY(1px)',
                      flexShrink: 0,
                    }
                    const strokeWidth = 2.2
                    return (
                      <span style={common} aria-label={tickVariantR === 'read' ? 'Read' : 'Sent'}>
                        {tickVariantR === 'read' ? (
                          <svg width={18} height={12} viewBox="0 0 18 12" fill="none" xmlns="http://www.w3.org/2000/svg">
                            <path d="M1 6.5L4.5 10L11.5 1" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
                            <path d="M7 6.5L10.5 10L17.5 1" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        ) : (
                          <svg width={12} height={12} viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg">
                            <path d="M1 6.5L4.5 10L11 1.5" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        )}
                      </span>
                    )
                  }
                  return (
                    <div className="msg-meta" style={{ marginTop: 8, color: bubbleSelected ? '#27272a' : '#9aa0a8' }}>
                      <span>{labelOuter}</span>
                      {editedOuter ? <span style={{ fontSize: 11, opacity: 0.9 }}>изменено</span> : null}
                      {renderTicksOuter({ withLeftMargin: false })}
                    </div>
                  )
                }
                const chatMessageRowCtx = { activeConversation, activeId, attachmentDecryptMap, attachmentHeadInfoMap, client, currentUserId, failedImages, fullList, groupIncomingBubbleBg, hashToGray, isMobile, leftAlignAll, loadedImages, me, messagesRef, multiSelectMode, nameColorForUser, nearBottomRef, nodesByMessageId, openUserCard, replyQuoteVisual, resolveAttachmentUrl, selectedMessageIds, setContextMenu, setFailedImages, setLightbox, setLoadedImages, setVideoViewer, toggleMessageMultiSelect, usersById, virtuosoRef, visibleObserver }
                const renderChatMessageAtIndex = (
                  rowIndex: number,
                  forwardBundleInner?: boolean,
                  forwardBundleInnerLast?: boolean,
                  bundleForwardSenderId?: string | null,
                  /** id первого сообщения конверта пересылки: выделение только «целым конвертом», не внутренними id */
                  forwardBundleRepresentativeMessageId?: string | null,
                  /** когда пересылка свёрнута в бабл с комментарием — не дублируем галочки/время на представителе внутри */
                  forwardBundleSuppressMetaFooter?: boolean,
                ) =>
                  extractedRenderChatMessageAtIndex(rowIndex, forwardBundleInner, forwardBundleInnerLast, bundleForwardSenderId, forwardBundleRepresentativeMessageId, forwardBundleSuppressMetaFooter, chatMessageRowCtx)
                const renderRowContent = (mapIndex: number): ReactNode => {
                  const m = fullList[mapIndex]
                  if (!m || m.deletedAt) return null
                  if (__fwdSkip.has(mapIndex)) return null
                  const rowKey = rowKeyByIndex.get(mapIndex)
                  if (rowKey == null) return null
                  const wrapRow = (node: ReactNode) => <div className="msg-row">{node}</div>
                  void rowKey
                  if (m.type === 'SYSTEM') {
                    return wrapRow(
                      <div key={m.id} className="chat-system-message" style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', padding: '12px 16px', marginTop: 8 }}>
                        <div style={{ 
                          fontSize: 13, 
                          color: 'var(--text-muted)', 
                          textAlign: 'center',
                          fontStyle: 'italic',
                          opacity: 0.8
                        }}>
                          {renderMessageText(renderSystemMessageContent(m, currentUserId))}
                        </div>
                      </div>
                    )
                  }
                  const __fwdBundle = __fwdBundleByStart.get(mapIndex)
                  if (__fwdBundle) {
                    const m0 = fullList[__fwdBundle.start]
                    const prev0 = fullList[__fwdBundle.start - 1]
                    const isPrevSame0 = !!prev0 && prev0.senderId === m0.senderId
                    const isMe0 =
                      currentUserId != null &&
                      m0.senderId != null &&
                      String(m0.senderId) === String(currentUserId)
                    const baseRow0 = leftAlignAll ? 'msg left' : (isMe0 ? 'msg me' : 'msg them')
                    const bundleCanSel0 = forwardBundleHostCanMultiSelect(m0)
                    const bundleOuterSel0 =
                      multiSelectMode && bundleCanSel0 && selectedMessageIds.includes(String(m0.id))
                    const spacingClass0 = isPrevSame0 ? 'compact' : 'gap'
                    const rowClass0 = `${baseRow0} ${spacingClass0}${
                      multiSelectMode && bundleCanSel0 && leftAlignAll ? ' msg--multiselect-wide' : ''
                    }`
                    const idxs = Array.from(
                      { length: __fwdBundle.end - __fwdBundle.start + 1 },
                      (_, k) => __fwdBundle.start + k,
                    )
                    const isGroupConv0 = !!(activeConversation?.isGroup || (activeConversation?.participants?.length ?? 0) > 2)
                    const showAvatarBlock0 = leftAlignAll || isGroupConv0
                    const nextAfterBundle = fullList[__fwdBundle.end + 1]
                    const isLastOfRun0 =
                      !nextAfterBundle ||
                      nextAfterBundle.senderId == null ||
                      String(nextAfterBundle.senderId) !== String(m0.senderId)
                    const showAvatar0 = showAvatarBlock0 && isLastOfRun0
                    const avatarOnRight0 = !leftAlignAll && isGroupConv0 && isMe0
                    const avatarOnLeft0 = (leftAlignAll || isGroupConv0) && !avatarOnRight0
                    const senderUser0 = usersById[m0.senderId]
                    const avatarName0 =
                      senderUser0?.displayName ??
                      senderUser0?.username ??
                      (isMe0 ? (me?.displayName ?? me?.username ?? 'Me') : 'User')
                    const avatarId0 = senderUser0?.id ?? (isMe0 ? (me?.id ?? 'me') : 'user')
                    const avatarUrl0 =
                      senderUser0?.avatarUrl && String(senderUser0.avatarUrl).trim() ? senderUser0.avatarUrl : undefined
                    const bundleAvatarSlot = showAvatar0 ? (
                      <Avatar name={avatarName0} id={avatarId0} avatarUrl={avatarUrl0} onClick={senderUser0 ? () => openUserCard(senderUser0) : undefined} />
                    ) : (
                      <div className="avatar-spacer" />
                    )
                    const fwdComposerCaption0 = extractForwardComposerCaption(m0)
                    const baseBubble0Outer = leftAlignAll ? 'msg-bubble left' : isMe0 ? 'msg-bubble me' : 'msg-bubble them'
                    const soloForwardedContinuationTail0Outer =
                      hasForwardFromMeta(m0) &&
                      isMe0 &&
                      !leftAlignAll &&
                      !!nextAfterBundle &&
                      currentUserId != null &&
                      nextAfterBundle.senderId != null &&
                      String(nextAfterBundle.senderId) === String(currentUserId)
                    const wantsBubbleTail0Outer = isLastOfRun0 || soloForwardedContinuationTail0Outer
                    const bubbleClass0Outer = wantsBubbleTail0Outer
                      ? `${baseBubble0Outer} ${isMe0 && !leftAlignAll ? 'tail-right' : 'tail-left'}`
                      : baseBubble0Outer
                    const outerBg0Bubble =
                      isMe0 ? '#303845' : isGroupConv0 ? groupIncomingBubbleBg(m0.senderId) : hashToGray(m0.senderId)
                    const bubbleFg0Bubble = bundleOuterSel0 ? '#0a0a0a' : '#f1f3f6'
                    const bundleMessagesSlice0 = idxs.map((j) => fullList[j])
                    const forwardPhraseAfterName0 = formatForwardSourcePhraseAfterName(bundleMessagesSlice0)
                    const fwdCaptionNameColor0 = bundleOuterSel0 ? '#292524' : nameColorForUser(m0.senderId)
                    const onOuterFwdBubbleMultiClick0 = (e: React.MouseEvent) => {
                      if (!multiSelectMode || !bundleCanSel0) return
                      const t = e.target as HTMLElement
                      if (
                        t.closest(
                          '.msg-forward-bundle__item .msg,.msg-forward-bundle__item a[href],.msg-forward-bundle__item button,.msg-forward-bundle__item .reaction-emoji,.msg-forward-bundle__item .msg-reaction-rail-host,.msg-forward-bundle__item img,.msg-forward-bundle__item video,.msg-forward-bundle__item .msg-media-tile,.msg-forward-bundle__item .video-message-bubble',
                        )
                      )
                        return
                      const sel = typeof window.getSelection === 'function' ? window.getSelection() : null
                      if (sel && sel.toString().length > 0) return
                      e.preventDefault()
                      toggleMessageMultiSelect(m0.id)
                    }
                    if (!fwdComposerCaption0) {
                      return wrapRow(
                        <div
                          key={`multi-fwd-${m0.id}`}
                          className={`msg-forward-bundle-host forward-comment-wrap-host msg-forward-caption-nested ${rowClass0}`}
                          onClick={(e) => onForwardBundleHostMultiClick(e, m0.id)}
                        >
                          {!leftAlignAll && !isMe0 ? renderForwardBundleHostCheckbox(m0) : null}
                          {avatarOnLeft0 ? bundleAvatarSlot : null}
                          <div
                            className={`forward-comment-wrap ${bubbleClass0Outer}${bundleOuterSel0 ? ' msg-bubble--selected' : ''}`}
                            data-mid={m0.id}
                            ref={(el) => {
                              if (!el) {
                                nodesByMessageId.current.delete(m0.id)
                                return
                              }
                              nodesByMessageId.current.set(m0.id, el)
                              visibleObserver.current?.observe(el)
                            }}
                            style={{ ['--bubble-bg' as any]: outerBg0Bubble, ['--bubble-fg' as any]: bubbleFg0Bubble }}
                            onClick={(e) => {
                              onOuterFwdBubbleMultiClick0(e)
                              if (multiSelectMode && bundleCanSel0) return
                              if (!isMobile) return
                              const target = e.target as HTMLElement
                              if (
                                target.closest(
                                  'a, button, input, textarea, img, video, .reaction-emoji, .msg-reaction-rail-host, .video-message-bubble, .msg-forward-bundle__item .msg-bubble',
                                )
                              )
                                return
                              const selection = typeof window.getSelection === 'function' ? window.getSelection() : null
                              if (selection && selection.toString().length > 0) return
                              setContextMenu({ open: true, x: e.clientX, y: e.clientY, messageId: m0.id })
                            }}
                            onContextMenu={(e) => {
                              const target = e.target as HTMLElement
                              if (target.closest('.reaction-emoji')) {
                                e.preventDefault()
                                e.stopPropagation()
                                return
                              }
                              if (
                                target.closest(
                                  '.msg-forward-bundle__item .msg-bubble, .msg-forward-bundle__item a[href]',
                                )
                              )
                                return
                              e.preventDefault()
                              setContextMenu({ open: true, x: e.clientX, y: e.clientY, messageId: m0.id })
                            }}
                          >
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
                                lineHeight: 1.3,
                                marginBottom: 8,
                                color: fwdCaptionNameColor0,
                              }}
                            >
                              <span style={{ flexShrink: 0 }}>
                                {`${String(avatarName0).trim()} ${forwardPhraseAfterName0}`}
                              </span>
                              <Forward
                                size={14}
                                strokeWidth={2.6}
                                aria-hidden
                                style={{
                                  flexShrink: 0,
                                  opacity: 0.9,
                                  color: bundleOuterSel0 ? '#b45309' : 'var(--brand)',
                                }}
                              />
                            </div>
                            <div className="msg-forward-bundle-outer msg-forward-bundle-outer--nested-in-msg">
                              {idxs.map((j) => (
                                <div key={fullList[j].id} className="msg-forward-bundle__item">
                                  {renderChatMessageAtIndex(j, true, j === __fwdBundle.end, m0.senderId, m0.id, true)}
                                </div>
                              ))}
                            </div>
                            {renderForwardCaptionOuterBubbleMeta(m0, isMe0, !!bundleOuterSel0)}
                          </div>
                          {avatarOnRight0 ? bundleAvatarSlot : null}
                          {(leftAlignAll || isMe0) ? renderForwardBundleHostCheckbox(m0) : null}
                        </div>
                      )
                    }

                    return wrapRow(
                      <div
                        key={`multi-fwd-${m0.id}`}
                        className={`msg-forward-bundle-host forward-comment-wrap-host msg-forward-caption-nested ${rowClass0}`}
                        onClick={(e) => onForwardBundleHostMultiClick(e, m0.id)}
                      >
                        {!leftAlignAll && !isMe0 ? renderForwardBundleHostCheckbox(m0) : null}
                        {avatarOnLeft0 ? bundleAvatarSlot : null}
                        <div
                          className={`forward-comment-wrap ${bubbleClass0Outer}${bundleOuterSel0 ? ' msg-bubble--selected' : ''}`}
                          data-mid={m0.id}
                          ref={(el) => {
                            if (!el) {
                              nodesByMessageId.current.delete(m0.id)
                              return
                            }
                            nodesByMessageId.current.set(m0.id, el)
                            visibleObserver.current?.observe(el)
                          }}
                          style={{ ['--bubble-bg' as any]: outerBg0Bubble, ['--bubble-fg' as any]: bubbleFg0Bubble }}
                          onClick={(e) => {
                            onOuterFwdBubbleMultiClick0(e)
                            if (multiSelectMode && bundleCanSel0) return
                            if (!isMobile) return
                            const target = e.target as HTMLElement
                            if (
                              target.closest(
                                'a, button, input, textarea, img, video, .reaction-emoji, .msg-reaction-rail-host, .video-message-bubble, .msg-forward-bundle__item .msg-bubble',
                              )
                            )
                              return
                            const selection = typeof window.getSelection === 'function' ? window.getSelection() : null
                            if (selection && selection.toString()) return
                            setContextMenu({ open: true, x: e.clientX, y: e.clientY, messageId: m0.id })
                          }}
                          onContextMenu={(e) => {
                            const target = e.target as HTMLElement
                            if (target.closest('.reaction-emoji')) {
                              e.preventDefault()
                              e.stopPropagation()
                              return
                            }
                            if (
                              target.closest(
                                '.msg-forward-bundle__item .msg-bubble, .msg-forward-bundle__item a[href]',
                              )
                            )
                              return
                            e.preventDefault()
                            setContextMenu({ open: true, x: e.clientX, y: e.clientY, messageId: m0.id })
                          }}
                        >
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
                              lineHeight: 1.3,
                              marginBottom: 8,
                              color: fwdCaptionNameColor0,
                            }}
                          >
                            <span style={{ flexShrink: 0 }}>
                              {`${String(avatarName0).trim()} ${forwardPhraseAfterName0}`}
                            </span>
                            <Forward
                              size={14}
                              strokeWidth={2.6}
                              aria-hidden
                              style={{
                                flexShrink: 0,
                                opacity: 0.9,
                                color: bundleOuterSel0 ? '#b45309' : 'var(--brand)',
                              }}
                            />
                          </div>
                          <div className="msg-forward-bundle-outer msg-forward-bundle-outer--nested-in-msg">
                            {idxs.map((j) => (
                              <div key={fullList[j].id} className="msg-forward-bundle__item">
                                {renderChatMessageAtIndex(j, true, j === __fwdBundle.end, m0.senderId, m0.id, true)}
                              </div>
                            ))}
                          </div>
                          <div className="forward-composer-caption" style={{ marginTop: 10, wordBreak: 'break-word', overflowWrap: 'anywhere' }}>
                            {renderMessageText(fwdComposerCaption0)}
                          </div>
                          {renderForwardCaptionOuterBubbleMeta(m0, isMe0, !!bundleOuterSel0)}
                        </div>
                        {avatarOnRight0 ? bundleAvatarSlot : null}
                        {(leftAlignAll || isMe0) ? renderForwardBundleHostCheckbox(m0) : null}
                      </div>
                    )
                  }
                  const inAnyForwardBundle = __fwdBundles.some(
                    (b) => mapIndex >= b.start && mapIndex <= b.end,
                  )
                  if (hasForwardFromMeta(m) && !inAnyForwardBundle) {
                    const mS = m
                    const prevS = fullList[mapIndex - 1]
                    const isPrevSameS = !!prevS && prevS.senderId === mS.senderId
                    const isMeS =
                      currentUserId != null &&
                      mS.senderId != null &&
                      String(mS.senderId) === String(currentUserId)
                    const baseRowS = leftAlignAll ? 'msg left' : (isMeS ? 'msg me' : 'msg them')
                    const bundleCanSelS = forwardBundleHostCanMultiSelect(mS)
                    const bundleOuterSelS =
                      multiSelectMode && bundleCanSelS && selectedMessageIds.includes(String(mS.id))
                    const spacingClassS = isPrevSameS ? 'compact' : 'gap'
                    const rowClassS = `${baseRowS} ${spacingClassS}${
                      multiSelectMode && bundleCanSelS && leftAlignAll ? ' msg--multiselect-wide' : ''
                    }`
                    const isGroupConvS = !!(activeConversation?.isGroup || (activeConversation?.participants?.length ?? 0) > 2)
                    const showAvatarBlockS = leftAlignAll || isGroupConvS
                    const nextS = fullList[mapIndex + 1]
                    const isLastOfRunS =
                      !nextS ||
                      nextS.senderId == null ||
                      String(nextS.senderId) !== String(mS.senderId)
                    const showAvatarS = showAvatarBlockS && isLastOfRunS
                    const avatarOnRightS = !leftAlignAll && isGroupConvS && isMeS
                    const avatarOnLeftS = (leftAlignAll || isGroupConvS) && !avatarOnRightS
                    const senderUserS = usersById[mS.senderId]
                    const avatarNameS =
                      senderUserS?.displayName ??
                      senderUserS?.username ??
                      (isMeS ? (me?.displayName ?? me?.username ?? 'Me') : 'User')
                    const avatarIdS = senderUserS?.id ?? (isMeS ? (me?.id ?? 'me') : 'user')
                    const avatarUrlS =
                      senderUserS?.avatarUrl && String(senderUserS.avatarUrl).trim() ? senderUserS.avatarUrl : undefined
                    const singleFwdAvatarSlot = showAvatarS ? (
                      <Avatar name={avatarNameS} id={avatarIdS} avatarUrl={avatarUrlS} onClick={senderUserS ? () => openUserCard(senderUserS) : undefined} />
                    ) : (
                      <div className="avatar-spacer" />
                    )
                    const fwdComposerCaptionS = extractForwardComposerCaption(mS)
                    const baseBubbleSOuter = leftAlignAll ? 'msg-bubble left' : isMeS ? 'msg-bubble me' : 'msg-bubble them'
                    const soloForwardedContinuationTailSOuter =
                      hasForwardFromMeta(mS) &&
                      isMeS &&
                      !leftAlignAll &&
                      !!nextS &&
                      currentUserId != null &&
                      nextS.senderId != null &&
                      String(nextS.senderId) === String(currentUserId)
                    const wantsBubbleTailSOuter = isLastOfRunS || soloForwardedContinuationTailSOuter
                    const bubbleClassSOuter = wantsBubbleTailSOuter
                      ? `${baseBubbleSOuter} ${isMeS && !leftAlignAll ? 'tail-right' : 'tail-left'}`
                      : baseBubbleSOuter
                    const outerBgSBubble =
                      isMeS ? '#303845' : isGroupConvS ? groupIncomingBubbleBg(mS.senderId) : hashToGray(mS.senderId)
                    const bubbleFgSBubble = bundleOuterSelS ? '#0a0a0a' : '#f1f3f6'
                    const forwardPhraseAfterNameS = formatForwardSourcePhraseAfterName([mS])
                    const fwdCaptionNameColorS = bundleOuterSelS ? '#292524' : nameColorForUser(mS.senderId)
                    const onOuterFwdBubbleMultiClickS = (e: React.MouseEvent) => {
                      if (!multiSelectMode || !bundleCanSelS) return
                      const t = e.target as HTMLElement
                      if (
                        t.closest(
                          '.msg-forward-bundle__item .msg,.msg-forward-bundle__item a[href],.msg-forward-bundle__item button,.msg-forward-bundle__item .reaction-emoji,.msg-forward-bundle__item .msg-reaction-rail-host,.msg-forward-bundle__item img,.msg-forward-bundle__item video,.msg-forward-bundle__item .msg-media-tile,.msg-forward-bundle__item .video-message-bubble',
                        )
                      )
                        return
                      const sel = typeof window.getSelection === 'function' ? window.getSelection() : null
                      if (sel && sel.toString().length > 0) return
                      e.preventDefault()
                      toggleMessageMultiSelect(mS.id)
                    }
                    if (!fwdComposerCaptionS) {
                      return wrapRow(
                        <div
                          key={`single-fwd-${mS.id}`}
                          className={`msg-forward-bundle-host forward-comment-wrap-host msg-forward-caption-nested ${rowClassS}`}
                          onClick={(e) => onForwardBundleHostMultiClick(e, mS.id)}
                        >
                          {!leftAlignAll && !isMeS ? renderForwardBundleHostCheckbox(mS) : null}
                          {avatarOnLeftS ? singleFwdAvatarSlot : null}
                          <div
                            className={`forward-comment-wrap ${bubbleClassSOuter}${bundleOuterSelS ? ' msg-bubble--selected' : ''}`}
                            data-mid={mS.id}
                            ref={(el) => {
                              if (!el) {
                                nodesByMessageId.current.delete(mS.id)
                                return
                              }
                              nodesByMessageId.current.set(mS.id, el)
                              visibleObserver.current?.observe(el)
                            }}
                            style={{ ['--bubble-bg' as any]: outerBgSBubble, ['--bubble-fg' as any]: bubbleFgSBubble }}
                            onClick={(e) => {
                              onOuterFwdBubbleMultiClickS(e)
                              if (multiSelectMode && bundleCanSelS) return
                              if (!isMobile) return
                              const target = e.target as HTMLElement
                              if (
                                target.closest(
                                  'a, button, input, textarea, img, video, .reaction-emoji, .msg-reaction-rail-host, .video-message-bubble, .msg-forward-bundle__item .msg-bubble',
                                )
                              )
                                return
                              const selection = typeof window.getSelection === 'function' ? window.getSelection() : null
                              if (selection && selection.toString().length > 0) return
                              setContextMenu({ open: true, x: e.clientX, y: e.clientY, messageId: mS.id })
                            }}
                            onContextMenu={(e) => {
                              const target = e.target as HTMLElement
                              if (target.closest('.reaction-emoji')) {
                                e.preventDefault()
                                e.stopPropagation()
                                return
                              }
                              if (
                                target.closest(
                                  '.msg-forward-bundle__item .msg-bubble, .msg-forward-bundle__item a[href]',
                                )
                              )
                                return
                              e.preventDefault()
                              setContextMenu({ open: true, x: e.clientX, y: e.clientY, messageId: mS.id })
                            }}
                          >
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
                                lineHeight: 1.3,
                                marginBottom: 8,
                                color: fwdCaptionNameColorS,
                              }}
                            >
                              <span style={{ flexShrink: 0 }}>
                                {`${String(avatarNameS).trim()} ${forwardPhraseAfterNameS}`}
                              </span>
                              <Forward
                                size={14}
                                strokeWidth={2.6}
                                aria-hidden
                                style={{
                                  flexShrink: 0,
                                  opacity: 0.9,
                                  color: bundleOuterSelS ? '#b45309' : 'var(--brand)',
                                }}
                              />
                            </div>
                            <div className="msg-forward-bundle-outer msg-forward-bundle-outer--nested-in-msg">
                              <div className="msg-forward-bundle__item">
                                {renderChatMessageAtIndex(mapIndex, true, true, null, mS.id, true)}
                              </div>
                            </div>
                            {renderForwardCaptionOuterBubbleMeta(mS, isMeS, !!bundleOuterSelS)}
                          </div>
                          {avatarOnRightS ? singleFwdAvatarSlot : null}
                          {(leftAlignAll || isMeS) ? renderForwardBundleHostCheckbox(mS) : null}
                        </div>
                      )
                    }

                    return wrapRow(
                      <div
                        key={`single-fwd-${mS.id}`}
                        className={`msg-forward-bundle-host forward-comment-wrap-host msg-forward-caption-nested ${rowClassS}`}
                        onClick={(e) => onForwardBundleHostMultiClick(e, mS.id)}
                      >
                        {!leftAlignAll && !isMeS ? renderForwardBundleHostCheckbox(mS) : null}
                        {avatarOnLeftS ? singleFwdAvatarSlot : null}
                        <div
                          className={`forward-comment-wrap ${bubbleClassSOuter}${bundleOuterSelS ? ' msg-bubble--selected' : ''}`}
                          data-mid={mS.id}
                          ref={(el) => {
                            if (!el) {
                              nodesByMessageId.current.delete(mS.id)
                              return
                            }
                            nodesByMessageId.current.set(mS.id, el)
                            visibleObserver.current?.observe(el)
                          }}
                          style={{ ['--bubble-bg' as any]: outerBgSBubble, ['--bubble-fg' as any]: bubbleFgSBubble }}
                          onClick={(e) => {
                            onOuterFwdBubbleMultiClickS(e)
                            if (multiSelectMode && bundleCanSelS) return
                            if (!isMobile) return
                            const target = e.target as HTMLElement
                            if (
                              target.closest(
                                'a, button, input, textarea, img, video, .reaction-emoji, .msg-reaction-rail-host, .video-message-bubble, .msg-forward-bundle__item .msg-bubble',
                              )
                            )
                              return
                            const selection = typeof window.getSelection === 'function' ? window.getSelection() : null
                            if (selection && selection.toString()) return
                            setContextMenu({ open: true, x: e.clientX, y: e.clientY, messageId: mS.id })
                          }}
                          onContextMenu={(e) => {
                            const target = e.target as HTMLElement
                            if (target.closest('.reaction-emoji')) {
                              e.preventDefault()
                              e.stopPropagation()
                              return
                            }
                            if (
                              target.closest(
                                '.msg-forward-bundle__item .msg-bubble, .msg-forward-bundle__item a[href]',
                              )
                            )
                              return
                            e.preventDefault()
                            setContextMenu({ open: true, x: e.clientX, y: e.clientY, messageId: mS.id })
                          }}
                        >
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
                              lineHeight: 1.3,
                              marginBottom: 8,
                              color: fwdCaptionNameColorS,
                            }}
                          >
                            <span style={{ flexShrink: 0 }}>
                              {`${String(avatarNameS).trim()} ${forwardPhraseAfterNameS}`}
                            </span>
                            <Forward
                              size={14}
                              strokeWidth={2.6}
                              aria-hidden
                              style={{
                                flexShrink: 0,
                                opacity: 0.9,
                                color: bundleOuterSelS ? '#b45309' : 'var(--brand)',
                              }}
                            />
                          </div>
                          <div className="msg-forward-bundle-outer msg-forward-bundle-outer--nested-in-msg">
                            <div className="msg-forward-bundle__item">
                              {renderChatMessageAtIndex(mapIndex, true, true, null, mS.id, true)}
                            </div>
                          </div>
                          <div className="forward-composer-caption" style={{ marginTop: 10, wordBreak: 'break-word', overflowWrap: 'anywhere' }}>
                            {renderMessageText(fwdComposerCaptionS)}
                          </div>
                          {renderForwardCaptionOuterBubbleMeta(mS, isMeS, !!bundleOuterSelS)}
                        </div>
                        {avatarOnRightS ? singleFwdAvatarSlot : null}
                        {(leftAlignAll || isMeS) ? renderForwardBundleHostCheckbox(mS) : null}
                      </div>
                    )
                  }
                  return wrapRow(renderChatMessageAtIndex(mapIndex, false))
                }
                // Плоский список строк (в порядке rowKeyByIndex = хронология) + deps
                // для построчной мемоизации (React.memo в MessageListFlat). deps —
                // МАССИВ всего, что влияет на ВИЗУАЛ строки; если ничего не изменилось,
                // строка не перерисовывается (важно для больших чатов). Смещение lean в
                // сторону КОРРЕКТНОСТИ: лучше лишний ре-рендер, чем застывшая строка.
                //
                // id → сообщение: O(1) резолв цитат (иначе fullList.find = O(n) на строку).
                const __idMap = new Map<string, any>()
                for (const mm of fullList) {
                  const id = mm?.id ?? mm?.tempId
                  if (id != null) __idMap.set(String(id), mm)
                }
                // Сигнатура медиа-состояния строки: то, что живёт ВНЕ объекта сообщения
                // (loadedImages/failedImages/attachmentDecryptMap/attachmentHeadInfoMap,
                // ключ = att.url||idx). Без неё секретные картинки застыли бы на «Расшифровка…».
                const __mediaSig = (mm: any): string => {
                  const atts = mm?.attachments
                  if (!Array.isArray(atts) || atts.length === 0) return ''
                  let s = ''
                  for (let i = 0; i < atts.length; i++) {
                    const a = atts[i]
                    const url = a?.url
                    const k = url || String(i)
                    // loadedImages НЕ включаем: проявление картинки теперь локально в
                    // LazyImage (fade), строке перерисовываться не нужно. failedImages —
                    // включаем (ошибка редкая, а оверлей ошибки рисует родитель).
                    if (failedImages[k]) s += 'F'
                    if (url) {
                      const d = attachmentDecryptMap[url]
                      if (d) s += 'd' + (d.status || '')
                      const hi = attachmentHeadInfoMap[url]
                      // Значения (не только наличие): вторая HEAD-догрузка дополняет
                      // fileName→+mime/size, а карточка файла показывает размер/тип.
                      if (hi) s += 'h' + (hi.fileName || '') + '|' + (hi.mime || '') + '|' + (hi.size || '')
                    }
                    s += ';'
                  }
                  return s
                }
                // deps ОДНОЙ строки — ЛЕНИВО: MessageListFlat зовёт только для строк видимого
                // ОКНА, поэтому тяжёлый проход становится O(окно), а не O(весь чат). Это и есть
                // цена, которая раньше вешала подгрузку страницы на больших чатах.
                // «Сложные» строки → null (всегда перерисовываем): пересылки/бандлы (зависят от
                // неадъяцентных сообщений), мульти-цитаты (превью НЕСКОЛЬКИХ сообщений), «в
                // полёте» превью ссылки (скелетон на wall-clock 25с).
                // Подпись участников: меняется только при реальной смене состава/аватара/имени,
                // в отличие от идентичности объекта conversation (см. комментарий в deps ниже).
                const __participantsSig = (() => {
                  const parts = (activeConversation?.participants || []) as any[]
                  let s = ''
                  for (const p of parts) {
                    const u = p?.user
                    if (!u) continue
                    s += u.id + '|' + (u.avatarUrl || '') + '|' + (u.displayName || '') + ';'
                  }
                  return s
                })()
                const buildRowDeps = (mi: number): unknown[] | null => {
                  const m = fullList[mi]
                  const key = rowKeyByIndex.get(mi)
                  if (!m || !key) return null
                  const md = m?.metadata
                  const linkPreviewInFlight = !!(md?.linkPreviewAttemptedAt && !md?.linkPreview)
                  const multiReplyBundle = (parseReplyQuoteBundleEntries(m)?.length ?? 0) >= 2
                  if (key.startsWith('bundle:') || key.startsWith('forward:') || multiReplyBundle || linkPreviewInFlight) {
                    return null
                  }
                  const replyId = m?.replyTo?.id
                  const replyTarget = replyId != null ? __idMap.get(String(replyId)) : undefined
                  return [
                    m, // identity → контент/реакции/галочки/правки/replyTo/attachments/pending
                    fullList[mi - 1]?.senderId, // группировка: аватар/хвост/имя (сосед сверху)
                    fullList[mi + 1]?.senderId, // группировка (сосед снизу)
                    replyTarget, // цитируемое сообщение (правка/удаление меняет превью)
                    __mediaSig(m), // медиа-состояние ВНЕ объекта (загрузка/ошибка/дешифр)
                    replyTarget ? __mediaSig(replyTarget) : '', // медиа цитаты (миниатюра)
                    selectedMessageIds.includes(String(m?.id)), // выделение этой строки
                    // Общие для всего списка. ВАЖНО: только СКАЛЯРЫ/стабильные ссылки.
                    // Раньше здесь лежали объекты activeConversation/me/usersById, чья идентичность
                    // менялась при ЛЮБОЙ перезаписи кэша ['conversations'] (presence, refetch на
                    // фокусе, 20s-poll) → Object.is-компаратор MemoRow падал для ВСЕХ 150 строк и
                    // весь невиртуализированный список перерисовывался (300-700 мс за проход).
                    // На пробуждении вкладки таких проходов десятки — это и давало многосекундный столл.
                    multiSelectMode, leftAlignAll, isMobile,
                    activeConversation?.id, activeConversation?.isGroup,
                    __participantsSig, currentUserId, me?.id, me?.avatarUrl, me?.displayName,
                  ]
                }
                // Дешёвый список строк (только ключи, O(M) без аллокаций deps). Окно и ленивые
                // deps строит MessageListFlat.
                const rows: Array<{ mapIndex: number; key: string }> = []
                for (const [mi, key] of rowKeyByIndex) rows.push({ mapIndex: mi, key })
                virtuosoRowsRef.current = rows
                if (rows.length === 0) return null
                return (
                  <MessageListFlat
                    rows={rows}
                    renderRow={renderRowContent}
                    buildDeps={buildRowDeps}
                    activeId={activeId}
                    scrollElRef={messagesRef}
                    nearBottomRef={nearBottomRef}
                    onReachTop={() => { void loadOlderMessages() }}
                    setShowJump={setShowJump}
                    apiRef={virtuosoRef}
                  />
                )
              })()
            )}
          </div>
          {activeId && (
            <button
              className={showJump ? 'jump-bottom jump-bottom--visible' : 'jump-bottom'}
              onMouseDown={(e) => {
                // Prevent composer blur (toolbar collapse) from swallowing the click.
                e.preventDefault()
                virtuosoRef.current?.scrollToBottom?.(true)
                nearBottomRef.current = true
                userStickyScrollRef.current = false
                setShowJump(false)
              }}
              onClick={(e) => {
                // Keyboard activation: click has detail===0 (mouse is handled above).
                if ((e as any)?.detail > 0) return
                virtuosoRef.current?.scrollToBottom?.(true)
                nearBottomRef.current = true
                userStickyScrollRef.current = false
                setShowJump(false)
              }}
            >
              ↓
            </button>
          )}
          <div ref={composerBarRef} className="chat-composer-bar eb-no-drag" style={{ flexShrink: 0, display: 'flex', flexDirection: 'column' }}>
          {composerSelectionAnchor && composerSelectionToolbarStyle && createPortal(
            <div
              ref={composerSelectionToolbarRef}
              className="composer-sel-toolbar"
              style={composerSelectionToolbarStyle}
              role="toolbar"
              aria-label="Форматирование текста"
              onMouseDown={(e) => e.preventDefault()}
            >
              <button
                type="button"
                className={`composer-sel-toolbar__btn composer-sel-toolbar__btn--bold${composerSelectionFmt.bold ? ' is-active' : ''}`}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => applyComposerSelectionFormat('bold')}
                aria-label="Жирный"
                title="Жирный"
              >
                B
              </button>
              <button
                type="button"
                className={`composer-sel-toolbar__btn composer-sel-toolbar__btn--italic${composerSelectionFmt.italic ? ' is-active' : ''}`}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => applyComposerSelectionFormat('italic')}
                aria-label="Курсив"
                title="Курсив"
              >
                I
              </button>
              <button
                type="button"
                className={`composer-sel-toolbar__btn composer-sel-toolbar__btn--strike${composerSelectionFmt.strike ? ' is-active' : ''}`}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => applyComposerSelectionFormat('strikeThrough')}
                aria-label="Зачёркнутый"
                title="Зачёркнутый"
              >
                U
              </button>
            </div>,
            document.body,
          )}
          {/* Fixed-height typing row: always in DOM to avoid layout shift; visibility toggled via CSS + transition */}
          <div
            className={`chat-typing-row${Object.keys(typingByUserId).length > 0 ? ' chat-typing-row--visible' : ''}`}
            style={{
              flexShrink: 0,
              height: 'var(--chat-typing-row-h, 22px)',
              minHeight: 'var(--chat-typing-row-h, 22px)',
              display: 'flex',
              alignItems: 'center',
              padding: '0 16px',
              background: 'var(--surface-200)',
              pointerEvents: Object.keys(typingByUserId).length > 0 ? 'auto' : 'none',
            }}
            aria-live="polite"
          >
            {(() => {
              const ids = Object.keys(typingByUserId)
              const names = ids
                .filter((uid) => uid !== me?.id)
                .map((uid) => {
                  const u = usersById[uid]
                  return (u?.displayName ?? u?.username ?? 'Пользователь') as string
                })
                .filter(Boolean)
              const label =
                names.length === 0
                  ? ''
                  : names.length === 1
                    ? `${names[0]} печатает`
                    : 'несколько человек печатают'
              return (
                <>
                  <span>{label}</span>
                  {label ? (
                    <span className="chat-typing-bubble" aria-hidden>
                      <span className="chat-typing-bubble__dot" />
                      <span className="chat-typing-bubble__dot" />
                      <span className="chat-typing-bubble__dot" />
                    </span>
                  ) : null}
                </>
              )
            })()}
          </div>
          <div className="msg-input-bar eb-no-drag"
            style={{
              flexShrink: 0,
              // Keep composer visible even if CSS bundle changes.
              position: 'sticky',
              bottom: 0,
              background: 'var(--surface-200)',
              zIndex: 5,
              padding: '12px 16px',
              paddingBottom: 'max(12px, env(safe-area-inset-bottom, 0px))',
              borderTop: '1px solid var(--surface-border)',
            }}
          >
            <>
            {activeConversation?.isSecret && activeSecretUiState.readyState !== 'ready' && (
              <div
                style={{
                  marginBottom: 10,
                  padding: '10px 12px',
                  borderRadius: 10,
                  border: '1px solid var(--surface-border)',
                  background: 'rgba(13,148,136,0.10)',
                  color: 'var(--text-primary)',
                  fontSize: 13,
                  lineHeight: 1.25,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 10,
                }}
              >
                <div style={{ minWidth: 0 }}>
                  {(() => {
                    const isSecretV2 = String(activeConversation?.type ?? '').toUpperCase() === 'SECRET'
                    if (activeSecretUiState.readyState === 'bootstrapping') {
                      // v2 bootstrapping is typically "waiting for key package from the peer/creator"
                      if (isSecretV2) {
                        return activeSecretQueuedCount > 0
                          ? `🔒 Настраивается… ждём ключи от собеседника. ${activeSecretQueuedCount} сообщ. в очереди — отправим автоматически.`
                          : '🔒 Настраивается… ждём ключи от собеседника. Можно писать — отправим автоматически.'
                      }
                      return activeSecretQueuedCount > 0
                        ? `🔒 Настраивается… ${activeSecretQueuedCount} сообщ. в очереди, отправим автоматически.`
                        : '🔒 Настраивается… можно писать, отправим как только защита будет готова.'
                    }
                    return '⚠️ Секретный чат недоступен на этом устройстве.'
                  })()}
                </div>
                {activeSecretUiState.readyState === 'bootstrapping' &&
                  hasOtherTrustedDevice &&
                  String(activeConversation?.type ?? '').toUpperCase() !== 'SECRET' && (
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={() => setLinkDeviceModalOpen(true)}
                    style={{ flexShrink: 0 }}
                  >
                    Привязать устройство
                  </button>
                )}
              </div>
            )}
            {secretComposerInlineError && (
              <div
                style={{
                  marginBottom: 10,
                  padding: '10px 12px',
                  borderRadius: 10,
                  border: '1px solid rgba(239,68,68,0.25)',
                  background: 'rgba(239,68,68,0.08)',
                  color: '#fca5a5',
                  fontSize: 13,
                  lineHeight: 1.25,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                  <div style={{ minWidth: 0 }}>{secretComposerInlineError}</div>
                  {String(activeConversation?.type ?? '').toUpperCase() === 'SECRET' ? (
                    <div style={{ display: 'flex', gap: 8, flexShrink: 0, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                      <button
                        type="button"
                        className="btn btn-ghost"
                        onClick={() => {
                          try {
                            const threadId = String(activeConversation?.id ?? '').trim()
                            const peerUserId =
                              activeConversation?.participants?.find((p: any) => p?.user?.id && p.user.id !== currentUserId)?.user
                                ?.id ?? null
                            const amCreator = !!(me?.id && String(activeConversation?.createdById ?? '') === me.id)
                            if (threadId && peerUserId) {
                              if (secretEngineV2Enabled) {
                                void refreshKeysAndRetry({ threadId, peerUserId, amCreator }).catch(() => {})
                              } else {
                                void ensureSecretEngineReady({ threadId, peerUserId, amCreator }).catch(() => {})
                              }
                            }
                          } catch {}
                        }}
                      >
                        Восстановить
                      </button>
                      {hasOtherTrustedDevice ? (
                        <button type="button" className="btn btn-ghost" onClick={() => setLinkDeviceModalOpen(true)}>
                          Привязать устройство
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </div>
            )}
            {replyTo && !forwardComposerDraft && (
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 10, background: 'var(--surface-100)', padding: '8px 12px', borderRadius: 8, border: '1px solid var(--surface-border)' }}>
                <Quote size={16} strokeWidth={2.4} style={{ flexShrink: 0, marginTop: 2, color: 'var(--brand)' }} aria-hidden />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: replyTo.quoted.length > 1 ? 6 : 0 }}>
                    {formatReplyBundleHeader(replyTo.quoted.length)}
                  </div>
                  {replyTo.quoted.length === 1 ? (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                      {(() => {
                        const q0 = replyTo.quoted[0]
                        const turl = q0.replyImageStub ? resolveAttachmentUrl(q0.replyImageStub) : null
                        return turl ? (
                          <img
                            src={turl}
                            alt=""
                            style={{ width: 40, height: 40, borderRadius: 8, objectFit: 'cover', flexShrink: 0 }}
                          />
                        ) : null
                      })()}
                      {(() => {
                        const q0 = replyTo.quoted[0]
                        const turl = q0.replyImageStub ? resolveAttachmentUrl(q0.replyImageStub) : null
                        const txt = q0.preview
                        if (turl && replySnippetIsGenericRu(txt)) return null
                        return (
                          <div
                            style={{
                              flex: 1,
                              fontSize: 12,
                              color: 'var(--text-primary)',
                              whiteSpace: 'nowrap',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                            }}
                          >
                            {txt}
                          </div>
                        )
                      })()}
                    </div>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 96, overflow: 'hidden' }}>
                      {replyTo.quoted.slice(0, 5).map((q: any) => {
                        const tu = q.replyImageStub ? resolveAttachmentUrl(q.replyImageStub) : null
                        const hideTxt = !!(tu && replySnippetIsGenericRu(q.preview))
                        return (
                          <div key={q.id} style={{ display: 'flex', alignItems: 'center', gap: 6, minHeight: 0 }}>
                            {tu ? (
                              <img
                                src={tu}
                                alt=""
                                style={{ width: 28, height: 28, borderRadius: 6, objectFit: 'cover', flexShrink: 0 }}
                              />
                            ) : null}
                            {!hideTxt ? (
                              <div style={{ flex: 1, fontSize: 11, color: 'var(--text-primary)', lineHeight: 1.35, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                {q.preview}
                              </div>
                            ) : null}
                          </div>
                        )
                      })}
                      {replyTo.quoted.length > 5 ? (
                        <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>…ещё {replyTo.quoted.length - 5}</div>
                      ) : null}
                    </div>
                  )}
                </div>
                <button type="button" className="btn btn-icon btn-ghost" onClick={() => setReplyTo(null)} style={{ marginLeft: 'auto', flexShrink: 0 }}>
                  <X size={16} />
                </button>
              </div>
            )}
            {forwardComposerDraft && (
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 10, background: 'var(--surface-100)', padding: '8px 12px', borderRadius: 8, border: '1px solid var(--surface-border)' }}>
                <Forward size={16} strokeWidth={2.4} style={{ flexShrink: 0, marginTop: 2, color: 'var(--brand)' }} aria-hidden />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: forwardComposerDraft.previews.length > 1 ? 6 : 0 }}>
                    {forwardComposerDraft.previews.length > 1
                      ? `Переслать сообщения (${forwardComposerDraft.previews.length})`
                      : 'Переслать'}
                  </div>
                  {forwardComposerDraft.previews.length === 1 ? (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                      {(() => {
                        const row = forwardComposerDraft.previews[0]
                        const turl = row.imageStub ? resolveAttachmentUrl(row.imageStub) : null
                        return turl ? (
                          <img
                            src={turl}
                            alt=""
                            style={{ width: 40, height: 40, borderRadius: 8, objectFit: 'cover', flexShrink: 0 }}
                          />
                        ) : null
                      })()}
                      {(() => {
                        const row = forwardComposerDraft.previews[0]
                        const turl = row.imageStub ? resolveAttachmentUrl(row.imageStub) : null
                        const hide = !!(turl && replySnippetIsGenericRu(row.text))
                        if (hide) return null
                        return (
                          <div style={{ flex: 1, fontSize: 12, color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                            {row.text}
                          </div>
                        )
                      })()}
                    </div>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 96, overflow: 'hidden' }}>
                      {forwardComposerDraft.previews.slice(0, 5).map((row: any, idx: any) => {
                        const turl = row.imageStub ? resolveAttachmentUrl(row.imageStub) : null
                        const hide = !!(turl && replySnippetIsGenericRu(row.text))
                        return (
                          <div key={idx} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            {turl ? (
                              <img src={turl} alt="" style={{ width: 28, height: 28, borderRadius: 6, objectFit: 'cover', flexShrink: 0 }} />
                            ) : null}
                            {!hide ? (
                              <div style={{ flex: 1, fontSize: 11, color: 'var(--text-primary)', lineHeight: 1.35, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                {row.text}
                              </div>
                            ) : null}
                          </div>
                        )
                      })}
                      {forwardComposerDraft.previews.length > 5 ? (
                        <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>…ещё {forwardComposerDraft.previews.length - 5}</div>
                      ) : null}
                    </div>
                  )}
                </div>
                <button type="button" className="btn btn-icon btn-ghost" onClick={() => setForwardComposerDraft(null)} style={{ marginLeft: 'auto', flexShrink: 0 }} aria-label="Отменить пересылку">
                  <X size={16} />
                </button>
              </div>
            )}
            {pendingImages.length > 0 && (
              <div style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 6 }}>Изображения перед отправкой</div>
                <div style={{ display: 'flex', gap: 12, overflowX: 'auto', paddingBottom: 4 }}>
                  {pendingImages.map((img: any) => (
                    <div key={img.id} style={{ position: 'relative', flexShrink: 0, width: 132, background: 'var(--surface-100)', borderRadius: 12, border: '1px solid var(--surface-border)', padding: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
                      <button
                        className="btn btn-icon btn-ghost"
                        style={{ position: 'absolute', top: 4, right: 4 }}
                        onClick={() => {
                          if (editingImageId === img.id) setEditingImageId(null)
                          removeComposerImage(img.id)
                        }}
                        aria-label="Удалить изображение"
                      >
                        <X size={14} />
                      </button>
                      <button
                        type="button"
                        onClick={() => setEditingImageId(img.id)}
                        style={{ border: 'none', padding: 0, borderRadius: 8, overflow: 'hidden', cursor: 'pointer', background: 'transparent' }}
                        aria-label="Редактировать изображение"
                      >
                        <img src={img.previewUrl} alt={img.fileName} style={{ width: '100%', height: 90, objectFit: 'cover', display: 'block' }} />
                      </button>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                        <div style={{ fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{img.fileName}</div>
                        <button
                          type="button"
                          className="btn btn-ghost"
                          onClick={() => setEditingImageId(img.id)}
                          style={{ fontSize: 12, padding: '4px 6px', justifyContent: 'center' }}
                        >
                          Редактировать
                        </button>
                        {img.edited && (
                          <div style={{ fontSize: 10, color: '#34d399', textTransform: 'uppercase', letterSpacing: 0.5 }}>
                            Отредактировано
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {pendingFiles.length > 0 && (
              <div style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 6 }}>Файлы перед отправкой</div>
                <div style={{ display: 'flex', gap: 10, overflowX: 'auto', paddingBottom: 4 }}>
                  {pendingFiles.map((f: any) => (
                    <div
                      key={f.id}
                      style={{
                        position: 'relative',
                        flexShrink: 0,
                        minWidth: 220,
                        maxWidth: 320,
                        background: 'var(--surface-100)',
                        borderRadius: 12,
                        border: '1px solid var(--surface-border)',
                        padding: '10px 12px',
                        display: 'flex',
                        alignItems: 'center',
                        gap: 10,
                      }}
                    >
                      <button
                        className="btn btn-icon btn-ghost"
                        style={{ position: 'absolute', top: 4, right: 4 }}
                        onClick={() => removeComposerFile(f.id)}
                        aria-label="Удалить файл"
                        type="button"
                      >
                        <X size={14} />
                      </button>
                      <div style={{ width: 32, height: 32, borderRadius: 10, background: 'var(--surface-200)', border: '1px solid var(--surface-border)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                        <Paperclip size={16} color="var(--text-muted)" />
                      </div>
                      <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
                        <div style={{ fontSize: 12, color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          {f.fileName}
                        </div>
                        <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                          {formatAttachmentFileSize(f.size) || '—'}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
            <input type="file" multiple style={{ display: 'none' }} ref={attachInputRef} onChange={async (e) => {
              const files = Array.from(e.target.files || [])
              if (!activeId || files.length === 0) return
              if (editState) {
                e.target.value = ''
                return
              }
              if (forwardComposerDraft) {
                systemToast.error('Сначала отправьте или отмените пересылку — файлы из композера с ней не смешиваем.')
                e.target.value = ''
                return
              }
              const imageFiles = files.filter((file) => file.type.startsWith('image/'))
              const otherFiles = files.filter((file) => !file.type.startsWith('image/'))
              imageFiles.forEach((file) => addComposerImage(file, 'upload'))
              otherFiles.forEach((file) => addComposerFile(file, 'upload'))
              e.target.value = ''
            }} />
            {voiceRecording ? (
              <div style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '12px 16px', background: 'var(--surface-100)', borderRadius: 8, border: '1px solid var(--surface-border)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, flex: 1 }}>
                  <div style={{ width: 12, height: 12, borderRadius: '50%', background: '#ef4444', animation: 'pulse 1.5s ease-in-out infinite', flexShrink: 0 }} />
                  {/* Фиксированный контейнер для waveform - звук движется справа налево */}
                  <div 
                    ref={waveformContainerRef}
                    style={{ 
                      width: '100%', 
                      ...(isMobile ? { maxWidth: 200 } : {}), 
                      height: 24, 
                      overflow: 'hidden', 
                      position: 'relative',
                      flex: 1,
                      minWidth: 0,
                    }}
                  >
                    {(() => {
                      // Используем фиксированное количество баров (как при воспроизведении)
                      const barWidth = 2
                      const barGap = 2
                      const barTotalWidth = barWidth + barGap
                      const maxBars = isMobile ? 60 : waveformMaxBars
                      
                      // Если данных еще нет, показываем плейсхолдер
                      if (voiceWaveform.length === 0) {
                        return (
                          <div style={{ 
                            display: 'flex', 
                            alignItems: 'center', 
                            gap: barGap, 
                            height: 24,
                          }}>
                            {Array(maxBars).fill(0).map((_, i) => (
                              <div
                                key={i}
                                style={{
                                  width: barWidth,
                                  height: 12,
                                  background: 'var(--surface-border)',
                                  borderRadius: 1,
                                  animation: 'pulse 1.5s ease-in-out infinite',
                                  animationDelay: `${i * 0.1}s`,
                                  flexShrink: 0,
                                }}
                              />
                            ))}
                          </div>
                        )
                      }
                      
                      // Показываем waveform данные с прокруткой справа налево (как на ПК)
                      return (
                        <div style={{ 
                          display: 'flex', 
                          alignItems: 'center', 
                          gap: barGap, 
                          height: 24,
                          position: 'absolute',
                          right: 0,
                          // Сдвигаем влево: когда данных больше maxBars, каждый новый бар сдвигает весь waveform влево
                          transform: voiceWaveform.length > maxBars 
                            ? `translateX(-${(voiceWaveform.length - maxBars) * barTotalWidth}px)` 
                            : 'translateX(0)',
                          transition: 'none', // Убираем transition для мгновенного обновления
                        }}>
                          {/* Показываем последние maxBars баров, новые появляются справа */}
                          {voiceWaveform.slice(-maxBars).map((amplitude: any, index: any) => {
                            // Вычисляем высоту бара: минимум 4px, максимум 20px (как при воспроизведении)
                            const height = Math.max(4, (amplitude / 100) * 20)
                            return (
                              <div
                                key={`${voiceWaveform.length - maxBars + index}-${index}`}
                                style={{
                                  width: barWidth,
                                  height: `${height}px`,
                                  background: 'var(--brand)',
                                  borderRadius: 1,
                                  alignSelf: 'flex-end',
                                  flexShrink: 0,
                                }}
                              />
                            )
                          })}
                        </div>
                      )
                    })()}
                  </div>
                  <div style={{ fontSize: 14, color: 'var(--text-primary)', fontWeight: 500, whiteSpace: 'nowrap', flexShrink: 0 }}>
                    {Math.floor(voiceDuration / 60)}:{(voiceDuration % 60).toString().padStart(2, '0')}
                  </div>
                </div>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={cancelVoiceRecording}
                  style={{ flexShrink: 0 }}
                  aria-label="Отменить запись"
                >
                  <X size={16} />
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={stopVoiceRecording}
                  style={{ flexShrink: 0 }}
                  aria-label="Отправить голосовое сообщение"
                >
                  <Send size={16} />
                </button>
              </div>
            ) : (
              <>
            {editState && (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 10,
                  padding: '10px 12px',
                  background: 'var(--surface-100)',
                  border: '1px solid var(--surface-border)',
                  borderRadius: 10,
                  marginBottom: 10,
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 700, color: 'var(--text-primary)', fontSize: 13, lineHeight: '18px' }}>
                    Редактирование сообщения
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    Esc — отмена · Enter — сохранить · Shift+Enter — перенос строки
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
                  <button type="button" className="btn btn-ghost" onClick={cancelEdit} disabled={editBusy}>
                    Отмена
                  </button>
                  <button type="button" className="btn btn-primary" disabled={editBusy} onClick={() => { (composerEditorRef.current?.closest('form') as HTMLFormElement)?.requestSubmit?.() }}>
                    {editBusy ? 'Сохраняем...' : 'Сохранить'}
                  </button>
                </div>
              </div>
            )}
            <form autoComplete="off" onSubmit={async (e) => {
                    e.preventDefault()
              if (!activeId) return
              stopTyping(activeId)
              if (editBusy) return
              const value = getComposerValue().trim()

              if (editState) {
                const mid = editState.messageId
                if (!value) return
                setEditBusy(true)
                try {
                  await api.post('/messages/update', { messageId: mid, content: value })
                  setEditState(null)
                  setComposerValue('')
                  setReplyTo(null)
                } catch (err: any) {
                  console.error('Failed to update message:', err)
                  const status = err?.response?.status
                  const serverMsg = err?.response?.data?.message
                  const msg =
                    typeof serverMsg === 'string' && serverMsg.trim()
                      ? serverMsg
                      : status === 404
                        ? 'Сервер не поддерживает редактирование сообщений (обновите/перезапустите backend после сборки).'
                        : err?.message || 'Не удалось сохранить изменения'
                  systemToast.error(msg)
                  setEditState(null)
                } finally {
                  setEditBusy(false)
                }
                return
              }

              const draftFw = forwardComposerDraft
              if (
                draftFw &&
                activeConversation &&
                String(activeConversation.id) === draftFw.destinationConversationId
              ) {
                if (pendingImages.length > 0 || pendingFiles.length > 0) {
                  systemToast.error(
                    'При пересылке нельзя прикреплять файлы из композера. Отправьте без вложений или отмените пересылку крестиком.',
                  )
                  return
                }
                const comment = value
                const { lastOutcome } = await executeForwardPayloadDelivery(
                  activeConversation,
                  draftFw.payloads,
                  draftFw.mergeAsImageBulk,
                  comment,
                )
                if (lastOutcome?.outcome === 'blocked') return
                setForwardComposerDraft(null)
                setComposerValue('')
                setReplyTo(null)
                if (activeId) {
                  client.invalidateQueries({ queryKey: ['messages', activeId] })
                }
                setTimeout(() => {
                  if (messagesRef.current) messagesRef.current.scrollTop = 0 /* column-reverse: 0 == визуальный низ */
                }, 0)
                return
              }

              if (pendingImages.length > 0 || pendingFiles.length > 0) {
                const imagesSnapshot = pendingImages.map((img: any) => ({ file: img.file, previewUrl: img.previewUrl }))
                const filesSnapshot = pendingFiles.map((f: any) => f.file)
                setPendingImages([])
                setPendingFiles([])
                setEditingImageId(null)
                imagesSnapshot.forEach((entry: any) => releasePreviewUrl(entry.previewUrl))
                await uploadAndSendAttachments([...imagesSnapshot.map((entry: any) => entry.file), ...filesSnapshot], value || '', replyTo)
                setComposerValue('')
                setReplyTo(null)
              } else if (value) {
                    const replyMeta = buildReplyQuoteMetadataForSend(replyTo)
                    const r = await sendMessageToConversation(activeConversation, {
                      type: 'TEXT',
                      content: value,
                      replyToId: replyTo?.replyToId,
                      ...(replyMeta ? { metadata: replyMeta } : {}),
                    })
                    if (r?.outcome === 'blocked') return
                    setComposerValue('')
                    setReplyTo(null)
              }
                    if (activeId) {
                      client.invalidateQueries({ queryKey: ['messages', activeId] })
                    }
                    setTimeout(() => { if (messagesRef.current) messagesRef.current.scrollTop = 0 /* column-reverse: 0 == визуальный низ */ }, 0)
            }} style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => attachInputRef.current?.click()}
              disabled={!!editState || !!forwardComposerDraft}
              style={{
                flexShrink: 0,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: isMobile ? 0 : 6,
                whiteSpace: 'nowrap',
                height: 'var(--control-h)',
                minHeight: 'var(--control-h)',
                padding: '0 12px',
              }}
              aria-label="Прикрепить файлы"
            >
                <Paperclip size={16} />
                {!isMobile && <span>Загрузить</span>}
              </button>
              <div style={{ position: 'relative', flex: 1, minWidth: 0, display: 'flex' }}>
                {composerEmpty && (
                  <div
                    aria-hidden
                    style={{
                      position: 'absolute',
                      left: 16,
                      top: 12,
                      right: 16,
                      pointerEvents: 'none',
                      color: 'var(--text-muted)',
                      fontSize: 16,
                      lineHeight: '20px',
                    }}
                  >
                    {(pendingImages.length > 0 || pendingFiles.length > 0)
                      ? 'Добавьте подпись к вложениям...'
                      : forwardComposerDraft
                        ? 'Комментарий к пересылке (необязательно)…'
                        : 'Напишите сообщение...'}
                  </div>
                )}
                <div
                  ref={composerEditorRef}
                  contentEditable
                  suppressContentEditableWarning
                  role="textbox"
                  aria-multiline="true"
                  aria-placeholder={(pendingImages.length > 0 || pendingFiles.length > 0)
                      ? 'Добавьте подпись к вложениям...'
                      : forwardComposerDraft
                        ? 'Комментарий к пересылке (необязательно)…'
                        : 'Напишите сообщение...'}
                  onContextMenu={(e) => {
                    e.stopPropagation()
                  }}
                  onFocus={() => setComposerFocused(true)}
                  onBlur={() => {
                    setComposerFocused(false)
                    closeComposerSelectionToolbar()
                    if (activeId) stopTyping(activeId)
                  }}
                  onInput={() => {
                    const el = composerEditorRef.current
                    const empty = !el || !el.innerText?.trim()
                    setComposerEmpty(empty)
                    notifyTyping()
                    resizeComposer()
                    requestAnimationFrame(() => updateComposerSelectionToolbar())
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') {
                      if (editState) {
                        e.preventDefault()
                        closeComposerSelectionToolbar()
                        cancelEdit()
                        return
                      }
                      if (composerSelectionAnchor) {
                        e.preventDefault()
                        closeComposerSelectionToolbar({ collapseSelection: true })
                        return
                      }
                      if (forwardComposerDraft) {
                        e.preventDefault()
                        setForwardComposerDraft(null)
                        return
                      }
                    }
                    if (e.key === 'ArrowUp' && !editState) {
                      const noAttachments = pendingImages.length === 0 && pendingFiles.length === 0
                      if (composerEmpty && noAttachments && !forwardComposerDraft) {
                        const list = (displayedMessages ? [...displayedMessages] : [])
                          .filter((m: any) => !m?.deletedAt)
                          .sort((a: any, b: any) => new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime())
                        const last = list[list.length - 1]
                        if (last && last.senderId === me?.id && (last.type || 'TEXT') === 'TEXT' && (!last.attachments || last.attachments.length === 0)) {
                          e.preventDefault()
                          startEdit(last)
                          return
                        }
                      }
                    }
                    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                      e.preventDefault()
                      if (activeId) stopTyping(activeId)
                      const form = (e.currentTarget as HTMLElement).closest('form') as HTMLFormElement | null
                      if (!form) return
                      if (typeof (form as any).requestSubmit === 'function') {
                        (form as any).requestSubmit()
                      } else {
                        form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }))
                      }
                      return
                    }
                    if (e.ctrlKey || e.metaKey) {
                      const key = (e.key || '').toLowerCase()
                      if (key === 'b') {
                        e.preventDefault()
                        applyWysiwygFormat('bold')
                        requestAnimationFrame(() => updateComposerSelectionToolbar())
                        return
                      }
                      if (key === 'i') {
                        e.preventDefault()
                        applyWysiwygFormat('italic')
                        requestAnimationFrame(() => updateComposerSelectionToolbar())
                        return
                      }
                      if (e.shiftKey && key === 'x') {
                        e.preventDefault()
                        applyWysiwygFormat('strikeThrough')
                        requestAnimationFrame(() => updateComposerSelectionToolbar())
                        return
                      }
                    }
                  }}
                  onPaste={(e) => {
                    if (!activeId) return
                    if (forwardComposerDraft) {
                      const clipItems = e.clipboardData?.items
                      const hasClipboardImage =
                        !!clipItems &&
                        Array.from(clipItems).some((it) => typeof it.type === 'string' && it.type.indexOf('image') !== -1)
                      if (hasClipboardImage) {
                        e.preventDefault()
                        systemToast.error('При пересылке нельзя вставлять изображения из буфера. Вставьте только текст или отмените пересылку.')
                        return
                      }
                    }
                    const items = e.clipboardData?.items
                    if (!items) return
                    let hasText = false
                    let text = ''
                    try {
                      text = e.clipboardData?.getData('text/plain') ?? ''
                      hasText = !!text.length
                    } catch {
                      hasText = false
                    }
                    let pastedImage = false
                    for (let i = 0; i < items.length; i++) {
                      const item = items[i]
                      if (item.type.indexOf('image') !== -1) {
                        const file = item.getAsFile()
                        if (file) addComposerImage(file, 'paste')
                        pastedImage = true
                        break
                      }
                    }
                    if (pastedImage && !hasText) {
                      e.preventDefault()
                      return
                    }
                    if (hasText) {
                      if (insertPlainTextIntoComposer(text)) {
                        e.preventDefault()
                        setComposerEmpty(false)
                        notifyTyping()
                        resizeComposer()
                      }
                    }
                  }}
                  className="chat-md eb-no-drag"
                  style={{
                    flex: 1,
                    minWidth: 0,
                    padding: '12px 16px',
                    borderRadius: 'var(--radius-sm)',
                    border: `1px solid ${composerFocused ? 'var(--brand-600)' : 'var(--surface-border)'}`,
                    boxShadow: composerFocused ? '0 0 0 3px rgba(217,119,6,0.15)' : 'none',
                    background: 'var(--surface-100)',
                    color: 'var(--text-primary)',
                    fontSize: 16,
                    minHeight: 'var(--control-h)',
                    maxHeight: 'var(--composer-max-h)',
                    height: 'var(--control-h)',
                    lineHeight: '20px',
                    overflowY: 'hidden',
                    outline: 'none',
                    transition: 'border-color .2s ease, box-shadow .2s ease',
                  }}
                />
              </div>
              <button
                type="button"
                className="btn btn-secondary"
                  onClick={startVoiceRecording}
                  disabled={!!editState || !!forwardComposerDraft}
                style={{
                  flexShrink: 0,
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: isMobile ? 0 : 6,
                  whiteSpace: 'nowrap',
                  height: 'var(--control-h)',
                  minHeight: 'var(--control-h)',
                  padding: '0 12px',
                }}
                aria-label="Записать голосовое сообщение"
              >
                <Mic size={16} />
                {!isMobile && <span>Голос</span>}
              </button>
              <button
                type="submit"
                className="btn btn-primary"
                disabled={editBusy}
                aria-label={editState ? (editBusy ? 'Сохраняем…' : 'Сохранить') : 'Отправить'}
                style={{
                  flexShrink: 0,
                  whiteSpace: 'nowrap',
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: isMobile ? 0 : 6,
                  height: 'var(--control-h)',
                  minHeight: 'var(--control-h)',
                  padding: '0 12px',
                }}
              >
                <Send size={16} />
                {!isMobile && <span>{editState ? (editBusy ? 'Сохраняем...' : 'Сохранить') : 'Отправить'}</span>}
              </button>
            </form>
              </>
            )}
            {attachUploading && (
              <div
                style={{
                  marginTop: 10,
                  padding: '10px 12px',
                  borderRadius: 14,
                  border: '1px solid var(--surface-border)',
                  background: 'color-mix(in srgb, var(--surface-100) 88%, transparent)',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 8 }}>
                  <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, minWidth: 0, fontSize: 13, color: 'var(--text-primary)', fontWeight: 600 }}>
                    {attachUploadState === 'processing' ? (
                      <Loader2 size={14} style={{ animation: 'spin 1s linear infinite', flexShrink: 0, color: 'var(--brand)' }} />
                    ) : (
                      <UploadCloud size={14} style={{ flexShrink: 0, color: 'var(--brand)' }} />
                    )}
                    <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {attachUploadState === 'processing'
                        ? (ATTACH_PROCESSING_MESSAGES[attachProcessingMessageIndex]?.title ?? '🔐 Шифруем файл (AES-256-GCM)')
                        : 'Загрузка файла...'}
                    </span>
                  </div>
                  <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                    <span>{attachUploadState === 'processing' ? '100%' : `${attachProgress}%`}</span>
                    <button
                      type="button"
                      onClick={() => { void cancelActiveAttachUpload() }}
                      disabled={attachCanceling}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 6,
                        borderRadius: 999,
                        border: '1px solid var(--surface-border)',
                        background: 'color-mix(in srgb, var(--surface-200) 92%, transparent)',
                        color: 'var(--text-primary)',
                        padding: '7px 14px',
                        minHeight: 34,
                        fontSize: 13,
                        fontWeight: 600,
                        cursor: attachCanceling ? 'default' : 'pointer',
                        opacity: attachCanceling ? 0.7 : 1,
                        boxShadow: '0 1px 2px rgba(0,0,0,0.16)',
                      }}
                    >
                      {attachCanceling ? (
                        <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} />
                      ) : (
                        <X size={14} />
                      )}
                      <span>{attachCanceling ? 'Отменяем...' : 'Отменить'}</span>
                    </button>
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 8, fontSize: 12, color: 'var(--text-muted)', minHeight: 16 }}>
                  <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {attachCanceling
                      ? 'Прерываем загрузку и удаляем временный файл...'
                      : attachUploadState === 'processing'
                      ? (ATTACH_PROCESSING_MESSAGES[attachProcessingMessageIndex]?.detail ?? 'Каждый блок защищён отдельной подписью')
                      : attachUploadSpeed}
                  </span>
                  <span style={{ flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>
                    {attachUploadState === 'processing' ? '100%' : `${attachProgress}%`}
                  </span>
                </div>
                <div style={{ height: 6, background: 'var(--surface-100)', borderRadius: 3, overflow: 'hidden' }}>
                  <div
                    style={{
                      width: `${attachUploadState === 'processing' ? 100 : attachProgress}%`,
                      height: '100%',
                      background: attachUploadState === 'processing'
                        ? 'linear-gradient(90deg, var(--brand), rgba(255,255,255,0.65), var(--brand))'
                        : 'var(--brand)',
                      backgroundSize: attachUploadState === 'processing' ? '200% 100%' : undefined,
                      animation: attachUploadState === 'processing' ? 'eb-shimmer 1.6s linear infinite, pulse 1.8s ease-in-out infinite' : undefined,
                      transition: 'width 0.2s ease',
                    }}
                  />
                </div>
              </div>
            )}
            </>
          </div>
          </div>
        </div>
        <ImageEditorModal
          open={!!editingImage}
          image={editingImage}
          onClose={() => setEditingImageId(null)}
          onApply={({ file, previewUrl }) => {
            if (!editingImage) return
            applyComposerImageEdit(editingImage.id, file, previewUrl)
            setEditingImageId(null)
          }}
        />
        {outgoingCall && (() => {
          const conv = conversationsQuery.data?.find((r: any) => r.conversation.id === outgoingCall.conversationId)?.conversation
          const isGroup = conv?.isGroup || (conv?.participants?.length ?? 0) > 2
          // Не показываем экран дозвона для групповых бесед
          if (isGroup) {
            return null
          }
          let displayName = 'Неизвестный'
          let avatarUrl: string | undefined = undefined
          let avatarId: string = outgoingCall.conversationId
          if (isGroup) {
            displayName = conv?.title ?? 'Группа'
            avatarUrl = conv?.avatarUrl
            avatarId = outgoingCall.conversationId
          } else {
            const otherParticipant = conv?.participants?.find((p: any) => p.user.id !== me?.id)?.user
            if (otherParticipant) {
              displayName = otherParticipant.displayName ?? otherParticipant.username ?? otherParticipant.id ?? 'Неизвестный'
              avatarUrl = otherParticipant.avatarUrl
              avatarId = otherParticipant.id
            } else {
              // Fallback: попробуем получить из contacts
              const contact = contactsQuery.data?.find((c: any) => {
                const convIds = c.conversationIds || []
                return convIds.includes(outgoingCall.conversationId)
              })
              if (contact?.friend) {
                displayName = contact.friend.displayName ?? contact.friend.username ?? contact.friend.id ?? 'Неизвестный'
                avatarUrl = contact.friend.avatarUrl
                avatarId = contact.friend.id
              }
            }
          }
          const elapsed = Math.floor((Date.now() - outgoingCall.startedAt) / 1000)
          const minutes = Math.floor(elapsed / 60)
          const seconds = elapsed % 60
          const timeStr = `${minutes}:${seconds.toString().padStart(2, '0')}`
          return createPortal(
            <div style={{ position: 'fixed', inset: 0, background: 'rgba(10,12,16,0.55)', backdropFilter: 'blur(4px) saturate(110%)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1001 }}>
              <div style={{ background: 'var(--surface-200)', borderRadius: 16, border: '1px solid var(--surface-border)', padding: 24, width: 'min(92vw, 440px)', boxShadow: 'var(--shadow-sharp)', transform: 'translateY(-4vh)', color: 'var(--text-primary)' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
                  <div style={{ fontWeight: 700 }}>{outgoingCall.video ? 'Видеозвонок' : 'Звонок'}</div>
                  {!outgoingCall.minimized && (
                    <button
                      className="btn btn-icon btn-ghost"
                      onClick={() => {
                        setOutgoingCall((prev: any) => prev ? { ...prev, minimized: true } : null)
                      }}
                      style={{ padding: 8 }}
                    >
                      <Minus size={18} />
                    </button>
                  )}
                </div>
                <div className="caller-tile" style={{ display: 'flex', alignItems: 'center', gap: 12, padding: 12, background: 'var(--surface-100)', border: '1px solid var(--surface-border)', borderRadius: 12, marginBottom: 16 }}>
                  <Avatar
                    name={displayName}
                    id={avatarId}
                    size={64}
                    avatarUrl={avatarUrl}
                  />
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 600, fontSize: 16 }}>{displayName}</div>
                    <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>дозвон…</div>
                  </div>
                  <div style={{ fontSize: 18, fontWeight: 600, color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums' }}>
                    {timeStr}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button
                    className="btn"
                    style={{ background: 'var(--danger)', color: '#fff', flex: 1, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '14px 16px', minHeight: 48, borderRadius: 12 }}
                    onClick={() => {
                      if (outgoingCallTimerRef.current) {
                        window.clearTimeout(outgoingCallTimerRef.current)
                        outgoingCallTimerRef.current = null
                      }
                      stopDialingSound()
                      playEndCallSound()
                      endCall(outgoingCall.conversationId)
                      setOutgoingCall(null)
                      setActiveCalls((prev: any) => {
                        const current = prev[outgoingCall.conversationId]
                        if (current?.active) {
                          return { ...prev, [outgoingCall.conversationId]: { ...current, active: false, endedAt: Date.now() } }
                        }
                        const { [outgoingCall.conversationId]: _omit, ...rest } = prev
                        return rest
                      })
                      callStore.endCall()
                    }}
                  >
                    <PhoneOff size={18} />
                    <span>Сбросить</span>
                  </button>
                  {outgoingCall.minimized && (
                    <button
                      className="btn btn-primary"
                      style={{ flex: 1, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '14px 16px', minHeight: 48, borderRadius: 12 }}
                      onClick={() => {
                        setOutgoingCall((prev: any) => prev ? { ...prev, minimized: false } : null)
                      }}
                    >
                      <Maximize2 size={18} />
                      <span>Развернуть</span>
                    </button>
                  )}
                </div>
              </div>
            </div>, document.body)
        })()}
        {callStore.incoming && callStore.incoming.source !== 'android_native' && createPortal(
          <div style={{ position: 'fixed', inset: 0, background: 'rgba(10,12,16,0.55)', backdropFilter: 'blur(4px) saturate(110%)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1001 }}>
            <div style={{ background: 'var(--surface-200)', borderRadius: 16, border: '1px solid var(--surface-border)', padding: 24, width: 'min(92vw, 440px)', boxShadow: 'var(--shadow-sharp)', transform: 'translateY(-4vh)', color: 'var(--text-primary)' }}>
              <div style={{ fontWeight: 700, marginBottom: 12 }}>{callStore.incoming.video ? 'Входящий видеозвонок' : 'Входящий аудиозвонок'}</div>
              <div className="caller-tile" style={{ display: 'flex', alignItems: 'center', gap: 12, padding: 12, background: 'var(--surface-100)', border: '1px solid var(--surface-border)', borderRadius: 12, marginBottom: 12 }}>
                <Avatar
                  name={(callStore.incoming.from.name ?? callStore.incoming.from.id)}
                  id={callStore.incoming.from.id}
                  size={64}
                  avatarUrl={
                    callStore.incoming.from.avatarUrl ??
                    (conversationsQuery.data?.find((r: any) => r.conversation.id === callStore.incoming!.conversationId)?.conversation?.participants?.find((p: any) => p.user.id === callStore.incoming!.from.id)?.user?.avatarUrl) ??
                    (contactsQuery.data?.find((c: any) => c.friend?.id === callStore.incoming!.from.id)?.friend?.avatarUrl) ??
                    undefined
                  }
                />
                <div>
                  <div style={{ fontWeight: 600, fontSize: 16 }}>{callStore.incoming.from.name ?? callStore.incoming.from.id}</div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>звонит…</div>
                </div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button className="btn btn-primary" style={{ flex: 1, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '14px 16px', minHeight: 48, borderRadius: 12 }} onClick={() => { void acceptIncomingCallAction({ callId: callStore.incoming?.callId ?? callStore.incoming?.conversationId, conversationId: callStore.incoming?.conversationId, isVideo: false }, 'web_ui') }}>
                    <Phone size={18} />
                    <span>Ответить</span>
                  </button>
                  <button className="btn" style={{ background: 'transparent', color: 'var(--brand-600)', border: '1px solid var(--brand-600)', flex: 1, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '14px 16px', minHeight: 48, borderRadius: 12 }} onClick={() => { void acceptIncomingCallAction({ callId: callStore.incoming?.callId ?? callStore.incoming?.conversationId, conversationId: callStore.incoming?.conversationId, isVideo: true }, 'web_ui') }}>
                    <Video size={18} />
                    <span>Ответить с видео</span>
                  </button>
                </div>
                <div style={{ display: 'flex' }}>
                  <button className="btn" style={{ background: 'var(--danger)', color: '#fff', width: '100%', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '14px 16px', minHeight: 48, borderRadius: 12 }} onClick={() => { void declineIncomingCallAction({ callId: callStore.incoming?.callId ?? callStore.incoming?.conversationId, conversationId: callStore.incoming?.conversationId }, 'web_ui') }}>
                    <PhoneOff size={18} />
                    <span>Отклонить</span>
                  </button>
                </div>
                {callPermissionError && (
                  <div style={{ marginTop: 12, fontSize: 13, color: '#fca5a5', textAlign: 'center', lineHeight: 1.4 }}>
                    {callPermissionError}
                  </div>
                )}
              </div>
            </div>
          </div>, document.body)
        }
      </section>
    )
}
