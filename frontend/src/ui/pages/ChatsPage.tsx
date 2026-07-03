import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, lazy, Suspense, Fragment, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import { api, getUploadUrl } from '../../utils/api'
import type { AxiosError } from 'axios'
import { socket, connectSocket, onConversationNew, onConversationDeleted, onConversationUpdated, onConversationMemberRemoved, onSecretChatAccepted, inviteCall, onIncomingCall, onCallAccepted, onCallDeclined, onCallEnded, onCallGlare, acceptCall, declineCall, endCall, onReceiptsUpdate, onPresenceUpdate, onPresenceGame, onPresenceGameSnapshot, onPresenceGameSnapshotBatch, subscribePresenceGame, helloPresenceGame, onContactRequest, onContactAccepted, onContactRejected, onContactRemoved, onProfileUpdate, onCallStatus, onCallStatusBulk, requestCallStatuses, joinConversation, joinCallRoom, leaveCallRoom, type PresenceGamePayload, type PresenceGameSnapshotBatchPayload } from '../../core/realtime'
import { Phone, Video, X, PlusCircle, Users, UserPlus, BellRing, Copy, UploadCloud, CheckCircle, ArrowLeft, Paperclip, PhoneOff, Trash2, Maximize2, Minus, LogOut, Lock, Unlock, MoreVertical, Mic, Send, Bold, Italic, Strikethrough, Code, Quote, Link2, Monitor, Smartphone, Tablet, ImagePlus, MessageCircle, Loader2, ChevronUp, RefreshCw, Check, Forward, Pencil } from 'lucide-react'
import { AvailabilityButton } from '../../features/availability/AvailabilityButton'
import { AvailabilityOverlay } from '../../features/availability/AvailabilityOverlay'
import { getFallbackTimeZone } from '../../features/availability/availability.time'
const CallOverlay = lazy(() => import('../components/CallOverlay').then(m => ({ default: m.CallOverlay })))
const preloadCallOverlay = () => import('../components/CallOverlay')
import { useAppStore } from '../../domain/store/appStore'
import { Avatar } from '../components/Avatar'
import { UserProfileCard, UserProfileHero } from '../components/UserProfileCard'
import { ImageEditorModal } from '../components/ImageEditorModal'
import { ImageLightbox } from '../components/ImageLightbox'
import { VideoViewer } from '../components/VideoViewer'
import { VideoMessageBubble } from '../components/VideoMessageBubble'
import { LazyImage } from '../components/LazyImage'
import { LinkDeviceModal } from '../components/LinkDeviceModal'
import LoadingSpinner from '../components/LoadingSpinner'
import { systemConfirm, systemToast } from '../../domain/store/systemUiStore'
import { useCallStore } from '../../domain/store/callStore'
import { ensureDeviceBootstrap, getStoredDeviceInfo, rebootstrapDevice, isElectron } from '../../domain/device/deviceManager'
import { wipeLocalDeviceData } from '../../domain/device/deviceWipe'
import { e2eeManager } from '../../domain/e2ee/e2eeManager'
import { hasSecretThreadKey, ensureSecretThreadKey } from '../../domain/secret/secretThreadKeyStore'
import { shareSecretThreadKeyToDevice } from '../../domain/secret/secretThreadSetup'
import { fetchSecretHistory, sendSecretThreadText, transformSecretHistoryItemToMessage } from '../../domain/secret/secretThreadMessaging'
import { getLastPendingShareAt, getPendingDeviceIds, getReceiptDeviceIds } from '../../domain/secret/secretKeyShareState'
import { isSecretEngineV2Enabled } from '../../domain/secretV2/featureFlag'
import { ensureReady as ensureSecretEngineReady, getThreadView as getSecretEngineThreadView, refreshKeysAndRetry, subscribeSecretThreadState, type SecretReasonCode } from '../../domain/secretV2'
import { ensureMediaPermissions, convertToProxyUrl, extractObjectKeyFromUrl } from '../../utils/media'
import { VoiceRecorder } from '../../utils/voiceRecorder'
import { extractFirstPreviewableUrl } from '../../js/link-detect'
import { renderChatMarkdownToHtml, htmlToMarkdown } from '../lib/chatMarkdown'
import { renderMessageText } from './chats/chatsTextRender'
import { openUrlSystemBrowser } from './chats/chatsEmbeds'
import { LinkPreviewCard } from './chats/components/LinkPreviewCard'
import { MessageReactionRail } from './chats/components/MessageReactionRail'
import { isChatsRoute, withAppRoutePrefix } from '../../core/navigation/routes'
import { signalApkIncomingAccepted, signalApkOutgoingStarted } from '../../utils/apkCallSignal'
import { shouldShowAudioUnlockPrompt } from '../../utils/audioUnlock'
import { copyImageFromUrl, copyPlainText } from '../../utils/clipboard'
import { formatRegistrationInviteCodeForDisplay } from '../../utils/formatRegistrationInviteCode'
import { VoiceMessagePlayer } from './chats/components/VoiceMessagePlayer'
import { DeviceLinkInline } from './chats/components/DeviceLinkInline'
import { useChatAudio } from './chats/hooks/useChatAudio'
import { useChatSocketSubscriptions } from './chats/hooks/useChatSocketSubscriptions'
import { useChatTyping } from './chats/hooks/useChatTyping'
import { useChatsResponsive } from './chats/hooks/useChatsResponsive'
import { useChatUiStore } from '../../core/chat-sync/chatUiStore'
import { renderActiveCallOverlay } from './chats/render/CallOverlayHost'
import { renderConversationList } from './chats/render/ConversationListPane'
import { renderMessagesPane } from './chats/render/MessagesPane'
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
} from './chats/chatsEblo'
import {
  acceptIncomingCallAction,
  declineIncomingCallAction,
  endActiveCallAction,
  registerActiveCallRuntime,
  registerIncomingCallRuntime,
  type ResolvedActiveCall,
  type ResolvedIncomingCall,
} from '../../core/call-state/incomingCallActions'
import {
  NAME_COLOR_PALETTE_13,
  NAME_COLOR_PALETTE_26,
  BUBBLE_BG_BASES,
} from './chats/chatsColors'
import {
  LAST_ACTIVE_CONVERSATION_KEY,
  MIN_OUTGOING_CALL_DURATION_MS,
  MAX_PENDING_IMAGES,
  MAX_PENDING_FILES,
  MESSAGES_PAGE_SIZE,
  EMPTY_EBLID_DIGITS,
} from './chats/chatsConstants'
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
} from './chats/chatsAttachments'
import {
  formatMessageClockLabel,
  formatRuRelativeSendDay,
  ruPluralDaysAgo,
  formatSmallBubbleTimeLabel,
} from './chats/chatsTime'
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
} from './chats/chatsMessages'





/**
 * ChatsPage — корневой экран мессенджера: список бесед (сайдбар), открытая беседа
 * (сообщения + композер) и слой звонков. Это самый большой компонент приложения;
 * чистая (не зависящая от состояния) логика вынесена в соседние модули `./chats/*`
 * (см. chats/README.md), а здесь остаётся компонент со своим состоянием и рендером.
 *
 * ВЫНЕСЕННЫЕ МОДУЛИ (детали — в chats/README.md):
 *   • chatsConstants / chatsColors            — константы и цветовые палитры
 *   • chatsAttachments                        — типы и хелперы вложений/файлов
 *   • chatsTime                               — форматирование времени/дат (ru-RU)
 *   • chatsMessages                           — «модель сообщения»: метаданные,
 *                                               reply-черновики, forward-логика
 *   • chatsEblo                               — виртуализация списка (EbloMeasuredRow)
 *   • chatsTextRender / chatsEmbeds           — рендер текста и встраиваемых ссылок
 *   • components/*                            — VoiceMessagePlayer, LinkPreviewCard,
 *                                               MessageReactionRail, DeviceLinkInline…
 *   • hooks/*                                 — useChatAudio, useChatTyping,
 *                                               useChatSocketSubscriptions, useChatsResponsive
 *
 * КАРТА ВНУТРЕННЕЙ СТРУКТУРЫ (крупные регионы по порядку в файле):
 *   1. Состояние, рефы, запросы данных, производные значения
 *   2. Секретные чаты (старт/отправка/очередь ключей)         — регион «SECRET CHAT»
 *   3. Подгрузка истории вверх (loadOlderMessages)            — регион «OLDER MESSAGES»
 *   4. Виртуализация списка + прилипание к низу (Eblo)         — регион «MESSAGE LIST VIEWPORT»
 *   5. Отправка/реакции/выделение/звонки и прочая логика
 *   6. renderConversationList(mobile)  — рендер сайдбара со списком бесед
 *   7. renderMessagesPane(mobile)      — рендер открытой беседы (шапка/сообщения/композер)
 *   8. renderActiveCallOverlay()       — рендер оверлея активного звонка
 *   9. return (...)                    — сборка экрана из вышеперечисленного
 *
 * Дальнейшая декомпозиция (вынос вьюпорт-хука и под-компонентов рендера) возможна,
 * но требует аккуратной пошаговой работы — логика прокрутки/виртуализации тесно
 * переплетена с подгрузкой истории и композером.
 */
export default function ChatsPage() {
  const navigate = useNavigate()
  const location = useLocation()
  const params = useParams<{ conversationId?: string }>()
  const activeId = useChatUiStore((state) => state.activeConversationId)
  const setActiveId = useChatUiStore((state) => state.setActiveConversationId)
  const markConversationJoined = useChatUiStore((state) => state.markConversationJoined)
  const callConvId = useCallStore((state) => state.overlayConvId)
  const setCallConvId = useCallStore((state) => state.setOverlayConvId)
  const minimizedCallConvId = useCallStore((state) => state.minimizedCallConvId)
  const setMinimizedCallConvId = useCallStore((state) => state.setMinimizedCallConvId)
  const outgoingCall = useCallStore((state) => state.outgoingCall)
  const setOutgoingCall = useCallStore((state) => state.setOutgoingCall)
  const outgoingCallRef = useRef<typeof outgoingCall>(null)
  useEffect(() => { outgoingCallRef.current = outgoingCall }, [outgoingCall])
  const outgoingCallTimerRef = useRef<number | null>(null)
  const [replyTo, setReplyTo] = useState<ReplyDraftState>(null)
  const [editState, setEditState] = useState<{
    messageId: string
    originalText: string
  } | null>(null)
  const [editBusy, setEditBusy] = useState(false)
  const [composerEmpty, setComposerEmpty] = useState(true)
  const [composerFocused, setComposerFocused] = useState(false)
  const composerEditorRef = useRef<HTMLDivElement | null>(null)
  const composerBarRef = useRef<HTMLDivElement | null>(null)
  const composerSelectionRangeRef = useRef<Range | null>(null)
  const composerSelectionToolbarRef = useRef<HTMLDivElement | null>(null)
  const [composerSelectionAnchor, setComposerSelectionAnchor] = useState<null | { left: number; top: number; bottom: number; width: number }>(null)
  const [composerSelectionFmt, setComposerSelectionFmt] = useState<{ bold: boolean; italic: boolean; strike: boolean }>({ bold: false, italic: false, strike: false })
  const [composerSelectionToolbarSize, setComposerSelectionToolbarSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 })
  const attachInputRef = useRef<HTMLInputElement | null>(null)
  const messagesRef = useRef<HTMLDivElement | null>(null)
  const messagesContentRef = useRef<HTMLDivElement | null>(null)
  const pinBurstRafRef = useRef<number>(0)
  type OlderMessagesMeta = { hasMore: boolean; nextCursor: string | null }
  const olderMetaByConvRef = useRef(new Map<string, OlderMessagesMeta>())

  const { isMobile, isMobileRef, isNarrowHeaderButtons, mobileView, setMobileView } = useChatsResponsive(activeId)
  useEffect(() => {
    const routeConversationId = typeof params.conversationId === 'string' ? params.conversationId : null
    if (routeConversationId && routeConversationId !== activeId) {
      setActiveId(routeConversationId)
    }
  }, [activeId, params.conversationId, setActiveId])

  const mobileNavGuardRef = useRef<{ from: string; to: string; at: number }>({ from: '', to: '', at: 0 })
  useEffect(() => {
    if (typeof window === 'undefined') return
    const mobile = window.innerWidth <= 768
    if (!mobile) return
    if (!isChatsRoute(location.pathname)) return
    const target =
      mobileView === 'list'
        ? withAppRoutePrefix(location.pathname, '/chats')
        : activeId
          ? withAppRoutePrefix(location.pathname, `/chats/${activeId}`)
          : null
    if (!target || location.pathname === target) return
    // Oscillation guard. This effect syncs mobile view-state -> URL; AppRuntimeCoordinator syncs
    // URL -> view-state. A one-render lag between them can ping-pong /chats <-> /chats/<id> ~50x/s,
    // remounting the whole screen (the "everything jitters" bug). If we are about to bounce straight
    // back to the route we just navigated away from, skip it and let the URL settle.
    const now = Date.now()
    const g = mobileNavGuardRef.current
    if (g.from === target && g.to === location.pathname && now - g.at < 700) return
    mobileNavGuardRef.current = { from: location.pathname, to: target, at: now }
    navigate(target, { replace: true })
  }, [activeId, location.pathname, mobileView, navigate])

  const {
    showAudioUnlock,
    setShowAudioUnlock,
    ringingConvIdRef,
    ringTimerRef,
    notifyUnlockedRef,
    ringUnlockedRef,
    ensureNotifyAudio,
    ensureRingAudio,
    performAudioUnlock,
    stopRingtone,
    startDialingSound,
    stopDialingSound,
    playEndCallSound,
    playNotifySoundIfAllowed,
  } = useChatAudio()

  const [leftAlignAll, setLeftAlignAll] = useState(false)
  const tm = useRef<{ pinTimer: number | null }>({ pinTimer: null })
  const [contextMenu, setContextMenu] = useState<{ open: boolean; x: number; y: number; messageId: string | null }>(() => ({ open: false, x: 0, y: 0, messageId: null }))
  const [convMenu, setConvMenu] = useState<{ open: boolean; x: number; y: number; conversationId: string | null }>(() => ({ open: false, x: 0, y: 0, conversationId: null }))
  const convMenuRef = useRef<HTMLDivElement | null>(null)
  const [headerMenu, setHeaderMenu] = useState<{ open: boolean; anchor: HTMLElement | null }>(() => ({ open: false, anchor: null }))
  const headerMenuRef = useRef<HTMLDivElement | null>(null)
  const [availabilityContext, setAvailabilityContext] = useState<{
    conversationId: string
    peerId: string
    peerName?: string | null
    peerTimeZone?: string | null
  } | null>(null)
  const convScrollRef = useRef<HTMLDivElement | null>(null)
  const [groupAvatarEditor, setGroupAvatarEditor] = useState(false)
  const [reactionBar, setReactionBar] = useState<{ open: boolean; x: number; y: number; messageId: string | null }>(() => ({ open: false, x: 0, y: 0, messageId: null }))
  const [forwardModal, setForwardModal] = useState<{ open: boolean; messageIds: string[] }>(() => ({ open: false, messageIds: [] }))
  const [forwardComposerDraft, setForwardComposerDraft] = useState<ForwardComposerDraftState | null>(null)
  const fwdDraftDestinationId = forwardComposerDraft?.destinationConversationId ?? null
  const [multiSelectMode, setMultiSelectMode] = useState(false)
  const [selectedMessageIds, setSelectedMessageIds] = useState<string[]>([])
  const [addParticipantsModal, setAddParticipantsModal] = useState(false)
  const [addParticipantsSelectedIds, setAddParticipantsSelectedIds] = useState<string[]>([])
  const [addParticipantsLoading, setAddParticipantsLoading] = useState(false)
  const [addParticipantsMode, setAddParticipantsMode] = useState<'friends' | 'eblid'>('friends')
  const [addParticipantsEblDigits, setAddParticipantsEblDigits] = useState<string[]>(['', '', '', ''])
  const addParticipantsEblRefs = [
    useRef<HTMLInputElement>(null),
    useRef<HTMLInputElement>(null),
    useRef<HTMLInputElement>(null),
    useRef<HTMLInputElement>(null),
  ]
  const [addParticipantsFoundUser, setAddParticipantsFoundUser] = useState<any | null>(null)
  const [addParticipantsSearchError, setAddParticipantsSearchError] = useState<string | null>(null)
  const [addParticipantsSearching, setAddParticipantsSearching] = useState(false)
  const addParticipantsSearchTokenRef = useRef(0)
  const [convHasTopFade, setConvHasTopFade] = useState(false)
  const [convHasBottomFade, setConvHasBottomFade] = useState(false)
  const [showJump, setShowJump] = useState(false)
  const visibleObserver = useRef<IntersectionObserver | null>(null)
  const resizeObserverRef = useRef<ResizeObserver | null>(null)
  const nodesByMessageId = useRef<Map<string, HTMLElement>>(new Map())
  const nearBottomRef = useRef<boolean>(true)
  const [ebloRange, setEbloRange] = useState<EbloRange>(() => ({ start: 0, end: EBLO_INITIAL_ROWS }))
  const ebloRangeRef = useRef<EbloRange>({ start: 0, end: EBLO_INITIAL_ROWS })
  const ebloRowsRef = useRef<EbloRowMeta[]>([])
  const ebloRowHeightsRef = useRef<Map<string, number>>(new Map())
  const ebloRafRef = useRef<number | null>(null)
  const userStickyScrollRef = useRef<boolean>(false)
  const lastRenderedMessagesRef = useRef(0)
  const lastScrollConvRef = useRef<string | null>(null)
  // ID последнего (самого нового) сообщения в списке. Используем чтобы отличать
  // «новое сообщение пришло снизу» от «подгрузилась страница старых сверху»:
  // в первом случае хвост меняется и можно стикаться к низу, во втором — нельзя,
  // иначе при подгрузке истории нас выкидывает в самый низ.
  const lastTailMessageIdRef = useRef<string | null>(null)
  const batchToRead = useRef<Set<string>>(new Set())
  const batchTimer = useRef<number | null>(null)
  const scrollPinTimerRef = useRef<number | null>(null)
  const touchStartRef = useRef<{ x: number; y: number } | null>(null)
  const touchDeltaRef = useRef<number>(0)
  const [newGroupOpen, setNewGroupOpen] = useState(false)
  const [groupTitle, setGroupTitle] = useState('')
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [creatingGroup, setCreatingGroup] = useState(false)
  const [newGroupAvatarFile, setNewGroupAvatarFile] = useState<File | null>(null)
  const [newGroupAvatarPreviewUrl, setNewGroupAvatarPreviewUrl] = useState<string | null>(null)
  const [newGroupAvatarSourceUrl, setNewGroupAvatarSourceUrl] = useState<string | null>(null)
  const [newGroupAvatarBlob, setNewGroupAvatarBlob] = useState<Blob | null>(null)
  const [newGroupAvatarEditorOpen, setNewGroupAvatarEditorOpen] = useState(false)
  const newGroupFileInputRef = useRef<HTMLInputElement | null>(null)
  const newGroupEditorRef = useRef<HTMLDivElement | null>(null)
  const newGroupImageRef = useRef<HTMLImageElement | null>(null)
  const newGroupCropCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const [newGroupCrop, setNewGroupCrop] = useState({ x: 0, y: 0, scale: 1 })
  const [newGroupDragOver, setNewGroupDragOver] = useState(false)
  const [newGroupAvatarHover, setNewGroupAvatarHover] = useState(false)
  const [contactsOpen, setContactsOpen] = useState(false)
  const [contactsBarDismissed, setContactsBarDismissed] = useState(false)
  const [contactsBarEntered, setContactsBarEntered] = useState(false)
  const [rejectedOutgoing, setRejectedOutgoing] = useState<Array<{ contactId: string; friend?: { id: string; username: string; displayName: string | null } }>>([])
  const [eblDigits, setEblDigits] = useState<string[]>(['', '', '', ''])
  const eblRefs = [useRef<HTMLInputElement>(null), useRef<HTMLInputElement>(null), useRef<HTMLInputElement>(null), useRef<HTMLInputElement>(null)]
  const [foundUser, setFoundUser] = useState<any | null>(null)
  const [sendingInvite, setSendingInvite] = useState(false)
  const [myEblid, setMyEblid] = useState<string>('')
  const [myEblidCopied, setMyEblidCopied] = useState(false)
  const [contactsInviteNow, setContactsInviteNow] = useState(() => Date.now())
  const [contactsInviteCopied, setContactsInviteCopied] = useState(false)
  const [contactsInviteRefreshing, setContactsInviteRefreshing] = useState(false)
  const [mePopupOpen, setMePopupOpen] = useState(false)
  const [uploadingAvatar, setUploadingAvatar] = useState(false)
  const [selectedAvatarFile, setSelectedAvatarFile] = useState<File | null>(null)
  const [avatarPreviewUrl, setAvatarPreviewUrl] = useState<string | null>(null)
  const cropCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const [crop, setCrop] = useState({ x: 0, y: 0, scale: 1 })
  const [uploadProgress, setUploadProgress] = useState<number>(0)
  const editorRef = useRef<HTMLDivElement | null>(null)
  const imageRef = useRef<HTMLImageElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const touchStateRef = useRef<{ touches: React.Touch[], initialDistance: number, initialScale: number, initialX: number, initialY: number } | null>(null)
  const rafRef = useRef<number | null>(null)
  // Refs для редактора группы
  const groupEditorRef = useRef<HTMLDivElement | null>(null)
  const groupImageRef = useRef<HTMLImageElement | null>(null)
  const groupTouchStateRef = useRef<{ touches: React.Touch[], initialDistance: number, initialScale: number, initialX: number, initialY: number } | null>(null)
  const groupRafRef = useRef<number | null>(null)
  const groupCropCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const groupFileInputRef = useRef<HTMLInputElement | null>(null)
  const [groupCrop, setGroupCrop] = useState({ x: 0, y: 0, scale: 1 })
  const [groupAvatarPreviewUrl, setGroupAvatarPreviewUrl] = useState<string | null>(null)
  const [groupSelectedAvatarFile, setGroupSelectedAvatarFile] = useState<File | null>(null)
  const [groupTitleEditValue, setGroupTitleEditValue] = useState('')
  const [savingGroupTitle, setSavingGroupTitle] = useState(false)
  const [groupDragOver, setGroupDragOver] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [uploadMessage, setUploadMessage] = useState<string | null>(null)
  const [lightbox, setLightbox] = useState<{ open: boolean; index: number; items: string[] }>({ open: false, index: 0, items: [] })
  const [videoViewer, setVideoViewer] = useState<{ open: boolean; url: string; fileName?: string }>({ open: false, url: '', fileName: undefined })
  const [attachUploading, setAttachUploading] = useState(false)
  const [attachProgress, setAttachProgress] = useState(0)
  const [attachUploadState, setAttachUploadState] = useState<'uploading' | 'processing' | 'done'>('done')
  const [attachUploadSpeed, setAttachUploadSpeed] = useState('0 B/s')
  const [attachProcessingMessageIndex, setAttachProcessingMessageIndex] = useState(0)
  const [attachCanceling, setAttachCanceling] = useState(false)
  const [attachDragOver, setAttachDragOver] = useState(false)
  const attachDragDepthRef = useRef(0)
  const attachUploadStartedAtRef = useRef<number | null>(null)
  const attachUploadSpeedUpdatedAtRef = useRef(0)
  const activeAttachXhrRef = useRef<XMLHttpRequest | null>(null)
  const activeAttachAbortControllerRef = useRef<AbortController | null>(null)
  const activeAttachUploadIdRef = useRef<string | null>(null)
  const activeAttachPendingMessageIdRef = useRef<string | null>(null)
  const activeAttachConversationIdRef = useRef<string | null>(null)
  const attachCancelRequestedRef = useRef(false)
  const callPermissionError = useCallStore((state) => state.callPermissionError)
  const setCallPermissionError = useCallStore((state) => state.setCallPermissionError)
  const [pendingByConv, setPendingByConv] = useState<Record<string, PendingMessage[]>>({})
  const [attachmentDecryptMap, setAttachmentDecryptMap] = useState<Record<string, AttachmentDecryptionEntry>>({})
  const [attachmentHeadInfoMap, setAttachmentHeadInfoMap] = useState<Record<string, AttachmentHeadInfo>>({})
  const attachmentDecryptUrlsRef = useRef<Set<string>>(new Set())
  const attachmentDecryptInProgressRef = useRef<Set<string>>(new Set())
  const attachmentHeadInfoInFlightRef = useRef<Set<string>>(new Set())
  const [pendingImages, setPendingImages] = useState<PendingComposerImage[]>([])
  const [pendingFiles, setPendingFiles] = useState<PendingComposerFile[]>([])
  const [editingImageId, setEditingImageId] = useState<string | null>(null)
  const [e2eeVersion, setE2eeVersion] = useState(0)
  const voiceRecorderRef = useRef<VoiceRecorder | null>(null)
  const [voiceRecording, setVoiceRecording] = useState(false)
  const [voiceDuration, setVoiceDuration] = useState(0)
  const [voiceWaveform, setVoiceWaveform] = useState<number[]>([])
  const waveformUpdateIntervalRef = useRef<number | null>(null)
  const waveformContainerRef = useRef<HTMLDivElement | null>(null)
  const [waveformMaxBars, setWaveformMaxBars] = useState(150)

  // Вычисляем количество баров на основе ширины контейнера
  useEffect(() => {
    if (isMobile) {
      setWaveformMaxBars(60)
      return
    }
    
    const updateMaxBars = () => {
      if (!waveformContainerRef.current) return
      const containerWidth = waveformContainerRef.current.clientWidth
      const barTotalWidth = 4 // 2px ширина + 2px gap
      const maxBars = Math.floor(containerWidth / barTotalWidth)
      setWaveformMaxBars(Math.max(100, maxBars)) // Минимум 100 баров
    }
    
    updateMaxBars()
    const resizeObserver = new ResizeObserver(updateMaxBars)
    if (waveformContainerRef.current) {
      resizeObserver.observe(waveformContainerRef.current)
    }
    
    return () => {
      resizeObserver.disconnect()
    }
  }, [isMobile])

  // Prefetch CallOverlay to avoid first-time render delay (bundle loading)
  useEffect(() => {
    preloadCallOverlay().catch(() => {})
  }, [])
const activeConversationIdRef = useRef<string | null>(null)
useEffect(() => { activeConversationIdRef.current = activeId }, [activeId])
  useEffect(() => {
    if (availabilityContext && availabilityContext.conversationId !== activeId) {
      setAvailabilityContext(null)
    }
  }, [availabilityContext, activeId])
const pendingImagesRef = useRef<PendingComposerImage[]>([])
useEffect(() => { pendingImagesRef.current = pendingImages }, [pendingImages])
const pendingFilesRef = useRef<PendingComposerFile[]>([])
useEffect(() => { pendingFilesRef.current = pendingFiles }, [pendingFiles])
  const releasePreviewUrl = useCallback((url: string | null | undefined) => {
    if (!url) return
    try {
      URL.revokeObjectURL(url)
    } catch {
      // ignore revocation errors
    }
  }, [])
  const clearPendingImages = useCallback(() => {
    setEditingImageId(null)
    setPendingImages((prev) => {
      if (!prev.length) return prev
      prev.forEach((img) => releasePreviewUrl(img.previewUrl))
      return []
    })
  }, [releasePreviewUrl, setEditingImageId])
  const clearPendingFiles = useCallback(() => {
    setPendingFiles([])
  }, [])
  const addComposerImage = useCallback((file: File, source: 'paste' | 'upload') => {
    if (!file || !file.type.startsWith('image/')) return
    setPendingImages((prev) => {
      if (prev.length >= MAX_PENDING_IMAGES) {
        systemToast.error('Можно редактировать не более 10 изображений за раз.')
        return prev
      }
      const id = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `img-${Date.now()}-${Math.random().toString(36).slice(2)}`
      const previewUrl = URL.createObjectURL(file)
      const entry: PendingComposerImage = {
        id,
        file,
        previewUrl,
        edited: false,
        fileName: file.name || 'image.png',
        source,
      }
      return [...prev, entry]
    })
  }, [])
  const addComposerFile = useCallback((file: File, source: 'drop' | 'upload') => {
    if (!file) return
    if (file.type && file.type.startsWith('image/')) return
    setPendingFiles((prev) => {
      if (prev.length >= MAX_PENDING_FILES) {
        systemToast.error('Можно прикрепить не более 10 файлов за раз.')
        return prev
      }
      const id = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `file-${Date.now()}-${Math.random().toString(36).slice(2)}`
      const entry: PendingComposerFile = {
        id,
        file,
        fileName: file.name || 'Файл',
        size: typeof file.size === 'number' ? file.size : 0,
        mime: file.type || 'application/octet-stream',
        source,
      }
      return [...prev, entry]
    })
  }, [])
  const removeComposerImage = useCallback((id: string) => {
    setPendingImages((prev) => {
      const target = prev.find((img) => img.id === id)
      if (target) releasePreviewUrl(target.previewUrl)
      return prev.filter((img) => img.id !== id)
    })
    setEditingImageId((prev) => (prev === id ? null : prev))
  }, [releasePreviewUrl, setEditingImageId])
  const removeComposerFile = useCallback((id: string) => {
    setPendingFiles((prev) => prev.filter((f) => f.id !== id))
  }, [])
  const applyComposerImageEdit = useCallback((id: string, file: File, previewUrl: string) => {
    setPendingImages((prev) =>
      prev.map((img) => {
        if (img.id !== id) return img
        releasePreviewUrl(img.previewUrl)
        return {
          ...img,
          file,
          previewUrl,
          edited: true,
          fileName: file.name || img.fileName,
        }
      }),
    )
  }, [releasePreviewUrl])
  const devicesQuery = useQuery({
    queryKey: ['my-devices'],
    queryFn: async () => {
      const response = await api.get('/devices')
      return response.data.devices as Array<{
        id: string
        name?: string
        platform?: string | null
        userId: string
        createdAt?: string | Date | null
        lastSeenAt?: string | Date | null
        revokedAt?: string | Date | null
        lastIp?: string | null
        lastCountry?: string | null
        lastCity?: string | null
        availablePrekeys?: number | null
      }>
    },
  })
  // For "Link device" UX we must know the CURRENT device id; otherwise we can mistakenly
  // think the user has "another" device while bootstrap hasn't completed yet.
  let localDeviceIdForLinking: string | null = null
  try {
    localDeviceIdForLinking = getStoredDeviceInfo()?.deviceId ?? null
  } catch {
    localDeviceIdForLinking = null
  }
  const hasOtherTrustedDevice = useMemo(() => {
    const current = String(localDeviceIdForLinking ?? '').trim()
    if (!current) return false
    const active = (devicesQuery.data || []).filter((d: any) => !d?.revokedAt)
    if (!active.length) return false
    return active.some((d: any) => String(d?.id ?? '').trim() && String(d.id).trim() !== current)
  }, [devicesQuery.data, localDeviceIdForLinking])
  const [pingMs, setPingMs] = useState<number | null>(null)
  const [isSocketOnline, setIsSocketOnline] = useState<boolean>(() => socket.connected)
  const [myPresence, setMyPresence] = useState<'ONLINE' | 'AWAY' | 'BACKGROUND' | 'OFFLINE' | 'IN_CALL' | null>(null)
  // Realtime presence overrides (e.g. IN_CALL) must win over API poll results,
  // because the API returns base User.status (ONLINE/BACKGROUND/OFFLINE) from DB.
  const [presenceOverridesByUserId, setPresenceOverridesByUserId] = useState<Record<string, string>>({})
  type PresenceGameState = { ts: number; game: NonNullable<PresenceGamePayload['game']> }
  const [presenceGameByUserId, setPresenceGameByUserId] = useState<Record<string, PresenceGameState>>({})
  const presenceGameExpiryTimersRef = useRef<Map<string, number>>(new Map())
  const [loadedImages, setLoadedImages] = useState<Record<string, boolean>>({})
  const [failedImages, setFailedImages] = useState<Record<string, boolean>>({})
  const [imageDimensions, setImageDimensions] = useState<Record<string, { width: number; height: number }>>({})
  const [endSecretModalOpen, setEndSecretModalOpen] = useState(false)
  const [secretRequestLoading, setSecretRequestLoading] = useState(false)
  const [secretHistoryGate, setSecretHistoryGate] = useState<{ open: boolean; threadId: string | null }>({ open: false, threadId: null })
  const [linkDeviceModalOpen, setLinkDeviceModalOpen] = useState(false)
  const [deviceLinkInviteOpen, setDeviceLinkInviteOpen] = useState(false)
  const [secretKeysVersion, setSecretKeysVersion] = useState(0)
  const secretEngineV2Enabled = useMemo(() => isSecretEngineV2Enabled(), [])
  const [secretEngineV2Version, setSecretEngineV2Version] = useState(0)
  const [secretBootQueueVersion, setSecretBootQueueVersion] = useState(0)
  const [secretComposerInlineError, setSecretComposerInlineError] = useState<string | null>(null)
  const [secretBootDonePulse, setSecretBootDonePulse] = useState(0)
  const prevSecretBootReadyRef = useRef<boolean>(false)
  const secretBootStartedAtRef = useRef<Record<string, number>>({})
  const secretBootQueueRef = useRef<
    Record<string, Array<{ pendingId: string; peerUserId: string; text: string; replyToId?: string | null }>>
  >({})
  const secretBootFlushInFlightRef = useRef<Record<string, boolean>>({})
  const menuRef = useRef<HTMLDivElement | null>(null)
  const me = useAppStore((s) => s.session?.user)
  // Universal user card: opened by clicking any avatar. Self routes to the profile popup.
  const [userCardUser, setUserCardUser] = useState<any | null>(null)
  const openUserCard = useCallback((u: any) => {
    if (!u || typeof u !== 'object' || !u.id) return
    if (me?.id && String(u.id) === String(me.id)) { setMePopupOpen(true); return }
    setUserCardUser(u)
    // Enrich with bio/createdAt from the public mini-profile endpoint (best-effort).
    void api.get(`/users/${encodeURIComponent(String(u.id))}`)
      .then((r) => {
        const full = r.data?.user
        if (full?.id) setUserCardUser((cur: any) => (cur && String(cur.id) === String(full.id) ? { ...cur, ...full } : cur))
      })
      .catch(() => {})
  }, [me?.id])
  const storedUserIdRef = useRef<string | null>(null)
  if (storedUserIdRef.current === null && typeof window !== 'undefined') {
    try {
      const raw = localStorage.getItem('eb_user')
      if (raw) {
        const parsed = JSON.parse(raw)
        if (parsed && typeof parsed.id === 'string') {
          storedUserIdRef.current = parsed.id
        }
      }
    } catch {
      storedUserIdRef.current = null
    }
  }
  useEffect(() => {
    if (me?.id) {
      storedUserIdRef.current = me.id
    }
  }, [me?.id])
  const currentUserId = me?.id ?? storedUserIdRef.current ?? null

  useEffect(() => {
    const handler = () => setSecretKeysVersion((v) => (v + 1) % Number.MAX_SAFE_INTEGER)
    try {
      window.addEventListener('eb:secretKeysUpdated', handler as any)
    } catch {}
    return () => {
      try { window.removeEventListener('eb:secretKeysUpdated', handler as any) } catch {}
    }
  }, [])

  // Re-render when device-link keys were imported (new device became trusted for secret history).
  const [deviceLinkedVersion, setDeviceLinkedVersion] = useState(0)
  useEffect(() => {
    const handler = () => setDeviceLinkedVersion((v) => (v + 1) % Number.MAX_SAFE_INTEGER)
    try {
      window.addEventListener('eb:deviceLinked', handler as any)
    } catch {}
    return () => {
      try { window.removeEventListener('eb:deviceLinked', handler as any) } catch {}
    }
  }, [])

  const hasAnySecretThreadKeys = useMemo(() => {
    try {
      // Consider this a "trusted" device if it already has any secret thread keys stored.
      // New devices start with an empty store and must be linked.
      const raw = typeof window !== 'undefined' ? window.localStorage.getItem('eb_secret_thread_keys_v1') : null
      if (!raw) return false
      const parsed = JSON.parse(raw) as any
      if (!parsed || typeof parsed !== 'object') return false
      return Object.keys(parsed).length > 0
    } catch {
      return false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [secretKeysVersion, deviceLinkedVersion])

  useEffect(() => {
    if (!secretEngineV2Enabled) return
    return subscribeSecretThreadState(() => {
      setSecretEngineV2Version((v) => (v + 1) % Number.MAX_SAFE_INTEGER)
    })
  }, [secretEngineV2Enabled])

  // Re-render when key receipts arrive (creator waiting state).
  useEffect(() => {
    const onReceipt = () => setSecretEngineV2Version((v) => (v + 1) % Number.MAX_SAFE_INTEGER)
    try {
      window.addEventListener('eb:secretV2:keyReceipt', onReceipt as any)
    } catch {}
    return () => {
      try { window.removeEventListener('eb:secretV2:keyReceipt', onReceipt as any) } catch {}
    }
  }, [])

  const secretDebug = useMemo(() => {
    try {
      const q = typeof window !== 'undefined' ? String(window.location?.search ?? '') : ''
      if (q.includes('SECRET_DEBUG=1')) return true
      return typeof window !== 'undefined' && window.localStorage.getItem('eb_secret_debug') === '1'
    } catch {
      return false
    }
  }, [])

  const { typingByUserId, typingByConversationId, typingDots, onIncomingTyping, notifyTyping, stopTyping } = useChatTyping({
    activeId,
    meId: currentUserId,
    isMobileRef,
    messagesRef,
  })

  const callStore = useCallStore()
  const client = useQueryClient()
  const activePendingMessages = useMemo<PendingMessage[]>(() => {
    if (!activeId) return []
    return pendingByConv[activeId] || []
  }, [activeId, pendingByConv])
  const editingImage = useMemo(() => {
    if (!editingImageId) return null
    return pendingImages.find((img) => img.id === editingImageId) ?? null
  }, [pendingImages, editingImageId])
  const lightboxTimerRef = useRef<number | null>(null)
  const attachInputOverlayRef = useRef<HTMLDivElement | null>(null)
  const [activeCalls, setActiveCalls] = useState<Record<string, { startedAt: number | null; endedAt?: number | null; active: boolean; participants?: string[]; elapsedMs?: number; aloneSince?: number; autoEndAt?: number }>>({})
  const [timerTick, setTimerTick] = useState(0)
  const callConvIdRef = useRef<string | null>(null)
  useEffect(() => { callConvIdRef.current = callConvId }, [callConvId])
  const inviterByConvRef = useRef<Record<string, string>>({})
  const groupAloneReminderToastAtRef = useRef<Record<string, number>>({})
  const minCallDurationUntilRef = useRef<Record<string, number>>({})
  const pendingCallAutoCloseTimersRef = useRef<Record<string, number>>({})
  const stopOutgoingDialing = useCallback((options?: { playEndTone?: boolean }) => {
    if (outgoingCallTimerRef.current) {
      window.clearTimeout(outgoingCallTimerRef.current)
      outgoingCallTimerRef.current = null
    }
    stopDialingSound()
    if (options?.playEndTone) {
      playEndCallSound()
    }
  }, [playEndCallSound, stopDialingSound])

  useEffect(() => {
    return () => {
      if (typeof window === 'undefined') return
      Object.values(pendingCallAutoCloseTimersRef.current).forEach((id) => {
        if (typeof id === 'number') {
          window.clearTimeout(id)
        }
      })
      stopOutgoingDialing()
    }
  }, [stopOutgoingDialing])

  useEffect(() => {
    if (!outgoingCall) {
      stopOutgoingDialing()
    }
  }, [outgoingCall, stopOutgoingDialing])

  useEffect(() => {
    if (!callConvId) return
    if (outgoingCallRef.current && outgoingCallRef.current.conversationId !== callConvId) return
    stopOutgoingDialing()
    setOutgoingCall((prev) => (prev?.conversationId === callConvId ? null : prev))
  }, [callConvId, setOutgoingCall, stopOutgoingDialing])

  // Обновляем таймер дозвона каждую секунду
  useEffect(() => {
    if (!outgoingCall) return
    const interval = setInterval(() => {
      setOutgoingCall((prev) => prev ? { ...prev } : null) // Force re-render для обновления времени
    }, 1000)
    return () => clearInterval(interval)
  }, [outgoingCall])
  const getConversationFromCache = useCallback((conversationId: string | null | undefined) => {
    if (!conversationId) return null
    const rows = client.getQueryData(['conversations']) as any[] | undefined
    if (!Array.isArray(rows)) return null
    const row = rows.find((r: any) => r?.conversation?.id === conversationId)
    return row?.conversation ?? null
  }, [client])
  const isOneToOneConversation = useCallback((conversationId: string | null | undefined) => {
    const conv = getConversationFromCache(conversationId)
    if (!conv) return false
    const participantsCount = conv.participants?.length ?? 0
    return !conv.isGroup && participantsCount <= 2
  }, [getConversationFromCache])
  const clearMinCallDurationGuard = useCallback((conversationId: string | null | undefined) => {
    if (!conversationId) return
    const timerId = pendingCallAutoCloseTimersRef.current[conversationId]
    if (typeof timerId === 'number' && typeof window !== 'undefined') {
      window.clearTimeout(timerId)
      delete pendingCallAutoCloseTimersRef.current[conversationId]
    }
    delete minCallDurationUntilRef.current[conversationId]
  }, [])
  const beginOutgoingCallGuard = useCallback((conversationId: string | null | undefined) => {
    if (!conversationId) return
    if (!isOneToOneConversation(conversationId)) return
    minCallDurationUntilRef.current[conversationId] = Date.now() + MIN_OUTGOING_CALL_DURATION_MS
  }, [isOneToOneConversation])
  const scheduleAfterMinCallDuration = useCallback((conversationId: string | null | undefined, action: () => void, options?: { force?: boolean }) => {
    if (!conversationId) {
      action()
      return
    }
    if (options?.force) {
      clearMinCallDurationGuard(conversationId)
      action()
      return
    }
    const deadline = minCallDurationUntilRef.current[conversationId]
    if (!deadline) {
      action()
      return
    }
    const now = Date.now()
    if (now >= deadline) {
      clearMinCallDurationGuard(conversationId)
      action()
      return
    }
    const remaining = deadline - now
    const existing = pendingCallAutoCloseTimersRef.current[conversationId]
    if (typeof existing === 'number' && typeof window !== 'undefined') {
      window.clearTimeout(existing)
    }
    if (typeof window === 'undefined') {
      action()
      return
    }
    pendingCallAutoCloseTimersRef.current[conversationId] = window.setTimeout(() => {
      delete pendingCallAutoCloseTimersRef.current[conversationId]
      clearMinCallDurationGuard(conversationId)
      action()
    }, remaining)
  }, [clearMinCallDurationGuard])
  const describeMediaPermissionError = useCallback((needsVideo: boolean, error: unknown) => {
    const target = needsVideo ? 'камере и микрофону' : 'микрофону'
    const name = typeof error === 'object' && error && 'name' in error ? String((error as { name?: string }).name) : ''
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      return `Браузер запретил доступ к ${target}. Разрешите его в адресной строке и попробуйте снова.`
    }
    if (name === 'NotFoundError') {
      return needsVideo
        ? 'Браузер не нашёл камеру или микрофон. Подключите устройство и попробуйте ещё раз.'
        : 'Браузер не нашёл микрофон. Подключите устройство и попробуйте ещё раз.'
    }
    if (name === 'NotReadableError' || name === 'TrackStartError') {
      return 'Камера или микрофон уже используются другим приложением или вкладкой.'
    }
    return `Не удалось получить доступ к ${target}. Проверьте настройки браузера и попробуйте снова.`
  }, [])
  const requireMediaAccess = useCallback(async (needsVideo: boolean) => {
    try {
      const result = await ensureMediaPermissions({ audio: true, video: needsVideo })
      if (!result.ok) {
        setCallPermissionError(describeMediaPermissionError(needsVideo, result.error))
        return false
      }
      setCallPermissionError(null)
      return true
    } catch (error) {
      setCallPermissionError(describeMediaPermissionError(needsVideo, error))
      return false
    }
  }, [describeMediaPermissionError])
  const performAcceptIncomingCall = useCallback(async (call: ResolvedIncomingCall) => {
    // Silence the ringtone the instant the user accepts — BEFORE awaiting camera/mic permission.
    // A slow or failing media request (common for video, which also grabs the camera) otherwise
    // kept the phone ringing, and on failure the function returned below before the old
    // stopRingtone() at the end ever ran. Stopping here makes accept feel immediate and reliable.
    stopRingtone()
    if (!(await requireMediaAccess(call.isVideo))) return false
    const convId = call.conversationId
    beginOutgoingCallGuard(convId)
    acceptCall(convId, call.isVideo)
    signalApkIncomingAccepted(convId, call.isVideo)
    callStore.startOutgoing(convId, call.isVideo)
    setActiveCalls((prev) => {
      const current = prev[convId]
      const myId = me?.id
      if (!current?.active) {
        return { ...prev, [convId]: { startedAt: Date.now(), active: true, participants: myId ? [myId] : [] } }
      }
      if (myId && current.participants && !current.participants.includes(myId)) {
        return { ...prev, [convId]: { ...current, participants: [...current.participants, myId] } }
      }
      return prev
    })
    setCallConvId(convId)
    setMinimizedCallConvId((prev) => (prev === convId ? null : prev))
    callStore.setIncoming(null)
    stopRingtone()
    return true
  }, [beginOutgoingCallGuard, callStore, me?.id, requireMediaAccess, stopRingtone])

  const performDeclineIncomingCall = useCallback((call: ResolvedIncomingCall) => {
    declineCall(call.conversationId)
    callStore.setIncoming(null)
    stopRingtone()
    return true
  }, [callStore, stopRingtone])

  const performEndActiveCall = useCallback((call: ResolvedActiveCall) => {
    const convId = call.conversationId
    const conv = getConversationFromCache(convId)
    const participantsCount = conv?.participants?.length ?? 0
    const isGroupConv = !!(conv?.isGroup || participantsCount > 2)
    const isDialog = !isGroupConv

    if (outgoingCallTimerRef.current) {
      window.clearTimeout(outgoingCallTimerRef.current)
      outgoingCallTimerRef.current = null
    }

    if (isDialog) {
      endCall(convId)
      setActiveCalls((prev) => {
        const current = prev[convId]
        if (!current) return prev
        if (current.active) {
          return { ...prev, [convId]: { ...current, active: false, endedAt: Date.now() } }
        }
        return prev
      })
    } else {
      try {
        leaveCallRoom(convId)
      } catch {
        // ignore leave failures; store/server reconciliation will follow
      }
      setActiveCalls((prev) => {
        const current = prev[convId]
        if (!current) return prev
        if (!current.participants) return prev
        const myId = me?.id
        if (!myId || !current.participants.includes(myId)) return prev
        return {
          ...prev,
          [convId]: { ...current, participants: current.participants.filter((id: string) => id !== myId) },
        }
      })
    }

    setOutgoingCall((prev) => (prev?.conversationId === convId ? null : prev))
    setCallConvId((prev) => (prev === convId ? null : prev))
    setMinimizedCallConvId((prev) => (prev === convId ? null : prev))
    callStore.endCall()
    stopRingtone()
    clearMinCallDurationGuard(convId)
    return true
  }, [
    callStore,
    clearMinCallDurationGuard,
    getConversationFromCache,
    me?.id,
    setCallConvId,
    setMinimizedCallConvId,
    setOutgoingCall,
    stopRingtone,
  ])

  useEffect(() => {
    return registerIncomingCallRuntime({
      id: 'chats-page',
      priority: 100,
      acceptIncomingCall: (call) => performAcceptIncomingCall(call),
      declineIncomingCall: (call) => performDeclineIncomingCall(call),
    })
  }, [performAcceptIncomingCall, performDeclineIncomingCall])

  useEffect(() => {
    return registerActiveCallRuntime({
      id: 'chats-page',
      priority: 100,
      endActiveCall: (call) => performEndActiveCall(call),
    })
  }, [performEndActiveCall])

  useEffect(() => {
    if (callStore.incoming?.source !== 'android_native') {
      return
    }

    stopRingtone()
    if (ringTimerRef.current) {
      window.clearTimeout(ringTimerRef.current)
      ringTimerRef.current = null
    }
    ringingConvIdRef.current = callStore.incoming.conversationId
  }, [callStore.incoming?.conversationId, callStore.incoming?.source, stopRingtone])

  // Safety net: whenever there is no pending incoming call (it was accepted, declined, cancelled or
  // timed out), make sure the ringtone is silenced — regardless of which code path cleared the call.
  useEffect(() => {
    if (!callStore.incoming) stopRingtone()
  }, [callStore.incoming, stopRingtone])

  useEffect(() => {
    const id = window.setInterval(() => setTimerTick((t) => (t + 1) % 1000000), 1000)
    return () => window.clearInterval(id)
  }, [])

  // Fix "Завершён N мин назад" right after hangup:
  // when a call transitions active -> inactive, endedAt must be "now".
  // If endedAt is far from now at that exact transition (e.g. equals call start),
  // force-correct it once so the post-call timer counts from the hangup moment.
  const prevCallActiveByConvIdRef = useRef<Record<string, boolean>>({})
  useEffect(() => {
    const prevActiveMap = prevCallActiveByConvIdRef.current
    const now = Date.now()
    const toFix: string[] = []

    for (const [cid, entry] of Object.entries(activeCalls || {})) {
      if (!entry) continue
      const wasActive = !!prevActiveMap[cid]
      const isActive = !!entry.active
      if (!wasActive || isActive) continue
      const endedAt = typeof entry.endedAt === 'number' && Number.isFinite(entry.endedAt) ? entry.endedAt : null
      // If we just transitioned to inactive, endedAt should be very close to "now".
      if (!endedAt || Math.abs(now - endedAt) > 5000) {
        toFix.push(cid)
      }
    }

    // Update prev map to current.
    const nextPrev: Record<string, boolean> = {}
    for (const [cid, entry] of Object.entries(activeCalls || {})) {
      if (!entry) continue
      nextPrev[cid] = !!entry.active
    }
    prevCallActiveByConvIdRef.current = nextPrev

    if (!toFix.length) return
    setActiveCalls((prev) => {
      const next = { ...prev }
      for (const cid of toFix) {
        const entry = prev[cid]
        if (!entry || entry.active) continue
        next[cid] = { ...entry, endedAt: now }
      }
      return next
    })
  }, [activeCalls])

  useEffect(() => {
    if (!callPermissionError) return
    if (typeof window === 'undefined') return
    const timer = window.setTimeout(() => setCallPermissionError(null), 9000)
    return () => window.clearTimeout(timer)
  }, [callPermissionError])

  // Initialize/subscribe to server call status for group calls
  useEffect(() => {
    const debugCallStatus = (() => {
      try {
        const qs = new URLSearchParams(window.location.search)
        const q = qs.get('lkDebugCallStatus')
        if (q === '1' || q === 'true') return true
        const raw = window.localStorage.getItem('lk-debug-callstatus')
        return raw === '1' || raw === 'true'
      } catch {
        return false
      }
    })()

    const handleSingle = (p: { conversationId: string; active: boolean; startedAt?: number; elapsedMs?: number; participants?: string[]; isGroup?: boolean; aloneSince?: number; autoEndAt?: number; aloneReminder?: boolean }) => {
      if (debugCallStatus) console.log('[CallStatus] Single:', p)
      if (p.aloneReminder) {
        const last = groupAloneReminderToastAtRef.current[p.conversationId] ?? 0
        if (Date.now() - last > 60_000) {
          groupAloneReminderToastAtRef.current[p.conversationId] = Date.now()
          systemToast.info('Вы один в групповом звонке. Если никто не подключится, он завершится автоматически.', {
            title: 'Активный звонок',
            ttlMs: 7000,
          })
        }
      }
      setActiveCalls((prev) => {
        const current = prev[p.conversationId]

        const participants = p.participants || []
        if (p.active) {
          const serverStartedAt = typeof p.startedAt === 'number' && p.startedAt > 0 ? p.startedAt : (current?.startedAt ?? Date.now())
          return {
            ...prev,
            [p.conversationId]: {
              active: true,
              startedAt: serverStartedAt,
              participants,
              endedAt: null,
              elapsedMs: typeof p.elapsedMs === 'number' ? p.elapsedMs : undefined,
              aloneSince: typeof p.aloneSince === 'number' ? p.aloneSince : undefined,
              autoEndAt: typeof p.autoEndAt === 'number' ? p.autoEndAt : undefined,
            },
          }
        }

        if (!current) return prev
        const prevEndedAt = (typeof current?.endedAt === 'number' && Number.isFinite(current.endedAt)) ? current.endedAt : null
        const startedAt = (typeof current?.startedAt === 'number' && Number.isFinite(current.startedAt)) ? current.startedAt : null
        // If we receive an "inactive" update but endedAt is missing/invalid (or equals startedAt),
        // treat it as ended "now" to avoid incorrect "Завершён N мин назад" right after hangup.
        const endedAtRaw = current?.active ? Date.now() : prevEndedAt
        const endedAt =
          (typeof endedAtRaw === 'number' && typeof startedAt === 'number' && endedAtRaw <= startedAt)
            ? Date.now()
            : endedAtRaw
        return {
          ...prev,
          [p.conversationId]: {
            active: false,
            startedAt: current?.startedAt ?? null,
            endedAt,
            participants: [],
            elapsedMs: undefined,
            aloneSince: undefined,
            autoEndAt: undefined,
          },
        }
      })
    }
    const handleBulk = (payload: { statuses: Record<string, { active: boolean; startedAt?: number; elapsedMs?: number; participants?: string[]; isGroup?: boolean; aloneSince?: number; autoEndAt?: number; aloneReminder?: boolean }> }) => {
      if (debugCallStatus) console.log('[CallStatus] Bulk:', payload)
      setActiveCalls((prev) => {
        const merged = { ...prev }
        
        for (const [cid, st] of Object.entries(payload.statuses || {})) {
          const current = prev[cid]

          const participants = st.participants || []
          if (st.active) {
            const serverStartedAt = typeof st.startedAt === 'number' && st.startedAt > 0 ? st.startedAt : (current?.startedAt ?? Date.now())
            merged[cid] = {
              active: true,
              startedAt: serverStartedAt,
              participants,
              endedAt: null,
              elapsedMs: typeof st.elapsedMs === 'number' ? st.elapsedMs : undefined,
              aloneSince: typeof st.aloneSince === 'number' ? st.aloneSince : undefined,
              autoEndAt: typeof st.autoEndAt === 'number' ? st.autoEndAt : undefined,
            }
            continue
          }

          if (!current) continue
          const prevEndedAt = (typeof current?.endedAt === 'number' && Number.isFinite(current.endedAt)) ? current.endedAt : null
          const startedAt = (typeof current?.startedAt === 'number' && Number.isFinite(current.startedAt)) ? current.startedAt : null
          const endedAtRaw = current?.active ? Date.now() : prevEndedAt
          const endedAt =
            (typeof endedAtRaw === 'number' && typeof startedAt === 'number' && endedAtRaw <= startedAt)
              ? Date.now()
              : endedAtRaw
          merged[cid] = {
            active: false,
            startedAt: current?.startedAt ?? null,
            endedAt,
            participants: [],
            elapsedMs: undefined,
            aloneSince: undefined,
            autoEndAt: undefined,
          }
        }
        return merged
      })
    }
    onCallStatus(handleSingle)
    onCallStatusBulk(handleBulk)
    return () => {
      socket.off('call:status', handleSingle as any)
      socket.off('call:status:bulk', handleBulk as any)
    }
  }, [])

  // (moved below queries declaration)

  // keep menu within viewport
  useEffect(() => {
    if (!contextMenu.open) return
    const menu = menuRef.current
    if (!menu) return
    const vw = window.innerWidth
    const vh = (window as any).visualViewport ? (window as any).visualViewport.height : window.innerHeight
    const rect = menu.getBoundingClientRect()
    let left = contextMenu.x
    let top = contextMenu.y
    if (left + rect.width > vw - 8) left = Math.max(8, vw - rect.width - 8)
    if (top + rect.height > vh - 8) top = Math.max(8, vh - rect.height - 8)
    if (left !== contextMenu.x || top !== contextMenu.y) {
      setContextMenu((s) => ({ ...s, x: left, y: top }))
    }
  }, [contextMenu.open, contextMenu.x, contextMenu.y])

  useEffect(() => {
    if (!convMenu.open) return
    const menu = convMenuRef.current
    if (!menu) return
    const vw = window.innerWidth
    const vh = (window as any).visualViewport ? (window as any).visualViewport.height : window.innerHeight
    const rect = menu.getBoundingClientRect()
    let left = convMenu.x
    let top = convMenu.y
    if (left + rect.width > vw - 8) left = Math.max(8, vw - rect.width - 8)
    if (top + rect.height > vh - 8) top = Math.max(8, vh - rect.height - 8)
    if (left !== convMenu.x || top !== convMenu.y) {
      setConvMenu((s) => ({ ...s, x: left, y: top }))
    }
  }, [convMenu.open, convMenu.x, convMenu.y])

  useEffect(() => {
    if (!headerMenu.open || !headerMenu.anchor) return
    const menu = headerMenuRef.current
    if (!menu) return
    const anchorRect = headerMenu.anchor.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = (window as any).visualViewport ? (window as any).visualViewport.height : window.innerHeight
    menu.style.display = 'flex'
    const rect = menu.getBoundingClientRect()
    let left = anchorRect.right - rect.width
    let top = anchorRect.bottom + 8
    if (left < 8) left = 8
    if (left + rect.width > vw - 8) left = vw - rect.width - 8
    if (top + rect.height > vh - 8) top = anchorRect.top - rect.height - 8
    if (top < 8) top = 8
    menu.style.left = `${left}px`
    menu.style.top = `${top}px`
  }, [headerMenu.open, headerMenu.anchor])

  useEffect(() => {
    if (!activeId) {
      setHeaderMenu({ open: false, anchor: null })
    }
  }, [activeId])

  function selectConversation(id: string) {
    setActiveId((prev) => {
      try {
        if (prev && prev !== id) {
          const prevRow = (conversationsQuery.data || []).find((r: any) => r.conversation.id === prev)
          const prevConv = prevRow?.conversation
          if (prevConv?.isSecret) {
            // Drop cached messages for secret conversations when leaving them
            client.removeQueries({ queryKey: ['messages', prev] })
            olderMetaByConvRef.current.delete(prev)
          }
        }
      } catch {
        // ignore cache cleanup errors
      }
        return id
      })
    // Use ref to avoid race: `isMobile` state can be stale on first tap.
    if (isMobileRef.current) {
      setMobileView('conversation')
    }
    if (pendingImagesRef.current.length) {
      clearPendingImages()
    }
    if (pendingFilesRef.current.length) {
      clearPendingFiles()
    }
  }

  async function ensureLocalDevice(): Promise<{ deviceId: string; publicKey: string } | null> {
    let info = getStoredDeviceInfo()
    if (!info) {
      info = await ensureDeviceBootstrap()
    }
    if (!info) return null
    return info
  }

  // ==========================================================================
  // РЕГИОН: SECRET CHAT — старт секретного чата, отправка через E2EE-движок
  // (v2) или legacy-путь, очередь сообщений до готовности ключей и их сброс.
  // ==========================================================================
  async function initiateSecretChat(targetUserId: string) {
    if (secretRequestLoading) return
    setSecretRequestLoading(true)
    try {
      const device = await ensureLocalDevice()
      if (!device) {
        systemToast.error('Не удалось инициализировать устройство для секретного чата')
        return
      }

      const resp = await api.post('/threads/secret', { peerUserId: targetUserId })
      const threadId = String(resp.data?.threadId ?? resp.data?.thread?.id ?? '').trim()
      const created = !!resp.data?.created
      const createdById = String(resp.data?.thread?.createdById ?? '').trim()
      client.invalidateQueries({ queryKey: ['conversations'] })
      if (threadId) {
        const amCreator = created || (!!me?.id && createdById === me.id)
        const returnedStatus = String(resp.data?.thread?.secretStatus ?? (created ? 'PENDING' : '')).toUpperCase()
        const initiatorDeviceId = String(resp.data?.thread?.secretInitiatorDeviceId ?? '')
        const amInitiatorDevice = created || (!!initiatorDeviceId && initiatorDeviceId === device.deviceId)
        // SecretEngine v2 path (feature flag): deterministic state machine + self-heal.
        // Legacy path keeps previous behavior for safe rollback.
        if (secretEngineV2Enabled && (!amCreator || returnedStatus === 'ACTIVE')) {
          // While PENDING the creator must NOT run the engine: it fans the key out to every peer
          // device, which both defeats accept-on-one-device and suppresses the peer's invite card.
          void ensureSecretEngineReady({ threadId, peerUserId: targetUserId, amCreator }).catch(() => {})
        } else if (amCreator && amInitiatorDevice) {
          // Only the creator's INITIATOR device mints the key (Android enforces the same rule):
          // a second creator device minting here would diverge from the real key, and the peer's
          // last-writer-wins import would brick earlier ciphertexts. Other creator devices
          // onboard via device-linking.
          ensureSecretThreadKey(threadId)
        }
        if (secretDebug) {
          // eslint-disable-next-line no-console
          console.log('[secret] start thread', {
            threadId,
            peerUserId: targetUserId,
            created,
            createdById,
            amCreator,
            hasKey: hasSecretThreadKey(threadId),
            localDeviceId: device.deviceId,
          })
        }
        // Open the thread right away — while PENDING the creator sees the "ждём подтверждения"
        // blocking card instead of the composer.
        selectConversation(threadId)
        // Accept-on-one-device: the creator generated the key above but does NOT fan it out. It waits
        // for the peer to accept the invite on ONE device (secret:chat:accepted), then keys exactly
        // that device (see the socket handler). This removes the "which peer device wins the TTL
        // lottery" problem; the peer's other devices onboard via "identify on another device".
      }
    } catch (err: any) {
      console.error('Failed to start secret conversation:', err)
      const errorMessage = err?.message || err?.response?.data?.message || 'Не удалось отправить запрос на секретный чат'
      systemToast.error(errorMessage)
    } finally {
      setSecretRequestLoading(false)
    }
  }

  type SendOutcome = 'sent' | 'queued' | 'blocked'

  async function sendMessageToConversation(
    conversation: any | null | undefined,
    payload: { type: string; content?: string | null; metadata?: Record<string, any>; replyToId?: string; attachments?: Array<any> },
  ): Promise<{ outcome: SendOutcome }> {
    if (!conversation) return { outcome: 'blocked' }
    // Normalize null content to undefined
    const normalizedPayload = { ...payload, content: payload.content ?? undefined }
    const isSecretV2 = String(conversation?.type ?? '').toUpperCase() === 'SECRET'
    if (isSecretV2) {
      const threadId = String(conversation.id ?? '').trim()
      const peerUserId =
        conversation?.participants?.find((p: any) => p?.user?.id && p.user.id !== currentUserId)?.user?.id ?? null
      if (!threadId || !peerUserId) {
        systemToast.error('Не удалось определить участника секретного чата')
        return { outcome: 'blocked' }
      }
      const text = String(normalizedPayload.content ?? '').trim()
      if (!text) return { outcome: 'blocked' }
      setSecretComposerInlineError(null)
      if (!hasSecretThreadKey(threadId)) {
        if (secretEngineV2Enabled) {
          const amCreator = !!(me?.id && String(conversation?.createdById ?? '') === me.id)
          void ensureSecretEngineReady({ threadId, peerUserId, amCreator }).catch(() => {})
        }
        // Non-blocking bootstrapping: queue locally, render as pending bubble, flush when keys arrive.
        const pendingId = `pending_secret_${typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : String(Date.now())}`
        setPendingByConv((prev) => ({
          ...prev,
          [threadId]: [
            ...(prev[threadId] || []),
            {
              id: pendingId,
              createdAt: Date.now(),
              senderId: currentUserId ?? 'me',
              attachments: [],
              content: text,
            },
          ],
        }))
        secretBootQueueRef.current[threadId] = [
          ...(secretBootQueueRef.current[threadId] || []),
          { pendingId, peerUserId, text, replyToId: normalizedPayload.replyToId ?? null },
        ]
        setSecretBootQueueVersion((v) => (v + 1) % Number.MAX_SAFE_INTEGER)
        // IMPORTANT: Do not auto-open any modal here.
        // Missing thread key is expected while waiting for key package delivery.
        // "Link device" is an explicit action from the user (Settings or inline CTA after timeout).
        return { outcome: 'queued' }
      }
      const { localMessage } = await sendSecretThreadText({
        threadId,
        peerUserId,
        text,
        allowGenerateKey: false,
      })
      // optimistic cache insert
      appendMessageToCache(threadId, {
        ...localMessage,
        senderId: currentUserId,
        sender: { id: currentUserId },
      })
      return { outcome: 'sent' }
    }

    if (conversation.isSecret) {
      try {
        // Legacy secret chats: never block UI with banners; show inline hint if session isn't ready yet.
        if (!e2eeManager.hasSession(conversation.id)) {
          setSecretComposerInlineError('🔒 Настраивается… сообщение можно отправить через пару секунд.')
          return { outcome: 'blocked' }
        }
        const encrypted = await e2eeManager.encryptPayload(conversation, normalizedPayload)
        await api.post('/conversations/send', encrypted)
        return { outcome: 'sent' }
      } catch (err) {
        console.warn('Failed to send legacy secret message:', err)
        setSecretComposerInlineError('Не удалось отправить в секретный чат. Попробуйте ещё раз.')
        return { outcome: 'blocked' }
      }
    }
    try {
      await api.post('/conversations/send', { conversationId: conversation.id, ...normalizedPayload })
      return { outcome: 'sent' }
    } catch (err: unknown) {
      console.warn('Failed to send message:', err)
      const ax = err as { response?: { data?: { message?: unknown }; status?: number } }
      const serverMsg = ax?.response?.data?.message
      const msg =
        typeof serverMsg === 'string' && serverMsg.trim()
          ? serverMsg.trim()
          : 'Не удалось отправить сообщение. Попробуйте ещё раз.'
      systemToast.error(msg)
      return { outcome: 'blocked' }
    }
  }

  /** Отправка уже подготовленных пересылок + необязательный комментарий из композера. */
  async function executeForwardPayloadDelivery(
    conversation: any,
    payloadsIn: Array<{ type: string; content?: string | null; metadata?: Record<string, any>; attachments?: any[] }>,
    mergeAsImageBulk: boolean,
    comment: string,
  ): Promise<{ lastOutcome: { outcome: SendOutcome } | null }> {
    const commentTrim = comment.trim()
    const forwardPayloads = payloadsIn.map((p) => ({
      ...p,
      replyToId: undefined as undefined,
      metadata:
        typeof p.metadata === 'object' && p.metadata !== null && !Array.isArray(p.metadata)
          ? { ...(p.metadata as Record<string, unknown>) }
          : {},
    }))

    if (!forwardPayloads.length) return { lastOutcome: null }

    if (mergeAsImageBulk) {
      const mergedAttachments = forwardPayloads.flatMap((p) => (Array.isArray(p.attachments) ? p.attachments : []))
      const captionParts = forwardPayloads.map((p) => String(p.content ?? '').trim()).filter(Boolean)
      /** Тексты из самих пересылаемых сообщений — комментарий из композера только в metadata (как при обычной пересылке), иначе UI не включает вложенный бабл без «Из …» / «Переслано». */
      const mergedContent = captionParts.length ? captionParts.join('\n\n') : undefined
      const baseMetaRaw = (() => {
        const withPeer = forwardPayloads.find((p) => {
          const m = p.metadata as Record<string, unknown> | undefined
          if (!m) return false
          if (typeof m.sourceDmPeerName === 'string' && String(m.sourceDmPeerName).trim() !== '') return true
          const ff = m.forwardFrom as { directChatPeerName?: string } | undefined
          return ff && typeof ff.directChatPeerName === 'string' && String(ff.directChatPeerName).trim() !== ''
        })
        const pick =
          withPeer ?? forwardPayloads.find((p) => Object.keys((p.metadata as Record<string, unknown>) || {}).length > 0)
        return pick?.metadata as Record<string, unknown> | undefined
      })()
      const mergedMetadata: Record<string, unknown> = {
        ...(baseMetaRaw && typeof baseMetaRaw === 'object' && !Array.isArray(baseMetaRaw) ? { ...baseMetaRaw } : {}),
        ...(commentTrim ? { [FORWARD_COMPOSER_CAPTION_META_KEY]: commentTrim } : {}),
      }
      const r = await sendMessageToConversation(conversation, {
        type: 'IMAGE',
        attachments: mergedAttachments,
        ...(mergedContent ? { content: mergedContent } : {}),
        ...(Object.keys(mergedMetadata).length > 0 ? { metadata: mergedMetadata } : {}),
        replyToId: undefined,
      })
      return { lastOutcome: r }
    }

    let lastOutcome: { outcome: SendOutcome } | null = null

    if (commentTrim && forwardPayloads.length > 0) {
      const m0meta = forwardPayloads[0].metadata as Record<string, unknown>
      forwardPayloads[0] = {
        ...forwardPayloads[0],
        metadata: {
          ...m0meta,
          [FORWARD_COMPOSER_CAPTION_META_KEY]: commentTrim,
        },
      }
    }

    for (const payload of forwardPayloads) {
      lastOutcome = await sendMessageToConversation(conversation, { ...payload, replyToId: undefined })
      if (lastOutcome?.outcome === 'blocked') return { lastOutcome }
    }
    return { lastOutcome }
  }

  const flushSecretBootQueue = useCallback(async () => {
    const entries = secretBootQueueRef.current
    const threadIds = Object.keys(entries)
    for (const threadId of threadIds) {
      const q = entries[threadId]
      if (!q || q.length === 0) {
        delete entries[threadId]
        continue
      }
      if (!hasSecretThreadKey(threadId)) continue
      if (secretBootFlushInFlightRef.current[threadId]) continue

      secretBootFlushInFlightRef.current[threadId] = true
      try {
        while (entries[threadId] && entries[threadId]!.length > 0) {
          const item = entries[threadId]![0]!
          const { localMessage } = await sendSecretThreadText({
            threadId,
            peerUserId: item.peerUserId,
            text: item.text,
            allowGenerateKey: false,
          })
          appendMessageToCache(threadId, {
            ...localMessage,
            senderId: currentUserId,
            sender: { id: currentUserId },
          })
          setPendingByConv((prev) => {
            const list = prev[threadId] || []
            if (!list.length) return prev
            const nextList = list.filter((m) => m.id !== item.pendingId)
            if (nextList.length === list.length) return prev
            return { ...prev, [threadId]: nextList }
          })
          entries[threadId]!.shift()
          setSecretBootQueueVersion((v) => (v + 1) % Number.MAX_SAFE_INTEGER)
        }
        setSecretComposerInlineError(null)
      } catch (err) {
        console.warn('Failed to flush queued secret messages:', err)
        setSecretComposerInlineError('Не удалось отправить сообщение в секретный чат. Проверьте подключение.')
        // Keep remaining queue for retry on next key update / manual send.
      } finally {
        secretBootFlushInFlightRef.current[threadId] = false
        if (!entries[threadId] || entries[threadId]!.length === 0) {
          delete entries[threadId]
        }
      }
    }
  }, [currentUserId])

  useEffect(() => {
    void flushSecretBootQueue().catch(() => {})
  }, [secretKeysVersion, flushSecretBootQueue])

  const closeAddParticipantsModal = () => {
    setAddParticipantsModal(false)
    setAddParticipantsSelectedIds([])
    setAddParticipantsLoading(false)
    setAddParticipantsMode('friends')
    setAddParticipantsEblDigits(['', '', '', ''])
    setAddParticipantsFoundUser(null)
    setAddParticipantsSearchError(null)
    setAddParticipantsSearching(false)
  }

  const handleAddParticipants = async () => {
    if (!activeId || addParticipantsSelectedIds.length === 0) {
      closeAddParticipantsModal()
      return
    }
    setAddParticipantsLoading(true)
    try {
      await api.post(`/conversations/${activeId}/participants`, { participantIds: addParticipantsSelectedIds })
      client.invalidateQueries({ queryKey: ['conversations'] })
      conversationsQuery.refetch()
      closeAddParticipantsModal()
    } catch (err: any) {
      console.error('Error adding participants:', err)
      systemToast.error(err.response?.data?.message || 'Не удалось добавить участников')
    } finally {
      setAddParticipantsLoading(false)
    }
  }

  const handleAddParticipantByEbl = async () => {
    if (!activeId || !addParticipantsFoundUser) return
    setAddParticipantsLoading(true)
    try {
      await api.post(`/conversations/${activeId}/participants`, { participantIds: [addParticipantsFoundUser.id] })
      client.invalidateQueries({ queryKey: ['conversations'] })
      conversationsQuery.refetch()
      closeAddParticipantsModal()
    } catch (err: any) {
      console.error('Error adding participant by EBLID:', err)
      systemToast.error(err.response?.data?.message || 'Не удалось добавить участника')
    } finally {
      setAddParticipantsLoading(false)
    }
  }

  const onKeyDownAddParticipantsDigit = (idx: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace' && !addParticipantsEblDigits[idx] && idx > 0) {
      e.preventDefault()
      const next = [...addParticipantsEblDigits]
      next[idx - 1] = ''
      setAddParticipantsEblDigits(next)
      setAddParticipantsFoundUser(null)
      setAddParticipantsSearchError(null)
      addParticipantsEblRefs[idx - 1].current?.focus()
    }
  }

  const onChangeAddParticipantsDigit = (idx: number, val: string) => {
    if (!/^\d?$/.test(val)) return
    const next = [...addParticipantsEblDigits]
    next[idx] = val
    setAddParticipantsEblDigits(next)
    if (val && idx < 3) addParticipantsEblRefs[idx + 1].current?.focus()
    if (!val && idx > 0) addParticipantsEblRefs[idx - 1].current?.focus()
    const full = next.join('')
    if (full.length === 4 && /^\d{4}$/.test(full)) {
      const token = Date.now()
      addParticipantsSearchTokenRef.current = token
      setAddParticipantsSearching(true)
      setAddParticipantsSearchError(null)
      api
        .get('/contacts/search', { params: { query: full } })
        .then((resp) => {
          if (addParticipantsSearchTokenRef.current !== token) return
          const user = resp.data.results?.[0] ?? null
          setAddParticipantsFoundUser(user)
          setAddParticipantsSearchError(user ? null : 'Пользователь не найден')
        })
        .catch(() => {
          if (addParticipantsSearchTokenRef.current !== token) return
          setAddParticipantsFoundUser(null)
          setAddParticipantsSearchError('Не удалось выполнить поиск')
        })
        .finally(() => {
          if (addParticipantsSearchTokenRef.current === token) {
            setAddParticipantsSearching(false)
          }
        })
    } else {
      setAddParticipantsFoundUser(null)
      setAddParticipantsSearchError(null)
      setAddParticipantsSearching(false)
    }
  }

  // Mobile "back" must match swipe-right behavior: show the list,
  // keep activeId so user can swipe back into the conversation.
  function backToList() {
    if (isMobileRef.current) {
      setMobileView('list')
      setShowJump(false)
    }
    // Only clear pending composer attachments when we actually leave the conversation pane.
    if (mobileView === 'conversation') {
      if (pendingImagesRef.current.length) {
        clearPendingImages()
      }
      if (pendingFilesRef.current.length) {
        clearPendingFiles()
      }
    }
  }

  const meInfoQuery = useQuery({
    queryKey: ['me-info'],
    queryFn: async () => {
      const r = await api.get('/status/me')
      return r.data.user as any
    }
  })
  const registrationInviteCodeQuery = useQuery({
    queryKey: ['registration-invite-code', 'contacts-overlay'],
    enabled: contactsOpen,
    queryFn: async () => {
      const r = await api.get('/auth/register/code')
      return r.data as { code: string; expiresAt: string }
    },
  })
  const conversationsQuery = useQuery({
    queryKey: ['conversations'],
    queryFn: async () => {
      const response = await api.get('/conversations')
      return response.data.conversations
    },
  })

  const [olderMeta, setOlderMeta] = useState<OlderMessagesMeta>({ hasMore: false, nextCursor: null })
  const [olderLoading, setOlderLoading] = useState<boolean>(false)
  const olderLoadingRef = useRef<boolean>(false)
  const olderMetaRef = useRef<OlderMessagesMeta>({ hasMore: false, nextCursor: null })
  const persistOlderMeta = useCallback((conversationId: string, meta: OlderMessagesMeta) => {
    olderMetaByConvRef.current.set(conversationId, meta)
    setOlderMeta(meta)
  }, [])
  useEffect(() => { olderMetaRef.current = olderMeta }, [olderMeta])

  const activeConversationRow = useMemo(() => {
    const id = activeId as string | null
    if (!id) return null
    return (conversationsQuery.data || []).find((r: any) => r?.conversation?.id === id) ?? null
  }, [conversationsQuery.data, activeId])

  const messagesQuery = useQuery({
    queryKey: ['messages', activeId],
    // IMPORTANT: don't fetch messages until we know the conversation type.
    // Otherwise SECRET chats may incorrectly hit /conversations/:id/messages and get 403.
    enabled: !!activeId && !!activeConversationRow?.conversation?.id,
    queryFn: async () => {
      const conversationId = activeId as string
      const conv = (activeConversationRow as any)?.conversation
      const isSecretV2 = String(conv?.type ?? '').toUpperCase() === 'SECRET'

      const fetchedResult = isSecretV2
        ? await fetchSecretHistory(conversationId, { limit: MESSAGES_PAGE_SIZE })
        : await (async () => {
            const response = await api.get(`/conversations/${conversationId}/messages`, { params: { limit: MESSAGES_PAGE_SIZE } })
            return {
              items: (response.data?.messages || []) as Array<any>,
              nextCursor: (response.data?.nextCursor ?? null) as string | null,
              hasMore: !!response.data?.hasMore,
            }
          })()

      const fetched = (fetchedResult.items || []) as Array<any>
      const normalizedFetched = isSecretV2
        ? fetched.map((it: any) => transformSecretHistoryItemToMessage(conversationId, it))
        : fetched
      const sortedFetched = [...normalizedFetched].sort(
        (a: any, b: any) => new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime(),
      )
      const nextCursor = (fetchedResult.nextCursor ?? null) as string | null
      const hasMore = !!fetchedResult.hasMore
      // Keep older pages already loaded when refetching.
      const existing = client.getQueryData(['messages', conversationId]) as Array<any> | undefined
      const merged = (() => {
        const all = [...(Array.isArray(existing) ? existing : []), ...sortedFetched]
        const byId = new Map<string, any>()
        for (const m of all) {
          if (m && m.id) byId.set(m.id, m)
        }
        return [...byId.values()].sort((a: any, b: any) => new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime())
      })()
      // Initialize cursor/meta only on first load; do not overwrite after older pages are loaded,
      // otherwise periodic refetch would reset `nextCursor` back to the newest page.
      const savedMeta = olderMetaByConvRef.current.get(conversationId)
      if (!Array.isArray(existing) || existing.length === 0) {
        persistOlderMeta(conversationId, { hasMore, nextCursor })
      } else if (!savedMeta?.nextCursor && existing.length <= MESSAGES_PAGE_SIZE) {
        // Cache was populated externally (e.g. inbox pump) with only the first page.
        persistOlderMeta(conversationId, { hasMore, nextCursor })
      }
      return merged
    },
    // Avoid hard overwriting older pages; we merge in queryFn.
    refetchInterval: activeId ? 15000 : false,
  })

  useEffect(() => {
    // Restore per-conversation pagination when switching chats (do not drop saved cursors).
    olderLoadingRef.current = false
    setOlderLoading(false)
    if (!activeId) {
      setOlderMeta({ hasMore: false, nextCursor: null })
      return
    }
    const saved = olderMetaByConvRef.current.get(activeId) ?? { hasMore: false, nextCursor: null }
    setOlderMeta(saved)
  }, [activeId])

  // ==========================================================================
  // РЕГИОН: OLDER MESSAGES — подгрузка истории вверх (инфинити-скролл).
  // Держит позицию прокрутки стабильной при добавлении старых сообщений сверху
  // (см. якорь scrollTop по дельте scrollHeight внутри).
  // ==========================================================================
  const loadOlderMessages = useCallback(async () => {
    const conversationId = activeId
    if (!conversationId) return
    if (olderLoadingRef.current) return
    const meta = olderMetaRef.current
    if (!meta.hasMore || !meta.nextCursor) return

    const el = messagesRef.current
    const before = el ? { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight } : null
    olderLoadingRef.current = true
    setOlderLoading(true)
    try {
      const conv = (activeConversationRow as any)?.conversation
      if (!conv) return
      const isSecretV2 = String(conv?.type ?? '').toUpperCase() === 'SECRET'

      const fetchedResult = isSecretV2
        ? await fetchSecretHistory(conversationId, { cursor: meta.nextCursor, limit: MESSAGES_PAGE_SIZE })
        : await (async () => {
            const resp = await api.get(`/conversations/${conversationId}/messages`, {
              params: { cursor: meta.nextCursor, limit: MESSAGES_PAGE_SIZE },
            })
            return {
              items: (resp.data?.messages || []) as Array<any>,
              nextCursor: (resp.data?.nextCursor ?? null) as string | null,
              hasMore: !!resp.data?.hasMore,
            }
          })()

      const fetched = (fetchedResult.items || []) as Array<any>
      const normalizedFetched = isSecretV2
        ? fetched.map((it: any) => transformSecretHistoryItemToMessage(conversationId, it))
        : fetched
      const sortedFetched = [...normalizedFetched].sort(
        (a: any, b: any) => new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime(),
      )
      const nextCursor = (fetchedResult.nextCursor ?? null) as string | null
      const hasMore = !!fetchedResult.hasMore

      client.setQueryData(['messages', conversationId], (old: any) => {
        const existing = Array.isArray(old) ? old : []
        const byId = new Map<string, any>()
        for (const m of [...sortedFetched, ...existing]) {
          if (m && m.id) byId.set(m.id, m)
        }
        return [...byId.values()].sort((a: any, b: any) => new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime())
      })
      persistOlderMeta(conversationId, { hasMore, nextCursor })

      if (before && messagesRef.current) {
        requestAnimationFrame(() => {
          const el2 = messagesRef.current
          if (!el2) return
          const delta = el2.scrollHeight - before.scrollHeight
          if (delta > 0) {
            el2.scrollTop = before.scrollTop + delta
          }
        })
      }
    } catch (err) {
      console.warn('[ChatsPage] Failed to load older messages', err)
    } finally {
      olderLoadingRef.current = false
      setOlderLoading(false)
    }
  }, [activeId, client, activeConversationRow, persistOlderMeta])

  // Lazy link preview fetch for older messages (or when socket updates are missed).
  // Server persists preview in message.metadata and may broadcast message:update.
  const requestedPreviewsRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    if (!activeId) return
    const row = (conversationsQuery.data || []).find((r: any) => r?.conversation?.id === activeId)
    const isSecret = !!row?.conversation?.isSecret
    if (isSecret) return
    const list = (messagesQuery.data || []) as any[]
    if (!list.length) return
    const candidates = list
      .filter((m) => m && m.type === 'TEXT' && typeof m.content === 'string' && m.content && !m.deletedAt)
      // Do not gate by attemptedAt here: we may have attempted before we added oEmbed support (e.g., YouTube).
      .filter((m) => !(m as any)?.metadata?.linkPreview)
      .filter((m) => {
        if (requestedPreviewsRef.current.has(m.id)) return false
        return !!extractFirstPreviewableUrl(m.content)
      })
      .slice(0, 2)

    if (candidates.length === 0) return

    candidates.forEach((m) => {
      requestedPreviewsRef.current.add(m.id)
      api.get(`/messages/${m.id}/preview`)
        .then((r) => {
          const updated = r.data?.message
          if (updated && updated.id) {
            updateMessageInCache(activeId, updated, { preserveScroll: true })
          } else {
            // fallback
            messagesQuery.refetch().catch(() => {})
          }
        })
        .catch(() => {
          try {
            // Make failures visible even when logs are silenced.
            console.warn('[linkPreview] preview request failed for message', m.id)
          } catch {}
          // allow retry later
          requestedPreviewsRef.current.delete(m.id)
        })
    })
  }, [activeId, conversationsQuery.data, messagesQuery.data])

  useEffect(() => {
    const error = messagesQuery.error as AxiosError | undefined
    if (error?.response?.status === 403 && activeId) {
      console.warn('[ChatsPage] Lost access to conversation, closing view', activeId)
      client.removeQueries({ queryKey: ['messages', activeId] })
      setActiveId(null)
    }
  }, [messagesQuery.error, activeId, client])

  const contactsQuery = useQuery({
    queryKey: ['accepted-contacts'],
    queryFn: async () => {
      const r = await api.get('/contacts', { params: { filter: 'accepted' } })
      return r.data.contacts as Array<any>
    },
  })

  const incomingContactsQuery = useQuery({
    queryKey: ['incoming-contacts'],
    queryFn: async () => {
      const r = await api.get('/contacts', { params: { filter: 'incoming' } })
      return r.data.contacts as Array<any>
    },
  })

  const outgoingContactsQuery = useQuery({
    queryKey: ['contacts', 'outgoing'],
    queryFn: async () => {
      const r = await api.get('/contacts', { params: { filter: 'outgoing' } })
      return r.data.contacts as Array<any>
    },
  })

  useEffect(() => {
    if (!activeId) return
    if (typeof window === 'undefined') return
    try {
      window.localStorage.setItem(LAST_ACTIVE_CONVERSATION_KEY, activeId)
    } catch {}
  }, [activeId])

  useEffect(() => {
    if (typeof window === 'undefined') return
    if (activeId) return
    const rows = conversationsQuery.data
    if (!rows || rows.length === 0) return
    try {
      const stored = window.localStorage.getItem(LAST_ACTIVE_CONVERSATION_KEY)
      if (!stored) return
      const exists = rows.some((row: any) => row?.conversation?.id === stored)
      if (exists) {
        selectConversation(stored)
      }
    } catch {}
  }, [activeId, conversationsQuery.data, mobileView])

  const closeNewGroupModal = () => {
    setNewGroupOpen(false)
    setGroupTitle('')
    setSelectedIds([])
    setCreatingGroup(false)
    if (newGroupAvatarPreviewUrl) {
      try {
        URL.revokeObjectURL(newGroupAvatarPreviewUrl)
      } catch {
        // ignore
      }
    }
    setNewGroupAvatarPreviewUrl(null)
    if (newGroupAvatarSourceUrl) {
      try {
        URL.revokeObjectURL(newGroupAvatarSourceUrl)
      } catch {
        // ignore
      }
    }
    setNewGroupAvatarSourceUrl(null)
    setNewGroupAvatarFile(null)
    setNewGroupAvatarBlob(null)
    setNewGroupCrop({ x: 0, y: 0, scale: 1 })
    setNewGroupAvatarEditorOpen(false)
    setNewGroupAvatarHover(false)
  }

  // Scroll shadows for conversations list
  useEffect(() => {
    const el = convScrollRef.current
    if (!el) return

    const update = () => {
      const { scrollTop, scrollHeight, clientHeight } = el
      const hasTop = scrollTop > 2
      const hasBottom = scrollHeight - scrollTop - clientHeight > 2
      setConvHasTopFade(hasTop)
      setConvHasBottomFade(hasBottom)
    }

    update()
    el.addEventListener('scroll', update)
    window.addEventListener('resize', update)

    return () => {
      el.removeEventListener('scroll', update)
      window.removeEventListener('resize', update)
    }
  }, [conversationsQuery.data?.length])

  useEffect(() => {
    try {
      const list = (conversationsQuery.data || []).map((r: any) => r.conversation.id)
      try {
        const qs = new URLSearchParams(window.location.search)
        const q = qs.get('lkDebugCallStatus')
        const debugCallStatus = (q === '1' || q === 'true') || (window.localStorage.getItem('lk-debug-callstatus') === '1' || window.localStorage.getItem('lk-debug-callstatus') === 'true')
        if (debugCallStatus) console.log('[CallStatus] Requesting statuses for:', list)
      } catch {
        // ignore
      }
      if (list.length > 0) requestCallStatuses(list)
      for (const cid of list) {
        try {
          joinConversation(cid)
          markConversationJoined(cid)
        } catch {}
      }
    } catch {}
  }, [conversationsQuery.data, markConversationJoined])

  const activeConversation = useMemo(() => {
    return conversationsQuery.data?.find((r: any) => r.conversation.id === activeId)?.conversation
  }, [conversationsQuery.data, activeId])

  // Позиция каждого участника активной беседы в отсортированном списке. Этот же
  // индекс используют и цвет имени, и фон пузыря — поэтому в пределах одной
  // группы двое не получат ни одинаковый цвет имени, ни одинаковый фон, а «имя+
  // фон» одного человека берутся из согласованного слота.
  const participantColorIndex = useMemo(() => {
    const ids = ((activeConversation?.participants ?? []) as any[])
      .map((p) => p?.user?.id)
      .filter((x): x is string => typeof x === 'string' && x.length > 0)
    const ordered = Array.from(new Set(ids)).sort()
    const map = new Map<string, number>()
    ordered.forEach((id, i) => map.set(id, i))
    return map
  }, [activeConversation])

  // Sync group title input with the active conversation when the group editor opens.
  useEffect(() => {
    if (groupAvatarEditor) {
      setGroupTitleEditValue(activeConversation?.title ?? '')
    }
  }, [groupAvatarEditor, activeConversation?.id, activeConversation?.title])

  useEffect(() => {
    const isSecretV2 = Boolean(activeConversation?.id && String(activeConversation?.type ?? '').toUpperCase() === 'SECRET')
    if (!isSecretV2) return
    if (!activeConversation?.id) return
    const hasKey = hasSecretThreadKey(activeConversation.id)
    if (hasKey) {
      // Auto-close gate if the key arrived (e.g. via linked device / key package).
      if (secretHistoryGate.open && secretHistoryGate.threadId === activeConversation.id) {
        setSecretHistoryGate({ open: false, threadId: null })
      }
      return
    }
    // IMPORTANT: Do NOT auto-open link-device gate when key is missing.
    // Missing key can be normal while waiting for the peer's key package, and on the first device
    // there may be no other trusted device to link from.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeConversation?.id, activeConversation?.type, secretKeysVersion])

  useEffect(() => {
    return () => {
      attachmentDecryptUrlsRef.current.forEach((url) => URL.revokeObjectURL(url))
      attachmentDecryptUrlsRef.current.clear()
      attachmentDecryptInProgressRef.current.clear()
    }
  }, [])

  useEffect(() => {
      attachmentDecryptUrlsRef.current.forEach((url) => URL.revokeObjectURL(url))
      attachmentDecryptUrlsRef.current.clear()
      attachmentDecryptInProgressRef.current.clear()
      setAttachmentDecryptMap({})
  }, [activeConversation?.id])

  const localDeviceId = useMemo(() => getStoredDeviceInfo()?.deviceId ?? null, [e2eeVersion])
  const myDevicesMap = useMemo(() => {
    const map: Record<string, { id: string; name?: string; platform?: string | null; userId: string }> = {}
    for (const device of devicesQuery.data || []) {
      map[device.id] = device
    }
    return map
  }, [devicesQuery.data])

  const resolveConversationDeviceId = useCallback(
    (conversation: any | null | undefined) => {
      const isSecretV2 = String(conversation?.type ?? '').toUpperCase() === 'SECRET'
      if (!conversation?.isSecret || isSecretV2) return null
      const ids = [conversation.secretInitiatorDeviceId, conversation.secretPeerDeviceId]
      for (const deviceId of ids) {
        if (!deviceId) continue
        const info = myDevicesMap[deviceId]
        if (info?.userId && me?.id && info.userId === me.id) {
          return deviceId
        }
      }
      if (me?.id) {
        if (conversation.createdById === me.id && conversation.secretInitiatorDeviceId) {
          return conversation.secretInitiatorDeviceId
        }
        if (conversation.createdById !== me.id && conversation.secretPeerDeviceId) {
          return conversation.secretPeerDeviceId
        }
      }
      return null
    },
    [myDevicesMap, me?.id],
  )

  const myConversationDeviceId = useMemo(() => resolveConversationDeviceId(activeConversation), [activeConversation, resolveConversationDeviceId])
  const connectedDeviceName = useMemo(() => {
    if (!myConversationDeviceId) return undefined
    const fromMap = myDevicesMap[myConversationDeviceId]?.name
    if (fromMap && fromMap.trim()) return fromMap
    const localInfo = getStoredDeviceInfo()
    if (localInfo && localInfo.deviceId === myConversationDeviceId && localInfo.name) {
      return localInfo.name
    }
    return undefined
  }, [myConversationDeviceId, myDevicesMap, e2eeVersion])

  const isSecretBlockedForDevice = useCallback(
    (conversationId: string) => {
      if (!conversationId) return false
      const conv = (conversationsQuery.data || []).find((row: any) => row?.conversation?.id === conversationId)?.conversation
      const isSecretV2 = String(conv?.type ?? '').toUpperCase() === 'SECRET'
      if (!conv?.isSecret || isSecretV2) return false
      const convDeviceId = resolveConversationDeviceId(conv)
      return Boolean(convDeviceId && localDeviceId && convDeviceId !== localDeviceId)
    },
    [conversationsQuery.data, localDeviceId, resolveConversationDeviceId],
  )
  const isLegacySecret = Boolean(activeConversation?.isSecret && String(activeConversation?.type ?? '').toUpperCase() !== 'SECRET')
  const conversationSecretInactive = !!(isLegacySecret && (activeConversation.secretStatus ?? 'ACTIVE') !== 'ACTIVE')
  const conversationSecretSessionReady = useMemo(() => {
    if (!isLegacySecret) return true
    return e2eeManager.hasSession(activeConversation.id)
  }, [activeConversation?.id, isLegacySecret, e2eeVersion])
  const secretBlockedByOtherDevice = Boolean(
    isLegacySecret &&
    !conversationSecretInactive &&
    !conversationSecretSessionReady &&
    myConversationDeviceId &&
    localDeviceId &&
    myConversationDeviceId !== localDeviceId,
  )
  const endSecretLabel = secretBlockedByOtherDevice ? 'Завершить везде' : 'Завершить'
  const endSecretTitle = secretBlockedByOtherDevice ? 'Завершить везде' : 'Завершить секретный чат'

  type SecretReadyState = 'ready' | 'bootstrapping' | 'error'

  const SECRET_V2_ERROR_KEY = 'eb_secret_v2_thread_error_v1'
  const getSecretV2ErrorCode = (threadId: string): string | null => {
    try {
      const raw = localStorage.getItem(SECRET_V2_ERROR_KEY)
      if (!raw) return null
      const parsed = JSON.parse(raw) as any
      const rec = parsed && typeof parsed === 'object' ? parsed[String(threadId)] : null
      const code = typeof rec?.code === 'string' ? rec.code : null
      const at = typeof rec?.at === 'number' ? rec.at : 0
      if (!code) return null
      // expire after 1 hour
      if (at && Date.now() - at > 60 * 60_000) return null
      return code
    } catch {
      return null
    }
  }
  const setSecretV2ErrorCode = (threadId: string, code: string) => {
    try {
      const raw = localStorage.getItem(SECRET_V2_ERROR_KEY)
      const parsed = raw ? (JSON.parse(raw) as any) : {}
      const obj = parsed && typeof parsed === 'object' ? parsed : {}
      obj[String(threadId)] = { code: String(code), at: Date.now() }
      localStorage.setItem(SECRET_V2_ERROR_KEY, JSON.stringify(obj))
    } catch {}
  }
  const clearSecretV2ErrorCode = (threadId: string) => {
    try {
      const raw = localStorage.getItem(SECRET_V2_ERROR_KEY)
      if (!raw) return
      const parsed = JSON.parse(raw) as any
      const obj = parsed && typeof parsed === 'object' ? parsed : {}
      if (obj[String(threadId)]) {
        delete obj[String(threadId)]
        localStorage.setItem(SECRET_V2_ERROR_KEY, JSON.stringify(obj))
      }
    } catch {}
  }

  const activeSecretUiState = useMemo(() => {
    if (!activeConversation?.isSecret) {
      return { isSecret: false, readyState: 'ready' as SecretReadyState, error: null as string | null }
    }
    const isSecretV2 = String(activeConversation?.type ?? '').toUpperCase() === 'SECRET'
    if (isSecretV2) {
      const threadId = String(activeConversation.id ?? '').trim()
      if (secretEngineV2Enabled) {
        const view = getSecretEngineThreadView(threadId)
        if (view.state === 'READY') {
          return { isSecret: true, readyState: 'ready' as SecretReadyState, error: null as string | null }
        }
        if (view.state === 'ERROR') {
          return { isSecret: true, readyState: 'error' as SecretReadyState, error: (view.reasonCode ?? null) as string | null }
        }
        return { isSecret: true, readyState: 'bootstrapping' as SecretReadyState, error: null as string | null }
      }
      const ready = !!(threadId && hasSecretThreadKey(threadId))
      if (ready) return { isSecret: true, readyState: 'ready' as SecretReadyState, error: null as string | null }
      const code = threadId ? getSecretV2ErrorCode(threadId) : null
      if (code) return { isSecret: true, readyState: 'error' as SecretReadyState, error: code }
      return { isSecret: true, readyState: 'bootstrapping' as SecretReadyState, error: null as string | null }
    }
    const status = String(activeConversation?.secretStatus ?? 'ACTIVE').toUpperCase()
    if (status !== 'ACTIVE') {
      return { isSecret: true, readyState: 'error' as SecretReadyState, error: null as string | null }
    }
    const ready = e2eeManager.hasSession(activeConversation.id)
    return { isSecret: true, readyState: (ready ? 'ready' : 'bootstrapping') as SecretReadyState, error: null as string | null }
  }, [activeConversation?.id, activeConversation?.isSecret, activeConversation?.type, activeConversation?.secretStatus, secretKeysVersion, secretEngineV2Version, secretEngineV2Enabled, e2eeVersion, secretComposerInlineError])

  // A PENDING secret invite that THIS user (not the creator) must accept on ONE device. Drives the
  // accept/decline card and suppresses the key-wait machinery until accepted.
  const secretInviteForMe = useMemo(() => {
    const conv = activeConversation
    if (!conv) return null
    if (String(conv?.type ?? '').toUpperCase() !== 'SECRET') return null
    if (String(conv?.secretStatus ?? '').toUpperCase() !== 'PENDING') return null
    const myId = me?.id ?? storedUserIdRef.current
    if (!myId) return null
    if (String(conv?.createdById ?? '') === myId) return null // the creator waits, does not accept
    if (hasSecretThreadKey(String(conv.id ?? ''))) return null // already keyed → treat as active
    const peer = (conv.participants || []).find((p: any) => p?.user?.id && p.user.id !== myId)?.user
    const fromName = peer?.displayName || peer?.username || 'Собеседник'
    return { conversationId: String(conv.id ?? ''), fromName }
  }, [activeConversation?.id, activeConversation?.type, activeConversation?.secretStatus, activeConversation?.createdById, secretKeysVersion, me?.id])

  const [secretInviteBusy, setSecretInviteBusy] = useState(false)
  const acceptSecretInvite = async () => {
    const convId = secretInviteForMe?.conversationId
    if (!convId || secretInviteBusy) return
    setSecretInviteBusy(true)
    try {
      const device = await ensureLocalDevice()
      const deviceId = device?.deviceId ?? getStoredDeviceInfo()?.deviceId
      if (!deviceId) {
        systemToast.error('Не удалось определить устройство')
        return
      }
      // Accept on THIS device — the creator will now key exactly this one; the pump imports it.
      await api.post(`/threads/secret/${convId}/accept`, { deviceId })
      client.invalidateQueries({ queryKey: ['conversations'] })
      conversationsQuery.refetch()
    } catch (err: any) {
      systemToast.error(err?.response?.data?.message || 'Не удалось принять приглашение')
    } finally {
      setSecretInviteBusy(false)
    }
  }
  const declineSecretInvite = async () => {
    const convId = secretInviteForMe?.conversationId
    if (!convId || secretInviteBusy) return
    setSecretInviteBusy(true)
    try {
      await api.post(`/threads/secret/${convId}/decline`, {})
      client.invalidateQueries({ queryKey: ['conversations'] })
    } catch (err: any) {
      systemToast.error(err?.response?.data?.message || 'Не удалось отклонить приглашение')
    } finally {
      setSecretInviteBusy(false)
    }
  }

  // CREATOR side of a PENDING invite: the chat is open but blocked until the peer accepts.
  const secretWaitingAsCreator = useMemo(() => {
    const conv = activeConversation
    if (!conv) return null
    if (String(conv?.type ?? '').toUpperCase() !== 'SECRET') return null
    if (String(conv?.secretStatus ?? '').toUpperCase() !== 'PENDING') return null
    const myId = me?.id ?? storedUserIdRef.current
    if (!myId) return null
    if (String(conv?.createdById ?? '') !== String(myId)) return null // peers get the invite card instead
    const peer = (conv.participants || []).find((p: any) => p?.user?.id && p.user.id !== myId)?.user
    const peerName = peer?.displayName || peer?.username || 'собеседника'
    return { conversationId: String(conv.id ?? ''), peerName }
  }, [activeConversation?.id, activeConversation?.type, activeConversation?.secretStatus, activeConversation?.createdById, me?.id])

  const cancelSecretInviteAsCreator = async () => {
    const convId = secretWaitingAsCreator?.conversationId
    if (!convId || secretInviteBusy) return
    setSecretInviteBusy(true)
    try {
      await api.post(`/threads/secret/${convId}/decline`, {})
      client.invalidateQueries({ queryKey: ['conversations'] })
      setActiveId(null)
      if (isMobile) setMobileView('list')
    } catch (err: any) {
      systemToast.error(err?.response?.data?.message || 'Не удалось отменить приглашение')
    } finally {
      setSecretInviteBusy(false)
    }
  }

  // Reconcile: if this creating device holds the key and the peer accepted while we were offline
  // (secretStatus ACTIVE + secretPeerDeviceId set, but no receipt yet), key that device now. Once per
  // (thread,device) per session; the peer's key_receipt confirms delivery.
  const secretReconcileAttemptedRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    const list = conversationsQuery.data as any[] | undefined
    if (!Array.isArray(list)) return
    const myId = me?.id ?? storedUserIdRef.current
    if (!myId) return
    for (const row of list) {
      const conv = row?.conversation
      if (!conv) continue
      if (String(conv.type ?? '').toUpperCase() !== 'SECRET') continue
      if (String(conv.secretStatus ?? '').toUpperCase() !== 'ACTIVE') continue
      if (String(conv.createdById ?? '') !== myId) continue
      const peerDeviceId = String(conv.secretPeerDeviceId ?? '').trim()
      if (!peerDeviceId) continue
      const threadId = String(conv.id ?? '')
      if (!threadId || !hasSecretThreadKey(threadId)) continue
      if (getReceiptDeviceIds(threadId).includes(peerDeviceId)) continue
      const k = `${threadId}:${peerDeviceId}`
      if (secretReconcileAttemptedRef.current.has(k)) continue
      secretReconcileAttemptedRef.current.add(k)
      void shareSecretThreadKeyToDevice(threadId, peerDeviceId).catch(() => {
        secretReconcileAttemptedRef.current.delete(k)
      })
    }
  }, [conversationsQuery.data, me?.id, secretKeysVersion])

  const creatorAwaitPeerAccept = useMemo(() => {
    const conv = activeConversation
    if (!conv?.isSecret) return false
    const isSecretV2 = String(conv?.type ?? '').toUpperCase() === 'SECRET'
    if (!isSecretV2) return false
    const threadId = String(conv.id ?? '').trim()
    if (!threadId) return false
    const amCreator = !!(me?.id && String(conv?.createdById ?? '') === me.id)
    if (!amCreator) return false
    // Only show this "await peer" state when our local key exists (we're ready),
    // but peer hasn't confirmed import yet.
    if (!hasSecretThreadKey(threadId)) return false
    const myDeviceIds = new Set((devicesQuery.data || []).map((d: any) => String(d?.id ?? '').trim()).filter(Boolean))
    const receiptIds = getReceiptDeviceIds(threadId)
    const hasPeerReceipt = receiptIds.some((d) => d && !myDeviceIds.has(d))
    if (hasPeerReceipt) return false
    // Avoid infinite "waiting" on re-enter: show only shortly after we actually sent key-packages.
    // If peer never sends receipt (old client/offline), we stop showing this state.
    const pendingIds = getPendingDeviceIds(threadId)
    const hasPendingPeer = pendingIds.some((d) => d && !myDeviceIds.has(d))
    if (!hasPendingPeer) return false
    const lastSentAt = getLastPendingShareAt(threadId)
    if (!lastSentAt) return false
    return Date.now() - lastSentAt < 25_000
  }, [activeConversation?.id, activeConversation?.type, activeConversation?.isSecret, activeConversation?.createdById, me?.id, devicesQuery.data, secretEngineV2Version])

  // Show a short "done" checkmark pulse when bootstrapping finishes.
  useEffect(() => {
    const isSecretV2 = String(activeConversation?.type ?? '').toUpperCase() === 'SECRET'
    const isBoot = !!(isSecretV2 && activeSecretUiState?.isSecret && activeSecretUiState.readyState === 'bootstrapping')
    const isReady = !!(isSecretV2 && activeSecretUiState?.isSecret && activeSecretUiState.readyState === 'ready')
    if (isReady && prevSecretBootReadyRef.current === false) {
      setSecretBootDonePulse(Date.now())
      const t = window.setTimeout(() => setSecretBootDonePulse(0), 700)
      return () => window.clearTimeout(t)
    }
    prevSecretBootReadyRef.current = isReady
    if (isBoot) {
      // reset when entering bootstrapping
      setSecretBootDonePulse(0)
    }
  }, [activeConversation?.id, activeConversation?.type, activeSecretUiState?.readyState, activeSecretUiState?.isSecret])

  const activeSecretQueuedCount = useMemo(() => {
    const threadId = String(activeConversation?.id ?? '').trim()
    if (!threadId) return 0
    const q = secretBootQueueRef.current[threadId]
    return Array.isArray(q) ? q.length : 0
  }, [activeConversation?.id, secretBootQueueVersion])

  useEffect(() => {
    if (!activeConversation?.isSecret) return
    const isSecretV2 = String(activeConversation?.type ?? '').toUpperCase() === 'SECRET'
    if (!isSecretV2) return
    const threadId = String(activeConversation.id ?? '').trim()
    if (!threadId) return
    const hasKey = hasSecretThreadKey(threadId)
    if (
      String(activeConversation?.secretStatus ?? '').toUpperCase() === 'PENDING' &&
      !(me?.id && String(activeConversation?.createdById ?? '') === me.id) &&
      !hasKey
    ) {
      return
    }
    const peerUserId =
      activeConversation?.participants?.find((p: any) => p?.user?.id && p.user.id !== currentUserId)?.user?.id ?? null
    const amCreator = !!(me?.id && String(activeConversation?.createdById ?? '') === me.id)
    if (secretDebug) {
      // eslint-disable-next-line no-console
      console.log('[secret] open thread', {
        threadId,
        peerUserId,
        hasKey,
        queued: (secretBootQueueRef.current[threadId] || []).length,
      })
    }
    if (hasKey) {
      delete secretBootStartedAtRef.current[threadId]
      clearSecretV2ErrorCode(threadId)
      setSecretComposerInlineError(null)
      return
    }
    if (!secretBootStartedAtRef.current[threadId]) {
      secretBootStartedAtRef.current[threadId] = Date.now()
    }
    if (secretEngineV2Enabled && peerUserId) {
      void ensureSecretEngineReady({ threadId, peerUserId, amCreator }).catch(() => {})
    }
    const startedAt = secretBootStartedAtRef.current[threadId]
    const t = window.setTimeout(() => {
      // If still no key after 120s, show inline error + CTA (no banners).
      if (!hasSecretThreadKey(threadId)) {
        // Last-chance: refresh/publish OPKs + request resend + pull once more,
        // then give it a short grace window to avoid flashing NO_KEYPACKAGE right before the key arrives.
        if (secretEngineV2Enabled && peerUserId) {
          void (async () => {
            try {
              await refreshKeysAndRetry({ threadId, peerUserId, amCreator })
            } catch {}
            try {
              const fn = (window as any).__ebSecretInboxPullNow
              if (typeof fn === 'function') await fn()
            } catch {}
          })()
          window.setTimeout(() => {
            if (hasSecretThreadKey(threadId)) return
            try {
              const raw = localStorage.getItem('eb_secret_last_root_cause_v1')
              if (raw) {
                const parsed = JSON.parse(raw) as any
                const code = typeof parsed?.code === 'string' ? parsed.code : ''
                if (code) {
                  // eslint-disable-next-line no-console
                  console.log(`ROOT_CAUSE=${code}`)
                  setSecretV2ErrorCode(threadId, code)
                } else {
                  setSecretV2ErrorCode(threadId, 'NO_KEYPACKAGE')
                }
              } else {
                setSecretV2ErrorCode(threadId, 'NO_KEYPACKAGE')
              }
            } catch {}
            setSecretComposerInlineError(
              hasOtherTrustedDevice
                ? `Не удалось получить ключи для секретного чата (${getSecretV2ErrorCode(threadId) ?? 'NO_KEYPACKAGE'}).`
                : `Не удалось получить ключи для секретного чата (${getSecretV2ErrorCode(threadId) ?? 'NO_KEYPACKAGE'}).`,
            )
          }, 12_000)
          return
        }
        try {
          const raw = localStorage.getItem('eb_secret_last_root_cause_v1')
          if (raw) {
            const parsed = JSON.parse(raw) as any
            const code = typeof parsed?.code === 'string' ? parsed.code : ''
            if (code) {
              // eslint-disable-next-line no-console
              console.log(`ROOT_CAUSE=${code}`)
              setSecretV2ErrorCode(threadId, code)
            } else {
              setSecretV2ErrorCode(threadId, 'NO_KEYPACKAGE')
            }
          } else {
            setSecretV2ErrorCode(threadId, 'NO_KEYPACKAGE')
          }
        } catch {}
        setSecretComposerInlineError(
          hasOtherTrustedDevice
            ? `Не удалось получить ключи для секретного чата (${getSecretV2ErrorCode(threadId) ?? 'NO_KEYPACKAGE'}).`
            : `Не удалось получить ключи для секретного чата (${getSecretV2ErrorCode(threadId) ?? 'NO_KEYPACKAGE'}).`,
        )
      }
    }, Math.max(0, 120_000 - (Date.now() - startedAt)))
    return () => window.clearTimeout(t)
  }, [activeConversation?.id, activeConversation?.isSecret, activeConversation?.type, activeConversation?.createdById, activeConversation?.secretStatus, secretKeysVersion, currentUserId, me?.id, secretDebug, hasOtherTrustedDevice, secretEngineV2Enabled])

  useEffect(() => {
    if (!activeConversation?.isSecret) return
    if (activeConversation.secretStatus !== 'ACTIVE') return
    // Secret chat v2 does NOT use legacy per-conversation E2EE sessions.
    if (String((activeConversation as any)?.type ?? '').toUpperCase() === 'SECRET') return
    let cancelled = false
    e2eeManager.ensureSession(activeConversation).then((session) => {
      if (!cancelled && session) {
        setE2eeVersion((v) => (v + 1) % Number.MAX_SAFE_INTEGER)
      }
    }).catch((err) => {
      console.warn('Failed to ensure E2EE session', err)
    })
    return () => {
      cancelled = true
    }
  }, [activeConversation?.id, activeConversation?.secretStatus, activeConversation?.isSecret])

  useEffect(() => {
    if (!activeConversation?.isSecret) return
    if (!messagesQuery.data || messagesQuery.data.length === 0) return
    // Secret chat v2 does NOT use legacy per-conversation handshake processing.
    if (String((activeConversation as any)?.type ?? '').toUpperCase() === 'SECRET') return
    const updated = e2eeManager.processHandshakes(activeConversation, messagesQuery.data)
    if (updated) {
      setE2eeVersion((v) => (v + 1) % Number.MAX_SAFE_INTEGER)
    }
  }, [messagesQuery.data, activeConversation?.id, activeConversation?.isSecret, activeConversation?.secretStatus])

  const displayedMessages = useMemo(() => {
    if (!messagesQuery.data) return []
    if (!activeConversation?.isSecret) {
      return messagesQuery.data
    }
    // Secret chat v2: messages are already decrypted (or explicitly locked) via secret thread key store.
    // Do NOT run legacy e2eeManager.transformMessage here.
    if (String((activeConversation as any)?.type ?? '').toUpperCase() === 'SECRET') {
      return messagesQuery.data.filter((msg: any) => {
        const meta = (msg?.metadata ?? {}) as Record<string, any>
        const e2eeMeta = meta.e2ee
        return !(e2eeMeta && e2eeMeta.kind === 'handshake')
      })
    }
    return messagesQuery.data
      .filter((msg: any) => {
        const meta = (msg?.metadata ?? {}) as Record<string, any>
        const e2eeMeta = meta.e2ee
        return !(e2eeMeta && e2eeMeta.kind === 'handshake')
      })
      .map((msg: any) => e2eeManager.transformMessage(activeConversation.id, msg))
  }, [messagesQuery.data, activeConversation?.id, activeConversation?.isSecret, e2eeVersion])

  useEffect(() => {
    ebloRangeRef.current = ebloRange
  }, [ebloRange])

  // ==========================================================================
  // РЕГИОН: MESSAGE LIST VIEWPORT — виртуализация «Eblo» + прилипание к низу.
  //   estimateEbloRowHeight / updateEblo / scheduleEbloUpdate — выбор видимого окна
  //   строк (см. chats/chatsEblo). handleEbloRowHeightChange — реакция на измеренную
  //   высоту строки. pinToBottomBurst + ResizeObserver контента — надёжное
  //   прилипание к низу при догрузке картинок/мозаик/видео (см. эффекты ниже).
  //   nearBottomRef — мы у низа; userStickyScrollRef=true — пользователь ушёл вверх.
  // ==========================================================================
  const estimateEbloRowHeight = useCallback((rowKey: string) => {
    const cached = ebloRowHeightsRef.current.get(rowKey)
    if (typeof cached === 'number' && Number.isFinite(cached) && cached > 0) return cached
    if (rowKey.startsWith('bundle:') || rowKey.startsWith('forward:')) return EBLO_FORWARD_ROW_HEIGHT
    if (rowKey.startsWith('system:')) return EBLO_SYSTEM_ROW_HEIGHT
    return EBLO_DEFAULT_ROW_HEIGHT
  }, [])

  const setEbloRangeIfChanged = useCallback((next: EbloRange) => {
    const prev = ebloRangeRef.current
    if (prev.start === next.start && prev.end === next.end) return
    ebloRangeRef.current = next
    setEbloRange(next)
  }, [])

  const updateEblo = useCallback(() => {
    const rows = ebloRowsRef.current
    const el = messagesRef.current
    if (!el || rows.length <= EBLO_MIN_ROWS) {
      setEbloRangeIfChanged({ start: 0, end: Number.MAX_SAFE_INTEGER })
      return
    }

    const viewportTop = Math.max(0, el.scrollTop - Math.max(EBLO_OVERSCAN_PX, el.clientHeight * 2))
    const viewportBottom = el.scrollTop + el.clientHeight + Math.max(EBLO_OVERSCAN_PX, el.clientHeight * 2)
    let y = 0
    let start = 0
    let end = Math.min(rows.length - 1, EBLO_INITIAL_ROWS)
    let foundStart = false

    for (let i = 0; i < rows.length; i++) {
      const height = estimateEbloRowHeight(rows[i].key)
      const rowBottom = y + height
      if (!foundStart && rowBottom >= viewportTop) {
        start = Math.max(0, i - EBLO_INDEX_OVERSCAN)
        foundStart = true
      }
      if (y <= viewportBottom) {
        end = Math.min(rows.length - 1, i + EBLO_INDEX_OVERSCAN)
      } else if (foundStart) {
        break
      }
      y = rowBottom
    }

    if (!foundStart) {
      start = Math.max(0, rows.length - EBLO_INITIAL_ROWS)
      end = rows.length - 1
    }

    const actualNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < Math.max(80, el.clientHeight * 0.5)
    if (nearBottomRef.current && actualNearBottom) {
      start = Math.min(start, Math.max(0, rows.length - EBLO_INITIAL_ROWS))
      end = rows.length - 1
    }

    if (end < start) end = start
    setEbloRangeIfChanged({ start, end })
  }, [estimateEbloRowHeight, setEbloRangeIfChanged])

  const scheduleEbloUpdate = useCallback(() => {
    if (typeof window === 'undefined') return
    if (ebloRafRef.current !== null) return
    ebloRafRef.current = window.requestAnimationFrame(() => {
      ebloRafRef.current = null
      updateEblo()
    })
  }, [updateEblo])

  // Прижать к низу «пачкой» кадров. Одного присвоения scrollTop мало: виртуализация
  // (Eblo) после этого ре-рендерится в rAF и может сдвинуть scrollHeight, сбив нас с
  // низа. Поэтому переякориваемся ещё несколько кадров подряд, пока раскладка не
  // устаканится. Используется при открытии беседы и при росте высоты контента.
  const pinToBottomBurst = useCallback(() => {
    const el = messagesRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
    if (pinBurstRafRef.current) cancelAnimationFrame(pinBurstRafRef.current)
    let frames = 0
    const step = () => {
      const el2 = messagesRef.current
      if (!el2) return
      el2.scrollTop = el2.scrollHeight
      nearBottomRef.current = true
      frames += 1
      if (frames < 5) {
        pinBurstRafRef.current = requestAnimationFrame(step)
      } else {
        pinBurstRafRef.current = 0
      }
    }
    pinBurstRafRef.current = requestAnimationFrame(step)
  }, [])

  const handleEbloRowHeightChange = useCallback((rowKey: string, height: number) => {
    if (!Number.isFinite(height) || height <= 0) return
    const next = Math.max(1, Math.ceil(height))
    const prev = ebloRowHeightsRef.current.get(rowKey)
    if (typeof prev === 'number' && Math.abs(prev - next) < 2) return
    const grew = typeof prev === 'number' ? next > prev : true
    ebloRowHeightsRef.current.set(rowKey, next)
    scheduleEbloUpdate()
    // Пока мы «прилипли» к низу, любой рост высоты строки (догрузилась картинка,
    // превью ссылки, видео, реакции) должен возвращать нас на самый низ — иначе
    // последнее сообщение уезжает вниз за край. Работает для контента, который
    // приходит в ЛЮБОЙ момент, а не только в первые сотни мс после открытия.
    if (grew && nearBottomRef.current) {
      pinToBottomBurst()
    }
  }, [scheduleEbloUpdate, pinToBottomBurst])

  useEffect(() => {
    return () => {
      if (ebloRafRef.current !== null) {
        window.cancelAnimationFrame(ebloRafRef.current)
        ebloRafRef.current = null
      }
    }
  }, [])

  useEffect(() => {
    ebloRowHeightsRef.current.clear()
    setEbloRangeIfChanged({ start: 0, end: EBLO_INITIAL_ROWS })
    scheduleEbloUpdate()
  }, [activeId, leftAlignAll, setEbloRangeIfChanged, scheduleEbloUpdate])

  useLayoutEffect(() => {
    scheduleEbloUpdate()
  }, [activeId, displayedMessages.length, activePendingMessages.length, olderLoading, scheduleEbloUpdate])

  const clearMessageMultiSelect = useCallback(() => {
    setMultiSelectMode(false)
    setSelectedMessageIds([])
  }, [])

  const toggleMessageMultiSelect = useCallback((id: string) => {
    setSelectedMessageIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
  }, [])

  const getSelectedMessagesOrdered = useCallback((): any[] => {
    const list = (displayedMessages ? [...displayedMessages] : []).filter((m: any) => !m.deletedAt)
    const pending = (activePendingMessages || []) as any[]
    const full = [...list, ...pending]
    const expanded = new Set(selectedMessageIds)
    const bundles = computeMultiSourceForwardBundles(full as any[])
    for (const b of bundles) {
      const fid = full[b.start]?.id
      if (fid != null && String(fid).length && expanded.has(fid)) {
        for (let j = b.start; j <= b.end; j++) {
          const id = full[j]?.id
          if (id != null && String(id).length) expanded.add(id)
        }
      }
    }
    return full.filter((m) => expanded.has(m.id)).sort(
      (a, b) => new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime(),
    )
  }, [displayedMessages, activePendingMessages, selectedMessageIds])

  useEffect(() => {
    clearMessageMultiSelect()
  }, [activeId, clearMessageMultiSelect])

  const decryptAttachment = useCallback(
    (att: any) => {
      if (!activeConversation?.id) return
      // Secret chat v2 does not support legacy attachment E2EE sessions.
      if (String((activeConversation as any)?.type ?? '').toUpperCase() === 'SECRET') return
      const meta = att?.metadata?.e2ee
      if (!meta || meta.kind !== 'ciphertext' || !meta.nonce) return
      
      // Проверяем, что сессия готова
      if (!e2eeManager.hasSession(activeConversation.id)) return
      
      // Проверяем, не запущен ли уже процесс расшифровки
      if (attachmentDecryptInProgressRef.current.has(att.url)) return
      
      // Проверяем текущее состояние
      const currentState = attachmentDecryptMap[att.url]
      if (currentState?.status === 'ready') return
      
      // Помечаем как запущенный и устанавливаем состояние
      attachmentDecryptInProgressRef.current.add(att.url)
      setAttachmentDecryptMap((prev) => ({
        ...prev,
        [att.url]: { status: 'pending' },
      }))
      
      ;(async () => {
        try {
          // Convert to proxy URL if needed
          const fetchUrl = convertToProxyUrl(att.url) || att.url
          const response = await fetch(fetchUrl, { credentials: 'omit' })
          if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`)
          }
          const cipher = new Uint8Array(await response.arrayBuffer())
          
          const plain = e2eeManager.decryptBinary(activeConversation.id, cipher, meta.nonce)
          if (!plain) {
            throw new Error('Failed to decrypt attachment: decryptBinary returned null')
          }
          
          const blob = new Blob([plain as BlobPart], {
            type:
              meta.originalType ||
              att.metadata?.mime ||
              att.metadata?.contentType ||
              'application/octet-stream',
          })
          const objectUrl = URL.createObjectURL(blob)
          attachmentDecryptUrlsRef.current.add(objectUrl)
          attachmentDecryptInProgressRef.current.delete(att.url)
          setAttachmentDecryptMap((prev) => ({
            ...prev,
            [att.url]: { status: 'ready', url: objectUrl },
          }))
        } catch (error: any) {
          attachmentDecryptInProgressRef.current.delete(att.url)
          setAttachmentDecryptMap((prev) => {
            const next = { ...prev }
            if (error?.message?.includes('E2EE session is not ready')) {
              // Если сессия не готова, удаляем из map, чтобы попробовать позже
              delete next[att.url]
            } else {
              next[att.url] = { status: 'error' }
            }
            return next
          })
        }
      })()
    },
    [activeConversation?.id, attachmentDecryptMap],
  )

  const resolveAttachmentUrl = useCallback(
    (att: any) => {
      if (!att) return null
      
      // Convert S3 URL to proxy URL if needed (for old URLs in database)
      const baseUrl = convertToProxyUrl(att.url)
      
      if (!activeConversation?.isSecret) return baseUrl
      // Secret chat v2: do not apply legacy encrypted-attachment gating here.
      if (String((activeConversation as any)?.type ?? '').toUpperCase() === 'SECRET') {
        return baseUrl
      }
      
      const meta = att.metadata?.e2ee
      if (!meta || meta.kind !== 'ciphertext') {
        return baseUrl
      }
      
      // For encrypted attachments, use the original URL as key for decryption map
      const entry = attachmentDecryptMap[att.url]
      if (entry?.status === 'ready' && entry.url) {
        return entry.url
      }
      return null
    },
    [attachmentDecryptMap, activeConversation?.isSecret],
  )

  const resolveFirstImageAttachmentUrl = useCallback((message: any): string | null => {
    const attachments = Array.isArray(message?.attachments) ? message.attachments : []
    for (const att of attachments) {
      if (att?.type !== 'IMAGE') continue
      const resolvedUrl = resolveAttachmentUrl(att)
      if (resolvedUrl) return resolvedUrl
    }
    return null
  }, [resolveAttachmentUrl])

  useEffect(() => {
    if (!activeConversation?.isSecret) return
    if (!conversationSecretSessionReady) return
    const attachments = (displayedMessages || []).flatMap(
      (msg: any) => msg.attachments || [],
    )
    attachments.forEach((att) => {
      if (att?.metadata?.e2ee?.kind === 'ciphertext') {
        decryptAttachment(att)
      }
    })
  }, [
    displayedMessages,
    activeConversation?.id,
    activeConversation?.isSecret,
    conversationSecretSessionReady,
    decryptAttachment,
  ])

  // Retro: if message attachment metadata lacks originalName/mime/size, enrich FILE cards via proxy HEAD headers.
  useEffect(() => {
    const atts = (displayedMessages || []).flatMap((m: any) => m.attachments || [])
    const fileAtts = atts.filter((a: any) => a?.type === 'FILE' && typeof a?.url === 'string' && a.url)
    if (!fileAtts.length) return

    let cancelled = false
    for (const att of fileAtts) {
      const meta = att?.metadata ?? {}
      const existing = attachmentHeadInfoMap[att.url]
      const hasName = typeof meta?.originalName === 'string' && meta.originalName.trim()
      const hasMime = typeof meta?.mime === 'string' && meta.mime.trim()
      const hasSize = typeof att?.size === 'number' && att.size > 0
      if (hasName && (hasMime || hasSize)) continue
      if (existing?.fileName && existing?.mime) continue
      if (attachmentHeadInfoInFlightRef.current.has(att.url)) continue

      attachmentHeadInfoInFlightRef.current.add(att.url)
      const href = convertToProxyUrl(att.url) || att.url
      fetch(href, { method: 'HEAD', credentials: 'omit' })
        .then((r) => {
          if (!r.ok) throw new Error(`HEAD ${r.status}`)
          const cd = r.headers.get('content-disposition')
          const ct = r.headers.get('content-type')
          const cl = r.headers.get('content-length')
          const fileName = parseContentDispositionFilename(cd)
          const size = cl ? Number(cl) : undefined
          if (cancelled) return
          setAttachmentHeadInfoMap((prev) => ({
            ...prev,
            [att.url]: {
              ...(prev[att.url] || {}),
              ...(fileName ? { fileName } : {}),
              ...(ct ? { mime: ct } : {}),
              ...(Number.isFinite(size) && (size as number) > 0 ? { size: size as number } : {}),
            },
          }))
        })
        .catch(() => {
          // ignore
        })
        .finally(() => {
          attachmentHeadInfoInFlightRef.current.delete(att.url)
        })
    }

    return () => {
      cancelled = true
    }
  }, [displayedMessages, attachmentHeadInfoMap])


  const usersById = useMemo(() => {
    const map: Record<string, any> = {}
    if (activeConversation) {
      for (const p of activeConversation.participants) {
        map[p.user.id] = p.user
      }
    }
    // don't overwrite participant data (which contains up-to-date avatarUrl) with stale session
    if (me && !map[me.id]) map[me.id] = me
    return map
  }, [activeConversation, me])

  const activeConversationParticipantIds = useMemo(() => {
    if (!activeConversation) return []
    return (activeConversation.participants || []).map((p: any) => p.user.id)
  }, [activeConversation])

  const eligibleContactsForAdd = useMemo(() => {
    if (!activeConversation || !contactsQuery.data) return []
    const participantIds = new Set(activeConversationParticipantIds)
    return contactsQuery.data.filter((c: any) => !participantIds.has(c.friend.id))
  }, [activeConversation, contactsQuery.data, activeConversationParticipantIds])

  const sortedAcceptedContacts = useMemo(() => {
    const list = contactsQuery.data ?? []
    return [...list].sort((a: any, b: any) => {
      const ta = new Date(a.updatedAt ?? a.createdAt ?? 0).getTime()
      const tb = new Date(b.updatedAt ?? b.createdAt ?? 0).getTime()
      return tb - ta
    })
  }, [contactsQuery.data])

  const displayOutgoingWithRejected = useMemo(() => {
    const pending = (outgoingContactsQuery.data ?? []).map((c: any) => ({ id: c.id, rejected: false, friend: c.friend }))
    const rejected = rejectedOutgoing.map((r) => ({
      id: r.contactId,
      rejected: true,
      friend: r.friend ?? { id: '', username: '', displayName: null },
    }))
    return [...pending, ...rejected]
  }, [outgoingContactsQuery.data, rejectedOutgoing])

  const contactsInviteCode = typeof registrationInviteCodeQuery.data?.code === 'string' ? registrationInviteCodeQuery.data.code : ''
  const formattedContactsInviteCode = useMemo(
    () => formatRegistrationInviteCodeForDisplay(contactsInviteCode),
    [contactsInviteCode]
  )
  const contactsInviteRemainingLabel = useMemo(() => {
    const expiresAtRaw = registrationInviteCodeQuery.data?.expiresAt
    if (!expiresAtRaw) return '00:00'
    const expiresAtMs = Date.parse(expiresAtRaw)
    if (!Number.isFinite(expiresAtMs)) return '00:00'
    const remainingSeconds = Math.max(0, Math.ceil((expiresAtMs - contactsInviteNow) / 1000))
    const minutes = Math.floor(remainingSeconds / 60)
    const seconds = remainingSeconds % 60
    return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
  }, [registrationInviteCodeQuery.data?.expiresAt, contactsInviteNow])

  const identityBubbleStyle = {
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
    padding: '14px',
    borderRadius: 18,
    marginBottom: 16,
    border: '1px solid color-mix(in srgb, var(--brand) 24%, var(--surface-border) 76%)',
    background:
      'linear-gradient(180deg, color-mix(in srgb, var(--surface-100) 82%, var(--brand) 18%), color-mix(in srgb, var(--surface-200) 86%, var(--brand) 14%))',
    boxShadow: '0 14px 34px rgba(0,0,0,0.18)',
  } as const
  const identitySectionHeaderStyle = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
  } as const
  const identitySectionTitleStyle = {
    fontSize: 13,
    fontWeight: 700,
    color: 'var(--text-primary)',
  } as const
  const identityHelperTextStyle = {
    fontSize: 12,
    lineHeight: 1.35,
  } as const
  const identityIconButtonStyle = {
    width: 34,
    height: 34,
    borderRadius: 10,
    flexShrink: 0,
    border: '1px solid color-mix(in srgb, var(--surface-border) 78%, white 22%)',
    background: 'color-mix(in srgb, var(--surface-100) 74%, var(--surface-200) 26%)',
  } as const
  const identityInputsRowStyle = {
    display: 'flex',
    gap: 8,
    justifyContent: 'center',
    flexWrap: 'nowrap',
  } as const
  const identityDividerStyle = {
    height: 1,
    borderRadius: 999,
    background: 'linear-gradient(90deg, transparent, color-mix(in srgb, var(--surface-border) 55%, var(--brand) 45%), transparent)',
  } as const
  const identityBottomRowStyle = {
    display: 'flex',
    gap: 10,
    flexWrap: 'wrap',
  } as const
  const identityMiniCardBaseStyle = {
    flex: '1 1 190px',
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    padding: '12px 13px',
    borderRadius: 14,
  } as const
  const myEblidMiniCardStyle = {
    ...identityMiniCardBaseStyle,
    border: '1px solid color-mix(in srgb, var(--brand) 24%, var(--surface-border) 76%)',
    background:
      'linear-gradient(135deg, color-mix(in srgb, var(--brand) 9%, var(--surface-200) 91%), color-mix(in srgb, var(--brand) 6%, var(--surface-100) 94%))',
  } as const
  const registrationMiniCardStyle = {
    ...identityMiniCardBaseStyle,
    border: '1px solid color-mix(in srgb, var(--brand) 40%, var(--surface-border) 60%)',
    background:
      'linear-gradient(135deg, color-mix(in srgb, var(--brand) 18%, var(--surface-200) 82%), color-mix(in srgb, var(--brand-600) 20%, var(--surface-100) 80%))',
  } as const

  const addParticipantsFoundUserStatus = {
    alreadyInChat: addParticipantsFoundUser ? activeConversationParticipantIds.includes(addParticipantsFoundUser.id) : false,
    isSelf: addParticipantsFoundUser ? addParticipantsFoundUser.id === me?.id : false,
  }

  useEffect(() => {
    if (!contactsOpen) return
    const interval = window.setInterval(() => setContactsInviteNow(Date.now()), 1000)
    return () => window.clearInterval(interval)
  }, [contactsOpen])

  useEffect(() => {
    if (!contactsOpen) return
    const expiresAtRaw = registrationInviteCodeQuery.data?.expiresAt
    if (!expiresAtRaw) return
    const expiresAtMs = Date.parse(expiresAtRaw)
    if (!Number.isFinite(expiresAtMs)) return
    const timeout = window.setTimeout(() => {
      void registrationInviteCodeQuery.refetch()
    }, Math.max(250, expiresAtMs - Date.now() + 250))
    return () => window.clearTimeout(timeout)
  }, [contactsOpen, registrationInviteCodeQuery.data?.expiresAt, registrationInviteCodeQuery.refetch])

  useEffect(() => {
    if (!contactsInviteCopied) return
    const timeout = window.setTimeout(() => setContactsInviteCopied(false), 1600)
    return () => window.clearTimeout(timeout)
  }, [contactsInviteCopied])

  useEffect(() => {
    if (!myEblidCopied) return
    const timeout = window.setTimeout(() => setMyEblidCopied(false), 1600)
    return () => window.clearTimeout(timeout)
  }, [myEblidCopied])

  useEffect(() => {
    if (!addParticipantsModal) return
    if (addParticipantsMode === 'eblid') {
      addParticipantsEblRefs[0].current?.focus()
    }
  }, [addParticipantsModal, addParticipantsMode])

  // Realtime "playing game" presence (Electron) with local TTL fallback (60s)
  useEffect(() => {
    const timers = presenceGameExpiryTimersRef.current
    const clearTimer = (uid: string) => {
      const t = timers.get(uid)
      if (t) window.clearTimeout(t)
      timers.delete(uid)
    }
    const scheduleExpiry = (uid: string, ts: number) => {
      clearTimer(uid)
      const age = Date.now() - ts
      const remaining = Math.max(0, 60_000 - age)
      const t = window.setTimeout(() => {
        setPresenceGameByUserId((prev) => {
          if (!prev[uid]) return prev
          const next = { ...prev }
          delete next[uid]
          return next
        })
        timers.delete(uid)
      }, remaining + 50)
      timers.set(uid, t)
    }

    const handler = (p: PresenceGamePayload) => {
      const uid = typeof p?.userId === 'string' ? p.userId : ''
      if (!uid) return
      if (p.game && typeof p.ts === 'number') {
        scheduleExpiry(uid, p.ts)
        setPresenceGameByUserId((prev) => ({ ...prev, [uid]: { ts: p.ts, game: p.game as any } }))
      } else {
        clearTimer(uid)
        setPresenceGameByUserId((prev) => {
          if (!prev[uid]) return prev
          const next = { ...prev }
          delete next[uid]
          return next
        })
      }
    }

    const handleBatch = (payload: PresenceGameSnapshotBatchPayload) => {
      const items = Array.isArray(payload?.items) ? payload.items : []
      for (const it of items) handler(it as any)
    }

    onPresenceGame(handler)
    onPresenceGameSnapshot(handler)
    onPresenceGameSnapshotBatch(handleBatch)
    return () => {
      socket.off('presence:game', handler as any)
      socket.off('presence:game:snapshot', handler as any)
      socket.off('presence:game:snapshot:batch', handleBatch as any)
      for (const t of timers.values()) window.clearTimeout(t)
      timers.clear()
    }
  }, [])

  // Request game presence snapshots for "relevant" peers (last dialogs) once conversations list is available.
  const helloPeersRef = useRef<string[]>([])
  useEffect(() => {
    const rows = (conversationsQuery.data || []) as any[]
    const peers: string[] = []
    const seen = new Set<string>()
    try {
      for (const row of rows) {
        const conv = row?.conversation
        if (!conv) continue
        const isGroup = !!(conv.isGroup || (conv.participants?.length ?? 0) > 2)
        if (isGroup) continue
        const parts = conv.participants || []
        const peer = parts.find((p: any) => p?.user?.id && p.user.id !== me?.id)?.user
        const peerId = typeof peer?.id === 'string' ? peer.id : null
        if (!peerId) continue
        if (seen.has(peerId)) continue
        seen.add(peerId)
        peers.push(peerId)
        if (peers.length >= 50) break
      }
    } catch {}
    helloPeersRef.current = peers
    if (!peers.length) return
    if (!socket.connected) return
    try { helloPresenceGame(peers) } catch {}
  }, [conversationsQuery.data, me?.id])

  // Re-send hello snapshot batch after reconnect.
  useEffect(() => {
    const onConnect = () => {
      const peers = helloPeersRef.current || []
      if (!peers.length) return
      try { helloPresenceGame(peers) } catch {}
    }
    socket.on('connect', onConnect)
    return () => { socket.off('connect', onConnect as any) }
  }, [])

  // When opening a 1:1 chat, request an immediate snapshot for that peer.
  useEffect(() => {
    if (!activeConversation) return
    const isGroup = !!(activeConversation.isGroup || (activeConversation.participants?.length ?? 0) > 2)
    if (isGroup) return
    const parts = activeConversation.participants || []
    const peer = parts.find((p: any) => p?.user?.id && p.user.id !== me?.id)?.user
    const peerId = typeof peer?.id === 'string' ? peer.id : null
    if (!peerId) return
    try { subscribePresenceGame(peerId) } catch {}
  }, [activeConversation?.id, me?.id])

  // Realtime presence updates into conversations list
  useEffect(() => {
    const handler = (p: { userId: string; status: string }) => {
      // Keep an in-memory override map so polling doesn't revert "IN_CALL" back to "ONLINE".
      setPresenceOverridesByUserId((prev) => {
        const nextStatus = (p.status || '').toString().toUpperCase()
        const prevStatus = prev[p.userId]
        if (prevStatus === nextStatus) return prev
        return { ...prev, [p.userId]: nextStatus }
      })
      // Update status in conversations cache
      client.setQueryData(['conversations'], (old: any) => {
        if (!old) return old
        return old.map((row: any) => {
          const updated = {
            ...row,
            conversation: {
              ...row.conversation,
              participants: row.conversation.participants.map((cp: any) =>
                cp.user.id === p.userId
                  ? {
                      ...cp,
                      user: {
                        ...cp.user,
                        status: p.status,
                        lastSeenAt:
                          p.status === 'ONLINE' || p.status === 'BACKGROUND' || p.status === 'IN_CALL' || p.status === 'OFFLINE'
                            ? new Date().toISOString()
                            : cp.user.lastSeenAt,
                      },
                    }
                  : cp
              ),
            },
          }
          return updated
        })
      })
    }
    onPresenceUpdate(handler)
    return () => { socket.off('presence:update', handler as any) }
  }, [client])

  const effectiveUserStatus = useCallback((u: any): 'ONLINE' | 'AWAY' | 'BACKGROUND' | 'OFFLINE' | 'IN_CALL' => {
    const rawId = u?.id
    const id = typeof rawId === 'string' ? rawId : null
    const override = id ? presenceOverridesByUserId[id] : undefined
    const raw = (override ?? u?.status ?? 'OFFLINE').toString().toUpperCase()
    if (raw === 'IN_CALL') return 'IN_CALL'
    if (raw === 'ONLINE') return 'ONLINE'
    if (raw === 'BACKGROUND') return 'BACKGROUND'
    if (raw === 'AWAY') return 'AWAY'
    return 'OFFLINE'
  }, [presenceOverridesByUserId])

  // Track if socket was previously connected to detect actual reconnects
  const wasConnectedRef = useRef(socket.connected)
  // Reflect socket connection status in UI (especially for mobile self-status)
  useEffect(() => {
    // iOS Safari: refresh viewport height and trigger re-render on focus to avoid stale layout/state
    const onFocus = () => {
      try {
        const h = (window.visualViewport ? window.visualViewport.height : window.innerHeight) * 0.01
        document.documentElement.style.setProperty('--vh', h + 'px')
      } catch {}
      client.invalidateQueries({ queryKey: ['me-info'] })
      setIsSocketOnline(socket.connected)
    }
    window.addEventListener('focus', onFocus)
    const onConnect = () => {
      setIsSocketOnline(true)
      const wasConnected = wasConnectedRef.current
      wasConnectedRef.current = true
      // Only re-join rooms if this is an actual reconnect (was previously connected, then disconnected, now reconnected)
      // Skip if this is the initial connection (wasConnected is false and socket was never connected before)
      if (wasConnected) {
        try {
          const list = (conversationsQuery.data || []).map((r: any) => r.conversation.id)
          // re-join all conversation rooms after reconnect so we receive call:status broadcasts
          for (const cid of list) {
            try {
              joinConversation(cid)
              markConversationJoined(cid)
            } catch {}
          }
          if (list.length > 0) requestCallStatuses(list)
        } catch {}
      }
    }
    const onDisconnect = () => {
      setIsSocketOnline(false)
      wasConnectedRef.current = false
    }
    socket.on('connect', onConnect)
    socket.on('disconnect', onDisconnect)
    // initialize once in case it changed before
    setIsSocketOnline(socket.connected)
    if (socket.connected) {
      wasConnectedRef.current = true
    }
    const onVis = () => { client.invalidateQueries({ queryKey: ['me-info'] }) }
    document.addEventListener('visibilitychange', onVis)
    return () => {
      socket.off('connect', onConnect as any)
      socket.off('disconnect', onDisconnect as any)
      document.removeEventListener('visibilitychange', onVis)
      window.removeEventListener('focus', onFocus)
    }
  }, [client, conversationsQuery.data, markConversationJoined])

  // Keep own presence in sync with server events, like for other users
  useEffect(() => {
    const handler = (payload: { userId: string; status: string }) => {
      if (!me?.id) return
      if (payload.userId === me.id) {
        const v = (payload.status || '').toUpperCase()
        if (v === 'ONLINE' || v === 'AWAY' || v === 'BACKGROUND' || v === 'IN_CALL' || v === 'OFFLINE') setMyPresence(v)
      }
    }
    onPresenceUpdate(handler)
    return () => { socket.off('presence:update', handler as any) }
  }, [me?.id])

  // Initialize own presence from meInfo endpoint when available
  useEffect(() => {
    const v = ((meInfoQuery.data as any)?.status || '').toString().toUpperCase()
    if (v === 'ONLINE' || v === 'AWAY' || v === 'BACKGROUND' || v === 'IN_CALL' || v === 'OFFLINE') setMyPresence(v)
  }, [meInfoQuery.data])

  // Lightbox keyboard controls are handled inside <ImageLightbox /> now.

  // Live profile updates (avatar/name) across app
  useEffect(() => {
    const handler = (p: { userId: string; avatarUrl?: string | null; displayName?: string | null }) => {
      client.setQueryData(['conversations'], (old: any) => {
        if (!old) return old
        return old.map((row: any) => ({
          ...row,
          conversation: {
            ...row.conversation,
            participants: row.conversation.participants.map((cp: any) => cp.user.id === p.userId ? { ...cp, user: { ...cp.user, avatarUrl: p.avatarUrl ?? cp.user.avatarUrl, displayName: p.displayName ?? cp.user.displayName } } : cp)
          }
        }))
      })
      if (p.userId === me?.id) meInfoQuery.refetch()
    }
    onProfileUpdate(handler)
    return () => { socket.off('profile:update', handler as any) }
  }, [client, me?.id])

  function hashToGray(userId: string | null | undefined) {
    // Все сообщения собеседника используют один цвет
    return '#191d23'
  }

  function hashStringToUint(s: string | null | undefined): number {
    if (!s) return 0
    let h = 0
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0
    return h
  }

  /**
   * Цвет имени участника. В пределах беседы цвет берётся по позиции участника
   * (participantColorIndex) — двое в одной группе не получат один цвет. Для id вне
   * беседы (пересланное от постороннего и т.п.) — стабильный фолбэк по хешу.
   */
  function nameColorForUser(userId: string | null | undefined): string {
    if (userId) {
      const idx = participantColorIndex.get(userId)
      if (idx !== undefined) {
        const palette = participantColorIndex.size > NAME_COLOR_PALETTE_13.length ? NAME_COLOR_PALETTE_26 : NAME_COLOR_PALETTE_13
        return palette[idx % palette.length]
      }
    }
    return NAME_COLOR_PALETTE_13[hashStringToUint(userId) % NAME_COLOR_PALETTE_13.length]
  }

  /**
   * Фон входящих пузырей по участнику: тот же индекс участника, что и у цвета
   * имени, разложенный по разным hue (умбра/сине-сланцевый/хвойный/…). В пределах
   * группы фоны не совпадают. Для id вне беседы (пересланное) — фолбэк по хешу.
   */
  function groupIncomingBubbleBg(userId: string | null | undefined): string {
    if (userId) {
      const idx = participantColorIndex.get(userId)
      if (idx !== undefined) return BUBBLE_BG_BASES[idx % BUBBLE_BG_BASES.length]
    }
    return BUBBLE_BG_BASES[hashStringToUint(userId) % BUBBLE_BG_BASES.length]
  }

  // Глобальный обработчик paste для вставки изображений из буфера обмена (когда фокус не в поле ввода)
  useEffect(() => {
    if (!activeId) return
    
    const handlePaste = async (e: ClipboardEvent) => {
      const target = e.target as HTMLElement | null
      if (!target) return
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return
      if (target.isContentEditable || target.closest('[contenteditable="true"]')) return
      const items = e.clipboardData?.items
      if (!items) return
      for (let i = 0; i < items.length; i++) {
        const item = items[i]
        if (item.type.indexOf('image') !== -1) {
          e.preventDefault()
          e.stopPropagation()
          const file = item.getAsFile()
          if (file) {
            addComposerImage(file, 'paste')
          }
          break
        }
      }
    }
    
    window.addEventListener('paste', handlePaste, true)
    return () => {
      window.removeEventListener('paste', handlePaste, true)
    }
  }, [activeId, addComposerImage])

  useEffect(() => {
    conversationsQuery.refetch()
    connectSocket()
    onConversationNew(() => conversationsQuery.refetch())
    onConversationDeleted((payload) => {
      const convId = payload?.conversationId
      if (!convId) {
        conversationsQuery.refetch()
        return
      }
      setPendingByConv((prev) => {
        if (!prev[convId]) return prev
        const copy = { ...prev }
        delete copy[convId]
        return copy
      })
      e2eeManager.clearSession(convId)
      client.removeQueries({ queryKey: ['messages', convId] })
      client.setQueryData(['conversations'], (prev: any) => {
        if (!Array.isArray(prev)) return prev
        return prev.filter((row: any) => row?.conversation?.id !== convId)
      })
      const isDeletingActive = activeConversationIdRef.current === convId
      if (isDeletingActive) {
        setActiveId((prev) => (prev === convId ? null : prev))
        setShowJump(false)
        if (pendingImagesRef.current.length) {
          clearPendingImages()
        }
        if (pendingFilesRef.current.length) {
          clearPendingFiles()
        }
        if (isMobileRef.current) {
          setMobileView('list')
        }
      }
      conversationsQuery.refetch()
    })
    onConversationUpdated(() => { conversationsQuery.refetch() })
    onConversationMemberRemoved(() => { conversationsQuery.refetch() })
    onSecretChatAccepted((payload) => {
      const convId = payload?.conversationId
      const peerDeviceId = payload?.peerDeviceId
      if (!convId || !peerDeviceId) return
      conversationsQuery.refetch()
      try {
        const myId = me?.id ?? storedUserIdRef.current
        const list = client.getQueryData(['conversations']) as any[] | undefined
        const conv = Array.isArray(list) ? list.find((r: any) => r?.conversation?.id === convId)?.conversation : null
        const amCreator = !!conv && !!myId && conv.createdById === myId
        if (amCreator && hasSecretThreadKey(convId)) {
          void shareSecretThreadKeyToDevice(convId, peerDeviceId).catch((err) => {
            console.warn('[secret] shareSecretThreadKeyToDevice failed', err)
          })
        }
      } catch {}
    })
    onIncomingCall(({ conversationId, from, video }) => {
      // debounce duplicate incoming for same conv
      if (ringingConvIdRef.current && ringingConvIdRef.current === conversationId) return
      if (callStore.incoming?.conversationId === conversationId) {
        return
      }
      // stop previous ring if any
      stopRingtone()
      // suppress popup for group calls or if already in this call
      try {
        const list = client.getQueryData(['conversations']) as any[] | undefined
        const conv = Array.isArray(list) ? list.find((r: any) => r.conversation.id === conversationId)?.conversation : null
        const isGroup = !!(conv && ((conv.isGroup) || ((conv.participants?.length ?? 0) > 2)))
        inviterByConvRef.current[conversationId] = from.id
        const isAlreadyInThisCall = callConvIdRef.current === conversationId
        if (isGroup) {
          // group calls: no popup here; status is driven by room join/leave events
          return
        }
        if (isAlreadyInThisCall) return
        if (from?.id && me?.id && from.id === me.id) {
          // This is our own outgoing call, do not treat as incoming
          return
        }
        // ===== 1:1 GLARE RESOLUTION =====
        // If we are currently dialing the SAME 1:1 conversation, both sides
        // tried to call each other simultaneously. The server keeps the
        // first invite intact and forwards it as call:incoming to us. Drop
        // our outgoing dial UI/audio so the incoming modal can take over
        // cleanly; the user then accepts/declines the peer's call.
        if (outgoingCallRef.current?.conversationId === conversationId) {
          try { stopOutgoingDialing() } catch {}
          setOutgoingCall((prev) => (prev?.conversationId === conversationId ? null : prev))
          console.log('[ChatsPage] 1:1 call glare detected — converting our outgoing into incoming', conversationId)
        }
      } catch {}
      ringingConvIdRef.current = conversationId
      callStore.startIncoming({
        callId: conversationId,
        conversationId,
        from,
        video,
        source: 'web_ui',
      })
      // start ringtone from file
      try {
        const audio = ensureRingAudio()
        if (audio) {
          audio.currentTime = 0
          audio.loop = true
          audio.volume = 0.9
          void audio.play().catch(() => {})
        }
      } catch (err) {
        console.error('Error starting ringtone:', err)
      }
      // auto-decline after 25s
      ringTimerRef.current = window.setTimeout(() => {
        declineCall(conversationId)
        stopRingtone()
        callStore.setIncoming(null)
      }, 25000)
    })
    onCallAccepted(({ conversationId, by, video }) => {
      clearMinCallDurationGuard(conversationId)
      stopOutgoingDialing()

      // Останавливаем "дозвон" на этом устройстве сразу, как только другой участник принял звонок.
      // (Даже если мы не будем подключаться на этом устройстве — дозвон UI/звук не должен продолжаться.)
      setOutgoingCall((prev) => {
        if (prev?.conversationId === conversationId) {
          return null
        }
        return prev
      })
      
      // Если звонок принят на другом устройстве (by.id === me.id), прекращаем все действия на этом устройстве
      // и не открываем оверлей - звонок должен быть активен только на том устройстве, где его приняли
      if (by?.id === me?.id) {
        // Прекращаем входящий звонок для этой беседы, если он есть
        const hasIncomingForThisConv = callStore.incoming?.conversationId === conversationId || ringingConvIdRef.current === conversationId
        if (hasIncomingForThisConv) {
          stopRingtone()
          callStore.setIncoming(null)
          if (ringTimerRef.current) {
            window.clearTimeout(ringTimerRef.current)
            ringTimerRef.current = null
          }
          ringingConvIdRef.current = null
        }
        // Закрываем экран дозвона, если он открыт (если пользователь звонил с этого устройства)
        // (уже остановили выше)
        // Не открываем оверлей на этом устройстве - звонок принят на другом
        // НО: фиксируем, что звонок активен и в нём участвует МОЙ аккаунт (другое устройство).
        // Это нужно, чтобы в шапке беседы показалась кнопка «Тоже сюда» — возможность подключиться
        // к этому же звонку с этого устройства.
        if (me?.id) {
          const myId = me.id
          setActiveCalls((prev) => {
            const current = prev[conversationId]
            if (!current?.active) {
              return { ...prev, [conversationId]: { startedAt: Date.now(), active: true, endedAt: null, participants: [myId] } }
            }
            const participants = Array.isArray(current.participants) ? current.participants : []
            if (!participants.includes(myId)) {
              return { ...prev, [conversationId]: { ...current, active: true, endedAt: null, participants: [...participants, myId] } }
            }
            return prev
          })
        }
        return
      }

      // Если звонок принят ДРУГИМ пользователем (т.е. это ответ на наш исходящий),
      // то на этом устройстве подключаемся только если МЫ здесь реально инициировали звонок (activeConvId)
      // или уже находимся в этом оверлее. Это предотвращает ситуацию "звонок принялся на другом устройстве"
      // когда один аккаунт открыт на нескольких устройствах.
      const isAlreadyInOverlayHere = callConvIdRef.current === conversationId
      const isOutgoingIntentHere = useCallStore.getState().activeConvId === conversationId
      const hadOutgoingHere = outgoingCallRef.current?.conversationId === conversationId
      if (!isAlreadyInOverlayHere && !isOutgoingIntentHere && !hadOutgoingHere) {
        // У нас на этом устройстве нет намерения участвовать — просто гасим возможный рингтон/инкоминг UI.
        const hasIncomingForThisConv = useCallStore.getState().incoming?.conversationId === conversationId || ringingConvIdRef.current === conversationId
        if (hasIncomingForThisConv) {
          stopRingtone()
          callStore.setIncoming(null)
          if (ringTimerRef.current) {
            window.clearTimeout(ringTimerRef.current)
            ringTimerRef.current = null
          }
          ringingConvIdRef.current = null
        }
        // Звонок принят на другом устройстве моего аккаунта (или это другая сторона звонка),
        // у нас здесь намерения не было. Всё равно отметим звонок как активный — чтобы в
        // шапке беседы появилась кнопка «Тоже сюда» (если это мой собственный звонок,
        // активный с другого устройства) или «Подключиться» (если это групповой звонок).
        if (me?.id) {
          const myId = me.id
          const acceptedByMe = by?.id === myId
          setActiveCalls((prev) => {
            const current = prev[conversationId]
            if (!current?.active) {
              return {
                ...prev,
                [conversationId]: {
                  startedAt: Date.now(),
                  active: true,
                  endedAt: null,
                  participants: acceptedByMe ? [myId] : (by?.id ? [by.id] : []),
                },
              }
            }
            if (acceptedByMe) {
              const participants = Array.isArray(current.participants) ? current.participants : []
              if (!participants.includes(myId)) {
                return { ...prev, [conversationId]: { ...current, active: true, endedAt: null, participants: [...participants, myId] } }
              }
            }
            return prev
          })
        }
        return
      }
      // (дозвон уже остановили выше)
      
      // Для всех типов звонков (1:1 и группы) устанавливаем activeCalls вручную
      // Это обеспечивает единообразное поведение: звонок становится активным сразу
      setActiveCalls((prev) => {
        const current = prev[conversationId]
        if (!current?.active) {
          return { ...prev, [conversationId]: { startedAt: Date.now(), active: true, endedAt: null, participants: [me?.id || ''].filter(Boolean) } }
        }
        return prev
      })
      // Устанавливаем callStore.activeConvId для показа кнопок управления звонком
      // Это нужно для того, чтобы isParticipating был true и показывались кнопки "Развернуть" и "Сбросить"
      if (callStore.activeConvId !== conversationId) {
        // Определяем, есть ли информация о видео в активных звонках или используем false по умолчанию
        // Для 1:1 звонков можно использовать информацию из callStore, если она есть
        const hasVideo = !!video
        callStore.startOutgoing(conversationId, hasVideo)
      }
      // Открываем оверлей только на устройстве, где звонок был принят
      setCallConvId(conversationId)
      setMinimizedCallConvId((prev) => prev === conversationId ? null : prev) // Сбрасываем минимизацию для нового звонка
      stopRingtone()
    })
    onCallDeclined(({ conversationId }) => {
      stopOutgoingDialing({ playEndTone: true })
      // Закрываем экран дозвона, если он открыт
      setOutgoingCall((prev) => {
        if (prev?.conversationId === conversationId) {
          return null
        }
        return prev
      })
      const finalize = () => {
        setActiveCalls((prev) => {
          const current = prev[conversationId]
          if (current) {
            if (current.active) {
              return { ...prev, [conversationId]: { ...current, active: false, endedAt: Date.now() } }
            }
            const { [conversationId]: _omit, ...rest } = prev
            return rest
          }
          return prev
        })
        if (callConvIdRef.current === conversationId) {
          setCallConvId((prev) => (prev === conversationId ? null : prev))
          setMinimizedCallConvId((prev) => (prev === conversationId ? null : prev))
          callStore.endCall()
        } else {
          const state = useCallStore.getState()
          if (
            state.activeConvId === conversationId ||
            state.outgoingCall?.conversationId === conversationId ||
            state.incoming?.conversationId === conversationId
          ) {
            callStore.endCall()
          }
        }
        callStore.setIncoming(null)
        stopRingtone()
        clearMinCallDurationGuard(conversationId)
      }
      if (isOneToOneConversation(conversationId)) {
        scheduleAfterMinCallDuration(conversationId, finalize, { force: true })
      } else {
        finalize()
      }
    })
    onCallGlare(({ conversationId, with: peerInfo }) => {
      // We are the original 1:1 inviter and the peer simultaneously dialed us.
      // Server kept our invite intact; the peer's client converts its outgoing
      // into incoming. Nothing UI-level to do here: we keep our outgoing dial
      // running. Log for diagnostics so we can correlate with peer's log.
      console.log('[ChatsPage] 1:1 call glare reported by server (peer also dialed us)', { conversationId, peer: peerInfo?.id })
    })
    onCallEnded(({ conversationId, by }) => {
      const endedByOther = !!by?.id && by.id !== me?.id
      // Игнорируем для групповых звонков — статус придет отдельным событием call:status
      try {
        const list = client.getQueryData(['conversations']) as any[] | undefined
        const conv = Array.isArray(list) ? list.find((r: any) => r.conversation.id === conversationId)?.conversation : null
        const isGroup = !!(conv && ((conv.isGroup) || ((conv.participants?.length ?? 0) > 2)))
        if (isGroup) return
      } catch {}
      const finalize = () => {
        stopOutgoingDialing()
        if (endedByOther) {
          try {
            const audio = ensureNotifyAudio()
            if (audio && notifyUnlockedRef.current) {
              audio.currentTime = 0
              audio.volume = 0.9
              void audio.play().catch(() => {})
            }
          } catch {}
        }
        // Закрываем экран дозвона, если он открыт
        setOutgoingCall((prev) => {
          if (prev?.conversationId === conversationId) {
            return null
          }
          return prev
        })
        setActiveCalls((prev) => {
          const current = prev[conversationId]
          if (current?.active) {
            return { ...prev, [conversationId]: { ...current, active: false, endedAt: Date.now() } }
          }
          const { [conversationId]: _omit, ...rest } = prev
          return rest
        })
        if (callConvIdRef.current === conversationId) {
          setCallConvId((prev) => (prev === conversationId ? null : prev))
          setMinimizedCallConvId((prev) => (prev === conversationId ? null : prev))
          callStore.endCall()
        } else {
          const state = useCallStore.getState()
          if (
            state.activeConvId === conversationId ||
            state.outgoingCall?.conversationId === conversationId ||
            state.incoming?.conversationId === conversationId
          ) {
            callStore.endCall()
          }
        }
        callStore.setIncoming(null)
        stopRingtone()
        clearMinCallDurationGuard(conversationId)
      }
      if (isOneToOneConversation(conversationId)) {
        scheduleAfterMinCallDuration(conversationId, finalize, { force: true })
      } else {
        finalize()
      }
    })
    onReceiptsUpdate((payload) => {
      const applied = applyReceiptUpdateToCache(payload)
      const conversationId = payload.conversationId
      client.invalidateQueries({ queryKey: ['messages', conversationId] })
      if (!applied) {
        client.refetchQueries({ queryKey: ['messages', conversationId] })
      }
    })
    // prepare notification audio and unlock on first user gesture (autoplay policy)
    let detachUnlockListeners: (() => void) | null = null
    try {
      ensureNotifyAudio()
      if (shouldShowAudioUnlockPrompt()) {
        const hasSession = !!useAppStore.getState().session?.user
        const alreadyUnlocked = !!(window as any).__ebAudioUnlockedOnce
        if (hasSession && !alreadyUnlocked && (!notifyUnlockedRef.current || !ringUnlockedRef.current)) {
          setShowAudioUnlock(true)
        }

        const unlock = async () => {
          const ready = await performAudioUnlock()
          if (ready && detachUnlockListeners) {
            detachUnlockListeners()
            detachUnlockListeners = null
          }
        }
        window.addEventListener('click', unlock)
        window.addEventListener('keydown', unlock)
        window.addEventListener('touchstart', unlock)
        detachUnlockListeners = () => {
          window.removeEventListener('click', unlock)
          window.removeEventListener('keydown', unlock)
          window.removeEventListener('touchstart', unlock)
        }
      }
    } catch {}
    return () => {
      detachUnlockListeners?.()
    }
  }, [])
  // live update contacts tiles
  useEffect(() => {
    onContactRequest(() => {
      playNotifySoundIfAllowed()
      incomingContactsQuery.refetch()
    })
    onContactAccepted(() => {
      outgoingContactsQuery.refetch()
      contactsQuery.refetch()
      conversationsQuery.refetch()
      incomingContactsQuery.refetch()
    })
    onContactRejected((payload) => {
      setRejectedOutgoing((prev) => [...prev, { contactId: payload.contactId, friend: payload.friend ?? undefined }])
      outgoingContactsQuery.refetch()
    })
    onContactRemoved(() => { contactsQuery.refetch(); incomingContactsQuery.refetch(); outgoingContactsQuery.refetch() })
  }, [playNotifySoundIfAllowed])

  useEffect(() => {
    const id = requestAnimationFrame(() => requestAnimationFrame(() => setContactsBarEntered(true)))
    return () => cancelAnimationFrame(id)
  }, [])
  useEffect(() => {
    setContactsBarDismissed(false)
  }, [incomingContactsQuery.data])

  // Touch event handlers for personal avatar editor
  useEffect(() => {
    if (!avatarPreviewUrl) return
    const editor = editorRef.current
    if (!editor) return

    const getDistance = (touch1: Touch, touch2: Touch) => {
      const dx = touch2.clientX - touch1.clientX
      const dy = touch2.clientY - touch1.clientY
      return Math.sqrt(dx * dx + dy * dy)
    }

    const getCenter = (touch1: Touch, touch2: Touch) => ({
      x: (touch1.clientX + touch2.clientX) / 2,
      y: (touch1.clientY + touch2.clientY) / 2
    })

    const cropSize = 240
    const isPointInCircle = (x: number, y: number, centerX: number, centerY: number, radius: number) => {
      const dx = x - centerX
      const dy = y - centerY
      return dx * dx + dy * dy <= radius * radius
    }

    const handleTouchStart = (e: TouchEvent) => {
      const rect = editor.getBoundingClientRect()
      if (!rect) return
      const editorWidth = rect.width
      const editorHeight = rect.height
      const centerX = editorWidth / 2
      const centerY = editorHeight / 2
      const radius = cropSize / 2

      if (e.touches.length === 1) {
        const touch = e.touches[0]
        const touchX = touch.clientX - rect.left
        const touchY = touch.clientY - rect.top
        
        if (!isPointInCircle(touchX, touchY, centerX, centerY, radius)) {
          return
        }
        
        touchStateRef.current = {
          touches: [touch],
          initialDistance: 0,
          initialScale: crop.scale,
          initialX: crop.x,
          initialY: crop.y
        }
        e.preventDefault()
      } else if (e.touches.length === 2) {
        const touch1 = e.touches[0]
        const touch2 = e.touches[1]
        const center = getCenter(touch1, touch2)
        const centerTouchX = center.x - rect.left
        const centerTouchY = center.y - rect.top
        
        if (!isPointInCircle(centerTouchX, centerTouchY, centerX, centerY, radius)) {
          return
        }
        
        const distance = getDistance(touch1, touch2)
        touchStateRef.current = {
          touches: [touch1, touch2],
          initialDistance: distance,
          initialScale: crop.scale,
          initialX: crop.x,
          initialY: crop.y
        }
        e.preventDefault()
      }
    }

    const handleTouchMove = (e: TouchEvent) => {
      if (!touchStateRef.current) return
      e.preventDefault()

      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current)
      }

      rafRef.current = requestAnimationFrame(() => {
        if (!touchStateRef.current) return

        const rect = editor.getBoundingClientRect()
        if (!rect) return
        const editorWidth = rect.width
        const editorHeight = rect.height
        const centerX = editorWidth / 2
        const centerY = editorHeight / 2

        const touchesCount = e.touches.length
        const initialTouchesCount = touchStateRef.current.touches.length

        if (touchesCount === 1 && initialTouchesCount === 1) {
          const touch = e.touches[0]
          const initialTouch = touchStateRef.current.touches[0]
          
          const deltaX = touch.clientX - initialTouch.clientX
          const deltaY = touch.clientY - initialTouch.clientY
          
          setCrop((prev) => {
            let newX = touchStateRef.current!.initialX + deltaX
            let newY = touchStateRef.current!.initialY + deltaY
            
            const img = imageRef.current
            if (img) {
              const currentScale = prev.scale
              const imgScaledWidth = img.naturalWidth * currentScale
              const imgScaledHeight = img.naturalHeight * currentScale
              const maxX = centerX + cropSize / 2
              const minX = centerX - cropSize / 2 - imgScaledWidth
              const maxY = centerY + cropSize / 2
              const minY = centerY - cropSize / 2 - imgScaledHeight
              
              newX = Math.max(minX, Math.min(maxX, newX))
              newY = Math.max(minY, Math.min(maxY, newY))
            }
            
            return { ...prev, x: newX, y: newY }
          })
        } else if (touchesCount === 2 && initialTouchesCount === 2) {
          const touch1 = e.touches[0]
          const touch2 = e.touches[1]
          const distance = getDistance(touch1, touch2)
          const scaleChange = distance / touchStateRef.current.initialDistance
          const newScale = Math.max(0.1, Math.min(10, touchStateRef.current.initialScale * scaleChange))
          
          const img = imageRef.current
          if (img) {
            const imgWidth = img.naturalWidth
            const imgHeight = img.naturalHeight
            const initialCenterX = touchStateRef.current.initialX + (imgWidth * touchStateRef.current.initialScale) / 2
            const initialCenterY = touchStateRef.current.initialY + (imgHeight * touchStateRef.current.initialScale) / 2
            const vectorX = initialCenterX - centerX
            const vectorY = initialCenterY - centerY
            const scaleRatio = newScale / touchStateRef.current.initialScale
            const newCenterX = centerX + vectorX * scaleRatio
            const newCenterY = centerY + vectorY * scaleRatio
            const newX = newCenterX - (imgWidth * newScale) / 2
            const newY = newCenterY - (imgHeight * newScale) / 2
            setCrop({ x: newX, y: newY, scale: newScale })
          }
        }
        
        rafRef.current = null
      })
    }

    const handleTouchEnd = () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
      touchStateRef.current = null
    }

    editor.addEventListener('touchstart', handleTouchStart, { passive: false })
    editor.addEventListener('touchmove', handleTouchMove, { passive: false })
    editor.addEventListener('touchend', handleTouchEnd, { passive: true })
    editor.addEventListener('touchcancel', handleTouchEnd, { passive: true })

    return () => {
      editor.removeEventListener('touchstart', handleTouchStart)
      editor.removeEventListener('touchmove', handleTouchMove)
      editor.removeEventListener('touchend', handleTouchEnd)
      editor.removeEventListener('touchcancel', handleTouchEnd)
    }
  }, [avatarPreviewUrl, crop.scale, crop.x, crop.y])

  // Touch event handlers for group avatar editor
  useEffect(() => {
    if (!groupAvatarPreviewUrl) return
    const editor = groupEditorRef.current
    if (!editor) return

    const getDistance = (touch1: Touch, touch2: Touch) => {
      const dx = touch2.clientX - touch1.clientX
      const dy = touch2.clientY - touch1.clientY
      return Math.sqrt(dx * dx + dy * dy)
    }

    const getCenter = (touch1: Touch, touch2: Touch) => ({
      x: (touch1.clientX + touch2.clientX) / 2,
      y: (touch1.clientY + touch2.clientY) / 2
    })

    const cropSize = 240
    const isPointInCircle = (x: number, y: number, centerX: number, centerY: number, radius: number) => {
      const dx = x - centerX
      const dy = y - centerY
      return dx * dx + dy * dy <= radius * radius
    }

    const handleTouchStart = (e: TouchEvent) => {
      const rect = editor.getBoundingClientRect()
      if (!rect) return
      const editorWidth = rect.width
      const editorHeight = rect.height
      const centerX = editorWidth / 2
      const centerY = editorHeight / 2
      const radius = cropSize / 2

      if (e.touches.length === 1) {
        const touch = e.touches[0]
        const touchX = touch.clientX - rect.left
        const touchY = touch.clientY - rect.top
        
        if (!isPointInCircle(touchX, touchY, centerX, centerY, radius)) {
          return
        }
        
        groupTouchStateRef.current = {
          touches: [touch],
          initialDistance: 0,
          initialScale: groupCrop.scale,
          initialX: groupCrop.x,
          initialY: groupCrop.y
        }
        e.preventDefault()
      } else if (e.touches.length === 2) {
        const touch1 = e.touches[0]
        const touch2 = e.touches[1]
        const center = getCenter(touch1, touch2)
        const centerTouchX = center.x - rect.left
        const centerTouchY = center.y - rect.top
        
        if (!isPointInCircle(centerTouchX, centerTouchY, centerX, centerY, radius)) {
          return
        }
        
        const distance = getDistance(touch1, touch2)
        groupTouchStateRef.current = {
          touches: [touch1, touch2],
          initialDistance: distance,
          initialScale: groupCrop.scale,
          initialX: groupCrop.x,
          initialY: groupCrop.y
        }
        e.preventDefault()
      }
    }

    const handleTouchMove = (e: TouchEvent) => {
      if (!groupTouchStateRef.current) return
      e.preventDefault()

      if (groupRafRef.current !== null) {
        cancelAnimationFrame(groupRafRef.current)
      }

      groupRafRef.current = requestAnimationFrame(() => {
        if (!groupTouchStateRef.current) return

        const rect = editor.getBoundingClientRect()
        if (!rect) return
        const editorWidth = rect.width
        const editorHeight = rect.height
        const centerX = editorWidth / 2
        const centerY = editorHeight / 2

        const touchesCount = e.touches.length
        const initialTouchesCount = groupTouchStateRef.current.touches.length

        if (touchesCount === 1 && initialTouchesCount === 1) {
          const touch = e.touches[0]
          const initialTouch = groupTouchStateRef.current.touches[0]
          
          const deltaX = touch.clientX - initialTouch.clientX
          const deltaY = touch.clientY - initialTouch.clientY
          
          setGroupCrop((prev) => {
            let newX = groupTouchStateRef.current!.initialX + deltaX
            let newY = groupTouchStateRef.current!.initialY + deltaY
            
            const img = groupImageRef.current
            if (img) {
              const currentScale = prev.scale
              const imgScaledWidth = img.naturalWidth * currentScale
              const imgScaledHeight = img.naturalHeight * currentScale
              const maxX = centerX + cropSize / 2
              const minX = centerX - cropSize / 2 - imgScaledWidth
              const maxY = centerY + cropSize / 2
              const minY = centerY - cropSize / 2 - imgScaledHeight
              
              newX = Math.max(minX, Math.min(maxX, newX))
              newY = Math.max(minY, Math.min(maxY, newY))
            }
            
            return { ...prev, x: newX, y: newY }
          })
        } else if (touchesCount === 2 && initialTouchesCount === 2) {
          const touch1 = e.touches[0]
          const touch2 = e.touches[1]
          const distance = getDistance(touch1, touch2)
          const scaleChange = distance / groupTouchStateRef.current.initialDistance
          const newScale = Math.max(0.1, Math.min(10, groupTouchStateRef.current.initialScale * scaleChange))
          
          const img = groupImageRef.current
          if (img) {
            const imgWidth = img.naturalWidth
            const imgHeight = img.naturalHeight
            const initialCenterX = groupTouchStateRef.current.initialX + (imgWidth * groupTouchStateRef.current.initialScale) / 2
            const initialCenterY = groupTouchStateRef.current.initialY + (imgHeight * groupTouchStateRef.current.initialScale) / 2
            const vectorX = initialCenterX - centerX
            const vectorY = initialCenterY - centerY
            const scaleRatio = newScale / groupTouchStateRef.current.initialScale
            const newCenterX = centerX + vectorX * scaleRatio
            const newCenterY = centerY + vectorY * scaleRatio
            const newX = newCenterX - (imgWidth * newScale) / 2
            const newY = newCenterY - (imgHeight * newScale) / 2
            setGroupCrop({ x: newX, y: newY, scale: newScale })
          }
        }
        
        groupRafRef.current = null
      })
    }

    const handleTouchEnd = () => {
      if (groupRafRef.current !== null) {
        cancelAnimationFrame(groupRafRef.current)
        groupRafRef.current = null
      }
      groupTouchStateRef.current = null
    }

    editor.addEventListener('touchstart', handleTouchStart, { passive: false })
    editor.addEventListener('touchmove', handleTouchMove, { passive: false })
    editor.addEventListener('touchend', handleTouchEnd, { passive: true })
    editor.addEventListener('touchcancel', handleTouchEnd, { passive: true })

    return () => {
      editor.removeEventListener('touchstart', handleTouchStart)
      editor.removeEventListener('touchmove', handleTouchMove)
      editor.removeEventListener('touchend', handleTouchEnd)
      editor.removeEventListener('touchcancel', handleTouchEnd)
    }
  }, [groupAvatarPreviewUrl, groupCrop.scale, groupCrop.x, groupCrop.y])

  useChatSocketSubscriptions({
    activeId,
    meId: currentUserId,
    client,
    messagesQuery,
    appendMessageToCache,
    updateMessageInCache,
    setPendingByConv,
    isSecretBlockedForDevice,
    onIncomingTyping,
    playNotifySoundIfAllowed,
  })

  // Auto-stick to bottom when new messages render (but respect manual scroll)
  useLayoutEffect(() => {
    if (!activeId) {
      lastScrollConvRef.current = null
      lastRenderedMessagesRef.current = 0
      lastTailMessageIdRef.current = null
      return
    }
    if (lastScrollConvRef.current !== activeId) {
      lastScrollConvRef.current = activeId
      lastRenderedMessagesRef.current = 0
      lastTailMessageIdRef.current = null
    }
    const renderedCount = (displayedMessages?.length ?? 0) + activePendingMessages.length
    const prevCount = lastRenderedMessagesRef.current
    const prevTailId = lastTailMessageIdRef.current
    lastRenderedMessagesRef.current = renderedCount
    if (!messagesRef.current) return
    if (renderedCount === 0) return
    const fullList = [
      ...(displayedMessages || []),
      ...activePendingMessages,
    ]
    const lastMessage = fullList[fullList.length - 1]
    const tailId = (lastMessage as any)?.id ?? (lastMessage as any)?.tempId ?? null
    lastTailMessageIdRef.current = tailId
    // Если хвост (самое последнее сообщение) не изменился, значит это либо ничего не
    // поменялось, либо подгрузилась страница СТАРЫХ сверху. В обоих случаях
    // автоскролл вниз делать нельзя — иначе при загрузке истории нас выбрасывает
    // в самый низ беседы.
    if (renderedCount <= prevCount && tailId === prevTailId) return
    if (tailId === prevTailId) return
    const isMine = lastMessage?.senderId && me?.id ? lastMessage.senderId === me.id : false
    const shouldStick = isMine || !userStickyScrollRef.current || nearBottomRef.current
    if (!shouldStick) return
    requestAnimationFrame(() => {
      const el = messagesRef.current
      if (!el) return
      el.scrollTop = el.scrollHeight
      nearBottomRef.current = true
      if (isMine) {
        userStickyScrollRef.current = false
      }
      scheduleEbloUpdate()
    })
  }, [activeId, activePendingMessages, displayedMessages, me?.id, scheduleEbloUpdate])

  // notifications disabled

  // autoscroll to bottom when chat opens (агрессивно только на мобильных)
  useEffect(() => {
    if (!activeId) return
    // When we enter a conversation, we always start in "stick to bottom" mode.
    // Otherwise the first async render (messages/preview/toolbars) can leave us above the bottom
    // until the second interaction.
    nearBottomRef.current = true
    userStickyScrollRef.current = false
    setShowJump(false)

    // Первичная фиксация к низу «пачкой» кадров. Поздние изменения высоты (декод
    // картинок, мозаик, превью, видео — в любой момент, а не только в первые мс)
    // держат ResizeObserver контента и handleEbloRowHeightChange, поэтому прежнее
    // «распыление» скроллов на 0/50/200/600мс больше не нужно.
    scheduleEbloUpdate()
    pinToBottomBurst()
    return () => {
      if (pinBurstRafRef.current) {
        cancelAnimationFrame(pinBurstRafRef.current)
        pinBurstRafRef.current = 0
      }
    }
  }, [activeId, scheduleEbloUpdate, pinToBottomBurst])

  // Пуленепробиваемое «прилипание» к низу: единый ResizeObserver на контейнере
  // сообщений. КАКОЕ БЫ содержимое ни изменило высоту (догрузка картинок/мозаик/
  // видео/превью, разворачивание строки виртуализации из плейсхолдера в реальную
  // строку) — пока мы у низа, возвращаемся точно на низ. Это и есть «раз и навсегда».
  useEffect(() => {
    if (!activeId) return
    const content = messagesContentRef.current
    if (!content || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      if (nearBottomRef.current) pinToBottomBurst()
    })
    ro.observe(content)
    return () => ro.disconnect()
  }, [activeId, pinToBottomBurst])

  // keep pinned to bottom while keyboard is opening/moving on mobile (iOS visualViewport)
  useEffect(() => {
    if (!isMobileRef.current) return
    const el = messagesRef.current
    if (!el) return
    const handleVV = () => {
      const active = typeof document !== 'undefined' ? (document.activeElement as HTMLElement | null) : null
      if (active && active === composerEditorRef.current) {
        el.scrollTop = el.scrollHeight
        nearBottomRef.current = true
        userStickyScrollRef.current = false
        scheduleEbloUpdate()
      }
    }
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', handleVV, { passive: true } as any)
      window.visualViewport.addEventListener('scroll', handleVV, { passive: true } as any)
    }
    return () => {
      if (window.visualViewport) {
        window.visualViewport.removeEventListener('resize', handleVV as any)
        window.visualViewport.removeEventListener('scroll', handleVV as any)
      }
    }
  }, [activeId, scheduleEbloUpdate])

  // Dev-only: warn if credential-like inputs are present on chat page
  useEffect(() => {
    if (!(import.meta as any).env?.DEV) return
    const suspects = document.querySelectorAll(
      'input[type="password"], input[autocomplete*="password" i], input[name*="pass" i], input[name*="user" i], input[name*="email" i], input[autocomplete*="username" i]'
    )
    if (suspects.length) {
      // eslint-disable-next-line no-console
      console.warn('Credential-like inputs present on chat page:', suspects)
    }
  }, [])

  // автопрокрутка по новым сообщениям отключена, чтобы не мешать ручному скроллу

  // Show jump-to-bottom button when user scrolls up
  useEffect(() => {
    const el = messagesRef.current
    if (!el) return
    let raf = 0
    let lastScrollTop = el.scrollTop
    const onScroll = () => {
      if (raf) cancelAnimationFrame(raf)
      const currentScrollTop = el.scrollTop
      const scrollDelta = Math.abs(currentScrollTop - lastScrollTop)
      // Only mark as user scroll if there's actual movement (not just programmatic scroll)
      if (scrollDelta > 1) {
        userStickyScrollRef.current = true
      }
      raf = requestAnimationFrame(() => {
        const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 8
        nearBottomRef.current = nearBottom
        setShowJump(!nearBottom)
        scheduleEbloUpdate()
        // Infinite scroll: when user reaches near-top, load older messages.
        // We keep scroll position stable in `loadOlderMessages`.
        if (el.scrollTop < 420) {
          void loadOlderMessages()
        }
        if (nearBottom) {
          // Only reset user sticky scroll if we're actually near bottom
          // Give a small delay to allow programmatic scrolls
          window.setTimeout(() => {
            if (el.scrollHeight - el.scrollTop - el.clientHeight < 40) {
              userStickyScrollRef.current = false
            }
          }, 100)
        }
        lastScrollTop = el.scrollTop
      })
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    onScroll()
    return () => {
      el.removeEventListener('scroll', onScroll)
      if (raf) cancelAnimationFrame(raf)
    }
  }, [activeId, loadOlderMessages, scheduleEbloUpdate])

  useEffect(() => {
    if (!activeId) return
    if (!olderMeta.hasMore || olderLoading) return
    const el = messagesRef.current
    if (!el) return
    if (el.scrollHeight <= el.clientHeight + 420) {
      void loadOlderMessages()
    }
  }, [activeId, displayedMessages.length, activePendingMessages.length, olderMeta.hasMore, olderLoading, loadOlderMessages])

  // detect wide area to left-align all messages
  useEffect(() => {
    const measure = () => {
      if (!messagesRef.current) return
      const width = messagesRef.current.clientWidth
      setLeftAlignAll(width >= 900)
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [activeId])

  async function lookupUserByEblid(full: string) {
    try {
      const resp = await api.get('/contacts/search', { params: { query: full } })
      setFoundUser(resp.data.results?.[0] ?? null)
    } catch {
      setFoundUser(null)
    }
  }

  function applyEblidPaste(startIdx: number, text: string) {
    const only = String(text ?? '').replace(/\D/g, '').slice(0, EMPTY_EBLID_DIGITS.length)
    if (!only) return
    const next = [...eblDigits]
    for (let k = 0; k < only.length && startIdx + k < EMPTY_EBLID_DIGITS.length; k += 1) {
      next[startIdx + k] = only[k] ?? ''
    }
    setEblDigits(next)
    const full = next.join('')
    if (full.length === 4 && /^\d{4}$/.test(full)) {
      void lookupUserByEblid(full)
    } else {
      setFoundUser(null)
    }
    const last = Math.min(EMPTY_EBLID_DIGITS.length - 1, startIdx + only.length - 1)
    if (last >= 0 && last < EMPTY_EBLID_DIGITS.length - 1) {
      eblRefs[last + 1].current?.focus()
    }
  }

  function onKeyDownDigit(idx: number, e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Backspace' && !eblDigits[idx] && idx > 0) {
      e.preventDefault()
      const next = [...eblDigits]
      next[idx - 1] = ''
      setEblDigits(next)
      setFoundUser(null)
      eblRefs[idx - 1].current?.focus()
    }
  }

  function onChangeDigit(idx: number, val: string) {
    if (!/^\d?$/.test(val)) return
    const next = [...eblDigits]
    next[idx] = val
    setEblDigits(next)
    if (val && idx < 3) eblRefs[idx + 1].current?.focus()
    if (!val && idx > 0) eblRefs[idx - 1].current?.focus()
    const full = next.join('')
    if (full.length === 4 && /^\d{4}$/.test(full)) {
      void lookupUserByEblid(full)
    } else {
      setFoundUser(null)
    }
  }

  async function openContactsOverlay() {
    setContactsOpen(true)
    setContactsInviteCopied(false)
    setContactsInviteRefreshing(false)
    setMyEblidCopied(false)
    void registrationInviteCodeQuery.refetch()
    window.setTimeout(() => {
      const firstEmptyIdx = eblDigits.findIndex((digit) => !digit)
      const targetIdx = firstEmptyIdx >= 0 ? firstEmptyIdx : EMPTY_EBLID_DIGITS.length - 1
      eblRefs[targetIdx]?.current?.focus()
    }, 70)
    try {
      const r = await api.get('/status/me')
      setMyEblid(r.data.user?.eblid ?? '')
    } catch {}
  }

  async function copyContactsInviteCode() {
    if (!contactsInviteCode) return
    const copied = await copyPlainText(contactsInviteCode)
    if (copied) {
      setContactsInviteCopied(true)
    }
  }

  async function refreshContactsInviteCode() {
    setContactsInviteCopied(false)
    setContactsInviteRefreshing(true)
    try {
      const response = await api.post('/auth/register/code/refresh')
      const nextInvite = response.data as { code: string; expiresAt: string; digits?: number }
      client.setQueryData(['registration-invite-code'], nextInvite)
      client.setQueryData(['registration-invite-code', 'contacts-overlay'], nextInvite)
      setContactsInviteNow(Date.now())
    } finally {
      setContactsInviteRefreshing(false)
    }
  }

  async function copyMyEblid() {
    if (!myEblid) return
    const copied = await copyPlainText(myEblid)
    if (copied) {
      setMyEblidCopied(true)
    }
  }

  function clearEblidSearch() {
    setEblDigits([...EMPTY_EBLID_DIGITS])
    setFoundUser(null)
    eblRefs[0].current?.focus()
  }

  async function sendInvite() {
    const code = eblDigits.join('')
    if (!/^\d{4}$/.test(code)) return
    setSendingInvite(true)
    try {
      await api.post('/contacts/add', { identifier: code })
      client.invalidateQueries({ queryKey: ['contacts'] })
      await client.refetchQueries({ queryKey: ['contacts', 'outgoing'] })
      setTimeout(() => {
        client.refetchQueries({ queryKey: ['contacts', 'outgoing'] })
      }, 800)
      setEblDigits(['', '', '', ''])
      setFoundUser(null)
      eblRefs[0].current?.focus()
      setSendingInvite(false)
    } catch (err: any) {
      setSendingInvite(false)
      const msg = err.response?.data?.message ?? err.message ?? 'Не удалось отправить запрос'
      systemToast.error(msg)
    }
  }

  function canAutoMarkRead() {
    try {
      return document.visibilityState === 'visible' && document.hasFocus()
    } catch {
      return false
    }
  }

  function markConversationReadNow() {
    if (!activeId) return
    const isSecretV2 = String(activeConversation?.type ?? '').toUpperCase() === 'SECRET'
    if (isSecretV2) return
    if (!canAutoMarkRead()) return
    // mark conversation read on server to zero unreadCount
    api.post('/messages/mark-conversation-read', { conversationId: activeId }).catch(() => {})
    // Optimistically zero unread locally
    client.setQueryData(['conversations'], (old: any) => {
      if (!old) return old
      return old.map((row: any) => row.conversation.id === activeId ? { ...row, unreadCount: 0 } : row)
    })
  }

  // Simplified: mark all messages as READ if chat is open and window focused
  function markAllReadNow() {
    if (!activeId || !messagesQuery.data || !me?.id) return
    const isSecretV2 = String(activeConversation?.type ?? '').toUpperCase() === 'SECRET'
    if (isSecretV2) return
    if (!canAutoMarkRead()) return
    const unreadIds = (messagesQuery.data as Array<any>)
      .filter((m) => m.senderId !== me.id)
      .filter((m) => !(m.receipts || []).some((r: any) => r.userId === me.id && (r.status === 'READ' || r.status === 'SEEN')))
      .map((m) => m.id)
    if (unreadIds.length === 0) return
    api.post('/messages/receipts', { messageIds: unreadIds, status: 'READ' })
      .then(() => { client.invalidateQueries({ queryKey: ['messages', activeId] }); })
      .catch(() => {})
  }

  useEffect(() => {
    if (canAutoMarkRead()) {
      markAllReadNow()
      markConversationReadNow()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId])

  useEffect(() => {
    if (canAutoMarkRead()) {
      markAllReadNow()
      markConversationReadNow()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messagesQuery.data])

  useEffect(() => {
    const onFocus = () => {
      if (!canAutoMarkRead()) return
      markAllReadNow()
      markConversationReadNow()
    }
    const onVis = () => {
      if (!canAutoMarkRead()) return
      markAllReadNow()
      markConversationReadNow()
    }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVis)
    return () => {
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVis)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, messagesQuery.data])

  // batch sender for receipts
  function scheduleSendReceipts() {
    if (batchTimer.current) return
    batchTimer.current = window.setTimeout(() => {
      const ids = Array.from(batchToRead.current)
      batchToRead.current.clear()
      batchTimer.current && clearTimeout(batchTimer.current)
      batchTimer.current = null
      if (!ids.length) return
      const isSecretV2 = String(activeConversation?.type ?? '').toUpperCase() === 'SECRET'
      if (isSecretV2) return
      api.post('/messages/receipts', { messageIds: ids, status: 'READ' })
        .then(() => { if (activeId) client.invalidateQueries({ queryKey: ['messages', activeId] }) })
        .catch(() => {})
    }, 250)
  }

  // Observe bubbles and mark as READ when visible in viewport and app focused/visible
  useEffect(() => {
    if (!activeId || !messagesQuery.data || !me?.id) return
    const isSecretV2 = String(activeConversation?.type ?? '').toUpperCase() === 'SECRET'
    if (isSecretV2) return
    // Clean previous
    visibleObserver.current?.disconnect()
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting || entry.intersectionRatio < 0.6) continue
        if (!canAutoMarkRead()) continue
        const el = entry.target as HTMLElement
        const mid = el.dataset.mid
        if (!mid) continue
        const msg = (messagesQuery.data as Array<any>).find((m) => m.id === mid)
        if (!msg) continue
        if (msg.senderId === me.id) continue
        const already = (msg.receipts || []).some((r: any) => r.userId === me.id && (r.status === 'READ' || r.status === 'SEEN'))
        if (already) continue
        batchToRead.current.add(mid)
        observer.unobserve(el)
      }
      if (batchToRead.current.size) scheduleSendReceipts()
    }, { root: messagesRef.current!, threshold: [0.25] })
    visibleObserver.current = observer
    // Attach to all eligible message bubbles
    for (const m of messagesQuery.data as Array<any>) {
      if (m.senderId === me.id) continue
      const already = (m.receipts || []).some((r: any) => r.userId === me.id && (r.status === 'READ' || r.status === 'SEEN'))
      if (already) continue
      const node = nodesByMessageId.current.get(m.id)
      if (node) observer.observe(node)
    }
    return () => {
      observer.disconnect()
    }
  }, [activeId, messagesQuery.data, me?.id])

  // do not auto-mark all as READ on load; handled on message arrival if window focused

  // detect wide area to left-align all messages
  useEffect(() => {
    const measure = () => {
      if (!messagesRef.current) return
      const width = messagesRef.current.clientWidth
      setLeftAlignAll(width >= 900)
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [activeId])

  function moveCursorToEnd(el: HTMLDivElement | null) {
    if (!el) return
    try {
      const sel = window.getSelection()
      if (!sel) return
      const range = document.createRange()
      range.selectNodeContents(el)
      range.collapse(false)
      sel.removeAllRanges()
      sel.addRange(range)
    } catch {}
  }

  const insertPlainTextIntoComposer = useCallback((plain: string) => {
    const editor = composerEditorRef.current
    if (!editor || !plain) return false
    try {
      editor.focus()
      const sel = window.getSelection()
      if (!sel) return false
      let range: Range
      if (sel.rangeCount > 0 && sel.anchorNode && editor.contains(sel.anchorNode)) {
        range = sel.getRangeAt(0)
        range.deleteContents()
      } else {
        range = document.createRange()
        range.selectNodeContents(editor)
        range.collapse(false)
      }
      const textNode = document.createTextNode(plain)
      range.insertNode(textNode)
      range.setStartAfter(textNode)
      range.collapse(true)
      sel.removeAllRanges()
      sel.addRange(range)
      return true
    } catch {
      return false
    }
  }, [])

  const resizeComposer = useCallback(() => {
    const el = composerEditorRef.current
    if (!el) return
    try {
      const cs = window.getComputedStyle(el)
      const minHRaw = cs.getPropertyValue('--control-h').trim()
      const maxHRaw = cs.getPropertyValue('--composer-max-h').trim()
      const minH = Number.parseInt(minHRaw || '46', 10) || 46
      const maxH = Number.parseInt(maxHRaw || '140', 10) || 140
      el.style.height = '0px'
      const next = Math.min(el.scrollHeight, maxH)
      el.style.height = `${Math.max(next, minH)}px`
      el.style.overflowY = el.scrollHeight > maxH ? 'auto' : 'hidden'
    } catch {
      // ignore
    }
  }, [])

  const getComposerValue = useCallback((): string => {
    const el = composerEditorRef.current
    if (!el) return ''
    return htmlToMarkdown(el.innerHTML)
  }, [])

  const setComposerValue = useCallback((md: string) => {
    const el = composerEditorRef.current
    const html = (md || '').trim() ? renderChatMarkdownToHtml(md) : ''
    if (el) {
      el.innerHTML = html || '<br>'
      moveCursorToEnd(el)
      requestAnimationFrame(() => resizeComposer())
    }
    setComposerEmpty(!(md || '').trim())
  }, [resizeComposer])

  const cancelEdit = useCallback(() => {
    setEditState(null)
    setEditBusy(false)
    setComposerValue('')
    setReplyTo(null)
    requestAnimationFrame(() => {
      try {
        composerEditorRef.current?.focus()
      } catch {}
    })
  }, [setComposerValue])

  const startEdit = useCallback(
    (msg: any) => {
      if (!msg || typeof msg.id !== 'string') return
      if (msg.senderId !== me?.id) return
      if (msg.deletedAt) return
      if ((msg.type || 'TEXT') !== 'TEXT') return
      const atts = Array.isArray(msg.attachments) ? msg.attachments : []
      if (atts.length > 0) return
      const text = typeof msg.content === 'string' ? msg.content : ''
      setReplyTo(null)
      setEditBusy(false)
      setEditState({ messageId: msg.id, originalText: text })
      setComposerValue(text)
      requestAnimationFrame(() => {
        try {
          composerEditorRef.current?.focus()
          moveCursorToEnd(composerEditorRef.current)
        } catch {}
      })
    },
    [me?.id, setComposerValue],
  )

  const applyWysiwygFormat = useCallback(
    (cmd: string, value?: string) => {
      composerEditorRef.current?.focus()
      document.execCommand(cmd, false, value ?? '')
      notifyTyping()
      resizeComposer()
    },
    [notifyTyping, resizeComposer],
  )

  const closeComposerSelectionToolbar = useCallback((opts?: { collapseSelection?: boolean }) => {
    setComposerSelectionAnchor(null)
    composerSelectionRangeRef.current = null
    if (!opts?.collapseSelection) return
    try {
      const sel = window.getSelection()
      if (!sel || sel.rangeCount === 0) return
      sel.collapseToEnd()
    } catch {
      // ignore
    }
  }, [])

  const getComposerSelectionAnchorFromRange = useCallback((range: Range): null | { left: number; top: number; bottom: number; width: number } => {
    try {
      const rects = Array.from(range.getClientRects?.() || [])
      const fallback = range.getBoundingClientRect?.()
      const base = (fallback && (fallback.width > 0 || fallback.height > 0)) ? [fallback] : rects
      if (!base.length) return null
      let left = Number.POSITIVE_INFINITY
      let right = 0
      let top = Number.POSITIVE_INFINITY
      let bottom = 0
      for (const r of base) {
        left = Math.min(left, r.left)
        right = Math.max(right, r.right)
        top = Math.min(top, r.top)
        bottom = Math.max(bottom, r.bottom)
      }
      const width = Math.max(0, right - left)
      if (!Number.isFinite(left) || !Number.isFinite(top)) return null
      if (left === 0 && right === 0 && top === 0 && bottom === 0) return null
      return { left, top, bottom, width }
    } catch {
      return null
    }
  }, [])

  const updateComposerSelectionToolbar = useCallback(() => {
    const editor = composerEditorRef.current
    if (!editor) {
      setComposerSelectionFmt({ bold: false, italic: false, strike: false })
      return closeComposerSelectionToolbar()
    }
    try {
      const sel = window.getSelection()
      if (!sel || sel.rangeCount === 0) {
        setComposerSelectionFmt({ bold: false, italic: false, strike: false })
        return closeComposerSelectionToolbar()
      }
      const anchorNode = sel.anchorNode
      const focusNode = sel.focusNode
      const inEditor = !!(anchorNode && focusNode && editor.contains(anchorNode) && editor.contains(focusNode))
      const active = document.activeElement === editor || (composerFocused && inEditor)
      if (!active || !inEditor) {
        setComposerSelectionFmt({ bold: false, italic: false, strike: false })
        return closeComposerSelectionToolbar()
      }
      // If the composer is fully empty, reset formatting state and hide the toolbar.
      // execCommand formatting can remain "sticky" at caret even with no content.
      const empty = !(editor.innerText || '').trim()
      if (empty) {
        setComposerSelectionFmt({ bold: false, italic: false, strike: false })
        return closeComposerSelectionToolbar()
      }
      const fmt = {
        bold: !!document.queryCommandState?.('bold'),
        italic: !!document.queryCommandState?.('italic'),
        strike: !!document.queryCommandState?.('strikeThrough'),
      }
      setComposerSelectionFmt(fmt)
      const range = sel.getRangeAt(0)
      const selectedText = sel.toString() || ''
      const hasSelection = !sel.isCollapsed && !!selectedText.length
      const anchor = getComposerSelectionAnchorFromRange(range)
      composerSelectionRangeRef.current = range.cloneRange()
      if (hasSelection) {
        if (!anchor) return closeComposerSelectionToolbar()
        setComposerSelectionAnchor(anchor)
        return
      }
      if (fmt.bold || fmt.italic || fmt.strike) {
        setComposerSelectionAnchor((prev) => anchor || prev)
        return
      }
      closeComposerSelectionToolbar()
    } catch {
      setComposerSelectionFmt({ bold: false, italic: false, strike: false })
      closeComposerSelectionToolbar()
    }
  }, [closeComposerSelectionToolbar, composerFocused, getComposerSelectionAnchorFromRange])

  useEffect(() => {
    const handler = () => updateComposerSelectionToolbar()
    document.addEventListener('selectionchange', handler)
    window.addEventListener('mouseup', handler, { passive: true } as any)
    window.addEventListener('keyup', handler, { passive: true } as any)
    window.addEventListener('resize', handler, { passive: true } as any)
    const editor = composerEditorRef.current
    editor?.addEventListener('scroll', handler, { passive: true } as any)
    return () => {
      document.removeEventListener('selectionchange', handler)
      window.removeEventListener('mouseup', handler as any)
      window.removeEventListener('keyup', handler as any)
      window.removeEventListener('resize', handler as any)
      editor?.removeEventListener('scroll', handler as any)
    }
  }, [updateComposerSelectionToolbar])

  useLayoutEffect(() => {
    if (!composerSelectionAnchor) return
    const el = composerSelectionToolbarRef.current
    if (!el) return
    const measure = () => {
      try {
        const r = el.getBoundingClientRect()
        setComposerSelectionToolbarSize({ w: Math.round(r.width), h: Math.round(r.height) })
      } catch {
        // ignore
      }
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => measure())
    ro.observe(el)
    return () => ro.disconnect()
  }, [composerSelectionAnchor])

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node | null
      if (!t) return
      if (composerSelectionToolbarRef.current?.contains(t)) return
      if (composerEditorRef.current?.contains(t)) return
      closeComposerSelectionToolbar()
    }
    document.addEventListener('mousedown', onDown, true)
    return () => document.removeEventListener('mousedown', onDown, true)
  }, [closeComposerSelectionToolbar])

  const applyComposerSelectionFormat = useCallback((cmd: 'bold' | 'italic' | 'strikeThrough') => {
    const editor = composerEditorRef.current
    if (!editor) return
    try {
      editor.focus()
    } catch {}
    try {
      const sel = window.getSelection()
      if (sel && composerSelectionRangeRef.current) {
        sel.removeAllRanges()
        sel.addRange(composerSelectionRangeRef.current)
      }
    } catch {
      // ignore
    }
    applyWysiwygFormat(cmd)
    try {
      const sel = window.getSelection()
      if (sel && sel.rangeCount > 0) composerSelectionRangeRef.current = sel.getRangeAt(0).cloneRange()
    } catch {
      // ignore
    }
    setComposerEmpty(!editor.innerText?.trim())
    requestAnimationFrame(() => updateComposerSelectionToolbar())
  }, [applyWysiwygFormat, updateComposerSelectionToolbar])

  const composerSelectionToolbarStyle = useMemo(() => {
    if (!composerSelectionAnchor) return null
    const margin = 8
    const gap = 10
    const vw = (typeof window !== 'undefined')
      ? (window.innerWidth || document.documentElement.clientWidth || 0)
      : 0
    const vh = (typeof window !== 'undefined')
      ? (window.innerHeight || document.documentElement.clientHeight || 0)
      : 0
    const w = composerSelectionToolbarSize.w
    const h = composerSelectionToolbarSize.h

    const xCenter = composerSelectionAnchor.left + composerSelectionAnchor.width / 2
    let left = xCenter
    if (vw > 0 && w > 0) {
      left = Math.min(vw - margin - w / 2, Math.max(margin + w / 2, xCenter))
    } else if (vw > 0) {
      left = Math.min(vw - margin, Math.max(margin, xCenter))
    }

    const topPreferred = composerSelectionAnchor.top - gap - h
    const bottomPreferred = composerSelectionAnchor.bottom + gap
    let top = topPreferred
    if (h > 0 && topPreferred < margin) top = bottomPreferred
    if (h > 0 && vh > 0 && top + h > vh - margin && topPreferred >= margin) top = topPreferred
    if (vh > 0 && h > 0) top = Math.min(vh - margin - h, Math.max(margin, top))

    return {
      position: 'fixed' as const,
      left,
      top,
      transform: 'translateX(-50%)',
      opacity: w > 0 ? 1 : 0,
    }
  }, [composerSelectionAnchor, composerSelectionToolbarSize])

  const applyWysiwygCode = useCallback(() => {
    const el = composerEditorRef.current
    if (!el) return
    el.focus()
    const sel = window.getSelection()
    const text = (sel?.toString() || 'код').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    document.execCommand('insertHTML', false, `<code>${text}</code>`)
    notifyTyping()
    resizeComposer()
  }, [notifyTyping, resizeComposer])

  const applyWysiwygCodeBlock = useCallback(() => {
    const el = composerEditorRef.current
    if (!el) return
    el.focus()
    const sel = window.getSelection()?.toString() || ''
    const escaped = sel.replace(/</g, '&lt;').replace(/>/g, '&gt;')
    document.execCommand('insertHTML', false, `<pre><code>${escaped || '\n'}</code></pre>`)
    notifyTyping()
    resizeComposer()
  }, [notifyTyping, resizeComposer])

  const applyWysiwygLink = useCallback(() => {
    const url = window.prompt('URL ссылки:', 'https://')
    if (url != null && url.trim()) applyWysiwygFormat('createLink', url.trim())
  }, [applyWysiwygFormat])

  useLayoutEffect(() => {
    resizeComposer()
  }, [composerEmpty, resizeComposer])

  useEffect(() => {
    const el = composerEditorRef.current
    if (el && !el.textContent?.trim()) {
      el.innerHTML = '<br>'
    }
  }, [])

  const syncComposerBarHeightVar = useCallback(() => {
    const bar = composerBarRef.current
    if (!bar) return
    try {
      const h = Math.max(1, Math.round(bar.getBoundingClientRect().height))
      document.documentElement.style.setProperty('--composer-bar-h', `${h}px`)
    } catch {
      // ignore
    }
  }, [])

  useLayoutEffect(() => {
    syncComposerBarHeightVar()
  }, [composerEmpty, pendingImages.length, pendingFiles.length, replyTo?.replyToId, replyTo?.quoted?.length, forwardComposerDraft?.destinationConversationId, forwardComposerDraft?.previews?.length, editState?.messageId, attachUploading, attachUploadState, syncComposerBarHeightVar])

  useEffect(() => {
    if (attachUploadState !== 'processing') {
      setAttachProcessingMessageIndex(0)
      return
    }
    setAttachProcessingMessageIndex(0)
    const intervalId = window.setInterval(() => {
      setAttachProcessingMessageIndex((prev) => (prev + 1) % ATTACH_PROCESSING_MESSAGES.length)
    }, 2000)
    return () => window.clearInterval(intervalId)
  }, [attachUploadState])

  // Keep CSS var in sync for any layout changes (e.g. fonts/viewport).
  useEffect(() => {
    const bar = composerBarRef.current
    if (!bar || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      syncComposerBarHeightVar()
      // If the user was at the bottom, keep the view pinned when composer grows/shrinks
      // (e.g. toolbar appears, attachments preview, reply/edit bars).
      const el = messagesRef.current
      if (el && nearBottomRef.current) {
        try { el.scrollTop = el.scrollHeight } catch {}
      }
    })
    ro.observe(bar)
    return () => ro.disconnect()
  }, [syncComposerBarHeightVar])

  const beginAttachUploadTracking = useCallback(() => {
    attachUploadStartedAtRef.current = Date.now()
    attachUploadSpeedUpdatedAtRef.current = 0
    setAttachUploadSpeed('0 B/s')
  }, [])

  const updateAttachUploadSpeed = useCallback((uploadedBytes: number, force = false) => {
    const startedAt = attachUploadStartedAtRef.current
    if (!startedAt) return
    const now = Date.now()
    if (!force && now - attachUploadSpeedUpdatedAtRef.current < 400) return
    const elapsedMs = Math.max(1, now - startedAt)
    const bytesPerSecond = uploadedBytes / (elapsedMs / 1000)
    attachUploadSpeedUpdatedAtRef.current = now
    setAttachUploadSpeed(formatUploadSpeed(bytesPerSecond))
  }, [])

  const removePendingUploadMessage = useCallback((conversationId: string | null, pendingId: string | null) => {
    if (!conversationId || !pendingId) return
    setPendingByConv((prev) => {
      const convPending = prev[conversationId] || []
      const filtered = convPending.filter((m) => m.id !== pendingId)
      if (filtered.length === convPending.length) return prev
      if (filtered.length === 0) {
        const { [conversationId]: _removed, ...rest } = prev
        return rest
      }
      return { ...prev, [conversationId]: filtered }
    })
  }, [])

  const resetAttachUploadTracking = useCallback(() => {
    attachUploadStartedAtRef.current = null
    attachUploadSpeedUpdatedAtRef.current = 0
    setAttachUploadSpeed('0 B/s')
    setAttachProcessingMessageIndex(0)
  }, [])

  const resetActiveAttachUpload = useCallback(() => {
    activeAttachXhrRef.current = null
    activeAttachAbortControllerRef.current = null
    activeAttachUploadIdRef.current = null
    activeAttachPendingMessageIdRef.current = null
    activeAttachConversationIdRef.current = null
    attachCancelRequestedRef.current = false
    setAttachCanceling(false)
  }, [])

  const cancelActiveAttachUpload = useCallback(async () => {
    if (!attachUploading || attachCanceling) return
    setAttachCanceling(true)
    attachCancelRequestedRef.current = true

    const xhr = activeAttachXhrRef.current
    const controller = activeAttachAbortControllerRef.current
    const uploadId = activeAttachUploadIdRef.current
    const pendingId = activeAttachPendingMessageIdRef.current
    const conversationId = activeAttachConversationIdRef.current

    try { xhr?.abort() } catch {}
    try { controller?.abort() } catch {}

    if (uploadId) {
      try {
        await api.delete(`/upload/${uploadId}`)
      } catch {}
    }

    removePendingUploadMessage(conversationId, pendingId)
    setAttachUploadState('done')
    setAttachUploading(false)
    setAttachProgress(0)
    resetAttachUploadTracking()
    resetActiveAttachUpload()
  }, [attachUploading, attachCanceling, removePendingUploadMessage, resetActiveAttachUpload, resetAttachUploadTracking])

  const eventHasFiles = useCallback((e: React.DragEvent) => {
    try {
      const dt = e.dataTransfer
      if (!dt) return false
      if (dt.types && Array.from(dt.types).includes('Files')) return true
      if (dt.items && Array.from(dt.items).some((it) => it.kind === 'file')) return true
      return false
    } catch {
      return false
    }
  }, [])

  const handleChatDropFiles = useCallback(
    async (files: File[]) => {
      if (!activeId || !files.length) return
      if (editState) return
      if (forwardComposerDraft) {
        systemToast.error('Сначала отправьте или отмените пересылку — вложения с нею не смешиваем.')
        return
      }
      const imageFiles = files.filter((file) => file.type.startsWith('image/'))
      const otherFiles = files.filter((file) => !file.type.startsWith('image/'))
      imageFiles.forEach((file) => addComposerImage(file, 'upload'))
      otherFiles.forEach((file) => addComposerFile(file, 'drop'))
      // Focus composer after drop to allow adding a caption quickly.
      requestAnimationFrame(() => {
        try { composerEditorRef.current?.focus() } catch {}
      })
    },
    [activeId, addComposerFile, addComposerImage, editState, forwardComposerDraft],
  )

  async function uploadAndSendAttachments(files: File[], textContent: string = '', replyDraft: ReplyDraftState = null) {
    if (!activeId || files.length === 0) return
    if (forwardComposerDraft) {
      systemToast.error('Сначала отправьте или отмените пересылку — вложения с нею не смешиваем.')
      return
    }
    const isSecretV2 = String(activeConversation?.type ?? '').toUpperCase() === 'SECRET'
    const isLegacySecretConversation = !!activeConversation?.isSecret && !isSecretV2
    if (isSecretV2) {
      systemToast.error('Вложения в секретных чатах пока не поддерживаются на этом устройстве. Обновление уже в пути.')
      return
    }
    const isSecretConversation = isLegacySecretConversation
    if (isLegacySecretConversation) {
      if (conversationSecretInactive) {
        systemToast.error('Секретный чат больше не активен, отправка вложений отключена.')
        return
      }
      if (!conversationSecretSessionReady) {
        systemToast.error('Секретный чат ещё не готов к вложениям, подождите установления защищённой сессии.')
        return
      }
    }
    setAttachUploading(true)
    setAttachProgress(0)
    setAttachUploadState('uploading')
    setAttachCanceling(false)
    attachCancelRequestedRef.current = false
    activeAttachConversationIdRef.current = activeId
    activeAttachPendingMessageIdRef.current = null
    activeAttachUploadIdRef.current = null
    activeAttachXhrRef.current = null
    activeAttachAbortControllerRef.current = null
    beginAttachUploadTracking()
    // Let React paint the upload bar before sync prep/XHR starts.
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve())
    })
    const pid = `tmp-${Date.now()}-${Math.random().toString(36).slice(2)}`
    try {
      // Build optimistic pending entry
      const pendingAttachments: PendingAttachment[] = []
      const totalSize = files.reduce((s, f) => s + f.size, 0)
      // Precompute dimensions for images
      for (const f of files) {
        if (f.type.startsWith('image/')) {
          const blobUrl = URL.createObjectURL(f)
          const { width, height } = await getImageSize(blobUrl)
          pendingAttachments.push({ url: blobUrl, type: 'IMAGE', width, height, progress: 0, __pending: true })
        } else {
          const ext = (f.name || '').split('.').pop()?.toLowerCase() || ''
          const isVideo = f.type.startsWith('video/') || VIDEO_EXTS.includes(ext)
          const isAudio = f.type.startsWith('audio/') || AUDIO_EXTS.includes(ext)
          const pendingType = isVideo ? 'VIDEO' : isAudio ? 'AUDIO' : 'FILE'
          pendingAttachments.push({
            url: f.name,
            type: pendingType,
            size: f.size,
            __pending: true,
            progress: 0,
            metadata: { originalName: f.name || undefined, mime: f.type || undefined },
          })
        }
      }
      setPendingByConv((prev) => ({
        ...prev,
        [activeId!]: [
          ...(prev[activeId!] || []),
          { id: pid, createdAt: Date.now(), senderId: me?.id || 'me', attachments: pendingAttachments, content: textContent },
        ],
      }))
      activeAttachPendingMessageIdRef.current = pid

      const uploaded: Array<{ url: string; type: 'IMAGE' | 'FILE' | 'VIDEO' | 'AUDIO'; size?: number; metadata?: Record<string, any> }> = []
      const CHUNK_UPLOAD_THRESHOLD = 10 * 1024 * 1024
      const uploadBaseUrl = getUploadUrl()
      const authToken = (() => {
        try {
          return useAppStore.getState().session?.accessToken
        } catch {
          return undefined
        }
      })()
      let uploadDebug = !!import.meta.env.DEV
      try {
        if (typeof localStorage !== 'undefined' && localStorage.getItem('eblushaUploadDebug') === '1') uploadDebug = true
      } catch {}
      try {
        if (typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('uploadDebug') === '1') uploadDebug = true
      } catch {}
      const uploadChunkPart = (uploadId: string, partNumber: number, chunk: Blob, onProgress: (loaded: number) => void) => new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest()
        activeAttachXhrRef.current = xhr
        xhr.open('PUT', `${uploadBaseUrl}/${uploadId}/part/${partNumber}`)
        xhr.setRequestHeader('Content-Type', 'application/octet-stream')
        if (authToken) xhr.setRequestHeader('Authorization', `Bearer ${authToken}`)
        xhr.upload.onprogress = (e) => {
          const loaded = e.lengthComputable ? e.loaded : chunk.size
          if (uploadDebug) {
            console.log('[upload-chunk] onprogress', { uploadId, partNumber, loaded, chunkSize: chunk.size, lengthComputable: e.lengthComputable })
          }
          onProgress(Math.min(chunk.size, loaded))
        }
        xhr.onreadystatechange = () => {
          if (xhr.readyState !== 4) return
          if (activeAttachXhrRef.current === xhr) activeAttachXhrRef.current = null
          if (xhr.status >= 200 && xhr.status < 300) {
            onProgress(chunk.size)
            resolve()
            return
          }
          reject(new Error(`chunk upload failed: ${xhr.status}`))
        }
        xhr.onerror = () => {
          if (activeAttachXhrRef.current === xhr) activeAttachXhrRef.current = null
          reject(new Error('chunk upload failed'))
        }
        xhr.onabort = () => {
          if (activeAttachXhrRef.current === xhr) activeAttachXhrRef.current = null
          reject(new Error('chunk upload aborted'))
        }
        if (uploadDebug) {
          console.log('[upload-chunk] send', { uploadId, partNumber, chunkSize: chunk.size })
        }
        xhr.send(chunk)
      })
      const uploadViaChunks = async (
        uploadBlob: Blob | File,
        uploadName: string,
        contentType: string,
        reportProgress: (uploadFrac: number) => void,
      ): Promise<{ url: string; path?: string }> => {
        const initController = new AbortController()
        activeAttachAbortControllerRef.current = initController
        const initResp = await api.post('/upload/init', {
          filename: uploadName,
          size: uploadBlob.size,
          contentType,
        }, { signal: initController.signal })
        activeAttachAbortControllerRef.current = null
        const uploadId = initResp?.data?.uploadId
        const chunkSize = Number(initResp?.data?.chunkSize)
        if (!uploadId || !Number.isFinite(chunkSize) || chunkSize <= 0) {
          throw new Error('chunk upload init failed')
        }
        activeAttachUploadIdRef.current = uploadId
        const totalBytes = uploadBlob.size
        const totalParts = totalBytes === 0 ? 0 : Math.ceil(totalBytes / chunkSize)
        if (uploadDebug) {
          console.log('[upload-chunk] init', { uploadId, chunkSize, totalBytes, totalParts })
        }
        let uploadedBytes = 0
        try {
          for (let partNumber = 0; partNumber < totalParts; partNumber += 1) {
            const start = partNumber * chunkSize
            const end = Math.min(totalBytes, start + chunkSize)
            const chunk = uploadBlob.slice(start, end)
            let attempt = 0
            for (;;) {
              try {
                await uploadChunkPart(uploadId, partNumber, chunk, (loaded) => {
                  const uploadFrac = totalBytes > 0 ? Math.min(1, (uploadedBytes + loaded) / totalBytes) : 1
                  reportProgress(uploadFrac)
                })
                break
              } catch (error) {
                attempt += 1
                if (attempt >= 2) throw error
                if (uploadDebug) {
                  console.log('[upload-chunk] retry', { uploadId, partNumber, attempt, error })
                }
              }
            }
            uploadedBytes += chunk.size
            const uploadFrac = totalBytes > 0 ? Math.min(1, uploadedBytes / totalBytes) : 1
            reportProgress(uploadFrac)
          }
          setAttachUploadState('processing')
          setAttachUploadSpeed('0 B/s')
          const controller = new AbortController()
          activeAttachAbortControllerRef.current = controller
          const completeResp = await api.post(`/upload/${uploadId}/complete`, undefined, { signal: controller.signal })
          activeAttachAbortControllerRef.current = null
          activeAttachUploadIdRef.current = null
          return { url: completeResp.data.url, path: completeResp.data.path }
        } catch (error) {
          activeAttachAbortControllerRef.current = null
          if (!attachCancelRequestedRef.current) {
            try {
              await api.delete(`/upload/${uploadId}`)
            } catch {}
          }
          if (activeAttachUploadIdRef.current === uploadId) activeAttachUploadIdRef.current = null
          throw error
        }
      }
      let done = 0
      for (let i = 0; i < files.length; i++) {
        const f = files[i]
        setAttachUploadState('uploading')
        const pendingAtt = pendingAttachments[i]
        const updateProgress = (percent: number) => {
          setAttachProgress(percent)
          setPendingByConv((prev) => {
            const arr = prev[activeId!] || []
            const copy = arr.map((m) => ({ ...m, attachments: m.attachments.map((a) => ({ ...a })) }))
            const last = copy[copy.length - 1]
            if (last) {
              const pext = (f.name || '').split('.').pop()?.toLowerCase() || ''
              const ptype = f.type.startsWith('image/') ? 'IMAGE' : f.type.startsWith('video/') || VIDEO_EXTS.includes(pext) ? 'VIDEO' : f.type.startsWith('audio/') || AUDIO_EXTS.includes(pext) ? 'AUDIO' : 'FILE'
              const idx = last.attachments.findIndex((a) => a.__pending && a.type === ptype && (!a.width || a.url.startsWith('blob:')))
              if (idx >= 0) last.attachments[idx].progress = percent
            }
            return { ...prev, [activeId!]: copy }
          })
        }
        const fileWeight = f.size / totalSize
        let uploadBlob: Blob | File = f
        let encryptedMeta: Record<string, any> | undefined
        if (isSecretConversation && activeConversation) {
          // read file in chunks (no simulated progress; real progress comes from XHR upload)
          const chunks: Uint8Array[] = []
          let received = 0
          const reader = f.stream().getReader()
          while (true) {
            const { done: readerDone, value } = await reader.read()
            if (readerDone) break
            chunks.push(value)
            received += value.length
          }
          const buffer = new Uint8Array(received)
          let offset = 0
          for (const c of chunks) {
            buffer.set(c, offset)
            offset += c.length
          }
          // encryption (no simulated progress)
          const encrypted = await e2eeManager.encryptBinary(activeConversation, buffer)
          uploadBlob = new Blob([encrypted.cipher as BlobPart], { type: 'application/octet-stream' })
          encryptedMeta = {
            kind: 'ciphertext',
            version: 1,
            algorithm: 'xsalsa20_poly1305',
            nonce: encrypted.nonce,
            originalName: f.name,
            originalType: f.type,
            originalSize: f.size,
          }
        }
        const uploadName = isSecretConversation ? `${f.name || 'file'}.enc` : (f.name || 'file')
        const uploadContentType = uploadBlob.type || f.type || 'application/octet-stream'
        const reportProgress = (uploadFrac: number) => {
          const uploadedBytes = done + f.size * uploadFrac
          const pct = Math.min(100, Math.round(((done + f.size * uploadFrac) / totalSize) * 100))
          if (uploadDebug) {
            console.log('[upload] reportProgress', { uploadFrac, pct, doneBytes: done, fileSize: f.size, totalBytes: totalSize })
          }
          updateAttachUploadSpeed(uploadedBytes)
          updateProgress(pct)
        }
        const { url, path: objectKey } = uploadBlob.size > CHUNK_UPLOAD_THRESHOLD
          ? await uploadViaChunks(uploadBlob, uploadName, uploadContentType, reportProgress)
          : await new Promise<{ url: string; path?: string }>((resolve, reject) => {
            const form = new FormData()
            form.append('file', uploadBlob, uploadName)
            if (f.name) form.append('originalFileName', f.name)
            try { form.append('conversationId', activeId) } catch {}
            const xhr = new XMLHttpRequest()
            activeAttachXhrRef.current = xhr
            xhr.open('POST', uploadBaseUrl)
            if (uploadDebug) {
              console.log('[upload] xhr opened', { url: uploadBaseUrl, origin: window.location.origin, blobSize: uploadBlob.size })
            }
            if (authToken) xhr.setRequestHeader('Authorization', `Bearer ${authToken}`)
            let lastProgressMs = 0
            let progressEventCount = 0
            xhr.upload.onprogress = (e) => {
              progressEventCount += 1
              const uploadTotal = uploadBlob.size
              if (uploadTotal > 0) {
                const uploadFrac = Math.min(1, e.loaded / uploadTotal)
                const now = Date.now()
                if (uploadDebug) {
                  console.log('[upload] onprogress', { loaded: e.loaded, total: uploadTotal, uploadFrac, lengthComputable: e.lengthComputable, eventNum: progressEventCount, ts: now })
                }
                if (uploadFrac >= 1 || now - lastProgressMs >= 80) {
                  lastProgressMs = now
                  reportProgress(uploadFrac)
                }
              }
            }
            xhr.onreadystatechange = () => {
              if (uploadDebug && xhr.readyState === 4) {
                console.log('[upload] readyState 4', { status: xhr.status, progressEventsReceived: progressEventCount })
              }
              if (xhr.readyState === 4) {
                if (activeAttachXhrRef.current === xhr) activeAttachXhrRef.current = null
                if (xhr.status >= 200 && xhr.status < 300) {
                  reportProgress(1)
                  try {
                    const resp = JSON.parse(xhr.responseText)
                    resolve({ url: resp.url, path: resp.path })
                  } catch (err) {
                    reject(err)
                  }
                } else reject(new Error('upload failed'))
              }
            }
            xhr.onerror = () => {
              if (activeAttachXhrRef.current === xhr) activeAttachXhrRef.current = null
              reject(new Error('upload failed'))
            }
            xhr.onabort = () => {
              if (activeAttachXhrRef.current === xhr) activeAttachXhrRef.current = null
              reject(new Error('upload aborted'))
            }
            if (uploadDebug) {
              console.log('[upload] xhr.send(form) about to send', { formDataKeys: Array.from(form.keys()), blobSize: uploadBlob.size })
            }
            xhr.send(form)
          })
        const ext = (f.name || '').split('.').pop()?.toLowerCase() || ''
        const isVideo = f.type.startsWith('video/') || VIDEO_EXTS.includes(ext)
        const isAudio = f.type.startsWith('audio/') || AUDIO_EXTS.includes(ext)
        const attachType = f.type.startsWith('image/') ? 'IMAGE' : isVideo ? 'VIDEO' : isAudio ? 'AUDIO' : 'FILE'
        const uploadItem: { url: string; type: 'IMAGE' | 'FILE' | 'VIDEO' | 'AUDIO'; size?: number; metadata?: Record<string, any> } = {
          url,
          type: attachType,
          size: f.size,
        }
        const metadataPayload: Record<string, any> = {}
        if (f.name) metadataPayload.originalName = f.name
        if (f.type) metadataPayload.mime = f.type
        if (Number.isFinite(f.size) && f.size > 0) metadataPayload.size = f.size
        if (objectKey) metadataPayload.objectKey = objectKey
        if (pendingAtt && pendingAtt.type === 'IMAGE' && pendingAtt.width && pendingAtt.height) {
          metadataPayload.width = pendingAtt.width
          metadataPayload.height = pendingAtt.height
        }
        if (encryptedMeta) {
          metadataPayload.e2ee = encryptedMeta
        }
        if (Object.keys(metadataPayload).length > 0) {
          uploadItem.metadata = metadataPayload
        }
        uploaded.push(uploadItem)
        done += f.size
        setAttachProgress(Math.round((done / totalSize) * 100))
      }
      // Send as IMAGE/VIDEO/AUDIO message when all attachments are same type, else FILE
      const msgType = uploaded.every((u) => u.type === 'IMAGE') ? 'IMAGE'
        : uploaded.every((u) => u.type === 'VIDEO') ? 'VIDEO'
        : uploaded.every((u) => u.type === 'AUDIO') ? 'AUDIO'
        : 'FILE'
      const sendController = new AbortController()
      activeAttachAbortControllerRef.current = sendController
      const replyQuoteMeta = buildReplyQuoteMetadataForSend(replyDraft)
      await api.post(
        '/conversations/send',
        {
          conversationId: activeId,
          type: msgType,
          content: textContent,
          attachments: uploaded,
          replyToId: replyDraft?.replyToId,
          ...(replyQuoteMeta ? { metadata: replyQuoteMeta } : {}),
        },
        { signal: sendController.signal },
      )
      activeAttachAbortControllerRef.current = null
      // Remove pending message after successful send
      removePendingUploadMessage(activeId, pid)
      client.invalidateQueries({ queryKey: ['messages', activeId] })
    } catch (error) {
      if (attachCancelRequestedRef.current || isUploadAbortError(error)) {
        removePendingUploadMessage(activeId, pid)
      } else {
        console.error('Failed to upload attachments', error)
      }
    } finally {
      setAttachUploadState('done')
      setAttachUploading(false)
      setAttachProgress(0)
      resetAttachUploadTracking()
      resetActiveAttachUpload()
    }
  }

  async function getImageSize(url: string): Promise<{ width: number; height: number }> {
    return new Promise((resolve) => {
      const img = new Image()
      img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight })
      img.onerror = () => resolve({ width: 320, height: 200 })
      img.src = url
    })
  }

  const startVoiceRecording = async () => {
    if (!activeId) return
    if (voiceRecording) return
    if (forwardComposerDraft) {
      systemToast.error('Сначала отправьте или отмените пересылку.')
      return
    }

    try {
      const permissionResult = await ensureMediaPermissions({ audio: true })
      if (!permissionResult.ok) {
        systemToast.error('Необходимо разрешение на использование микрофона для записи голосовых сообщений')
        return
      }

      // На всякий случай останавливаем рингтон (мог остаться активным)
      stopRingtone()

      // Сбрасываем waveform при начале новой записи
      setVoiceWaveform([])

      const recorder = new VoiceRecorder({
        onStateChange: (state) => {
          setVoiceRecording(state === 'recording')
          if (state !== 'recording') {
            // Останавливаем сбор waveform данных
            if (waveformUpdateIntervalRef.current) {
              clearInterval(waveformUpdateIntervalRef.current)
              waveformUpdateIntervalRef.current = null
            }
          }
        },
        onDurationUpdate: (duration) => {
          setVoiceDuration(duration)
        },
        onAmplitudeUpdate: (amplitude) => {
          // Обновляем waveform в реальном времени
          // Используем фиксированное количество баров (как при воспроизведении) для стабильности на мобильных
          setVoiceWaveform((prev) => {
            const maxBars = isMobile ? 60 : waveformMaxBars
            const newWaveform = [...prev, amplitude]
            // Ограничиваем до фиксированного количества баров, новые данные сдвигают старые влево
            if (newWaveform.length > maxBars) {
              return newWaveform.slice(-maxBars)
            }
            return newWaveform
          })
        },
        onError: (error) => {
          console.error('Voice recording error:', error)
          systemToast.error('Ошибка записи голосового сообщения')
          stopVoiceRecording()
        },
      })

      voiceRecorderRef.current = recorder
      await recorder.start()
    } catch (error) {
      console.error('Failed to start voice recording:', error)
      systemToast.error('Не удалось начать запись голосового сообщения')
    }
  }

  const stopVoiceRecording = () => {
    if (!voiceRecorderRef.current) return
    const recorder = voiceRecorderRef.current
    const duration = recorder.getDuration()
    const audioBlob = recorder.stop()
    voiceRecorderRef.current = null
    setVoiceRecording(false)
    setVoiceDuration(0)

    if (audioBlob && activeId) {
      sendVoiceMessage(audioBlob, duration)
    }
  }

  const cancelVoiceRecording = () => {
    if (voiceRecorderRef.current) {
      voiceRecorderRef.current.cancel()
      voiceRecorderRef.current = null
    }
    if (waveformUpdateIntervalRef.current) {
      clearInterval(waveformUpdateIntervalRef.current)
      waveformUpdateIntervalRef.current = null
    }
    setVoiceRecording(false)
    setVoiceDuration(0)
    setVoiceWaveform([])
  }

  const sendVoiceMessage = async (audioBlob: Blob, duration: number) => {
    if (!activeId) return
    if (forwardComposerDraft) {
      systemToast.error('Сначала отправьте или отмените пересылку.')
      return
    }
    const isSecretV2 = String(activeConversation?.type ?? '').toUpperCase() === 'SECRET'
    const isLegacySecretConversation = !!activeConversation?.isSecret && !isSecretV2
    const isSecretConversation = isLegacySecretConversation

    if (isSecretV2) {
      systemToast.error('Голосовые в секретных чатах пока не поддерживаются на этом устройстве.')
      return
    }

    if (isLegacySecretConversation) {
      if (conversationSecretInactive) {
        systemToast.error('Секретный чат больше не активен, отправка голосовых сообщений отключена.')
        return
      }
      if (!conversationSecretSessionReady) {
        systemToast.error('Секретный чат ещё не готов к голосовым сообщениям, подождите установления защищённой сессии.')
        return
      }
    }

    setAttachUploading(true)
    setAttachProgress(0)
    setAttachUploadState('uploading')
    setAttachCanceling(false)
    attachCancelRequestedRef.current = false
    activeAttachConversationIdRef.current = activeId
    activeAttachPendingMessageIdRef.current = null
    activeAttachUploadIdRef.current = null
    activeAttachXhrRef.current = null
    activeAttachAbortControllerRef.current = null
    beginAttachUploadTracking()
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve())
    })

    try {
      const audioFile = new File([audioBlob], 'voice-message.webm', { type: audioBlob.type || 'audio/webm' })
      let uploadBlob: Blob | File = audioFile
      let encryptedMeta: Record<string, any> | undefined

      if (isSecretConversation && activeConversation) {
        const chunks: Uint8Array[] = []
        let received = 0
        const reader = audioFile.stream().getReader()
        while (true) {
          const { done: readerDone, value } = await reader.read()
          if (readerDone) break
          chunks.push(value)
          received += value.length
        }
        const buffer = new Uint8Array(received)
        let offset = 0
        for (const c of chunks) {
          buffer.set(c, offset)
          offset += c.length
        }
        const encrypted = await e2eeManager.encryptBinary(activeConversation, buffer)
        uploadBlob = new Blob([encrypted.cipher as BlobPart], { type: 'application/octet-stream' })
        encryptedMeta = {
          kind: 'ciphertext',
          version: 1,
          algorithm: 'xsalsa20_poly1305',
          nonce: encrypted.nonce,
          originalName: audioFile.name,
          originalType: audioFile.type,
          originalSize: audioFile.size,
        }
      }

      const form = new FormData()
      form.append('file', uploadBlob, isSecretConversation ? `${audioFile.name}.enc` : audioFile.name)
      if (audioFile.name) form.append('originalFileName', audioFile.name)
      try { form.append('conversationId', activeId) } catch {}

      const url = await new Promise<string>((resolve, reject) => {
        const xhr = new XMLHttpRequest()
        activeAttachXhrRef.current = xhr
        xhr.open('POST', getUploadUrl())
        try {
          const token = useAppStore.getState().session?.accessToken
          if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`)
        } catch {}
        xhr.upload.onprogress = (e) => {
          const total = uploadBlob.size
          if (total > 0) {
            const uploadFrac = Math.min(1, e.loaded / total)
            updateAttachUploadSpeed(uploadBlob.size * uploadFrac)
            setAttachProgress(Math.min(100, Math.round(uploadFrac * 100)))
          }
        }
        xhr.onreadystatechange = () => {
          if (xhr.readyState === 4) {
            if (activeAttachXhrRef.current === xhr) activeAttachXhrRef.current = null
            if (xhr.status >= 200 && xhr.status < 300) {
              try {
                const resp = JSON.parse(xhr.responseText)
                resolve(resp.url)
              } catch (err) {
                reject(err)
              }
            } else {
              reject(new Error('upload failed'))
            }
          }
        }
        xhr.onerror = () => {
          if (activeAttachXhrRef.current === xhr) activeAttachXhrRef.current = null
          reject(new Error('upload failed'))
        }
        xhr.onabort = () => {
          if (activeAttachXhrRef.current === xhr) activeAttachXhrRef.current = null
          reject(new Error('upload aborted'))
        }
        xhr.send(form)
      })

      const audioAttachmentMeta: Record<string, any> = {
        originalName: audioFile.name,
        mime: audioFile.type || 'audio/webm',
        size: audioFile.size,
      }
      if (encryptedMeta) {
        audioAttachmentMeta.e2ee = encryptedMeta
      }

      const attachment = {
        url,
        type: 'AUDIO' as const,
        size: audioFile.size,
        metadata: audioAttachmentMeta,
      }

      // Send directly (like uploadAndSendAttachments does for attachments)
      const sendController = new AbortController()
      activeAttachAbortControllerRef.current = sendController
      const replyVoiceMeta = buildReplyQuoteMetadataForSend(replyTo)
      await api.post('/conversations/send', {
        conversationId: activeId,
        type: 'AUDIO',
        metadata: replyVoiceMeta ? { duration, ...replyVoiceMeta } : { duration },
        attachments: [attachment],
        replyToId: replyTo?.replyToId,
      }, { signal: sendController.signal })
      activeAttachAbortControllerRef.current = null

      setReplyTo(null)
      client.invalidateQueries({ queryKey: ['messages', activeId] })
    } catch (error) {
      if (!(attachCancelRequestedRef.current || isUploadAbortError(error))) {
        console.error('Failed to send voice message', error)
        systemToast.error('Не удалось отправить голосовое сообщение')
      }
    } finally {
      setAttachUploadState('done')
      setAttachUploading(false)
      setAttachProgress(0)
      resetAttachUploadTracking()
      resetActiveAttachUpload()
    }
  }

  const fwdDraftArrivedRef = useRef(false)
  const fwdDraftPrevDestRef = useRef<string | null>(null)
  useEffect(() => {
    // Reset the "arrived at destination" latch whenever a new forward draft (destination) is created.
    if (fwdDraftDestinationId !== fwdDraftPrevDestRef.current) {
      fwdDraftPrevDestRef.current = fwdDraftDestinationId
      fwdDraftArrivedRef.current = false
    }
    if (!fwdDraftDestinationId || !activeId) return
    const routeId = typeof params.conversationId === 'string' ? params.conversationId : null
    // "Arrived" requires BOTH activeId and the URL to agree on the destination (desktop carries no
    // conversation id in the URL, so routeId === null counts as arrived there).
    if (activeId === fwdDraftDestinationId && (routeId === null || routeId === fwdDraftDestinationId)) {
      fwdDraftArrivedRef.current = true
      return
    }
    // Not at the destination. Clear the draft ONLY if we had already fully arrived and then the user
    // genuinely moved to another chat. Before arrival the URL->activeId sync can briefly revert
    // activeId to the SOURCE chat (mobile), and source-activeId + source-URL momentarily look
    // "settled" — clearing then would wipe the freshly-created forward draft (the "just navigates,
    // no draft" bug).
    if (fwdDraftArrivedRef.current) {
      setForwardComposerDraft(null)
    }
  }, [activeId, params.conversationId, fwdDraftDestinationId])

  // Cleanup voice recorder on unmount
  useEffect(() => {
    return () => {
      if (voiceRecorderRef.current) {
        voiceRecorderRef.current.cleanup()
      }
    }
  }, [])

  // ping to eblusha.org (approximate)
  useEffect(() => {
    let timer: number | null = null
    const ping = async () => {
      const start = performance.now()
      try {
        await fetch('https://eblusha.org/', { mode: 'no-cors' })
        setPingMs(Math.round(performance.now() - start))
      } catch {
        setPingMs(null)
      }
    }
    ping()
    timer = window.setInterval(ping, 15000)
    return () => { if (timer) clearInterval(timer) }
  }, [])

  // poll conversations every 20s for status/lastSeen updates
  useEffect(() => {
    let t: number | null = null
    const tick = () => client.invalidateQueries({ queryKey: ['conversations'] })
    t = window.setInterval(tick, 20000)
    return () => { if (t) clearInterval(t) }
  }, [client])

  // Users participating in active *group* calls (for labeling IN_CALL as "В БЕСЕДЕ" vs "В ЗВОНКЕ").
  const groupCallParticipantIds = useMemo(() => {
    const set = new Set<string>()
    try {
      const rows = (conversationsQuery.data || []) as any[]
      const convById = new Map<string, any>()
      for (const row of rows) {
        const conv = row?.conversation
        if (conv?.id) convById.set(conv.id, conv)
      }
      for (const [cid, entry] of Object.entries(activeCalls || {})) {
        if (!entry?.active) continue
        const conv = convById.get(cid)
        const isGroup = !!(conv && (conv.isGroup || (conv.participants?.length ?? 0) > 2))
        if (!isGroup) continue
        const parts = entry.participants || []
        for (const uid of parts) set.add(uid)
      }
    } catch {
      // ignore
    }
    return set
  }, [activeCalls, conversationsQuery.data])

  function formatPresence(u: any): string {
    const status = (u?.id ? effectiveUserStatus(u) : ((u?.status as string | undefined) ?? 'OFFLINE')) as string | undefined
    const uid = typeof u?.id === 'string' ? u.id : null
    const playing = uid ? presenceGameByUserId[uid]?.game : undefined
    const last = u.lastSeenAt ? new Date(u.lastSeenAt) : null
    if (playing?.name && status === 'IN_CALL') return `В звонке и в ${playing.name}`
    if (playing?.name && (status === 'ONLINE' || status === 'BACKGROUND')) return `Играет в ${playing.name}`
    if (status === 'ONLINE') return 'В сети'
    if (status === 'BACKGROUND') return 'В фоне'
    if (status === 'IN_CALL') {
      if (uid && groupCallParticipantIds.has(uid)) return 'В беседе'
      return 'В звонке'
    }
    if (!last) return 'оффлайн'
    const now = new Date()
    const diffMs = now.getTime() - last.getTime()
    const diffMin = Math.floor(diffMs / 60000)
    if (diffMin < 1) return 'был(а) онлайн только что'
    if (diffMin < 60) return `был(а) онлайн ${diffMin} мин назад`
    const diffH = Math.floor(diffMin / 60)
    if (diffH < 24) return `был(а) онлайн ${diffH} ч назад`
    const opts: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit', hour12: false }
    const dateStr = last.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' })
    const timeStr = last.toLocaleTimeString('ru-RU', opts)
    return `был(а) онлайн ${dateStr} в ${timeStr}`
  }

  type AvatarPresence = 'ONLINE' | 'AWAY' | 'BACKGROUND' | 'OFFLINE' | 'IN_CALL' | 'PLAYING'
  const avatarPresenceForUser = useCallback((u: any): AvatarPresence => {
    const uid = typeof u?.id === 'string' ? u.id : null
    const base = effectiveUserStatus(u)
    const playing = uid ? presenceGameByUserId[uid]?.game : undefined
    // If we have game presence (TTL-backed), prefer showing PLAYING regardless of base presence.
    // This allows rendering the gamepad even when the base status is briefly stale/offline.
    if (playing?.name) return 'PLAYING'
    return base
  }, [effectiveUserStatus, presenceGameByUserId])

  const avatarPresenceForUserIdAndStatus = useCallback((userId: string | null, status: any): AvatarPresence => {
    const raw = (status ?? 'OFFLINE').toString().toUpperCase()
    const base: AvatarPresence =
      raw === 'IN_CALL' ? 'IN_CALL'
      : raw === 'ONLINE' ? 'ONLINE'
      : raw === 'BACKGROUND' ? 'BACKGROUND'
      : raw === 'AWAY' ? 'AWAY'
      : 'OFFLINE'
    const playing = userId ? presenceGameByUserId[userId]?.game : undefined
    if (playing?.name) return 'PLAYING'
    return base
  }, [presenceGameByUserId])

  function formatDuration(ms: number): string {
    const totalSec = Math.max(0, Math.floor(ms / 1000))
    const hours = Math.floor(totalSec / 3600)
    const minutes = Math.floor((totalSec % 3600) / 60)
    const seconds = totalSec % 60
    if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    return `${minutes}:${String(seconds).padStart(2, '0')}`
  }

  // ==========================================================================
  // РЕНДЕР 1/3: сайдбар со списком бесед (+ плитки «Беседа»/«Контакты», код-инвайт).
  // ==========================================================================

  // ==========================================================================
  // РЕНДЕР 2/3: открытая беседа — шапка (собеседник/звонки/меню), контейнер
  // сообщений (виртуализованные строки Eblo, пузыри, реакции, ответы/пересылки,
  // кнопка «вниз»), строка «печатает» и композер. Самый большой блок рендера.
  // ==========================================================================

  // ==========================================================================
  // РЕНДЕР 3/3: оверлей активного звонка (ленивый CallOverlay) + входящий/исходящий
  // диалоги звонка.
  // ==========================================================================

  function appendMessageToCache(conversationId: string, msg: any) {
    if (!msg) return
    client.setQueryData(['messages', conversationId], (old: any) => {
      const list = Array.isArray(old) ? [...old] : []
      if (list.some((m: any) => m.id === msg.id)) return list
      list.push(msg)
      list.sort((a: any, b: any) => new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime())
      return list
    })
  }

  function updateMessageInCache(conversationId: string, msg: any, opts?: { preserveScroll?: boolean }) {
    if (!msg) return
    const el = messagesRef.current
    const preserve = !!opts?.preserveScroll && !!el && !nearBottomRef.current
    const before = preserve && el ? { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight } : null
    client.setQueryData(['messages', conversationId], (old: any) => {
      if (!Array.isArray(old)) return old
      const idx = old.findIndex((m: any) => m.id === msg.id)
      if (idx === -1) return old
      const next = [...old]
      next[idx] = { ...next[idx], ...msg }
      return next
    })
    if (preserve && before) {
      requestAnimationFrame(() => {
        const el2 = messagesRef.current
        if (!el2) return
        const delta = el2.scrollHeight - before.scrollHeight
        if (delta > 0) {
          el2.scrollTop = before.scrollTop + delta
        }
      })
    }
  }

  function receiptStatusRank(status: string | null | undefined) {
    if (status === 'SEEN') return 3
    if (status === 'READ') return 2
    if (status === 'DELIVERED') return 1
    return 0
  }

  function applyReceiptUpdateToCache(payload: {
    conversationId: string
    messageIds: string[]
    userId?: string
    status?: 'DELIVERED' | 'READ' | 'SEEN'
    receipts?: Array<any>
  }) {
    const messageIds = Array.isArray(payload.messageIds) ? payload.messageIds.filter(Boolean) : []
    if (!payload.conversationId || messageIds.length === 0) return false

    const incomingReceipts = Array.isArray(payload.receipts)
      ? payload.receipts.filter((receipt) => receipt?.messageId && receipt?.userId && receipt?.status)
      : []
    const updates = incomingReceipts.length > 0
      ? incomingReceipts
      : (payload.userId && payload.status
          ? messageIds.map((messageId) => ({ messageId, userId: payload.userId, status: payload.status }))
          : [])

    if (updates.length === 0) return false

    const updatesByMessageId = new Map<string, any[]>()
    for (const receipt of updates) {
      const key = String(receipt.messageId)
      updatesByMessageId.set(key, [...(updatesByMessageId.get(key) || []), receipt])
    }

    let applied = false
    client.setQueryData(['messages', payload.conversationId], (old: any) => {
      if (!Array.isArray(old)) return old
      let changed = false
      const next = old.map((message: any) => {
        const perMessage = updatesByMessageId.get(String(message?.id ?? ''))
        if (!perMessage || perMessage.length === 0) return message

        let messageChanged = false
        const receipts = Array.isArray(message.receipts) ? [...message.receipts] : []
        for (const receipt of perMessage) {
          const userId = String(receipt.userId ?? '')
          const status = String(receipt.status ?? '')
          if (!userId || !status) continue

          const existingIndex = receipts.findIndex((item: any) => String(item?.userId ?? '') === userId)
          if (existingIndex === -1) {
            receipts.push({ ...receipt, messageId: message.id })
            messageChanged = true
            continue
          }

          const existing = receipts[existingIndex]
          const nextStatus = receiptStatusRank(status) >= receiptStatusRank(existing?.status)
            ? status
            : existing?.status
          const nextReceipt = { ...existing, ...receipt, messageId: message.id, status: nextStatus }
          if (
            nextReceipt.status !== existing?.status ||
            nextReceipt.id !== existing?.id ||
            nextReceipt.createdAt !== existing?.createdAt
          ) {
            receipts[existingIndex] = nextReceipt
            messageChanged = true
          }
        }

        if (!messageChanged) return message
        changed = true
        return { ...message, receipts }
      })

      if (changed) applied = true
      return changed ? next : old
    })
    return applied
  }

  const incomingCount = incomingContactsQuery.data?.length ?? 0
  const showContactsBar = incomingCount > 0 && !contactsBarDismissed
  const barStyles: React.CSSProperties = {
    minHeight: 80,
    padding: 'calc(12px + var(--safe-top, 0px)) 16px 12px',
    borderBottom: '1px solid var(--surface-border)',
    background: 'linear-gradient(180deg, var(--surface-200), var(--surface-100))',
    backdropFilter: 'blur(10px) saturate(120%)',
    boxShadow: 'var(--shadow-medium)',
  }

  // ==========================================================================
  // СБОРКА ЭКРАНА: оверлей звонка + контакт-бар + раскладка «сайдбар | беседа»
  // (мобильная и десктопная ветки вызывают renderConversationList/renderMessagesPane).
  // ==========================================================================
  // Контекст для вынесенных рендер-функций: пробрасываем нужные значения компонента.
  const convListCtx = { activeCalls, activeId, avatarPresenceForUser, callConvId, callStore, contactsQuery, convHasBottomFade, convHasTopFade, convScrollRef, conversationsQuery, currentUserId, effectiveUserStatus, formatDuration, formatPresence, incomingContactsQuery, isSocketOnline, me, meInfoQuery, minimizedCallConvId, myPresence, openContactsOverlay, openUserCard, outgoingCall, presenceGameByUserId, selectConversation, setConvMenu, setMePopupOpen, setNewGroupOpen, typingByConversationId }
  const messagesPaneCtx = { acceptSecretInvite, activeCalls, activeConversation, activeId, activePendingMessages, activeSecretQueuedCount, activeSecretUiState, addComposerFile, addComposerImage, applyComposerImageEdit, applyComposerSelectionFormat, applyWysiwygFormat, attachCanceling, attachDragDepthRef, attachDragOver, attachInputRef, attachProcessingMessageIndex, attachProgress, attachUploadSpeed, attachUploadState, attachUploading, attachmentDecryptMap, attachmentHeadInfoMap, avatarPresenceForUser, backToList, beginOutgoingCallGuard, callConvId, callPermissionError, callStore, cancelActiveAttachUpload, cancelEdit, cancelSecretInviteAsCreator, cancelVoiceRecording, clearMessageMultiSelect, client, closeComposerSelectionToolbar, composerBarRef, composerEditorRef, composerEmpty, composerFocused, composerSelectionAnchor, composerSelectionFmt, composerSelectionToolbarRef, composerSelectionToolbarStyle, contactsQuery, conversationsQuery, creatorAwaitPeerAccept, currentUserId, declineSecretInvite, deviceLinkInviteOpen, displayedMessages, ebloRange, ebloRowsRef, editBusy, editState, editingImage, editingImageId, effectiveUserStatus, endSecretModalOpen, estimateEbloRowHeight, eventHasFiles, executeForwardPayloadDelivery, failedImages, formatDuration, formatPresence, forwardComposerDraft, getComposerValue, getSelectedMessagesOrdered, groupIncomingBubbleBg, handleChatDropFiles, handleEbloRowHeightChange, hasAnySecretThreadKeys, hasOtherTrustedDevice, hashToGray, imageDimensions, insertPlainTextIntoComposer, isMobile, isNarrowHeaderButtons, leftAlignAll, loadedImages, me, messagesContentRef, messagesRef, minimizedCallConvId, multiSelectMode, nameColorForUser, nearBottomRef, nodesByMessageId, notifyTyping, olderLoading, openUserCard, outgoingCall, outgoingCallTimerRef, pendingFiles, pendingImages, playEndCallSound, presenceGameByUserId, releasePreviewUrl, removeComposerFile, removeComposerImage, replyTo, requireMediaAccess, resizeComposer, resolveAttachmentUrl, resolveFirstImageAttachmentUrl, scheduleEbloUpdate, secretBootDonePulse, secretComposerInlineError, secretEngineV2Enabled, secretInviteBusy, secretInviteForMe, secretWaitingAsCreator, selectedMessageIds, sendMessageToConversation, setActiveCalls, setActiveId, setAttachDragOver, setAvailabilityContext, setCallConvId, setCallPermissionError, setComposerEmpty, setComposerFocused, setComposerValue, setContextMenu, setDeviceLinkInviteOpen, setEditBusy, setEditState, setEditingImageId, setEndSecretModalOpen, setFailedImages, setForwardComposerDraft, setForwardModal, setGroupAvatarEditor, setHeaderMenu, setImageDimensions, setLightbox, setLinkDeviceModalOpen, setLoadedImages, setMinimizedCallConvId, setOutgoingCall, setPendingFiles, setPendingImages, setReplyTo, setShowJump, setVideoViewer, showJump, startDialingSound, startEdit, startVoiceRecording, stopDialingSound, stopTyping, stopVoiceRecording, toggleMessageMultiSelect, typingByUserId, updateComposerSelectionToolbar, uploadAndSendAttachments, userStickyScrollRef, usersById, visibleObserver, voiceDuration, voiceRecording, voiceWaveform, waveformContainerRef, waveformMaxBars }
  return (
    <>
    {renderActiveCallOverlay({ callConvId, minimizedCallConvId, conversationsQuery, activeConversation, currentUserId, me, meInfoQuery, setMinimizedCallConvId, getConversationFromCache, callStore, setCallConvId, callConvIdRef, setActiveCalls, stopRingtone, scheduleAfterMinCallDuration, clearMinCallDurationGuard, isOneToOneConversation })}
    {showContactsBar && (
      <div
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          zIndex: 214,
          marginTop: isElectron() ? 24 : 0,
          transform: contactsBarEntered ? 'translateY(0)' : 'translateY(-100%)',
          transition: 'transform 0.25s ease-out',
          display: 'flex',
          justifyContent: 'center',
        }}
      >
        <div
          style={{
            width: isMobile ? '100%' : 'auto',
            maxWidth: isMobile ? '100%' : 480,
            borderRadius: isMobile ? 0 : '0 0 12px 12px',
            ...barStyles,
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
            maxHeight: 'min(320px, 50vh)',
            overflowY: 'auto',
          }}
        >
          <div style={{ fontWeight: 900, fontSize: 14, color: 'var(--text-primary)' }}>
            Запросы в друзья ({incomingCount})
          </div>
          {incomingContactsQuery.data!.map((c: any) => (
            <div
              key={c.id}
              style={{
                display: 'flex',
                alignItems: 'flex-end',
                gap: 12,
                flex: 1,
                minHeight: 0,
              }}
            >
              <div style={{ flexShrink: 0 }}>
                <Avatar
                  name={c.friend.displayName ?? c.friend.username}
                  id={c.friend.id}
                  presence={avatarPresenceForUserIdAndStatus(c.friend.id, c.friend.status)}
                  avatarUrl={c.friend.avatarUrl ?? undefined}
                  size={44}
                />
              </div>
              <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
                <div style={{ fontWeight: 600, fontSize: 15, color: 'var(--text-primary)' }}>
                  {c.friend.displayName ?? c.friend.username}
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.2 }}>
                  хочет добавить вас в друзья
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={async () => {
                    await api.post('/contacts/respond', { contactId: c.id, action: 'reject' })
                    incomingContactsQuery.refetch()
                    contactsQuery.refetch()
                  }}
                  style={{ padding: '8px 14px' }}
                >
                  Отклонить
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={async () => {
                    await api.post('/contacts/respond', { contactId: c.id, action: 'accept' })
                    incomingContactsQuery.refetch()
                    contactsQuery.refetch()
                    conversationsQuery.refetch()
                  }}
                  style={{ padding: '8px 14px' }}
                >
                  Добавить
                </button>
              </div>
            </div>
          ))}
          <div style={{ display: 'flex', justifyContent: 'center' }}>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => setContactsBarDismissed(true)}
              aria-label="Свернуть"
              style={{ fontSize: 12, color: 'var(--text-muted)', padding: '4px 8px' }}
            >
              <ChevronUp size={14} style={{ verticalAlign: 'middle', marginRight: 4 }} />
              Свернуть
            </button>
          </div>
        </div>
      </div>
    )}
    {showAudioUnlock && (
      <div className="audio-unlock-overlay">
        <button
          type="button"
          className="audio-unlock-button"
          onClick={() => {
            // Optimistically close overlay so UX doesn't "hang" on iOS while audio loads/plays.
            setShowAudioUnlock(false)
            void performAudioUnlock().then((ok) => {
              if (!ok) {
                // If unlock didn't succeed, show the button again so user can retry.
                setShowAudioUnlock(true)
              }
            })
          }}
        >
          Войти
        </button>
        <div className="audio-unlock-hint">Включить звук сообщений и звонков</div>
      </div>
    )}
    <div className={isMobile ? 'chats-page mobile-slider' : 'chats-page'}>
      {isMobile ? (
        <div
          className="slider-inner"
          style={{ transform: `translateX(${mobileView === 'conversation' ? '-100vw' : '0'})` }}
          onTouchStart={(e) => { const t = e.touches[0]; touchStartRef.current = { x: t.clientX, y: t.clientY }; touchDeltaRef.current = 0; }}
          onTouchMove={(e) => { if (!touchStartRef.current) return; const t = e.touches[0]; touchDeltaRef.current = t.clientX - touchStartRef.current.x; }}
          onTouchEnd={() => {
            const d = touchDeltaRef.current
            touchStartRef.current = null
            if (Math.abs(d) < 50) return
            if (d < 0 && activeId) setMobileView('conversation')
            if (d > 0 && mobileView === 'conversation') backToList()
          }}
        >
          {renderConversationList(true, convListCtx)}
          {renderMessagesPane(true, messagesPaneCtx)}
        </div>
      ) : (
        <>
          {renderConversationList(false, convListCtx)}
          {renderMessagesPane(false, messagesPaneCtx)}
        </>
      )}
    </div>
    {userCardUser && (
      <div
        className="eb-no-drag"
        style={{
          position: 'fixed',
          inset: 0,
          background: 'rgba(10,12,16,0.55)',
          backdropFilter: 'blur(4px) saturate(110%)',
          display: 'flex',
          alignItems: isMobile ? 'flex-start' : 'center',
          justifyContent: 'center',
          zIndex: 95,
          padding: isMobile ? '16px 12px' : 16,
          overflowY: 'auto',
        }}
        onClick={() => setUserCardUser(null)}
      >
        <div onClick={(e) => e.stopPropagation()} style={{ animation: 'ebCardPop .18s ease' }}>
          {(() => {
            const peerId = String(userCardUser.id)
            const rows = (conversationsQuery.data || []) as any[]
            const existingDm = rows.find((r: any) => {
              const c = r?.conversation
              return c && !c.isGroup && !c.isSecret && (c.participants?.length ?? 0) === 2 && c.participants.some((p: any) => p?.user?.id === peerId)
            })
            const sharedGroups = rows.filter((r: any) => {
              const c = r?.conversation
              return c && (c.isGroup || (c.participants?.length ?? 0) > 2) && (c.participants || []).some((p: any) => p?.user?.id === peerId)
            })
            const isFriend = ((contactsQuery.data || []) as any[]).some((c: any) => c?.friend?.id === peerId)
            const outPending = ((outgoingContactsQuery.data || []) as any[]).some((c: any) => c?.friend?.id === peerId)
            const inPending = ((incomingContactsQuery.data || []) as any[]).find((c: any) => c?.friend?.id === peerId)
            const closeAll = () => { setUserCardUser(null); setContactsOpen(false) }
            const actions = [
              existingDm
                ? { key: 'goto', icon: <MessageCircle size={20} />, label: 'К БЕСЕДЕ', onClick: () => { closeAll(); selectConversation(String(existingDm.conversation.id)) } }
                : { key: 'msg', icon: <MessageCircle size={20} />, label: 'НАПИСАТЬ', onClick: async () => { closeAll(); try { const resp = await api.post('/conversations', { participantIds: [peerId], isGroup: false }); client.invalidateQueries({ queryKey: ['conversations'] }); const cid = resp.data?.conversation?.id; if (cid) selectConversation(String(cid)) } catch { systemToast.error('Не удалось открыть чат') } } },
              { key: 'secret', icon: <Lock size={20} />, label: 'СЕКРЕТНЫЙ ЧАТ', tint: '#22c55e', onClick: async () => { closeAll(); await initiateSecretChat(peerId) } },
            ]
            const openGroup = (cid: string) => { closeAll(); selectConversation(String(cid)) }
            return (
              <UserProfileCard
                user={userCardUser}
                statusText={formatPresence(userCardUser)}
                presence={avatarPresenceForUser(userCardUser)}
                inCall={effectiveUserStatus(userCardUser) === 'IN_CALL'}
                eblid={userCardUser.eblid ?? null}
                avatars={userCardUser.avatars ?? null}
                isMobile={isMobile}
                onClose={() => setUserCardUser(null)}
                actions={actions}
              >
                {!isFriend && (
                  inPending ? (
                    <button type="button" className="btn btn-primary" style={{ width: '100%' }} onClick={async () => { try { await api.post('/contacts/respond', { contactId: inPending.id, action: 'accept' }); client.invalidateQueries({ queryKey: ['contacts'] }); contactsQuery.refetch(); incomingContactsQuery.refetch(); systemToast.success('Заявка принята') } catch { systemToast.error('Не удалось') } }}>
                      Принять заявку в друзья
                    </button>
                  ) : outPending ? (
                    <div style={{ textAlign: 'center', fontSize: 13, color: 'var(--text-muted)', padding: '10px 0' }}>Запрос в друзья отправлен</div>
                  ) : (
                    <button type="button" className="btn btn-secondary" style={{ width: '100%' }} onClick={async () => { try { await api.post('/contacts/add', { userId: peerId }); await client.refetchQueries({ queryKey: ['contacts', 'outgoing'] }); systemToast.success('Запрос в друзья отправлен') } catch (e: any) { systemToast.error(e?.response?.data?.message === 'Contact already exists' ? 'Вы уже отправляли запрос' : 'Не удалось отправить запрос') } }}>
                      + Добавить в друзья
                    </button>
                  )
                )}
                {sharedGroups.length > 0 && (
                  <div style={{ marginTop: !isFriend ? 14 : 0 }}>
                    <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: 0.3, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: 8 }}>Общие беседы</div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      {sharedGroups.map((r: any) => {
                        const c = r.conversation
                        const gname = c.title ?? 'Беседа'
                        return (
                          <div key={c.id} onClick={() => openGroup(String(c.id))} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', borderRadius: 12, border: '1px solid var(--surface-border)', background: 'var(--surface-100)', cursor: 'pointer' }}
                            onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--surface-300)' }}
                            onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--surface-100)' }}>
                            <Avatar name={gname?.trim()?.charAt(0) || 'Г'} id={c.id} size={34} avatarUrl={c.avatarUrl && c.avatarUrl.trim() ? c.avatarUrl : undefined} />
                            <span style={{ fontWeight: 600, fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{gname}</span>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )}
              </UserProfileCard>
            )
          })()}
        </div>
      </div>
    )}
    {mePopupOpen && (
      <div
        className="eb-no-drag"
        style={{
          position: 'fixed',
          inset: 0,
          background: 'rgba(10,12,16,0.55)',
          backdropFilter: 'blur(4px) saturate(110%)',
          display: 'flex',
          alignItems: isMobile ? 'flex-start' : 'center',
          justifyContent: 'center',
          zIndex: 80,
          padding: isMobile ? '16px 12px' : 0,
          overflowY: isMobile ? 'auto' : undefined,
        }}
        onClick={() => setMePopupOpen(false)}
      >
        <div
          style={{
            background: 'var(--surface-200)',
            padding: isMobile ? 16 : 24,
            borderRadius: 16,
            width: isMobile ? '100%' : 440,
            maxWidth: '90vw',
            border: '1px solid var(--surface-border)',
            boxShadow: 'var(--shadow-medium)',
            maxHeight: isMobile ? 'calc(100vh - 32px)' : '90vh',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, flexShrink: 0 }}>
            <div style={{ fontWeight: 700, fontSize: 20, color: 'var(--text-primary)' }}>Профиль</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
              <button className="btn btn-icon btn-ghost" title="Изменить аватар" onClick={() => fileInputRef.current?.click()}><Pencil size={16} /></button>
              <button className="btn btn-icon btn-ghost" onClick={() => setMePopupOpen(false)}><X size={18} /></button>
            </div>
          </div>
          <div style={{ overflowY: 'auto', flex: 1, minHeight: 0, paddingRight: isMobile ? 2 : 4 }}>
          <div style={{ marginBottom: 20, borderRadius: 16, overflow: 'hidden', border: '1px solid var(--surface-border)', background: 'var(--surface-100)', paddingBottom: 16 }}>
            <UserProfileHero
              compact
              user={{
                id: me?.id ?? 'me',
                displayName: me?.displayName,
                avatarUrl: avatarPreviewUrl ?? meInfoQuery.data?.avatarUrl ?? me?.avatarUrl,
                status: (myPresence ?? (meInfoQuery.data as any)?.status ?? 'ONLINE') as any,
                bio: (meInfoQuery.data as any)?.bio,
              }}
              statusText={(() => {
                const myId = me?.id
                const g = myId ? presenceGameByUserId[myId]?.game : undefined
                if (g?.name) return `Играю в ${g.name}`
                return formatPresence({ ...(me ?? {}), status: myPresence ?? (meInfoQuery.data as any)?.status })
              })()}
              presence={avatarPresenceForUser({ ...(me ?? {}), status: myPresence ?? (meInfoQuery.data as any)?.status })}
              eblid={meInfoQuery.data?.eblid ?? ''}
              avatars={[avatarPreviewUrl ?? (meInfoQuery.data as any)?.avatarUrl ?? me?.avatarUrl, ...(((meInfoQuery.data as any)?.avatarHistory ?? []) as string[])].filter((u): u is string => typeof u === 'string' && u.length > 0)}
              canManageAvatars
              onDeleteAvatar={async (url) => { try { await api.post('/status/me/avatars/remove', { url }); meInfoQuery.refetch() } catch { systemToast.error('Не удалось удалить аватар') } }}
            />
          </div>
          <input ref={fileInputRef} type="file" accept="image/*" onChange={(e) => {
            const file = e.target.files?.[0]
            if (!file) return
            setSelectedAvatarFile(file)
            try { setAvatarPreviewUrl(URL.createObjectURL(file)) } catch {}
          }} style={{ display: 'none' }} />
          {avatarPreviewUrl && (
            <div style={{ border: '1px solid var(--surface-border)', borderRadius: 16, padding: 16, marginTop: 16, background: 'var(--surface-100)', boxShadow: '0 4px 12px rgba(0,0,0,0.1)' }}>
              <div style={{ fontSize: 14, color: 'var(--text-primary)', marginBottom: 12, fontWeight: 600 }}>Настройка аватара</div>
              <div 
                ref={editorRef}
                onWheel={(e) => {
                  e.preventDefault()
                  const delta = -e.deltaY * 0.001
                  const newScale = Math.max(0.1, Math.min(10, crop.scale * (1 + delta)))
                  const rect = editorRef.current?.getBoundingClientRect()
                  if (rect) {
                    const x = e.clientX - rect.left
                    const y = e.clientY - rect.top
                    const scaleChange = newScale / crop.scale
                    const newX = x - (x - crop.x) * scaleChange
                    const newY = y - (y - crop.y) * scaleChange
                    setCrop({ x: newX, y: newY, scale: newScale })
                  }
                }}
                  onPointerDown={(e) => {
                  if (e.pointerType === 'touch') return // Touch обрабатывается в addEventListener
                  const rect = editorRef.current?.getBoundingClientRect()
                  if (!rect) return
                  const editorWidth = rect.width
                  const editorHeight = rect.height
                  const centerX = editorWidth / 2
                  const centerY = editorHeight / 2
                  const cropSizeValue = 240
                  const radius = cropSizeValue / 2
                  const x = e.clientX - rect.left
                  const y = e.clientY - rect.top
                  
                  // Проверяем, что клик внутри круга
                  const dx = x - centerX
                  const dy = y - centerY
                  if (dx * dx + dy * dy > radius * radius) {
                    return
                  }
                  
                    try { (e.currentTarget as any).setPointerCapture?.((e as any).pointerId) } catch {}
                  const startX = e.clientX
                  const startY = e.clientY
                  const start = { ...crop }
                    const onMove = (ev: PointerEvent) => {
                      ev.preventDefault()
                    const deltaX = ev.clientX - startX
                    const deltaY = ev.clientY - startY
                    setCrop({ ...start, x: start.x + deltaX, y: start.y + deltaY })
                    }
                    const onUp = () => {
                      window.removeEventListener('pointermove', onMove as any)
                      window.removeEventListener('pointerup', onUp)
                    }
                    window.addEventListener('pointermove', onMove as any, { passive: false } as any)
                    window.addEventListener('pointerup', onUp, { passive: true } as any)
                }}
                style={{ 
                position: 'relative', 
                width: '100%', 
                height: 320, 
                background: 'var(--surface-200)', 
                overflow: 'hidden', 
                borderRadius: 12, 
                touchAction: 'none',
                border: '1px solid var(--surface-border)',
                boxShadow: 'inset 0 2px 8px rgba(0,0,0,0.1)',
                cursor: 'move'
              }}>
                <img 
                  ref={imageRef}
                  src={avatarPreviewUrl} 
                  alt="preview" 
                  style={{ 
                    position: 'absolute', 
                    left: crop.x, 
                    top: crop.y, 
                    transform: `scale(${crop.scale})`, 
                    transformOrigin: 'top left',
                    willChange: 'transform',
                    pointerEvents: 'none'
                  }} 
                  draggable={false}
                  onLoad={(e) => {
                    const img = e.currentTarget
                    const editor = editorRef.current
                    if (!editor) return
                    const editorWidth = editor.clientWidth
                    const editorHeight = editor.clientHeight
                    const cropSizeValue = 240
                    const imgWidth = img.naturalWidth
                    const imgHeight = img.naturalHeight
                    const centerX = editorWidth / 2
                    const centerY = editorHeight / 2
                    
                    // Рассчитываем масштаб, чтобы изображение максимально заполняло круг
                    const scaleX = cropSizeValue / imgWidth
                    const scaleY = cropSizeValue / imgHeight
                    const initialScale = Math.max(scaleX, scaleY) * 1.2 // 1.2 для запаса
                    
                    // Центрируем изображение относительно центра круга
                    const initialX = centerX - (imgWidth * initialScale) / 2
                    const initialY = centerY - (imgHeight * initialScale) / 2
                    
                    setCrop({ x: initialX, y: initialY, scale: initialScale })
                  }}
                />
                {/* Маска с градиентом для более плавного эффекта */}
                <div style={{ 
                  position: 'absolute', 
                  inset: 0, 
                  pointerEvents: 'none', 
                  borderRadius: '50%', 
                  boxShadow: '0 0 0 9999px rgba(0,0,0,0.65)', 
                  width: 240, 
                  height: 240, 
                  margin: 'auto',
                  border: '2px solid rgba(255,255,255,0.3)',
                  boxSizing: 'border-box'
                }} />
                {/* Сетка для лучшего позиционирования */}
                <div style={{
                  position: 'absolute',
                  inset: 0,
                  pointerEvents: 'none',
                  borderRadius: '50%',
                  width: 240,
                  height: 240,
                  margin: 'auto',
                  background: `
                    linear-gradient(to right, rgba(255,255,255,0.1) 1px, transparent 1px),
                    linear-gradient(to bottom, rgba(255,255,255,0.1) 1px, transparent 1px)
                  `,
                  backgroundSize: '60px 60px',
                  opacity: 0.5
                }} />
              </div>
              <div style={{ marginTop: 16 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                  <div style={{ fontSize: 13, color: 'var(--text-muted)', fontWeight: 500 }}>Масштаб</div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', background: 'var(--surface-200)', padding: '4px 8px', borderRadius: 6 }}>
                    {Math.round(crop.scale * 100)}%
              </div>
                </div>
                <div style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 12 }}>
                  <div style={{ fontSize: 18, color: 'var(--text-muted)', cursor: 'pointer', userSelect: 'none' }} onClick={() => setCrop((c) => ({ ...c, scale: Math.max(0.1, c.scale - 0.1) }))}>−</div>
                  <input 
                    type="range" 
                    min={0.1} 
                    max={10} 
                    step={0.05} 
                    value={crop.scale} 
                    onChange={(e) => setCrop((c) => ({ ...c, scale: parseFloat(e.target.value) }))} 
                    style={{ 
                      flex: 1, 
                      height: 6,
                      background: 'var(--surface-200)',
                      borderRadius: 3,
                      outline: 'none',
                      cursor: 'pointer'
                    }}
                  />
                  <div style={{ fontSize: 18, color: 'var(--text-muted)', cursor: 'pointer', userSelect: 'none' }} onClick={() => setCrop((c) => ({ ...c, scale: Math.min(10, c.scale + 0.1) }))}>+</div>
                </div>
                <div style={{ display: 'flex', gap: 8, marginTop: 12, fontSize: 11, color: 'var(--text-muted)' }}>
                  <div style={{ flex: 1, textAlign: 'center', padding: '6px', background: 'var(--surface-200)', borderRadius: 6 }}>
                    {isMobile ? 'Два пальца для масштаба, один для перемещения' : 'Перетащите для перемещения, колесико мыши для масштаба'}
                  </div>
                </div>
              </div>
              <canvas ref={cropCanvasRef} width={240} height={240} style={{ display: 'none' }} />
            </div>
          )}
          {selectedAvatarFile && (
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 8 }}>
              <button className="btn btn-secondary" onClick={() => { setSelectedAvatarFile(null); if (avatarPreviewUrl) URL.revokeObjectURL(avatarPreviewUrl); setAvatarPreviewUrl(null) }}>Отмена</button>
              <button className="btn btn-primary" disabled={uploadingAvatar} onClick={async () => {
                if (!selectedAvatarFile) return
                setUploadingAvatar(true)
                setUploadProgress(0)
                try {
                  let blobToSend: Blob | null = null
                  if (cropCanvasRef.current && avatarPreviewUrl) {
                    const img = await new Promise<HTMLImageElement>((resolve) => { const i = new Image(); i.onload = () => resolve(i); i.src = avatarPreviewUrl })
                    const ctx = cropCanvasRef.current.getContext('2d')!
                    const size = 240
                    ctx.clearRect(0,0,size,size)
                    ctx.save()
                    ctx.beginPath(); ctx.arc(size/2, size/2, size/2, 0, Math.PI*2); ctx.closePath(); ctx.clip()
                    const vw = editorRef.current?.clientWidth ?? 320
                    const vh = editorRef.current?.clientHeight ?? 320
                    const viewportCenter = { x: vw / 2, y: vh / 2 }
                    const viewRect = { x: viewportCenter.x - size/2, y: viewportCenter.y - size/2, w: size, h: size }
                    const srcX = (viewRect.x - crop.x) / crop.scale
                    const srcY = (viewRect.y - crop.y) / crop.scale
                    const srcW = viewRect.w / crop.scale
                    const srcH = viewRect.h / crop.scale
                    ctx.drawImage(img, srcX, srcY, srcW, srcH, 0, 0, size, size)
                    ctx.restore()
                    blobToSend = await new Promise<Blob | null>((resolve) => cropCanvasRef.current!.toBlob((b) => resolve(b), 'image/png'))
                  }
                  const form = new FormData()
                  form.append('file', blobToSend ?? selectedAvatarFile)
                    const url = await new Promise<string>((resolve, reject) => {
                    const xhr = new XMLHttpRequest()
                    xhr.open('POST', getUploadUrl())
                    try { const token = useAppStore.getState().session?.accessToken; if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`) } catch {}
                    xhr.upload.onprogress = (e) => {
                      const total = e.lengthComputable ? e.total : ((blobToSend ?? selectedAvatarFile)?.size ?? 0)
                      if (total > 0) setUploadProgress(Math.min(100, Math.round(100 * e.loaded / total)))
                    }
                    xhr.onreadystatechange = () => {
                      if (xhr.readyState === 4) {
                        if (xhr.status >= 200 && xhr.status < 300) {
                          try { const resp = JSON.parse(xhr.responseText); resolve(resp.url) } catch (err) { reject(err) }
                        } else reject(new Error('upload failed'))
                      }
                    }
                    xhr.onerror = () => reject(new Error('upload failed'))
                    xhr.send(form)
                  })
                  await api.patch('/status/me', { avatarUrl: url })
                  setSelectedAvatarFile(null)
                  if (avatarPreviewUrl) URL.revokeObjectURL(avatarPreviewUrl)
                  setAvatarPreviewUrl(null)
                  meInfoQuery.refetch()
                } catch {}
                setUploadingAvatar(false)
                setUploadMessage('Готово')
                setTimeout(() => setUploadMessage(null), 2200)
              }}>{uploadingAvatar ? 'Загрузка...' : 'Загрузить'}</button>
            </div>
          )}
          {uploadingAvatar && (
            <div style={{ height: 8, background: 'var(--surface-100)', borderRadius: 6, overflow: 'hidden', marginTop: 12 }}>
              <div style={{ width: `${uploadProgress}%`, height: '100%', background: 'var(--brand)', transition: 'width 0.2s ease' }} />
            </div>
          )}
          {uploadMessage && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, color: '#16a34a', fontSize: 14 }}>
              <CheckCircle size={16} />
              <span>{uploadMessage}</span>
            </div>
          )}

          {/* divider */}
          <div style={{ borderTop: '1px solid var(--surface-border)', marginTop: 18, paddingTop: 18 }} />

          {/* Active sessions (device list) */}
          {isMobile ? (
            <details
              style={{
                marginTop: 0,
                marginBottom: 18,
                border: '1px solid var(--surface-border)',
                borderRadius: 14,
                background: 'var(--surface-100)',
                padding: 12,
              }}
            >
              <summary
                style={{
                  cursor: 'pointer',
                  fontWeight: 800,
                  fontSize: 13,
                  color: 'var(--text-muted)',
                  letterSpacing: 0.2,
                  userSelect: 'none',
                }}
              >
                АКТИВНЫЕ СЕАНСЫ
              </summary>
              <div style={{ marginTop: 12 }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'space-between' }}>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={async () => {
                      const currentId = String(localDeviceIdForLinking ?? '').trim()
                      const others = (devicesQuery.data || [])
                        .filter((d: any) => !d?.revokedAt)
                        .filter((d: any) => String(d?.id ?? '').trim() && String(d.id).trim() !== currentId)
                      if (!others.length) return
                      const ok = await systemConfirm({
                        title: 'Отключить все другие устройства?',
                        message: 'Они будут разлогинены и перестанут получать секретные сообщения.',
                        confirmText: 'Отключить',
                        cancelText: 'Отмена',
                        danger: true,
                      })
                      if (!ok) return
                      await api.post('/devices/revoke-others')
                      devicesQuery.refetch()
                      systemToast.success('Другие устройства отключены')
                    }}
                    disabled={!localDeviceIdForLinking || (devicesQuery.data || []).filter((d: any) => !d?.revokedAt).length <= 1}
                    title="Отключить все другие устройства"
                    style={{ padding: '6px 10px', height: 32, borderRadius: 999 }}
                  >
                    <X size={14} /> Отключить все другие
                  </button>
                </div>

                <div style={{ marginTop: 10 }}>
                  {(() => {
                    const listAll = (devicesQuery.data || [])
                      .filter((d: any) => !d?.revokedAt)
                      .slice()
                      .sort((a: any, b: any) => {
                        const ta = a?.lastSeenAt ? new Date(a.lastSeenAt).getTime() : 0
                        const tb = b?.lastSeenAt ? new Date(b.lastSeenAt).getTime() : 0
                        return tb - ta
                      })
                    if (!listAll.length) {
                      return <div style={{ padding: '12px 2px', fontSize: 13, color: 'var(--text-muted)' }}>Нет устройств</div>
                    }
                    const norm = (v: any) => String(v ?? '').trim().toLowerCase()
                    const pickTs = (d: any) => {
                      const t1 = d?.lastSeenAt ? new Date(d.lastSeenAt).getTime() : 0
                      const t2 = d?.createdAt ? new Date(d.createdAt).getTime() : 0
                      return Math.max(t1, t2)
                    }
                    const grouped = new Map<string, { device: any; count: number }>()
                    for (const d of listAll) {
                      const id = String(d?.id ?? '').trim()
                      const kBase = `${norm(d?.name)}|${norm(d?.platform)}|${norm(d?.lastIp)}|${norm(d?.lastCity)}|${norm(d?.lastCountry)}`
                      const key = kBase === '||||' ? `id:${id}` : kBase
                      const prev = grouped.get(key)
                      if (!prev) {
                        grouped.set(key, { device: d, count: 1 })
                        continue
                      }
                      const nextCount = prev.count + 1
                      const keep = pickTs(d) >= pickTs(prev.device) ? d : prev.device
                      grouped.set(key, { device: keep, count: nextCount })
                    }
                    const currentId = String(localDeviceIdForLinking ?? '').trim()
                    const rows = Array.from(grouped.values()).sort((a, b) => {
                      const aCurrent = !!currentId && String(a.device?.id ?? '').trim() === currentId
                      const bCurrent = !!currentId && String(b.device?.id ?? '').trim() === currentId
                      if (aCurrent && !bCurrent) return -1
                      if (!aCurrent && bCurrent) return 1
                      return pickTs(b.device) - pickTs(a.device)
                    })
                    const iconFor = (platformRaw: any) => {
                      const p = String(platformRaw ?? '').toLowerCase()
                      if (p.includes('ios') || p.includes('iphone') || p.includes('android')) return <Smartphone size={18} />
                      if (p.includes('ipad') || p.includes('tablet')) return <Tablet size={18} />
                      return <Monitor size={18} />
                    }
                    const statusFor = (d: any) => {
                      const n = typeof d?.availablePrekeys === 'number' ? d.availablePrekeys : null
                      if (n != null && n > 0) return { text: 'Ключи готовы', color: '#86efac' }
                      return { text: 'Ключи не готовы', color: 'var(--text-muted)' }
                    }
                    return (
                      <div style={{ maxHeight: 260, overflowY: 'auto' }}>
                        {rows.map((row: any, idx: number) => {
                          const d = row.device
                          const isCurrent = !!currentId && String(d?.id ?? '').trim() === currentId
                          const status = statusFor(d)
                          const lastSeen = d?.lastSeenAt ? new Date(d.lastSeenAt).toLocaleString() : null
                          const platform = d?.platform ? String(d.platform) : '—'
                          const ip = String(d?.lastIp ?? '').trim()
                          const city = String(d?.lastCity ?? '').trim()
                          const country = String(d?.lastCountry ?? '').trim()
                          const loc = [city, country].filter(Boolean).join(', ')
                          const locIp = (loc && ip) ? `${loc} • ${ip}` : (loc || ip || '')
                          return (
                            <div
                              key={String(d?.id ?? idx)}
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'space-between',
                                gap: 12,
                                padding: '12px 2px',
                                borderBottom: idx === rows.length - 1 ? 'none' : '1px solid rgba(255,255,255,0.06)',
                                opacity: 1,
                              }}
                            >
                              <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
                                <div
                                  style={{
                                    width: 40,
                                    height: 40,
                                    borderRadius: 999,
                                    background: 'rgba(255,255,255,0.06)',
                                    border: '1px solid var(--surface-border)',
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    color: 'var(--text-primary)',
                                    flexShrink: 0,
                                  }}
                                >
                                  {iconFor(d?.platform)}
                                </div>
                                <div style={{ minWidth: 0, flex: 1 }}>
                                  <div style={{ fontWeight: 800, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, minWidth: 0 }}>
                                    <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                      {d?.name ? String(d.name) : String(d?.id ?? '')}
                                      {row?.count > 1 ? (
                                        <span style={{ marginLeft: 4, fontSize: 11, color: 'var(--text-muted)', fontWeight: 800 }}>
                                          +{Number(row.count) - 1}
                                        </span>
                                      ) : null}
                                    </span>
                                    {isCurrent ? (
                                      <span
                                        className="device-current-badge"
                                        style={{
                                          fontSize: 11,
                                          padding: '2px 8px',
                                          borderRadius: 999,
                                          border: '1px solid rgba(34,197,94,0.25)',
                                          background: 'rgba(34,197,94,0.12)',
                                          color: '#86efac',
                                          fontWeight: 800,
                                          flexShrink: 0,
                                        }}
                                        title="Это устройство"
                                      >
                                        <span className="device-current-long">Это устройство</span>
                                        <span className="device-current-short">Мы</span>
                                      </span>
                                    ) : null}
                                  </div>
                                  <div style={{ fontSize: 12, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                                    <span>{platform}</span>
                                    {locIp ? (
                                      <>
                                        <span>•</span>
                                        <span>{locIp}</span>
                                      </>
                                    ) : null}
                                    <span>•</span>
                                    <span style={{ color: status.color, fontWeight: 700 }}>{status.text}</span>
                                    {lastSeen ? (
                                      <>
                                        <span>•</span>
                                        <span>{lastSeen}</span>
                                      </>
                                    ) : null}
                                  </div>
                                </div>
                              </div>

                              <button
                                type="button"
                                className="btn btn-icon btn-ghost"
                                title={isCurrent ? 'Нельзя отключить текущее устройство' : 'Отключить'}
                                disabled={isCurrent}
                                onClick={async () => {
                                  if (isCurrent) return
                                  const ok = await systemConfirm({
                                    title: 'Отключить устройство?',
                                    message: 'Оно перестанет получать секретные сообщения и ключи.',
                                    confirmText: 'Отключить',
                                    cancelText: 'Отмена',
                                    danger: true,
                                  })
                                  if (!ok) return
                                  await api.delete(`/devices/${encodeURIComponent(String(d.id))}`)
                                  devicesQuery.refetch()
                                  systemToast.success('Устройство отключено')
                                }}
                                style={{ flexShrink: 0 }}
                              >
                                <X size={18} />
                              </button>
                            </div>
                          )
                        })}
                      </div>
                    )
                  })()}
                </div>
              </div>
            </details>
          ) : (
            <div style={{ marginTop: 0, marginBottom: 18 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
                <div style={{ fontWeight: 800, fontSize: 13, color: 'var(--text-muted)', letterSpacing: 0.2 }}>АКТИВНЫЕ СЕАНСЫ</div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={async () => {
                      const currentId = String(localDeviceIdForLinking ?? '').trim()
                      const others = (devicesQuery.data || [])
                        .filter((d: any) => !d?.revokedAt)
                        .filter((d: any) => String(d?.id ?? '').trim() && String(d.id).trim() !== currentId)
                      if (!others.length) return
                      const ok = await systemConfirm({
                        title: 'Отключить все другие устройства?',
                        message: 'Они будут разлогинены и перестанут получать секретные сообщения.',
                        confirmText: 'Отключить',
                        cancelText: 'Отмена',
                        danger: true,
                      })
                      if (!ok) return
                      await api.post('/devices/revoke-others')
                      devicesQuery.refetch()
                      systemToast.success('Другие устройства отключены')
                    }}
                    disabled={!localDeviceIdForLinking || (devicesQuery.data || []).filter((d: any) => !d?.revokedAt).length <= 1}
                    title="Отключить все другие устройства"
                    style={{ padding: '6px 10px', height: 32, borderRadius: 999 }}
                  >
                    <X size={14} /> Отключить все другие
                  </button>
                </div>
              </div>

              <div
                style={{
                  border: '1px solid var(--surface-border)',
                  borderRadius: 14,
                  background: 'var(--surface-100)',
                  overflow: 'hidden',
                }}
              >
                {(() => {
                  const listAll = (devicesQuery.data || [])
                    .filter((d: any) => !d?.revokedAt)
                    .slice()
                    .sort((a: any, b: any) => {
                      const ta = a?.lastSeenAt ? new Date(a.lastSeenAt).getTime() : 0
                      const tb = b?.lastSeenAt ? new Date(b.lastSeenAt).getTime() : 0
                      return tb - ta
                    })
                  if (!listAll.length) {
                    return (
                      <div style={{ padding: '12px 14px', fontSize: 13, color: 'var(--text-muted)' }}>
                        Нет устройств
                      </div>
                    )
                  }
                  const norm = (v: any) => String(v ?? '').trim().toLowerCase()
                  const pickTs = (d: any) => {
                    const t1 = d?.lastSeenAt ? new Date(d.lastSeenAt).getTime() : 0
                    const t2 = d?.createdAt ? new Date(d.createdAt).getTime() : 0
                    return Math.max(t1, t2)
                  }
                  const grouped = new Map<string, { device: any; count: number }>()
                  for (const d of listAll) {
                    const id = String(d?.id ?? '').trim()
                    const kBase = `${norm(d?.name)}|${norm(d?.platform)}|${norm(d?.lastIp)}|${norm(d?.lastCity)}|${norm(d?.lastCountry)}`
                    const key = kBase === '||||' ? `id:${id}` : kBase
                    const prev = grouped.get(key)
                    if (!prev) {
                      grouped.set(key, { device: d, count: 1 })
                      continue
                    }
                    const nextCount = prev.count + 1
                    const keep = pickTs(d) >= pickTs(prev.device) ? d : prev.device
                    grouped.set(key, { device: keep, count: nextCount })
                  }
                  const currentId = String(localDeviceIdForLinking ?? '').trim()
                  const rows = Array.from(grouped.values()).sort((a, b) => {
                    const aCurrent = !!currentId && String(a.device?.id ?? '').trim() === currentId
                    const bCurrent = !!currentId && String(b.device?.id ?? '').trim() === currentId
                    if (aCurrent && !bCurrent) return -1
                    if (!aCurrent && bCurrent) return 1
                    return pickTs(b.device) - pickTs(a.device)
                  })
                  const iconFor = (platformRaw: any) => {
                    const p = String(platformRaw ?? '').toLowerCase()
                    if (p.includes('ios') || p.includes('iphone') || p.includes('android')) return <Smartphone size={18} />
                    if (p.includes('ipad') || p.includes('tablet')) return <Tablet size={18} />
                    return <Monitor size={18} />
                  }
                  const statusFor = (d: any) => {
                    const n = typeof d?.availablePrekeys === 'number' ? d.availablePrekeys : null
                    if (n != null && n > 0) return { text: 'Ключи готовы', color: '#86efac' }
                    return { text: 'Ключи не готовы', color: 'var(--text-muted)' }
                  }
                  return (
                    <div style={{ maxHeight: 320, overflowY: 'auto' }}>
                      {rows.map((row: any, idx: number) => {
                        const d = row.device
                        const isCurrent = !!currentId && String(d?.id ?? '').trim() === currentId
                        const status = statusFor(d)
                        const lastSeen = d?.lastSeenAt ? new Date(d.lastSeenAt).toLocaleString() : null
                        const platform = d?.platform ? String(d.platform) : '—'
                        const ip = String(d?.lastIp ?? '').trim()
                        const city = String(d?.lastCity ?? '').trim()
                        const country = String(d?.lastCountry ?? '').trim()
                        const loc = [city, country].filter(Boolean).join(', ')
                        const locIp = (loc && ip) ? `${loc} • ${ip}` : (loc || ip || '')
                        return (
                          <div
                            key={String(d?.id ?? idx)}
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'space-between',
                              gap: 12,
                              padding: '12px 14px',
                              borderBottom: idx === rows.length - 1 ? 'none' : '1px solid var(--surface-border)',
                              opacity: 1,
                            }}
                          >
                            <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
                              <div
                                style={{
                                  width: 40,
                                  height: 40,
                                  borderRadius: 999,
                                  background: 'rgba(255,255,255,0.06)',
                                  border: '1px solid var(--surface-border)',
                                  display: 'flex',
                                  alignItems: 'center',
                                  justifyContent: 'center',
                                  color: 'var(--text-primary)',
                                  flexShrink: 0,
                                }}
                              >
                                {iconFor(d?.platform)}
                              </div>
                              <div style={{ minWidth: 0, flex: 1 }}>
                                <div style={{ fontWeight: 800, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, minWidth: 0 }}>
                                  <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                    {d?.name ? String(d.name) : String(d?.id ?? '')}
                                    {row?.count > 1 ? (
                                      <span style={{ marginLeft: 4, fontSize: 11, color: 'var(--text-muted)', fontWeight: 800 }}>
                                        +{Number(row.count) - 1}
                                      </span>
                                    ) : null}
                                  </span>
                                  {isCurrent ? (
                                    <span
                                      className="device-current-badge"
                                      style={{
                                        fontSize: 11,
                                        padding: '2px 8px',
                                        borderRadius: 999,
                                        border: '1px solid rgba(34,197,94,0.25)',
                                        background: 'rgba(34,197,94,0.12)',
                                        color: '#86efac',
                                        fontWeight: 800,
                                        flexShrink: 0,
                                      }}
                                      title="Это устройство"
                                    >
                                      <span className="device-current-long">Это устройство</span>
                                      <span className="device-current-short">Мы</span>
                                    </span>
                                  ) : null}
                                </div>
                                <div style={{ fontSize: 12, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                                  <span>{platform}</span>
                                  {locIp ? (
                                    <>
                                      <span>•</span>
                                      <span>{locIp}</span>
                                    </>
                                  ) : null}
                                  <span>•</span>
                                  <span style={{ color: status.color, fontWeight: 700 }}>{status.text}</span>
                                  {lastSeen ? (
                                    <>
                                      <span>•</span>
                                      <span>{lastSeen}</span>
                                    </>
                                  ) : null}
                                </div>
                              </div>
                            </div>

                            <button
                              type="button"
                              className="btn btn-icon btn-ghost"
                              title={isCurrent ? 'Нельзя отключить текущее устройство' : 'Отключить'}
                              disabled={isCurrent}
                              onClick={async () => {
                                if (isCurrent) return
                                const ok = await systemConfirm({
                                  title: 'Отключить устройство?',
                                  message: 'Оно перестанет получать секретные сообщения и ключи.',
                                  confirmText: 'Отключить',
                                  cancelText: 'Отмена',
                                  danger: true,
                                })
                                if (!ok) return
                                await api.delete(`/devices/${encodeURIComponent(String(d.id))}`)
                                devicesQuery.refetch()
                                systemToast.success('Устройство отключено')
                              }}
                              style={{ flexShrink: 0 }}
                            >
                              <X size={18} />
                            </button>
                          </div>
                        )
                      })}
                    </div>
                  )
                })()}
              </div>
            </div>
          )}

          <div style={{ borderTop: '1px solid var(--surface-border)', marginTop: 24, paddingTop: 20 }}>
            <button 
              className="btn btn-secondary" 
              onClick={async () => {
                // Best-effort: revoke this device server-side, then wipe all local device material and logout.
                try {
                  const did = getStoredDeviceInfo()?.deviceId
                  if (did) {
                    await api.delete(`/devices/${encodeURIComponent(String(did))}`)
                  }
                } catch {}
                try {
                  const refreshToken = useAppStore.getState().session?.refreshToken
                  await api.post('/auth/logout', refreshToken ? { refreshToken } : undefined)
                } catch {
                  // Ignore errors during logout
                }
                wipeLocalDeviceData()
                useAppStore.getState().setSession(null)
                setMePopupOpen(false)
              }}
              style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, color: '#f87171' }}
            >
              <LogOut size={18} />
              <span>Выйти из Еблуши</span>
            </button>
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
            <button className="btn btn-ghost" onClick={() => setMePopupOpen(false)}>Закрыть</button>
          </div>
          </div>
        </div>
      </div>
    )}
    {newGroupAvatarEditorOpen && (
      <div
        className="eb-no-drag"
        style={{
          position: 'fixed',
          inset: 0,
          background: 'rgba(10,12,16,0.55)',
          backdropFilter: 'blur(4px) saturate(110%)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 85,
        }}
        onClick={() => setNewGroupAvatarEditorOpen(false)}
      >
        <div
          style={{
            background: 'var(--surface-200)',
            padding: 24,
            borderRadius: 16,
            width: 440,
            maxWidth: '90vw',
            border: '1px solid var(--surface-border)',
            boxShadow: 'var(--shadow-medium)',
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: 20,
            }}
          >
            <div style={{ fontWeight: 700, fontSize: 20, color: 'var(--text-primary)' }}>Аватар группы</div>
            <button className="btn btn-icon btn-ghost" onClick={() => setNewGroupAvatarEditorOpen(false)}>
              <X size={18} />
            </button>
          </div>

          <div style={{ display: 'flex', gap: 12, marginBottom: 20, alignItems: 'center' }}>
            <Avatar
              name={groupTitle.trim() || '?'}
              id="new-group-avatar-preview"
              avatarUrl={newGroupAvatarPreviewUrl ?? undefined}
              size={60}
            />
            <div>
              <div style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{groupTitle || 'Новая группа'}</div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Нажмите, чтобы изменить аватар</div>
            </div>
          </div>

          <input
            ref={newGroupFileInputRef}
            type="file"
            accept="image/*"
            style={{ display: 'none' }}
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (!file) return
              setNewGroupAvatarFile(file)
              if (newGroupAvatarSourceUrl) {
                try {
                  URL.revokeObjectURL(newGroupAvatarSourceUrl)
                } catch {
                  // ignore
                }
              }
              try {
                const url = URL.createObjectURL(file)
                setNewGroupAvatarSourceUrl(url)
              } catch {
                setNewGroupAvatarSourceUrl(null)
              }
              setNewGroupCrop({ x: 0, y: 0, scale: 1 })
            }}
          />

          {!newGroupAvatarSourceUrl && (
            <>
              <div
                onClick={() => newGroupFileInputRef.current?.click()}
                onDragOver={(e) => {
                  e.preventDefault()
                  setNewGroupDragOver(true)
                }}
                onDragLeave={() => setNewGroupDragOver(false)}
                onDrop={(e) => {
                  e.preventDefault()
                  setNewGroupDragOver(false)
                  const file = e.dataTransfer.files?.[0]
                  if (file) {
                    setNewGroupAvatarFile(file)
                    if (newGroupAvatarSourceUrl) {
                      try {
                        URL.revokeObjectURL(newGroupAvatarSourceUrl)
                      } catch {
                        // ignore
                      }
                    }
                    try {
                      const url = URL.createObjectURL(file)
                      setNewGroupAvatarSourceUrl(url)
                    } catch {
                      setNewGroupAvatarSourceUrl(null)
                    }
                    setNewGroupCrop({ x: 0, y: 0, scale: 1 })
                  }
                }}
                style={{
                  border: '2px dashed ' + (newGroupDragOver ? 'var(--brand-600)' : 'var(--surface-border)'),
                  borderRadius: 12,
                  padding: 20,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 10,
                  cursor: 'pointer',
                  background: newGroupDragOver ? 'rgba(217,119,6,0.1)' : 'var(--surface-100)',
                  transition: 'all .2s ease',
                  marginBottom: 16,
                }}
              >
                <UploadCloud size={18} color="var(--text-muted)" />
                <div style={{ color: 'var(--text-muted)', fontSize: 14 }}>
                  Перетащите файл сюда или нажмите, чтобы выбрать
                </div>
              </div>
            </>
          )}

          {newGroupAvatarSourceUrl && (
            <div
              style={{
                border: '1px solid var(--surface-border)',
                borderRadius: 16,
                padding: 16,
                marginTop: 16,
                background: 'var(--surface-100)',
                boxShadow: '0 4px 12px rgba(0,0,0,0.1)',
              }}
            >
              <div style={{ fontSize: 14, color: 'var(--text-primary)', marginBottom: 12, fontWeight: 600 }}>
                Настройка аватара
              </div>
              <div
                ref={newGroupEditorRef}
                onWheel={(e) => {
                  e.preventDefault()
                  const delta = -e.deltaY * 0.001
                  const newScale = Math.max(0.1, Math.min(10, newGroupCrop.scale * (1 + delta)))
                  const rect = newGroupEditorRef.current?.getBoundingClientRect()
                  if (rect) {
                    const x = e.clientX - rect.left
                    const y = e.clientY - rect.top
                    const scaleChange = newScale / newGroupCrop.scale
                    const newX = x - (x - newGroupCrop.x) * scaleChange
                    const newY = y - (y - newGroupCrop.y) * scaleChange
                    setNewGroupCrop({ x: newX, y: newY, scale: newScale })
                  }
                }}
                onPointerDown={(e) => {
                  if (e.pointerType === 'touch') return
                  const rect = newGroupEditorRef.current?.getBoundingClientRect()
                  if (!rect) return
                  const editorWidth = rect.width
                  const editorHeight = rect.height
                  const centerX = editorWidth / 2
                  const centerY = editorHeight / 2
                  const cropSizeValue = 240
                  const radius = cropSizeValue / 2
                  const x = e.clientX - rect.left
                  const y = e.clientY - rect.top
                  const dx = x - centerX
                  const dy = y - centerY
                  if (dx * dx + dy * dy > radius * radius) {
                    return
                  }
                  try {
                    ;(e.currentTarget as any).setPointerCapture?.((e as any).pointerId)
                  } catch {
                    // ignore
                  }
                  const startX = e.clientX
                  const startY = e.clientY
                  const start = { ...newGroupCrop }
                  const onMove = (ev: PointerEvent) => {
                    ev.preventDefault()
                    const deltaX = ev.clientX - startX
                    const deltaY = ev.clientY - startY
                    setNewGroupCrop({ ...start, x: start.x + deltaX, y: start.y + deltaY })
                  }
                  const onUp = () => {
                    window.removeEventListener('pointermove', onMove as any)
                    window.removeEventListener('pointerup', onUp)
                  }
                  window.addEventListener('pointermove', onMove as any, { passive: false } as any)
                  window.addEventListener('pointerup', onUp, { passive: true } as any)
                }}
                style={{
                  position: 'relative',
                  width: '100%',
                  height: 320,
                  background: 'var(--surface-200)',
                  overflow: 'hidden',
                  borderRadius: 12,
                  touchAction: 'none',
                  border: '1px solid var(--surface-border)',
                  boxShadow: 'inset 0 2px 8px rgba(0,0,0,0.1)',
                  cursor: 'move',
                }}
              >
                <img
                  ref={newGroupImageRef}
                  src={newGroupAvatarSourceUrl}
                  alt="preview"
                  style={{
                    position: 'absolute',
                    left: newGroupCrop.x,
                    top: newGroupCrop.y,
                    transform: `scale(${newGroupCrop.scale})`,
                    transformOrigin: 'top left',
                    willChange: 'transform',
                    pointerEvents: 'none',
                  }}
                  draggable={false}
                  onLoad={(e) => {
                    const img = e.currentTarget
                    const editor = newGroupEditorRef.current
                    if (!editor) return
                    const editorWidth = editor.clientWidth
                    const editorHeight = editor.clientHeight
                    const cropSizeValue = 240
                    const imgWidth = img.naturalWidth
                    const imgHeight = img.naturalHeight
                    const centerX = editorWidth / 2
                    const centerY = editorHeight / 2
                    const scaleX = cropSizeValue / imgWidth
                    const scaleY = cropSizeValue / imgHeight
                    const initialScale = Math.max(scaleX, scaleY) * 1.2
                    const initialX = centerX - (imgWidth * initialScale) / 2
                    const initialY = centerY - (imgHeight * initialScale) / 2
                    setNewGroupCrop({ x: initialX, y: initialY, scale: initialScale })
                  }}
                />
                <div
                  style={{
                    position: 'absolute',
                    inset: 0,
                    pointerEvents: 'none',
                    borderRadius: '50%',
                    boxShadow: '0 0 0 9999px rgba(0,0,0,0.65)',
                    width: 240,
                    height: 240,
                    margin: 'auto',
                    border: '2px solid rgba(255,255,255,0.3)',
                    boxSizing: 'border-box',
                  }}
                />
                <div
                  style={{
                    position: 'absolute',
                    inset: 0,
                    pointerEvents: 'none',
                    borderRadius: '50%',
                    width: 240,
                    height: 240,
                    margin: 'auto',
                    background: `
                      radial-gradient(circle at center, transparent 55%, rgba(17,24,39,0.9) 60%),
                      linear-gradient(to right, rgba(255,255,255,0.1) 1px, transparent 1px),
                      linear-gradient(to bottom, rgba(255,255,255,0.1) 1px, transparent 1px)
                    `,
                    backgroundSize: '100% 100%, 16px 16px, 16px 16px',
                    mixBlendMode: 'soft-light',
                  }}
                />
              </div>

              <div style={{ marginTop: 16 }}>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 6 }}>Масштаб</div>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                  }}
                >
                  <div
                    style={{
                      fontSize: 18,
                      color: 'var(--text-muted)',
                      cursor: 'pointer',
                      userSelect: 'none',
                    }}
                    onClick={() =>
                      setNewGroupCrop((c) => ({
                        ...c,
                        scale: Math.max(0.1, c.scale - 0.1),
                      }))
                    }
                  >
                    −
                  </div>
                  <input
                    type="range"
                    min={0.1}
                    max={4}
                    step={0.01}
                    value={newGroupCrop.scale}
                    onChange={(e) => {
                      const next = parseFloat(e.target.value)
                      const rect = newGroupEditorRef.current?.getBoundingClientRect()
                      if (!rect) {
                        setNewGroupCrop((c) => ({ ...c, scale: next }))
                        return
                      }
                      const centerX = rect.width / 2
                      const centerY = rect.height / 2
                      const scaleChange = next / newGroupCrop.scale
                      const newX = centerX - (centerX - newGroupCrop.x) * scaleChange
                      const newY = centerY - (centerY - newGroupCrop.y) * scaleChange
                      setNewGroupCrop({ x: newX, y: newY, scale: next })
                    }}
                    style={{
                      flex: 1,
                      height: 6,
                      background: 'var(--surface-200)',
                      borderRadius: 3,
                      outline: 'none',
                      cursor: 'pointer',
                    }}
                  />
                  <div
                    style={{
                      fontSize: 18,
                      color: 'var(--text-muted)',
                      cursor: 'pointer',
                      userSelect: 'none',
                    }}
                    onClick={() =>
                      setNewGroupCrop((c) => ({
                        ...c,
                        scale: Math.min(10, c.scale + 0.1),
                      }))
                    }
                  >
                    +
                  </div>
                </div>
              </div>

              <canvas
                ref={newGroupCropCanvasRef}
                width={240}
                height={240}
                style={{ display: 'none' }}
              />
            </div>
          )}

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
            <button
              className="btn btn-ghost"
              onClick={() => {
                setNewGroupAvatarEditorOpen(false)
              }}
            >
              Отмена
            </button>
            <button
              className="btn btn-primary"
              disabled={!newGroupAvatarSourceUrl}
              onClick={async () => {
                if (!newGroupAvatarSourceUrl || !newGroupCropCanvasRef.current) {
                  setNewGroupAvatarEditorOpen(false)
                  return
                }
                try {
                  const img = await new Promise<HTMLImageElement>((resolve) => {
                    const i = new Image()
                    i.onload = () => resolve(i)
                    i.src = newGroupAvatarSourceUrl
                  })
                  const canvas = newGroupCropCanvasRef.current
                  const ctx = canvas.getContext('2d')
                  if (!ctx) throw new Error('Could not get 2d context')
                  const size = 240
                  ctx.clearRect(0, 0, size, size)
                  ctx.save()
                  ctx.beginPath()
                  ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2)
                  ctx.closePath()
                  ctx.clip()
                  const vw = newGroupEditorRef.current?.clientWidth ?? 320
                  const vh = newGroupEditorRef.current?.clientHeight ?? 320
                  const viewportCenter = { x: vw / 2, y: vh / 2 }
                  const viewRect = {
                    x: viewportCenter.x - size / 2,
                    y: viewportCenter.y - size / 2,
                    w: size,
                    h: size,
                  }
                  const srcX = (viewRect.x - newGroupCrop.x) / newGroupCrop.scale
                  const srcY = (viewRect.y - newGroupCrop.y) / newGroupCrop.scale
                  const srcW = viewRect.w / newGroupCrop.scale
                  const srcH = viewRect.h / newGroupCrop.scale
                  ctx.drawImage(img, srcX, srcY, srcW, srcH, 0, 0, size, size)
                  ctx.restore()
                  const blob = await new Promise<Blob | null>((resolve) =>
                    canvas.toBlob((b) => resolve(b), 'image/png'),
                  )
                  if (blob) {
                    if (newGroupAvatarPreviewUrl) {
                      try {
                        URL.revokeObjectURL(newGroupAvatarPreviewUrl)
                      } catch {
                        // ignore
                      }
                    }
                    const url = URL.createObjectURL(blob)
                    setNewGroupAvatarBlob(blob)
                    setNewGroupAvatarPreviewUrl(url)
                  }
                } catch {
                  // ignore errors, just close
                } finally {
                  setNewGroupAvatarEditorOpen(false)
                }
              }}
            >
              Сохранить
            </button>
          </div>
        </div>
      </div>
    )}

    {newGroupOpen && (
      <div
        style={{
          position: 'fixed',
          inset: 0,
          background: 'rgba(5,6,9,0.7)',
          backdropFilter: 'blur(8px) saturate(120%)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 60,
          padding: 16,
          boxSizing: 'border-box',
        }}
        onClick={closeNewGroupModal}
      >
        <div
          style={{
            background: 'linear-gradient(180deg, var(--surface-200) 0%, var(--surface-300) 100%)',
            padding: 0,
            borderRadius: 20,
            width: '100%',
            maxWidth: 480,
            border: '1px solid var(--surface-border)',
            boxShadow: 'var(--shadow-soft), 0 0 0 1px rgba(255,255,255,0.04) inset',
            overflow: 'hidden',
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div
            style={{
              padding: '20px 24px',
              borderBottom: '1px solid var(--surface-border)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 12,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div
                style={{
                  width: 44,
                  height: 44,
                  borderRadius: 14,
                  background: 'linear-gradient(135deg, var(--brand-600), var(--brand-700))',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  boxShadow: '0 4px 12px rgba(227,139,10,0.35)',
                }}
              >
                <Users size={24} color="#fff" strokeWidth={2.5} />
              </div>
              <div>
                <div style={{ fontWeight: 700, fontSize: 18, color: 'var(--text-primary)', letterSpacing: '-0.02em' }}>
                  Создать беседу
                </div>
                <div style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 2 }}>
                  Добавьте участников и название
                </div>
              </div>
            </div>
            <button
              className="btn btn-icon btn-ghost"
              onClick={closeNewGroupModal}
              style={{ flexShrink: 0, borderRadius: 10 }}
              title="Закрыть"
            >
              <X size={20} />
            </button>
          </div>

          {/* Body */}
          <div style={{ padding: '20px 24px', maxHeight: 'calc(100vh - 220px)', overflow: 'auto' }}>
            {(() => {
              const trimmedTitle = groupTitle.trim()
              const avatarName = trimmedTitle ? trimmedTitle : '?'
              return (
                <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 24 }}>
                  <input
                    ref={newGroupFileInputRef}
                    type="file"
                    accept="image/*"
                    style={{ display: 'none' }}
                    onChange={(e) => {
                      const file = e.target.files?.[0]
                      if (!file) return
                      setNewGroupAvatarFile(file)
                      if (newGroupAvatarSourceUrl) {
                        try {
                          URL.revokeObjectURL(newGroupAvatarSourceUrl)
                        } catch {
                          // ignore
                        }
                      }
                      try {
                        const url = URL.createObjectURL(file)
                        setNewGroupAvatarSourceUrl(url)
                      } catch {
                        setNewGroupAvatarSourceUrl(null)
                      }
                      setNewGroupAvatarEditorOpen(true)
                    }}
                  />
                  <button
                    type="button"
                    className="btn btn-icon btn-ghost"
                    onClick={() => setNewGroupAvatarEditorOpen(true)}
                    title="Выбрать аватар группы"
                    onMouseEnter={() => setNewGroupAvatarHover(true)}
                    onMouseLeave={() => setNewGroupAvatarHover(false)}
                    style={{
                      borderRadius: '50%',
                      padding: 0,
                      width: 64,
                      height: 64,
                      flexShrink: 0,
                      position: 'relative',
                      overflow: 'hidden',
                      border: `2px solid ${newGroupAvatarHover ? 'var(--brand-600)' : 'var(--surface-border)'}`,
                      boxShadow: newGroupAvatarHover ? '0 0 0 4px rgba(227,139,10,0.15)' : 'none',
                      transition: 'border-color 0.2s, box-shadow 0.2s',
                    }}
                  >
                    <Avatar
                      name={avatarName}
                      id="new-group-avatar"
                      avatarUrl={newGroupAvatarPreviewUrl ?? undefined}
                      size={60}
                    />
                    <div
                      style={{
                        position: 'absolute',
                        inset: 0,
                        background: 'rgba(0,0,0,0.5)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        opacity: newGroupAvatarHover ? 1 : 0,
                        transition: 'opacity 0.2s',
                        pointerEvents: 'none',
                      }}
                    >
                      <ImagePlus size={24} color="#fff" strokeWidth={2.5} />
                    </div>
                  </button>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <label style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 500, marginBottom: 6, display: 'block' }}>
                      Название группы
                    </label>
                    <input
                      placeholder="Например: Семья, Коллеги..."
                      value={groupTitle}
                      onChange={(e) => setGroupTitle(e.target.value)}
                      style={{
                        width: '100%',
                        padding: '12px 16px',
                        borderRadius: 12,
                        border: '1px solid var(--surface-border)',
                        background: 'var(--surface-100)',
                        color: 'var(--text-primary)',
                        fontSize: 15,
                        outline: 'none',
                        transition: 'border-color 0.2s, box-shadow 0.2s',
                      }}
                      onFocus={(e) => {
                        e.currentTarget.style.borderColor = 'var(--brand-600)'
                        e.currentTarget.style.boxShadow = '0 0 0 3px rgba(227,139,10,0.18)'
                      }}
                      onBlur={(e) => {
                        e.currentTarget.style.borderColor = 'var(--surface-border)'
                        e.currentTarget.style.boxShadow = 'none'
                      }}
                    />
                  </div>
                </div>
              )
            })()}

            <div style={{ marginBottom: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                <div style={{ fontSize: 13, color: 'var(--text-muted)', fontWeight: 600 }}>
                  Участники
                </div>
                {selectedIds.length > 0 && (
                  <span style={{ fontSize: 12, color: 'var(--brand-600)', fontWeight: 600 }}>
                    Выбрано: {selectedIds.length}
                  </span>
                )}
              </div>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fill, minmax(100px, 1fr))',
                  gap: 10,
                  maxHeight: 200,
                  overflow: 'auto',
                  paddingRight: 4,
                }}
              >
                {(!contactsQuery.data || contactsQuery.data.length === 0) ? (
                  <div style={{ gridColumn: '1 / -1', padding: 24, textAlign: 'center', color: 'var(--text-muted)', fontSize: 14 }}>
                    Нет контактов. Добавьте друзей в разделе «Контакты», чтобы создать группу.
                  </div>
                ) : (
                contactsQuery.data?.map((c: any) => {
                  const u = c.friend
                  const checked = selectedIds.includes(u.id)
                  return (
                    <div
                      key={c.id}
                      onClick={() =>
                        setSelectedIds((prev) => (checked ? prev.filter((id) => id !== u.id) : [...prev, u.id]))
                      }
                      style={{
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'center',
                        padding: '14px 10px',
                        borderRadius: 12,
                        cursor: 'pointer',
                        background: checked ? 'rgba(227,139,10,0.12)' : 'var(--surface-100)',
                        border: `1px solid ${checked ? 'rgba(227,139,10,0.4)' : 'var(--surface-border)'}`,
                        transition: 'all 0.18s ease',
                        position: 'relative',
                        minHeight: 88,
                      }}
                      onMouseEnter={(e) => {
                        if (!checked) {
                          e.currentTarget.style.background = 'var(--surface-200)'
                          e.currentTarget.style.borderColor = 'var(--surface-border-strong)'
                        }
                      }}
                      onMouseLeave={(e) => {
                        if (!checked) {
                          e.currentTarget.style.background = 'var(--surface-100)'
                          e.currentTarget.style.borderColor = 'var(--surface-border)'
                        }
                      }}
                    >
                      {checked && (
                        <div
                          style={{
                            position: 'absolute',
                            top: 8,
                            right: 8,
                            width: 20,
                            height: 20,
                            borderRadius: 10,
                            background: 'var(--brand-600)',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                          }}
                        >
                          <CheckCircle size={12} color="#fff" strokeWidth={3} />
                        </div>
                      )}
                      <Avatar
                        name={u.displayName ?? u.username}
                        id={u.id}
                        presence={avatarPresenceForUser(u)}
                        avatarUrl={u.avatarUrl ?? undefined}
                        size={44}
                      />
                      <div
                        style={{
                          marginTop: 8,
                          fontSize: 12,
                          fontWeight: 600,
                          color: 'var(--text-primary)',
                          textAlign: 'center',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                          width: '100%',
                        }}
                      >
                        {u.displayName ?? u.username}
                      </div>
                    </div>
                  )
                })
                )}
              </div>
            </div>
          </div>

          {/* Footer */}
          <div
            style={{
              padding: '16px 24px 20px',
              borderTop: '1px solid var(--surface-border)',
              background: 'var(--surface-200)',
            }}
          >
            <button
              className="btn btn-primary"
              disabled={selectedIds.length === 0 || creatingGroup}
              style={{
                width: '100%',
                padding: '14px 24px',
                borderRadius: 12,
                fontSize: 15,
                fontWeight: 600,
              }}
              onClick={async () => {
                if (selectedIds.length === 0 || creatingGroup) return
                setCreatingGroup(true)
                try {
                  const resp = await api.post('/conversations', {
                    participantIds: selectedIds,
                    title: groupTitle || undefined,
                    isGroup: true,
                  })
                  const convId = resp.data?.conversation?.id as string | undefined

                  if (convId && (newGroupAvatarBlob || newGroupAvatarFile)) {
                    try {
                      const form = new FormData()
                      form.append('file', newGroupAvatarBlob ?? newGroupAvatarFile!)
                      const url = await new Promise<string>((resolve, reject) => {
                        const xhr = new XMLHttpRequest()
                        xhr.open('POST', getUploadUrl())
                        try {
                          const token = useAppStore.getState().session?.accessToken
                          if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`)
                        } catch {
                          // ignore
                        }
                        xhr.onreadystatechange = () => {
                          if (xhr.readyState === 4) {
                            if (xhr.status >= 200 && xhr.status < 300) {
                              try {
                                const data = JSON.parse(xhr.responseText)
                                resolve(data.url)
                              } catch (err) {
                                reject(err)
                              }
                            } else {
                              reject(new Error(`upload failed: ${xhr.status} ${xhr.statusText}`))
                            }
                          }
                        }
                        xhr.onerror = () => reject(new Error('Network error during upload'))
                        xhr.send(form)
                      })
                      await api.patch(`/conversations/${convId}`, { avatarUrl: url })
                    } catch (avatarErr) {
                      console.error('Error setting group avatar:', avatarErr)
                      // Не блокируем создание беседы из-за ошибок аватара
                    }
                  }

                  client.invalidateQueries({ queryKey: ['conversations'] })
                  if (resp.data?.conversation?.id) {
                    selectConversation(resp.data.conversation.id)
                  }
                  closeNewGroupModal()
                } catch (err: any) {
                  console.error('Error creating group:', err)
                  systemToast.error(err?.response?.data?.message || 'Не удалось создать беседу')
                } finally {
                  setCreatingGroup(false)
                }
              }}
            >
              {creatingGroup ? 'Создание...' : 'Создать'}
            </button>
          </div>
        </div>
      </div>
    )}

    {contactsOpen && (
      <div
        style={{
          position: 'fixed',
          inset: 0,
          background: 'rgba(5,6,9,0.7)',
          backdropFilter: 'blur(8px) saturate(120%)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 70,
          padding: 16,
          boxSizing: 'border-box',
        }}
        onClick={() => setContactsOpen(false)}
      >
        <div
          style={{
            background: 'linear-gradient(180deg, var(--surface-200) 0%, var(--surface-300) 100%)',
            padding: 0,
            borderRadius: 20,
            width: '100%',
            maxWidth: 520,
            border: '1px solid var(--surface-border)',
            boxShadow: 'var(--shadow-soft), 0 0 0 1px rgba(255,255,255,0.04) inset',
            overflow: 'hidden',
            color: 'var(--text-primary)',
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div
            style={{
              padding: '20px 24px',
              borderBottom: '1px solid var(--surface-border)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 12,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div
                style={{
                  width: 44,
                  height: 44,
                  borderRadius: 14,
                  background: 'linear-gradient(135deg, #6366f1, #4f46e5)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  boxShadow: '0 4px 12px rgba(99,102,241,0.35)',
                }}
              >
                <UserPlus size={24} color="#fff" strokeWidth={2.5} />
              </div>
              <div>
                <div style={{ fontWeight: 700, fontSize: 18, color: 'var(--text-primary)', letterSpacing: '-0.02em' }}>
                  Контакты
                </div>
                <div style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 2 }}>
                  Поиск по EBLID и список друзей
                </div>
              </div>
            </div>
            <button className="btn btn-icon btn-ghost" onClick={() => setContactsOpen(false)} style={{ flexShrink: 0, borderRadius: 10 }} title="Закрыть">
              <X size={20} />
            </button>
          </div>

          {/* Body */}
          <div style={{ padding: '20px 24px', maxHeight: 'calc(100vh - 200px)', overflow: 'auto' }}>
            {incomingContactsQuery.data && incomingContactsQuery.data.length > 0 && (
              <div style={{ marginBottom: 20 }}>
                <div style={{ fontSize: 13, color: 'var(--text-muted)', fontWeight: 600, marginBottom: 8 }}>Новые запросы</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {incomingContactsQuery.data.map((c: any) => (
                    <div
                      key={c.id}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 14,
                        padding: '14px 16px',
                        borderRadius: 12,
                        background: 'var(--surface-100)',
                        border: '1px solid var(--surface-border)',
                      }}
                    >
                      <Avatar
                        name={c.friend.displayName ?? c.friend.username}
                        id={c.friend.id}
                        presence={avatarPresenceForUserIdAndStatus(c.friend.id, c.friend.status)}
                        avatarUrl={c.friend.avatarUrl ?? undefined}
                        size={44}
                      />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 600 }}>{c.friend.displayName ?? c.friend.username}</div>
                        <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>хочет добавить вас</div>
                      </div>
                      <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
                        <button className="btn btn-secondary" style={{ padding: '8px 12px', fontSize: 13 }} onClick={async () => { await api.post('/contacts/respond', { contactId: c.id, action: 'reject' }); incomingContactsQuery.refetch() }}>Отклонить</button>
                        <button className="btn btn-primary" style={{ padding: '8px 12px', fontSize: 13 }} onClick={async () => { await api.post('/contacts/respond', { contactId: c.id, action: 'accept' }); contactsQuery.refetch(); incomingContactsQuery.refetch(); conversationsQuery.refetch() }}>Добавить</button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div style={identityBubbleStyle}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <div style={{ ...identityInputsRowStyle, justifyContent: 'flex-start', gap: 6, flex: '1 1 auto' }}>
                  {[0, 1, 2, 3].map((i) => (
                    <input
                      key={i}
                      ref={eblRefs[i]}
                      type="tel"
                      inputMode="numeric"
                      pattern="[0-9]*"
                      autoComplete="one-time-code"
                      enterKeyHint="done"
                      value={eblDigits[i]}
                      onChange={(e) => onChangeDigit(i, e.target.value.replace(/\D/g, '').slice(0, 1))}
                      onKeyDown={(e) => onKeyDownDigit(i, e)}
                      onFocus={(e) => {
                        try { e.currentTarget.select() } catch {}
                      }}
                      onPaste={(e) => {
                        const txt = e.clipboardData?.getData('text') ?? ''
                        if (!txt) return
                        e.preventDefault()
                        applyEblidPaste(i, txt)
                      }}
                      maxLength={1}
                      style={{
                        width: 46,
                        height: 46,
                        fontSize: 19,
                        fontWeight: 700,
                        textAlign: 'center',
                        borderRadius: 11,
                        border: eblDigits[i] ? '1px solid var(--brand-600)' : '1px solid var(--surface-border)',
                        background: 'var(--surface-200)',
                        color: 'var(--text-primary)',
                        outline: 'none',
                        boxShadow: eblDigits[i] ? '0 0 0 1px color-mix(in srgb, var(--brand) 16%, transparent)' : 'none',
                      }}
                    />
                  ))}
                </div>
                <button
                  className="btn btn-icon btn-ghost"
                  type="button"
                  onClick={clearEblidSearch}
                  disabled={!eblDigits.some(Boolean) && !foundUser}
                  title="Сбросить поиск"
                  aria-label="Сбросить поиск"
                  style={identityIconButtonStyle}
                >
                  <X size={16} aria-hidden />
                </button>
              </div>
              <div style={{ ...identityHelperTextStyle, color: 'var(--text-muted)' }}>
                Введи, чтобы добавить друга
              </div>

              {foundUser && (
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12,
                    padding: '12px 13px',
                    borderRadius: 13,
                    background: 'rgba(227,139,10,0.08)',
                    border: '1px solid rgba(227,139,10,0.3)',
                  }}
                >
                  <Avatar name={foundUser.displayName ?? foundUser.username} id={foundUser.id} presence={avatarPresenceForUser(foundUser)} avatarUrl={foundUser.avatarUrl ?? undefined} size={40} onClick={() => openUserCard(foundUser)} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600 }}>{foundUser.displayName ?? foundUser.username}</div>
                    <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Найден по EBLID</div>
                  </div>
                  <button disabled={sendingInvite} className="btn btn-primary" style={{ padding: '8px 14px' }} onClick={sendInvite}>Добавить</button>
                </div>
              )}

              <div style={identityDividerStyle} />

              <div style={identityBottomRowStyle}>
                <div style={myEblidMiniCardStyle}>
                  <div style={identitySectionHeaderStyle}>
                    <div style={identitySectionTitleStyle}>Мой EBLID</div>
                    <button
                      className="btn btn-icon btn-ghost"
                      type="button"
                      onClick={copyMyEblid}
                      disabled={!myEblid}
                      title={myEblidCopied ? 'Скопировано' : 'Скопировать EBLID'}
                      aria-label={myEblidCopied ? 'Скопировано' : 'Скопировать EBLID'}
                      style={identityIconButtonStyle}
                    >
                      {myEblidCopied ? <CheckCircle size={16} aria-hidden /> : <Copy size={16} aria-hidden />}
                    </button>
                  </div>
                  <div
                    style={{
                      fontSize: 24,
                      fontWeight: 800,
                      letterSpacing: '0.12em',
                      color: 'var(--text-primary)',
                      fontVariantNumeric: 'tabular-nums',
                      fontFamily:
                        'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
                    }}
                  >
                    {myEblid || '— — — —'}
                  </div>
                </div>

                <div style={registrationMiniCardStyle}>
                  <div style={identitySectionHeaderStyle}>
                    <div style={identitySectionTitleStyle}>Код регистрации</div>
                    <button
                      className="btn btn-icon btn-ghost"
                      type="button"
                      onClick={copyContactsInviteCode}
                      disabled={!contactsInviteCode || registrationInviteCodeQuery.isLoading || contactsInviteRefreshing}
                      title={contactsInviteCopied ? 'Скопировано' : 'Скопировать код регистрации'}
                      aria-label={contactsInviteCopied ? 'Скопировано' : 'Скопировать код регистрации'}
                      style={identityIconButtonStyle}
                    >
                      {contactsInviteCopied ? <CheckCircle size={16} aria-hidden /> : <Copy size={16} aria-hidden />}
                    </button>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0, overflow: 'hidden' }}>
                    <div
                      style={{
                        flex: '1 1 auto',
                        minWidth: 0,
                        fontSize: 'clamp(17px, 3.4vw, 22px)',
                        fontWeight: 800,
                        letterSpacing: '0.06em',
                        color: '#ffedd5',
                        fontVariantNumeric: 'tabular-nums',
                        fontFamily:
                          'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
                        whiteSpace: 'nowrap',
                        overflowX: 'auto',
                      }}
                    >
                      {registrationInviteCodeQuery.isLoading ? 'Загружаем…' : formattedContactsInviteCode}
                    </div>
                    <button
                      className="btn btn-icon btn-ghost"
                      type="button"
                      onClick={() => void refreshContactsInviteCode()}
                      disabled={registrationInviteCodeQuery.isFetching || contactsInviteRefreshing}
                      title="Обновить код"
                      aria-label="Обновить код"
                      style={{ ...identityIconButtonStyle, flexShrink: 0 }}
                    >
                      <RefreshCw
                        size={16}
                        aria-hidden
                        style={registrationInviteCodeQuery.isFetching || contactsInviteRefreshing ? { animation: 'contacts-page-spin 1s linear infinite' } : undefined}
                      />
                    </button>
                  </div>
                  <div style={{ ...identityHelperTextStyle, color: '#fdba74' }}>
                    {registrationInviteCodeQuery.isError
                      ? 'Не удалось получить код. Попробуйте открыть окно ещё раз.'
                      : `Обновится через ${contactsInviteRemainingLabel}.`}
                  </div>
                </div>
              </div>
            </div>

            {displayOutgoingWithRejected.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, marginBottom: 20 }}>
                {displayOutgoingWithRejected.map((item) =>
                  item.rejected ? (
                    <div
                      key={item.id}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 12,
                        padding: '14px 16px',
                        width: '100%',
                        maxWidth: 420,
                        borderRadius: 12,
                        background: 'var(--surface-100)',
                        border: '1px solid var(--surface-border)',
                      }}
                    >
                      {item.friend.id ? (
                        <Avatar name={item.friend.displayName ?? item.friend.username} id={item.friend.id} avatarUrl={undefined} size={40} />
                      ) : (
                        <div style={{ width: 40, height: 40, borderRadius: '50%', background: 'var(--surface-200)', flexShrink: 0 }} />
                      )}
                      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                        <span style={{ fontWeight: 600, fontSize: 15, color: 'var(--text-primary)' }}>
                          {item.friend.displayName ?? item.friend.username ?? 'Пользователь'}
                        </span>
                        <span style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.3 }}>Запрос отклонён</span>
                      </div>
                      <button
                        type="button"
                        className="btn btn-icon btn-ghost"
                        onClick={() => setRejectedOutgoing((p) => p.filter((r) => r.contactId !== item.id))}
                        aria-label="Убрать"
                        style={{ flexShrink: 0 }}
                      >
                        <X size={18} />
                      </button>
                    </div>
                  ) : (
                    <div
                      key={item.id}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 12,
                        padding: '14px 16px',
                        width: '100%',
                        maxWidth: 420,
                        borderRadius: 12,
                        background: 'var(--surface-100)',
                        border: '1px solid var(--surface-border)',
                      }}
                    >
                      <Loader2 size={20} style={{ flexShrink: 0, color: 'var(--text-muted)', animation: 'contacts-page-spin 1s linear infinite' }} aria-hidden />
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                        <span style={{ fontWeight: 600, fontSize: 15, color: 'var(--text-primary)' }}>Ожидание подтверждения</span>
                        <span style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.3 }}>Попроси зайти в «Контакты» и подтвердить.</span>
                      </div>
                    </div>
                  )
                )}
              </div>
            )}

            <div style={{ marginBottom: 8 }}>
              <div style={{ fontSize: 13, color: 'var(--text-muted)', fontWeight: 600, marginBottom: 8 }}>Мои друзья</div>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))',
                  gap: 12,
                  maxHeight: 280,
                  overflow: 'auto',
                  paddingRight: 4,
                }}
              >
                {sortedAcceptedContacts.length === 0 ? (
                  <div style={{ gridColumn: '1 / -1', padding: 24, textAlign: 'center', color: 'var(--text-muted)', fontSize: 14 }}>
                    Нет контактов. Введите EBLID выше или примите запрос в друзья.
                  </div>
                ) : (
                sortedAcceptedContacts.map((c: any) => {
                  const u = c.friend
                  return (
                    <div
                      key={c.id}
                      style={{
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 12,
                        padding: '16px',
                        borderRadius: 12,
                        background: 'var(--surface-100)',
                        border: '1px solid var(--surface-border)',
                        transition: 'border-color 0.18s, background 0.18s',
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.borderColor = 'var(--surface-border-strong)'
                        e.currentTarget.style.background = 'var(--surface-200)'
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.borderColor = 'var(--surface-border)'
                        e.currentTarget.style.background = 'var(--surface-100)'
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                        <Avatar name={u.displayName ?? u.username} id={u.id} presence={avatarPresenceForUser(u)} avatarUrl={u.avatarUrl ?? undefined} size={44} onClick={() => openUserCard(u)} />
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontWeight: 600, fontSize: 15, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{u.displayName ?? u.username}</div>
                          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Контакт</div>
                        </div>
                      </div>
                      <div style={{ display: 'flex', gap: 8, width: '100%' }}>
                        <button
                          className="btn btn-secondary btn-icon"
                          title="Удалить из друзей"
                          style={{ flex: 1, width: 'auto', minWidth: 0 }}
                          onClick={async () => {
                            await api.post('/contacts/remove', { contactId: c.id })
                            contactsQuery.refetch()
                          }}
                        >
                          <X size={16} />
                        </button>
                        <button
                          className="btn btn-secondary btn-icon"
                          title="Секретный чат"
                          style={{ flex: 1, width: 'auto', minWidth: 0 }}
                          onClick={async () => {
                            await initiateSecretChat(u.id)
                            setContactsOpen(false)
                            client.invalidateQueries({ queryKey: ['conversations'] })
                          }}
                        >
                          <Lock size={16} />
                        </button>
                        <button
                          className="btn btn-primary btn-icon"
                          title="Открыть чат"
                          style={{ flex: 1, width: 'auto', minWidth: 0 }}
                          onClick={async () => {
                            const resp = await api.post('/conversations', { participantIds: [u.id], isGroup: false })
                            setContactsOpen(false)
                            selectConversation(resp.data.conversation.id)
                            client.invalidateQueries({ queryKey: ['conversations'] })
                          }}
                        >
                          <MessageCircle size={16} />
                        </button>
                      </div>
                    </div>
                  )
                })
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    )}
    {contextMenu.open && contextMenu.messageId && (
      <div style={{ position: 'fixed', inset: 0, background: 'transparent', zIndex: 45 }} onClick={() => setContextMenu({ open: false, x: 0, y: 0, messageId: null })}>
        <div
          ref={menuRef}
          className="msg-menu"
          style={{ position: 'absolute', left: contextMenu.x, top: contextMenu.y, color: '#ffffff' }}
          onClick={(e) => e.stopPropagation()}
        >
          {(() => {
            const bulk = multiSelectMode && selectedMessageIds.length > 0
            if (bulk) {
              return (
                <>
                  <button
                    type="button"
                    style={{ color: '#ffffff' }}
                    onClick={() => {
                      const msgs = getSelectedMessagesOrdered()
                      const draft = buildReplyDraftFromMessages(msgs)
                      if (draft) {
                        setForwardComposerDraft(null)
                        setReplyTo(draft)
                      }
                      clearMessageMultiSelect()
                      setContextMenu({ open: false, x: 0, y: 0, messageId: null })
                    }}
                  >
                    Ответить
                  </button>
                  <button
                    type="button"
                    style={{ color: '#ffffff' }}
                    onClick={() => {
                      const ids = getSelectedMessagesOrdered().map((m) => m.id)
                      if (!ids.length) return
                      setForwardComposerDraft(null)
                      setForwardModal({ open: true, messageIds: ids })
                      setContextMenu({ open: false, x: 0, y: 0, messageId: null })
                    }}
                  >
                    Переслать ({selectedMessageIds.length})
                  </button>
                  <button
                    type="button"
                    style={{ color: '#ffffff' }}
                    onClick={async () => {
                      const msgs = getSelectedMessagesOrdered()
                      const mine = msgs.filter((m) => m.senderId === me?.id)
                      if (!mine.length) {
                        systemToast.error('Среди выбранных нет ваших сообщений')
                        setContextMenu({ open: false, x: 0, y: 0, messageId: null })
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
                      setContextMenu({ open: false, x: 0, y: 0, messageId: null })
                    }}
                  >
                    Удалить ({selectedMessageIds.length})
                  </button>
                  <button
                    type="button"
                    style={{ color: '#ffffff' }}
                    onClick={() => {
                      clearMessageMultiSelect()
                      setContextMenu({ open: false, x: 0, y: 0, messageId: null })
                    }}
                  >
                    Отменить выбор
                  </button>
                </>
              )
            }
            if (multiSelectMode) {
              return (
                <button
                  type="button"
                  style={{ color: '#ffffff' }}
                  onClick={() => {
                    clearMessageMultiSelect()
                    setContextMenu({ open: false, x: 0, y: 0, messageId: null })
                  }}
                >
                  Отменить выбор
                </button>
              )
            }
            return (
              <>
                <button style={{ color: '#ffffff' }} onClick={() => {
                  const mid = contextMenu.messageId!
                  const found = (displayedMessages || []).find((mm: any) => mm.id === mid)
                  const draft = found ? buildReplyDraftFromMessages([found]) : null
                  if (draft) {
                    setForwardComposerDraft(null)
                    setReplyTo(draft)
                  }
                  setContextMenu({ open: false, x: 0, y: 0, messageId: null })
                }}>Ответить</button>
                {(() => {
                  const mid = contextMenu.messageId!
                  const found = (displayedMessages || []).find((mm: any) => mm.id === mid)
                  const canEdit =
                    !!found &&
                    found?.senderId === me?.id &&
                    !found?.deletedAt &&
                    (found?.type || 'TEXT') === 'TEXT' &&
                    (!found?.attachments || found.attachments.length === 0)
                  if (!canEdit) return null
                  return (
                    <button style={{ color: '#ffffff' }} onClick={() => {
                      startEdit(found)
                      setContextMenu({ open: false, x: 0, y: 0, messageId: null })
                    }}>Редактировать</button>
                  )
                })()}
                {(() => {
                  const mid = contextMenu.messageId!
                  const found = (displayedMessages || []).find((mm: any) => mm.id === mid)
                  const canDelete = found?.senderId === me?.id
                  if (!canDelete) return null
                  return (
                    <button style={{ color: '#ffffff' }} onClick={async () => {
                      try {
                        await api.post('/messages/delete', { messageId: contextMenu.messageId })
                        if (activeId) client.invalidateQueries({ queryKey: ['messages', activeId] })
                      } catch {}
                      setContextMenu({ open: false, x: 0, y: 0, messageId: null })
                    }}>Удалить</button>
                  )
                })()}
                {(() => {
                  const mid = contextMenu.messageId!
                  const found = (displayedMessages || []).find((mm: any) => mm.id === mid)
                  const textToCopy = buildMessageCopyText(found)
                  const imageUrl = resolveFirstImageAttachmentUrl(found)
                  if (!textToCopy || !imageUrl) return null
                  return (
                    <button style={{ color: '#ffffff' }} onClick={async () => {
                      const copied = await copyImageFromUrl(imageUrl)
                      if (!copied) {
                        systemToast.error('Не удалось скопировать изображение')
                      }
                      setContextMenu({ open: false, x: 0, y: 0, messageId: null })
                    }}>Копировать изображение</button>
                  )
                })()}
                <button style={{ color: '#ffffff' }} onClick={async () => {
                  const mid = contextMenu.messageId!
                  const found = (displayedMessages || []).find((mm: any) => mm.id === mid)
                  const textToCopy = buildMessageCopyText(found)
                  const imageUrl = resolveFirstImageAttachmentUrl(found)
                  const copied = textToCopy
                    ? await copyPlainText(textToCopy)
                    : (imageUrl ? await copyImageFromUrl(imageUrl) : false)
                  if (!copied) {
                    systemToast.error(imageUrl ? 'Не удалось скопировать изображение' : 'Не удалось скопировать сообщение')
                  }
                  setContextMenu({ open: false, x: 0, y: 0, messageId: null })
                }}>Копировать</button>
                <button style={{ color: '#ffffff' }} onClick={() => { setForwardComposerDraft(null); setForwardModal({ open: true, messageIds: contextMenu.messageId ? [contextMenu.messageId] : [] }); setContextMenu({ open: false, x: 0, y: 0, messageId: null }) }}>Переслать</button>
                <button
                  type="button"
                  style={{ color: '#ffffff' }}
                  onClick={() => {
                    setMultiSelectMode(true)
                    const mid = contextMenu.messageId
                    if (mid) {
                      const list = [...(displayedMessages || []), ...(activePendingMessages || [])]
                      const fm = list.find((x: any) => x.id === mid)
                      const isPend = (() => {
                        if (!fm) return true
                        try {
                          if (typeof (fm as any)?.__pending === 'boolean') return (fm as any).__pending
                          if (typeof fm.id === 'string' && fm.id.startsWith('tmp-')) return true
                          const atts = (fm as any)?.attachments
                          if (Array.isArray(atts) && atts.some((a: any) => !!a?.__pending)) return true
                          return false
                        } catch {
                          return true
                        }
                      })()
                      if (fm && fm.type !== 'SYSTEM' && !isPend) {
                        setSelectedMessageIds((prev) => (prev.includes(mid) ? prev : [...prev, mid]))
                      }
                    }
                    setContextMenu({ open: false, x: 0, y: 0, messageId: null })
                  }}
                >
                  Выбрать несколько
                </button>
              </>
            )
          })()}
        </div>
      </div>
    )}
    <ImageLightbox
      open={lightbox.open}
      items={lightbox.items}
      index={lightbox.index}
      onClose={() => setLightbox((l) => ({ ...l, open: false }))}
      onIndexChange={(nextIndex) => setLightbox((l) => ({ ...l, index: nextIndex }))}
    />
    <VideoViewer
      open={videoViewer.open}
      videoUrl={videoViewer.url}
      fileName={videoViewer.fileName}
      onClose={() => setVideoViewer({ open: false, url: '', fileName: undefined })}
    />
    {forwardModal.open && (
      <div
        style={{
          position: 'fixed',
          inset: 0,
          background: 'rgba(10,12,16,0.6)',
          backdropFilter: 'blur(6px) saturate(120%)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 80,
          padding: 16,
        }}
        onClick={() => setForwardModal({ open: false, messageIds: [] })}
      >
        <div
          style={{
            background: 'var(--surface-200)',
            borderRadius: 16,
            width: 'min(480px, 100%)',
            maxWidth: 480,
            border: '1px solid var(--surface-border)',
            boxShadow: 'var(--shadow-medium)',
            color: 'var(--text-primary)',
            overflow: 'hidden',
            display: 'flex',
            flexDirection: 'column',
            maxHeight: 'min(560px, 92vh)',
          }}
          onClick={(e) => e.stopPropagation()}
        >
            <div style={{ padding: '18px 18px 14px', borderBottom: '1px solid var(--surface-border)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 700, fontSize: 19 }}>
                  {forwardModal.messageIds.length > 1
                    ? `Переслать сообщения (${forwardModal.messageIds.length})`
                    : 'Переслать сообщение'}
                </div>
                <div style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 5, lineHeight: 1.4 }}>
                  {forwardModal.messageIds.length > 1
                    ? 'Выберите беседу — откроется чат, можно добавить комментарий и отправить.'
                    : 'Выберите беседу — откроется чат, можно добавить комментарий и отправить.'}
                </div>
              </div>
              <button
                type="button"
                className="btn btn-icon btn-ghost"
                aria-label="Закрыть"
                onClick={() => setForwardModal({ open: false, messageIds: [] })}
              >
                <X size={20} />
              </button>
            </div>
          </div>
          <div
            style={{
              flex: 1,
              minHeight: 0,
              overflow: 'auto',
              padding: '10px 12px 14px',
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
            }}
          >
            {(() => {
              const rows = (conversationsQuery.data || [])
                .map((row: any) => {
                  const c = row.conversation
                  const othersArr = c.participants
                    .filter((p: any) => (currentUserId ? p.user.id !== currentUserId : true))
                    .map((p: any) => p.user)
                  const fallbackName = othersArr.map((u: any) => u.displayName ?? u.username).join(', ') || 'Диалог'
                  const title = c.title ?? fallbackName
                  return { row, c, title, othersArr }
                })
                .filter((x: { c: any }) => x.c.id !== activeId)
                // Hidden secret threads (creator's PENDING invite, CANCELLED) are not forward targets.
                .filter((x: { c: any }) => !x.c.isSecret || String(x.c.secretStatus ?? 'ACTIVE').toUpperCase() === 'ACTIVE')
                .sort(
                  (a: { row: any }, b: { row: any }) =>
                    recencyTimestampForConversationRow(b.row) - recencyTimestampForConversationRow(a.row),
                )

              if (rows.length === 0) {
                return (
                  <div style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: 14, padding: '28px 12px', lineHeight: 1.5 }}>
                    Нет других бесед для пересылки. Откройте ещё один диалог или группу.
                  </div>
                )
              }

              return rows.map(({ c, title, othersArr }: { c: any; title: string; othersArr: any[] }) => {
                const isGroup = c.isGroup || c.participants.length > 2
                const isSecretV2 = String(c?.type ?? '').toUpperCase() === 'SECRET'
                const isLegacySecret = !!c.isSecret
                const n = c.participants?.length ?? 0
                let subtitle: string
                if (isSecretV2) {
                  subtitle = 'Секретный чат'
                } else if (isLegacySecret) {
                  subtitle = 'Секретный чат (классический)'
                } else if (isGroup) {
                  const ruPart = (num: number) => {
                    const nn = num % 100
                    if (nn >= 11 && nn <= 14) return 'участников'
                    const k = num % 10
                    if (k === 1) return 'участник'
                    if (k >= 2 && k <= 4) return 'участника'
                    return 'участников'
                  }
                  subtitle = `Группа · ${n} ${ruPart(n)}`
                } else {
                  const peer = othersArr[0]
                  subtitle = peer ? formatPresence(peer) : 'Личные сообщения'
                }

                return (
                  <div
                    key={c.id}
                    className="tile"
                    onClick={async () => {
                      const ids = (forwardModal.messageIds || []).filter(Boolean)
                      if (!ids.length) return
                      if (!activeConversation) {
                        systemToast.error('Не удалось определить исходный чат.')
                        return
                      }
                      const src = activeConversation
                      const isTargetSecretV2 = String(c?.type ?? '').toUpperCase() === 'SECRET'
                      const isTargetLegacySecret = !!c?.isSecret && !isTargetSecretV2

                      type SendPayloadArg = Parameters<typeof sendMessageToConversation>[1]
                      const forwardPayloads: SendPayloadArg[] = []
                      const fwdPreviews: Array<{
                        text: string
                        imageStub?: { url: string; type: 'IMAGE'; metadata?: Record<string, unknown> } | null
                      }> = []
                      for (const mid of ids) {
                        const found = (displayedMessages || []).find((mm: any) => mm.id === mid)
                        if (!found) continue
                        fwdPreviews.push({
                          text: previewTextForReplyDraft(found),
                          imageStub: firstImageAttachmentStubForQuote(found),
                        })
                        const fctx = buildForwardSourceContextForSend(found, src, currentUserId, usersById)
                        const built = buildForwardSendPayload(found, fctx)
                        if (!built.ok) {
                          systemToast.error(built.error)
                          return
                        }
                        const attCount = built.payload.attachments?.length ?? 0
                        if (attCount > 0 && (isTargetSecretV2 || isTargetLegacySecret)) {
                          systemToast.error('Пересылка фото и файлов в секретный чат пока не поддерживается.')
                          return
                        }
                        forwardPayloads.push({ ...built.payload, replyToId: undefined })
                      }

                      if (!forwardPayloads.length) {
                        systemToast.error('Не удалось найти сообщения для пересылки.')
                        return
                      }

                      /** Несколько картинок — один бабл с альбомом, как при немедленной отправке */
                      const mergeAsImageBulk =
                        forwardPayloads.length > 1 &&
                        forwardPayloads.every((p) => String(p.type) === 'IMAGE')

                      setReplyTo(null)
                      setForwardComposerDraft({
                        destinationConversationId: String(c.id),
                        payloads: forwardPayloads.map((p) => ({ ...p })),
                        mergeAsImageBulk,
                        previews: fwdPreviews,
                      })
                      selectConversation(c.id)
                      setForwardModal({ open: false, messageIds: [] })
                      clearMessageMultiSelect()
                      requestAnimationFrame(() => {
                        try {
                          composerEditorRef.current?.focus()
                        } catch {
                          /* ignore */
                        }
                      })
                    }}
                    style={{
                      minHeight: 56,
                      alignItems: 'center',
                      gap: 12,
                      ...(isSecretV2
                        ? {
                            background: 'linear-gradient(135deg, rgba(34,197,94,0.09) 0%, rgba(34,197,94,0.04) 100%)',
                            borderColor: 'rgba(34,197,94,0.28)',
                          }
                        : {}),
                    }}
                  >
                    {isGroup ? (
                      <Avatar
                        name={title.trim().charAt(0) || 'Г'}
                        id={c.id}
                        avatarUrl={c.avatarUrl && String(c.avatarUrl).trim() ? c.avatarUrl : undefined}
                        size={44}
                      />
                    ) : (
                      (() => {
                        const peerUser = othersArr[0]
                        return (
                          <Avatar
                            name={peerUser?.displayName ?? peerUser?.username ?? '?'}
                            id={peerUser?.id ?? c.id}
                            avatarUrl={peerUser?.avatarUrl ?? undefined}
                            presence={peerUser ? avatarPresenceForUser(peerUser) : undefined}
                            size={44}
                          />
                        )
                      })()
                    )}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 600, fontSize: 15, lineHeight: 1.3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</div>
                      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 3, lineHeight: 1.35, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {subtitle}
                      </div>
                    </div>
                    {isGroup && (
                      <Users size={18} style={{ flexShrink: 0, opacity: 0.45, color: 'var(--text-muted)' }} aria-hidden />
                    )}
                  </div>
                )
              })
            })()}
          </div>
          <div style={{ padding: '12px 16px', borderTop: '1px solid var(--surface-border)', display: 'flex', justifyContent: 'flex-end' }}>
            <button type="button" className="btn btn-secondary" onClick={() => setForwardModal({ open: false, messageIds: [] })}>
              Отмена
            </button>
          </div>
        </div>
      </div>
    )}
    {addParticipantsModal && activeConversation && (
      <div style={{ position: 'fixed', inset: 0, background: 'rgba(10,12,16,0.55)', backdropFilter: 'blur(4px) saturate(110%)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 70 }} onClick={closeAddParticipantsModal}>
        <div style={{ background: 'var(--surface-200)', padding: 24, borderRadius: 16, width: 440, maxWidth: '90vw', border: '1px solid var(--surface-border)', boxShadow: 'var(--shadow-medium)', color: 'var(--text-primary)' }} onClick={(e) => e.stopPropagation()}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
            <div style={{ fontWeight: 700, fontSize: 20 }}>Добавить участников</div>
            <button className="btn btn-icon btn-ghost" onClick={closeAddParticipantsModal}><X size={18} /></button>
          </div>
          <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
            {[
              { key: 'friends', label: 'Из друзей' },
              { key: 'eblid', label: 'По EBLID' },
            ].map((opt) => {
              const active = addParticipantsMode === opt.key
              return (
                <button
                  key={opt.key}
                  className="btn btn-ghost"
                  onClick={() => setAddParticipantsMode(opt.key as 'friends' | 'eblid')}
                  style={{
                    flex: 1,
                    borderRadius: 999,
                    border: active ? '1px solid var(--brand-500)' : '1px solid var(--surface-border)',
                    background: active ? 'var(--surface-100)' : 'transparent',
                    color: active ? 'var(--text-primary)' : 'var(--text-muted)',
                    fontWeight: active ? 600 : 500,
                  }}
                >
                  {opt.label}
                </button>
              )
            })}
          </div>
          <div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 16 }}>
            {addParticipantsMode === 'friends'
              ? 'Выберите контакты, которых нужно пригласить в эту беседу.'
              : 'Введите EBLID пользователя, чтобы пригласить его в беседу.'}
          </div>
          {addParticipantsMode === 'friends' ? (
            <div style={{ maxHeight: 320, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 10 }}>
              {eligibleContactsForAdd.length === 0 ? (
                <div style={{ color: 'var(--text-muted)', fontSize: 14 }}>Все ваши контакты уже находятся в этой беседе.</div>
              ) : (
                eligibleContactsForAdd.map((c: any) => {
                  const u = c.friend
                  const checked = addParticipantsSelectedIds.includes(u.id)
                  return (
                    <div
                      key={c.id}
                      className="tile"
                      onClick={() =>
                        setAddParticipantsSelectedIds((prev) => (checked ? prev.filter((id) => id !== u.id) : [...prev, u.id]))
                      }
                      style={{
                        cursor: 'pointer',
                        borderColor: checked ? 'var(--brand-600)' : undefined,
                        display: 'flex',
                        alignItems: 'center',
                        gap: 12,
                      }}
                    >
                      <Avatar
                        name={u.displayName ?? u.username}
                        id={u.id}
                        presence={avatarPresenceForUser(u)}
                        avatarUrl={u.avatarUrl ?? undefined}
                      />
                      <div style={{ flex: 1 }}>
                        <div style={{ fontWeight: 600 }}>{u.displayName ?? u.username}</div>
                        <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                          {formatPresence(u)}
                        </div>
                      </div>
                      <div style={{ width: 18, height: 18, borderRadius: 4, border: '2px solid var(--surface-border)', background: checked ? 'var(--brand-600)' : 'transparent' }} />
                    </div>
                  )
                })
              )}
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
                {[0, 1, 2, 3].map((i) => (
                  <input
                    key={i}
                    ref={addParticipantsEblRefs[i]}
                    type="tel"
                    inputMode="numeric"
                    pattern="[0-9]*"
                    autoComplete="one-time-code"
                    enterKeyHint="done"
                    value={addParticipantsEblDigits[i]}
                    onChange={(e) => onChangeAddParticipantsDigit(i, e.target.value.replace(/\D/g, '').slice(0, 1))}
                    onKeyDown={(e) => onKeyDownAddParticipantsDigit(i, e)}
                    maxLength={1}
                    style={{
                      width: 56,
                      height: 60,
                      fontSize: 24,
                      textAlign: 'center',
                      borderRadius: 10,
                      border: '1px solid var(--surface-border)',
                      background: 'var(--surface-100)',
                      color: 'var(--text-primary)',
                      fontWeight: 600,
                    }}
                  />
                ))}
              </div>
              {addParticipantsSearching && (
                <div style={{ textAlign: 'center', fontSize: 13, color: 'var(--text-muted)' }}>Ищем пользователя…</div>
              )}
              {addParticipantsFoundUser && (
                <div className="tile" style={{ alignItems: 'center', gap: 12 }}>
                  <Avatar
                    name={addParticipantsFoundUser.displayName ?? addParticipantsFoundUser.username}
                    id={addParticipantsFoundUser.id}
                    presence={avatarPresenceForUserIdAndStatus(addParticipantsFoundUser.id, addParticipantsFoundUser.status)}
                    avatarUrl={addParticipantsFoundUser.avatarUrl ?? undefined}
                  />
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 600 }}>{addParticipantsFoundUser.displayName ?? addParticipantsFoundUser.username}</div>
                    <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                      {addParticipantsFoundUserStatus.alreadyInChat
                        ? 'Уже в беседе'
                        : addParticipantsFoundUserStatus.isSelf
                        ? 'Это вы'
                        : 'Найден по EBLID'}
                    </div>
                  </div>
                </div>
              )}
              {!addParticipantsFoundUser && addParticipantsSearchError && (
                <div style={{ textAlign: 'center', fontSize: 13, color: '#f87171' }}>{addParticipantsSearchError}</div>
              )}
            </div>
          )}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 12, marginTop: 20 }}>
            <button className="btn btn-secondary" onClick={closeAddParticipantsModal}>Отмена</button>
            <button
              className="btn btn-primary"
              disabled={
                addParticipantsLoading ||
                (addParticipantsMode === 'friends'
                  ? addParticipantsSelectedIds.length === 0
                  : !addParticipantsFoundUser ||
                    addParticipantsFoundUserStatus.alreadyInChat ||
                    addParticipantsFoundUserStatus.isSelf)
              }
              onClick={addParticipantsMode === 'friends' ? handleAddParticipants : handleAddParticipantByEbl}
            >
              {addParticipantsLoading ? 'Добавление...' : 'Добавить'}
            </button>
          </div>
        </div>
      </div>
    )}
    {convMenu.open && convMenu.conversationId && (
      <div
        style={{
          position: 'fixed',
          inset: 0,
          background: 'transparent',
          zIndex: 45,
        }}
        onClick={() => setConvMenu({ open: false, x: 0, y: 0, conversationId: null })}
      >
        <div
          ref={convMenuRef}
          className="msg-menu"
          style={{ position: 'absolute', left: convMenu.x, top: convMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          {(() => {
            const row = (conversationsQuery.data || []).find(
              (r: any) => r.conversation.id === convMenu.conversationId
            )
            const c = row?.conversation || (activeId === convMenu.conversationId ? activeConversation : null)
            const isGroup = !!(c && (c.isGroup || (c.participants?.length ?? 0) > 2))

            const isSecretV2Row = String(c?.type ?? '').toUpperCase() === 'SECRET'
            const peer = !isGroup ? (c?.participants || []).find((p: any) => p?.user?.id && p.user.id !== currentUserId)?.user : null
            const canStartSecret = !isGroup && !!c && !c.isSecret && !!peer?.id

            const handleClick = async () => {
              try {
                if (isGroup) {
                  await api.delete(`/conversations/${convMenu.conversationId}/participants/me`)
                } else if (isSecretV2Row) {
                  // V2 secret threads tear down via decline → CANCELLED everywhere (a hard
                  // delete would orphan the E2EE transport rows).
                  await api.post(`/threads/secret/${convMenu.conversationId}/decline`, {})
                } else {
                  await api.delete(`/conversations/${convMenu.conversationId}`)
                }
                client.invalidateQueries({ queryKey: ['conversations'] })
                if (activeId === convMenu.conversationId) {
                  setActiveId(null)
                  if (isMobile) setMobileView('list')
                }
              } catch {
                // ignore
              }
              setConvMenu({ open: false, x: 0, y: 0, conversationId: null })
            }

            return (
              <>
                {canStartSecret && (
                  <button
                    onClick={async () => {
                      setConvMenu({ open: false, x: 0, y: 0, conversationId: null })
                      if (peer?.id) await initiateSecretChat(peer.id)
                    }}
                    disabled={secretRequestLoading}
                    style={{ display: 'flex', alignItems: 'center', gap: 8 }}
                  >
                    <Lock size={16} color="#22c55e" />
                    Секретный чат
                  </button>
                )}
                <button onClick={handleClick} style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#ef4444' }}>
                  {isGroup ? <LogOut size={16} /> : <Trash2 size={16} />}
                  {isGroup ? 'Выйти из беседы' : isSecretV2Row ? 'Закрыть секретный чат' : 'Удалить беседу'}
                </button>
              </>
            )
          })()}
        </div>
      </div>
    )}
    {headerMenu.open && headerMenu.anchor && activeConversation && (
      <div
        style={{
          position: 'fixed',
          inset: 0,
          background: 'transparent',
          zIndex: 45,
        }}
        onClick={() => setHeaderMenu({ open: false, anchor: null })}
      >
        <div
          ref={headerMenuRef}
          className="msg-menu"
          style={{ position: 'fixed' }}
          onClick={(e) => e.stopPropagation()}
        >
          {(() => {
            const isGroup = activeConversation.isGroup || (activeConversation.participants?.length ?? 0) > 2
            const isSecret = !!activeConversation.isSecret && !isGroup
            const peer = !isGroup && activeConversation.participants?.find((p: any) => p.user.id !== currentUserId)?.user

            if (isGroup) {
              return (
                <>
                  <button
                    onClick={() => {
                      setAddParticipantsSelectedIds([])
                      setAddParticipantsMode('friends')
                      setAddParticipantsEblDigits(['', '', '', ''])
                      setAddParticipantsFoundUser(null)
                      setAddParticipantsSearchError(null)
                      setAddParticipantsSearching(false)
                      setAddParticipantsModal(true)
                      setHeaderMenu({ open: false, anchor: null })
                    }}
                    style={{ display: 'flex', alignItems: 'center', gap: 8 }}
                  >
                    <UserPlus size={16} />
                    Добавить участников
                  </button>
                  <button
                    onClick={async () => {
                      if (!activeId) return
                      try {
                        await api.delete(`/conversations/${activeId}/participants/me`)
                        client.invalidateQueries({ queryKey: ['conversations'] })
                        setActiveId(null)
                        if (isMobile) setMobileView('list')
                      } catch (err) {
                        console.error('Failed to leave conversation:', err)
                      }
                      setHeaderMenu({ open: false, anchor: null })
                    }}
                    style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#ef4444' }}
                  >
                    <LogOut size={16} />
                    Выйти из беседы
                  </button>
                </>
              )
            } else {
              return (
                <>
                  {!isSecret ? (
                    <button
                      onClick={async () => {
                        if (peer?.id) {
                          await initiateSecretChat(peer.id)
                        }
                        setHeaderMenu({ open: false, anchor: null })
                      }}
                      disabled={secretRequestLoading}
                      style={{ display: 'flex', alignItems: 'center', gap: 8 }}
                    >
                      <Lock size={16} />
                      Начать секретный чат
                    </button>
                  ) : (
                    <button
                      onClick={() => {
                        setEndSecretModalOpen(true)
                        setHeaderMenu({ open: false, anchor: null })
                      }}
                      style={{ display: 'flex', alignItems: 'center', gap: 8 }}
                    >
                      <Unlock size={16} />
                      Завершить секретный чат
                    </button>
                  )}
                  <button
                    onClick={async () => {
                      if (!activeId) return
                      try {
                        await api.delete(`/conversations/${activeId}`)
                        client.invalidateQueries({ queryKey: ['conversations'] })
                        client.removeQueries({ queryKey: ['messages', activeId] })
                        setActiveId(null)
                        if (isMobile) setMobileView('list')
                      } catch (err) {
                        console.error('Failed to delete conversation:', err)
                      }
                      setHeaderMenu({ open: false, anchor: null })
                    }}
                    style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#ef4444' }}
                  >
                    <Trash2 size={16} />
                    Удалить чат
                  </button>
                </>
              )
            }
          })()}
        </div>
      </div>
    )}
    {groupAvatarEditor && activeConversation && (
      <div className="eb-no-drag" style={{ position: 'fixed', inset: 0, background: 'rgba(10,12,16,0.55)', backdropFilter: 'blur(4px) saturate(110%)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 80 }} onClick={() => setGroupAvatarEditor(false)}>
        <div style={{ background: 'var(--surface-200)', padding: 24, borderRadius: 16, width: 440, maxWidth: '90vw', maxHeight: '90vh', overflowY: 'auto', border: '1px solid var(--surface-border)', boxShadow: 'var(--shadow-medium)' }} onClick={(e) => e.stopPropagation()}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
            <div style={{ fontWeight: 700, fontSize: 20, color: 'var(--text-primary)' }}>Настройки группы</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
              <button className="btn btn-icon btn-ghost" title="Изменить аватар" onClick={() => groupFileInputRef.current?.click()}><Pencil size={16} /></button>
              <button className="btn btn-icon btn-ghost" onClick={() => setGroupAvatarEditor(false)}><X size={18} /></button>
            </div>
          </div>
          <div style={{ marginBottom: 16, borderRadius: 16, overflow: 'hidden', border: '1px solid var(--surface-border)', background: 'var(--surface-100)', paddingBottom: 14 }}>
            <UserProfileHero
              compact
              hideStatusDot
              user={{
                id: activeConversation.id,
                displayName: groupTitleEditValue || activeConversation.title || 'Группа',
                avatarUrl: groupAvatarPreviewUrl ?? activeConversation.avatarUrl ?? undefined,
              }}
              statusText="Беседа"
            />
            <div style={{ padding: '4px 20px 0' }}>
              <div style={{ marginBottom: 6, color: 'var(--text-muted)', fontSize: 12, fontWeight: 500 }}>Название группы</div>
              <input
                type="text"
                value={groupTitleEditValue}
                onChange={(e) => setGroupTitleEditValue(e.target.value)}
                placeholder="Название группы"
                maxLength={100}
                style={{ width: '100%', padding: '8px 10px', borderRadius: 8, border: '1px solid var(--surface-border)', background: 'var(--surface-200)', color: 'var(--text-primary)', fontSize: 14, outline: 'none', boxSizing: 'border-box' }}
              />
            </div>
          </div>
          <input ref={groupFileInputRef} type="file" accept="image/*" onChange={(e) => {
            const file = e.target.files?.[0]
            if (!file) return
            setGroupSelectedAvatarFile(file)
            try { setGroupAvatarPreviewUrl(URL.createObjectURL(file)) } catch {}
          }} style={{ display: 'none' }} />
          {groupAvatarPreviewUrl && (
            <div style={{ border: '1px solid var(--surface-border)', borderRadius: 16, padding: 16, marginTop: 16, background: 'var(--surface-100)', boxShadow: '0 4px 12px rgba(0,0,0,0.1)' }}>
              <div style={{ fontSize: 14, color: 'var(--text-primary)', marginBottom: 12, fontWeight: 600 }}>Настройка аватара</div>
              <div 
                ref={groupEditorRef}
                onWheel={(e) => {
                  e.preventDefault()
                  const delta = -e.deltaY * 0.001
                  const newScale = Math.max(0.1, Math.min(10, groupCrop.scale * (1 + delta)))
                  const rect = groupEditorRef.current?.getBoundingClientRect()
                  if (rect) {
                    const x = e.clientX - rect.left
                    const y = e.clientY - rect.top
                    const scaleChange = newScale / groupCrop.scale
                    const newX = x - (x - groupCrop.x) * scaleChange
                    const newY = y - (y - groupCrop.y) * scaleChange
                    setGroupCrop({ x: newX, y: newY, scale: newScale })
                  }
                }}
                  onPointerDown={(e) => {
                  if (e.pointerType === 'touch') return // Touch обрабатывается в addEventListener
                  const rect = groupEditorRef.current?.getBoundingClientRect()
                  if (!rect) return
                  const editorWidth = rect.width
                  const editorHeight = rect.height
                  const centerX = editorWidth / 2
                  const centerY = editorHeight / 2
                  const cropSizeValue = 240
                  const radius = cropSizeValue / 2
                  const x = e.clientX - rect.left
                  const y = e.clientY - rect.top
                  
                  // Проверяем, что клик внутри круга
                  const dx = x - centerX
                  const dy = y - centerY
                  if (dx * dx + dy * dy > radius * radius) {
                    return
                  }
                  
                    try { (e.currentTarget as any).setPointerCapture?.((e as any).pointerId) } catch {}
                  const startX = e.clientX
                  const startY = e.clientY
                  const start = { ...groupCrop }
                    const onMove = (ev: PointerEvent) => {
                      ev.preventDefault()
                    const deltaX = ev.clientX - startX
                    const deltaY = ev.clientY - startY
                    setGroupCrop({ ...start, x: start.x + deltaX, y: start.y + deltaY })
                    }
                    const onUp = () => {
                      window.removeEventListener('pointermove', onMove as any)
                      window.removeEventListener('pointerup', onUp)
                    }
                    window.addEventListener('pointermove', onMove as any, { passive: false } as any)
                    window.addEventListener('pointerup', onUp, { passive: true } as any)
                }}
                style={{ 
                position: 'relative', 
                width: '100%', 
                height: 320, 
                background: 'var(--surface-200)', 
                overflow: 'hidden', 
                borderRadius: 12, 
                touchAction: 'none',
                border: '1px solid var(--surface-border)',
                boxShadow: 'inset 0 2px 8px rgba(0,0,0,0.1)',
                cursor: 'move'
              }}>
                <img 
                  ref={groupImageRef}
                  src={groupAvatarPreviewUrl} 
                  alt="preview" 
                  style={{ 
                    position: 'absolute', 
                    left: groupCrop.x, 
                    top: groupCrop.y, 
                    transform: `scale(${groupCrop.scale})`, 
                    transformOrigin: 'top left',
                    willChange: 'transform',
                    pointerEvents: 'none'
                  }} 
                  draggable={false}
                  onLoad={(e) => {
                    const img = e.currentTarget
                    const editor = groupEditorRef.current
                    if (!editor) return
                    const editorWidth = editor.clientWidth
                    const editorHeight = editor.clientHeight
                    const cropSizeValue = 240
                    const imgWidth = img.naturalWidth
                    const imgHeight = img.naturalHeight
                    const centerX = editorWidth / 2
                    const centerY = editorHeight / 2
                    
                    // Рассчитываем масштаб, чтобы изображение максимально заполняло круг
                    const scaleX = cropSizeValue / imgWidth
                    const scaleY = cropSizeValue / imgHeight
                    const initialScale = Math.max(scaleX, scaleY) * 1.2 // 1.2 для запаса
                    
                    // Центрируем изображение относительно центра круга
                    const initialX = centerX - (imgWidth * initialScale) / 2
                    const initialY = centerY - (imgHeight * initialScale) / 2
                    
                    setGroupCrop({ x: initialX, y: initialY, scale: initialScale })
                  }}
                />
                {/* Маска с градиентом для более плавного эффекта */}
                <div style={{ 
                  position: 'absolute', 
                  inset: 0, 
                  pointerEvents: 'none', 
                  borderRadius: '50%', 
                  boxShadow: '0 0 0 9999px rgba(0,0,0,0.65)', 
                  width: 240, 
                  height: 240, 
                  margin: 'auto',
                  border: '2px solid rgba(255,255,255,0.3)',
                  boxSizing: 'border-box'
                }} />
                {/* Сетка для лучшего позиционирования */}
                <div style={{
                  position: 'absolute',
                  inset: 0,
                  pointerEvents: 'none',
                  borderRadius: '50%',
                  width: 240,
                  height: 240,
                  margin: 'auto',
                  background: `
                    linear-gradient(to right, rgba(255,255,255,0.1) 1px, transparent 1px),
                    linear-gradient(to bottom, rgba(255,255,255,0.1) 1px, transparent 1px)
                  `,
                  backgroundSize: '60px 60px',
                  opacity: 0.5
                }} />
              </div>
              <div style={{ marginTop: 16 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                  <div style={{ fontSize: 13, color: 'var(--text-muted)', fontWeight: 500 }}>Масштаб</div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', background: 'var(--surface-200)', padding: '4px 8px', borderRadius: 6 }}>
                    {Math.round(groupCrop.scale * 100)}%
              </div>
                </div>
                <div style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 12 }}>
                  <div style={{ fontSize: 18, color: 'var(--text-muted)', cursor: 'pointer', userSelect: 'none' }} onClick={() => setGroupCrop((c) => ({ ...c, scale: Math.max(0.1, c.scale - 0.1) }))}>−</div>
                  <input 
                    type="range" 
                    min={0.1} 
                    max={10} 
                    step={0.01} 
                    value={groupCrop.scale} 
                    onChange={(e) => {
                      const newScale = parseFloat(e.target.value)
                      setGroupCrop((prev) => {
                        const rect = groupEditorRef.current?.getBoundingClientRect()
                        if (!rect) return { ...prev, scale: newScale }
                        const editorWidth = rect.width
                        const editorHeight = rect.height
                        const centerX = editorWidth / 2
                        const centerY = editorHeight / 2
                        const img = groupImageRef.current
                        if (img) {
                          const imgWidth = img.naturalWidth
                          const imgHeight = img.naturalHeight
                          const initialCenterX = prev.x + (imgWidth * prev.scale) / 2
                          const initialCenterY = prev.y + (imgHeight * prev.scale) / 2
                          const vectorX = initialCenterX - centerX
                          const vectorY = initialCenterY - centerY
                          const scaleRatio = newScale / prev.scale
                          const newCenterX = centerX + vectorX * scaleRatio
                          const newCenterY = centerY + vectorY * scaleRatio
                          const newX = newCenterX - (imgWidth * newScale) / 2
                          const newY = newCenterY - (imgHeight * newScale) / 2
                          return { x: newX, y: newY, scale: newScale }
                        }
                        return { ...prev, scale: newScale }
                      })
                    }}
                    style={{ flex: 1, height: 6, background: 'var(--surface-200)', borderRadius: 3, outline: 'none', cursor: 'pointer' }}
                  />
                  <div style={{ fontSize: 18, color: 'var(--text-muted)', cursor: 'pointer', userSelect: 'none' }} onClick={() => setGroupCrop((c) => ({ ...c, scale: Math.min(10, c.scale + 0.1) }))}>+</div>
                </div>
              </div>
              <canvas ref={groupCropCanvasRef} width={240} height={240} style={{ display: 'none' }} />
            </div>
          )}
          {(() => {
            const trimmedTitle = groupTitleEditValue.trim()
            const titleChanged = trimmedTitle.length > 0 && trimmedTitle !== (activeConversation.title ?? '').trim()
            const hasChanges = !!groupSelectedAvatarFile || titleChanged
            if (!hasChanges) return null
            const busy = uploadingAvatar || savingGroupTitle
            return (
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
                <button className="btn btn-secondary" disabled={busy} onClick={() => {
                  setGroupSelectedAvatarFile(null)
                  if (groupAvatarPreviewUrl) URL.revokeObjectURL(groupAvatarPreviewUrl)
                  setGroupAvatarPreviewUrl(null)
                  setGroupCrop({ x: 0, y: 0, scale: 1 })
                  setGroupTitleEditValue(activeConversation.title ?? '')
                }}>Отмена</button>
                <button className="btn btn-primary" disabled={busy} onClick={async () => {
                  if (!activeConversation) return
                  setSavingGroupTitle(true)
                  try {
                    let uploadedAvatarUrl: string | null = null
                    if (groupSelectedAvatarFile) {
                      setUploadingAvatar(true)
                      setUploadProgress(0)
                      let blobToSend: Blob | null = null
                      if (groupCropCanvasRef.current && groupAvatarPreviewUrl) {
                        const img = await new Promise<HTMLImageElement>((resolve) => { const i = new Image(); i.onload = () => resolve(i); i.src = groupAvatarPreviewUrl })
                        const ctx = groupCropCanvasRef.current.getContext('2d')!
                        if (!ctx) {
                          throw new Error('Could not get 2d context from canvas')
                        }
                        const size = 240
                        ctx.clearRect(0,0,size,size)
                        ctx.save()
                        ctx.beginPath(); ctx.arc(size/2, size/2, size/2, 0, Math.PI*2); ctx.closePath(); ctx.clip()
                        const vw = groupEditorRef.current?.clientWidth ?? 320
                        const vh = groupEditorRef.current?.clientHeight ?? 320
                        const viewportCenter = { x: vw / 2, y: vh / 2 }
                        const viewRect = { x: viewportCenter.x - size/2, y: viewportCenter.y - size/2, w: size, h: size }
                        const srcX = (viewRect.x - groupCrop.x) / groupCrop.scale
                        const srcY = (viewRect.y - groupCrop.y) / groupCrop.scale
                        const srcW = viewRect.w / groupCrop.scale
                        const srcH = viewRect.h / groupCrop.scale
                        ctx.drawImage(img, srcX, srcY, srcW, srcH, 0, 0, size, size)
                        ctx.restore()
                        blobToSend = await new Promise<Blob | null>((resolve) => groupCropCanvasRef.current!.toBlob((b) => resolve(b), 'image/png'))
                      }
                      if (!blobToSend && !groupSelectedAvatarFile) {
                        throw new Error('No file to upload')
                      }
                      const form = new FormData()
                      form.append('file', blobToSend ?? groupSelectedAvatarFile!)
                      uploadedAvatarUrl = await new Promise<string>((resolve, reject) => {
                        const xhr = new XMLHttpRequest()
                        xhr.open('POST', getUploadUrl())
                        try { const token = useAppStore.getState().session?.accessToken; if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`) } catch {}
                        xhr.upload.onprogress = (e) => {
                          const total = e.lengthComputable ? e.total : ((blobToSend ?? groupSelectedAvatarFile)?.size ?? 0)
                          if (total > 0) setUploadProgress(Math.min(100, Math.round(100 * e.loaded / total)))
                        }
                        xhr.onreadystatechange = () => {
                          if (xhr.readyState === 4) {
                            if (xhr.status >= 200 && xhr.status < 300) {
                              try {
                                const resp = JSON.parse(xhr.responseText)
                                resolve(resp.url)
                              } catch (err) {
                                reject(err)
                              }
                            } else {
                              reject(new Error(`upload failed: ${xhr.status} ${xhr.statusText}`))
                            }
                          }
                        }
                        xhr.onerror = () => reject(new Error('Network error during upload'))
                        xhr.send(form)
                      })
                    }
                    const patchPayload: { title?: string; avatarUrl?: string } = {}
                    if (titleChanged) patchPayload.title = trimmedTitle
                    if (uploadedAvatarUrl) patchPayload.avatarUrl = uploadedAvatarUrl
                    if (Object.keys(patchPayload).length > 0) {
                      await api.patch(`/conversations/${activeConversation.id}`, patchPayload)
                    }
                    client.setQueryData(['conversations'], (old: any) => {
                      if (!Array.isArray(old)) return old
                      return old.map((r: any) => {
                        if (r.conversation?.id === activeConversation.id) {
                          return {
                            ...r,
                            conversation: {
                              ...r.conversation,
                              ...(patchPayload.title !== undefined ? { title: patchPayload.title } : {}),
                              ...(patchPayload.avatarUrl !== undefined ? { avatarUrl: patchPayload.avatarUrl } : {}),
                            },
                          }
                        }
                        return r
                      })
                    })
                    client.invalidateQueries({ queryKey: ['conversations'] })
                    await conversationsQuery.refetch()
                    setGroupSelectedAvatarFile(null)
                    if (groupAvatarPreviewUrl) URL.revokeObjectURL(groupAvatarPreviewUrl)
                    setGroupAvatarPreviewUrl(null)
                    setGroupCrop({ x: 0, y: 0, scale: 1 })
                    setGroupAvatarEditor(false)
                    setUploadMessage('Готово')
                    setTimeout(() => setUploadMessage(null), 2200)
                  } catch (err) {
                    console.error('Error saving group settings:', err)
                    setUploadMessage(`Ошибка: ${err instanceof Error ? err.message : 'Неизвестная ошибка'}`)
                    setTimeout(() => setUploadMessage(null), 3000)
                  } finally {
                    setUploadingAvatar(false)
                    setSavingGroupTitle(false)
                  }
                }}>{busy ? 'Сохранение...' : 'Сохранить'}</button>
              </div>
            )
          })()}
          {uploadingAvatar && (
            <div style={{ height: 6, background: 'var(--surface-100)', borderRadius: 3, overflow: 'hidden', marginTop: 12 }}>
              <div style={{ width: `${uploadProgress}%`, height: '100%', background: 'var(--brand)', transition: 'width 0.2s ease' }} />
            </div>
          )}
          {uploadMessage && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, color: '#16a34a' }}>
              <CheckCircle size={16} />
              <span>{uploadMessage}</span>
            </div>
          )}
          <div style={{ marginTop: 20, borderTop: '1px solid var(--surface-border)', paddingTop: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
              <div style={{ fontSize: 13, fontWeight: 800, letterSpacing: 0.2, color: 'var(--text-muted)', textTransform: 'uppercase' }}>Участники · {activeConversation.participants?.length ?? 0}</div>
              <button className="btn btn-ghost" style={{ padding: '6px 10px', height: 32, display: 'inline-flex', alignItems: 'center', gap: 6 }} onClick={() => { setGroupAvatarEditor(false); setAddParticipantsModal(true) }}>
                <UserPlus size={15} /> Добавить
              </button>
            </div>
            <div style={{ maxHeight: 260, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2 }}>
              {(activeConversation.participants || []).map((p: any) => {
                const u = p.user
                if (!u?.id) return null
                const isMe = currentUserId && String(u.id) === String(currentUserId)
                return (
                  <div key={u.id} onClick={() => { setGroupAvatarEditor(false); openUserCard(u) }} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 8px', borderRadius: 12, cursor: 'pointer' }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--surface-100)' }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}>
                    <Avatar name={u.displayName ?? 'U'} id={u.id} size={38} avatarUrl={u.avatarUrl && u.avatarUrl.trim() ? u.avatarUrl : undefined} presence={avatarPresenceForUser(u)} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 600, fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{(u.displayName && String(u.displayName).trim()) || 'Без имени'}{isMe ? ' (вы)' : ''}</div>
                      <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{formatPresence(u)}</div>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      </div>
    )}
    {availabilityContext && (
      <AvailabilityOverlay
        isOpen={!!availabilityContext}
        conversationId={availabilityContext.conversationId}
        viewerId={me?.id ?? 'me'}
        peerId={availabilityContext.peerId}
        peerName={availabilityContext.peerName}
        viewerTimeZone={(me as any)?.timezone ?? (me as any)?.timeZone ?? getFallbackTimeZone()}
        peerTimeZone={availabilityContext.peerTimeZone ?? getFallbackTimeZone()}
        onClose={() => setAvailabilityContext(null)}
      />
    )}

    {secretHistoryGate.open && (
      <div
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 110,
          background: 'rgba(10,12,16,0.62)',
          backdropFilter: 'blur(8px) saturate(120%)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 16,
        }}
        onClick={() => setSecretHistoryGate({ open: false, threadId: null })}
      >
        <div
          onClick={(e) => e.stopPropagation()}
          style={{
            width: 520,
            maxWidth: '96vw',
            borderRadius: 18,
            border: '1px solid var(--surface-border)',
            background: 'linear-gradient(180deg, var(--surface-200), var(--surface-100))',
            boxShadow: 'var(--shadow-medium)',
            padding: 18,
          }}
        >
          <div style={{ fontWeight: 900, fontSize: 18, color: 'var(--text-primary)', marginBottom: 6 }}>
            Секретные чаты защищены
          </div>
          <div style={{ color: 'var(--text-muted)', fontSize: 14, lineHeight: '18px', marginBottom: 16 }}>
            Чтобы читать прошлые сообщения на этом устройстве, привяжи его к одному из доверенных устройств.
          </div>
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
            <button
              className="btn btn-secondary"
              onClick={async () => {
                const threadId = secretHistoryGate.threadId
                if (!threadId) {
                  setSecretHistoryGate({ open: false, threadId: null })
                  return
                }
                // "Continue without history" MUST NOT rotate/generate a new thread key.
                // Rotating key without epochs would cause A and B to diverge and stop decrypting each other.
                // We simply dismiss the gate; messages will still queue until keys arrive (Link Device / key package).
                try {
                  localStorage.setItem(`eb_secret_history_dismissed:${threadId}`, String(Date.now()))
                } catch {}
                setSecretHistoryGate({ open: false, threadId: null })
                client.invalidateQueries({ queryKey: ['messages', threadId] })
              }}
            >
              Продолжить без истории
            </button>
            <button
              className="btn btn-primary"
              onClick={() => {
                setSecretHistoryGate({ open: false, threadId: secretHistoryGate.threadId })
                setLinkDeviceModalOpen(true)
              }}
            >
              Привязать устройство
            </button>
          </div>
        </div>
      </div>
    )}

    <LinkDeviceModal
      open={linkDeviceModalOpen}
      onClose={() => setLinkDeviceModalOpen(false)}
      mode="new"
    />
    </>
  )
}

function makeParticipantsKey(list: Array<{ user: { id: string } }> | undefined | null): string {
  return (list ?? []).map((p) => p.user.id).sort().join(',')
}
