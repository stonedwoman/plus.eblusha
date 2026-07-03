/**
 * Модальные окна и оверлеи страницы чатов (карточки профиля, создание беседы,
 * контакты, контекст-меню сообщения, лайтбокс, просмотр видео, пересылка и т.п.).
 * Вынесено из ChatsPage; обычная функция рендера, значения — через ctx.
 */
import { lazy } from 'react'

import { api, getUploadUrl } from '../../../../utils/api'
import type { AxiosError } from 'axios'

import { X, Users, UserPlus, Copy, UploadCloud, CheckCircle, Trash2, LogOut, Lock, Unlock, Monitor, Smartphone, Tablet, ImagePlus, MessageCircle, Loader2, RefreshCw, Pencil } from 'lucide-react'
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

import { getStoredDeviceInfo } from '../../../../domain/device/deviceManager'
import { wipeLocalDeviceData } from '../../../../domain/device/deviceWipe'
import { e2eeManager } from '../../../../domain/e2ee/e2eeManager'

import { LinkPreviewCard } from '../components/LinkPreviewCard'
import { MessageReactionRail } from '../components/MessageReactionRail'

import { copyImageFromUrl, copyPlainText } from '../../../../utils/clipboard'

import { VoiceMessagePlayer } from '../components/VoiceMessagePlayer'
import { DeviceLinkInline } from '../components/DeviceLinkInline'
import { useChatAudio } from '../hooks/useChatAudio'
import { useChatSocketSubscriptions } from '../hooks/useChatSocketSubscriptions'
import { useChatTyping } from '../hooks/useChatTyping'
import { useChatsResponsive } from '../hooks/useChatsResponsive'

import { buildMessageCopyText, previewTextForReplyDraft, firstImageAttachmentStubForQuote, buildReplyDraftFromMessages, buildForwardSourceContextForSend, recencyTimestampForConversationRow, buildForwardSendPayload } from '../chatsMessages'

export interface ChatModalsCtx {
  activeConversation: any
  activeId: any
  activePendingMessages: any
  addParticipantsEblDigits: any
  addParticipantsEblRefs: any
  addParticipantsFoundUser: any
  addParticipantsFoundUserStatus: any
  addParticipantsLoading: any
  addParticipantsModal: any
  addParticipantsMode: any
  addParticipantsSearchError: any
  addParticipantsSearching: any
  addParticipantsSelectedIds: any
  applyEblidPaste: any
  availabilityContext: any
  avatarPresenceForUser: any
  avatarPresenceForUserIdAndStatus: any
  avatarPreviewUrl: any
  clearEblidSearch: any
  clearMessageMultiSelect: any
  client: any
  closeAddParticipantsModal: any
  closeNewGroupModal: any
  composerEditorRef: any
  contactsInviteCode: any
  contactsInviteCopied: any
  contactsInviteRefreshing: any
  contactsInviteRemainingLabel: any
  contactsOpen: any
  contactsQuery: any
  contextMenu: any
  convMenu: any
  convMenuRef: any
  conversationsQuery: any
  copyContactsInviteCode: any
  copyMyEblid: any
  creatingGroup: any
  crop: any
  cropCanvasRef: any
  currentUserId: any
  devicesQuery: any
  displayOutgoingWithRejected: any
  displayedMessages: any
  eblDigits: any
  eblRefs: any
  editorRef: any
  effectiveUserStatus: any
  eligibleContactsForAdd: any
  fileInputRef: any
  formatPresence: any
  formattedContactsInviteCode: any
  forwardModal: any
  foundUser: any
  getSelectedMessagesOrdered: any
  groupAvatarEditor: any
  groupAvatarPreviewUrl: any
  groupCrop: any
  groupCropCanvasRef: any
  groupEditorRef: any
  groupFileInputRef: any
  groupImageRef: any
  groupSelectedAvatarFile: any
  groupTitle: any
  groupTitleEditValue: any
  handleAddParticipantByEbl: any
  handleAddParticipants: any
  headerMenu: any
  headerMenuRef: any
  identityBottomRowStyle: any
  identityBubbleStyle: any
  identityDividerStyle: any
  identityHelperTextStyle: any
  identityIconButtonStyle: any
  identityInputsRowStyle: any
  identitySectionHeaderStyle: any
  identitySectionTitleStyle: any
  imageRef: any
  incomingContactsQuery: any
  initiateSecretChat: any
  isMobile: any
  lightbox: any
  linkDeviceModalOpen: any
  localDeviceIdForLinking: any
  me: any
  meInfoQuery: any
  mePopupOpen: any
  menuRef: any
  multiSelectMode: any
  myEblid: any
  myEblidCopied: any
  myEblidMiniCardStyle: any
  myPresence: any
  newGroupAvatarBlob: any
  newGroupAvatarEditorOpen: any
  newGroupAvatarFile: any
  newGroupAvatarHover: any
  newGroupAvatarPreviewUrl: any
  newGroupAvatarSourceUrl: any
  newGroupCrop: any
  newGroupCropCanvasRef: any
  newGroupDragOver: any
  newGroupEditorRef: any
  newGroupFileInputRef: any
  newGroupImageRef: any
  newGroupOpen: any
  onChangeAddParticipantsDigit: any
  onChangeDigit: any
  onKeyDownAddParticipantsDigit: any
  onKeyDownDigit: any
  openUserCard: any
  outgoingContactsQuery: any
  presenceGameByUserId: any
  refreshContactsInviteCode: any
  registrationInviteCodeQuery: any
  registrationMiniCardStyle: any
  resolveFirstImageAttachmentUrl: any
  savingGroupTitle: any
  secretHistoryGate: any
  secretRequestLoading: any
  selectConversation: any
  selectedAvatarFile: any
  selectedIds: any
  selectedMessageIds: any
  sendInvite: any
  sendMessageToConversation: any
  sendingInvite: any
  setActiveId: any
  setAddParticipantsEblDigits: any
  setAddParticipantsFoundUser: any
  setAddParticipantsModal: any
  setAddParticipantsMode: any
  setAddParticipantsSearchError: any
  setAddParticipantsSearching: any
  setAddParticipantsSelectedIds: any
  setAvailabilityContext: any
  setAvatarPreviewUrl: any
  setContactsOpen: any
  setContextMenu: any
  setConvMenu: any
  setCreatingGroup: any
  setCrop: any
  setEndSecretModalOpen: any
  setForwardComposerDraft: any
  setForwardModal: any
  setGroupAvatarEditor: any
  setGroupAvatarPreviewUrl: any
  setGroupCrop: any
  setGroupSelectedAvatarFile: any
  setGroupTitle: any
  setGroupTitleEditValue: any
  setHeaderMenu: any
  setLightbox: any
  setLinkDeviceModalOpen: any
  setMePopupOpen: any
  setMobileView: any
  setMultiSelectMode: any
  setNewGroupAvatarBlob: any
  setNewGroupAvatarEditorOpen: any
  setNewGroupAvatarFile: any
  setNewGroupAvatarHover: any
  setNewGroupAvatarPreviewUrl: any
  setNewGroupAvatarSourceUrl: any
  setNewGroupCrop: any
  setNewGroupDragOver: any
  setRejectedOutgoing: any
  setReplyTo: any
  setSavingGroupTitle: any
  setSecretHistoryGate: any
  setSelectedAvatarFile: any
  setSelectedIds: any
  setSelectedMessageIds: any
  setUploadMessage: any
  setUploadProgress: any
  setUploadingAvatar: any
  setUserCardUser: any
  setVideoViewer: any
  sortedAcceptedContacts: any
  startEdit: any
  uploadMessage: any
  uploadProgress: any
  uploadingAvatar: any
  userCardUser: any
  usersById: any
  videoViewer: any
}

export function renderChatModals(ctx: ChatModalsCtx) {
  const { activeConversation, activeId, activePendingMessages, addParticipantsEblDigits, addParticipantsEblRefs, addParticipantsFoundUser, addParticipantsFoundUserStatus, addParticipantsLoading, addParticipantsModal, addParticipantsMode, addParticipantsSearchError, addParticipantsSearching, addParticipantsSelectedIds, applyEblidPaste, availabilityContext, avatarPresenceForUser, avatarPresenceForUserIdAndStatus, avatarPreviewUrl, clearEblidSearch, clearMessageMultiSelect, client, closeAddParticipantsModal, closeNewGroupModal, composerEditorRef, contactsInviteCode, contactsInviteCopied, contactsInviteRefreshing, contactsInviteRemainingLabel, contactsOpen, contactsQuery, contextMenu, convMenu, convMenuRef, conversationsQuery, copyContactsInviteCode, copyMyEblid, creatingGroup, crop, cropCanvasRef, currentUserId, devicesQuery, displayOutgoingWithRejected, displayedMessages, eblDigits, eblRefs, editorRef, effectiveUserStatus, eligibleContactsForAdd, fileInputRef, formatPresence, formattedContactsInviteCode, forwardModal, foundUser, getSelectedMessagesOrdered, groupAvatarEditor, groupAvatarPreviewUrl, groupCrop, groupCropCanvasRef, groupEditorRef, groupFileInputRef, groupImageRef, groupSelectedAvatarFile, groupTitle, groupTitleEditValue, handleAddParticipantByEbl, handleAddParticipants, headerMenu, headerMenuRef, identityBottomRowStyle, identityBubbleStyle, identityDividerStyle, identityHelperTextStyle, identityIconButtonStyle, identityInputsRowStyle, identitySectionHeaderStyle, identitySectionTitleStyle, imageRef, incomingContactsQuery, initiateSecretChat, isMobile, lightbox, linkDeviceModalOpen, localDeviceIdForLinking, me, meInfoQuery, mePopupOpen, menuRef, multiSelectMode, myEblid, myEblidCopied, myEblidMiniCardStyle, myPresence, newGroupAvatarBlob, newGroupAvatarEditorOpen, newGroupAvatarFile, newGroupAvatarHover, newGroupAvatarPreviewUrl, newGroupAvatarSourceUrl, newGroupCrop, newGroupCropCanvasRef, newGroupDragOver, newGroupEditorRef, newGroupFileInputRef, newGroupImageRef, newGroupOpen, onChangeAddParticipantsDigit, onChangeDigit, onKeyDownAddParticipantsDigit, onKeyDownDigit, openUserCard, outgoingContactsQuery, presenceGameByUserId, refreshContactsInviteCode, registrationInviteCodeQuery, registrationMiniCardStyle, resolveFirstImageAttachmentUrl, savingGroupTitle, secretHistoryGate, secretRequestLoading, selectConversation, selectedAvatarFile, selectedIds, selectedMessageIds, sendInvite, sendMessageToConversation, sendingInvite, setActiveId, setAddParticipantsEblDigits, setAddParticipantsFoundUser, setAddParticipantsModal, setAddParticipantsMode, setAddParticipantsSearchError, setAddParticipantsSearching, setAddParticipantsSelectedIds, setAvailabilityContext, setAvatarPreviewUrl, setContactsOpen, setContextMenu, setConvMenu, setCreatingGroup, setCrop, setEndSecretModalOpen, setForwardComposerDraft, setForwardModal, setGroupAvatarEditor, setGroupAvatarPreviewUrl, setGroupCrop, setGroupSelectedAvatarFile, setGroupTitle, setGroupTitleEditValue, setHeaderMenu, setLightbox, setLinkDeviceModalOpen, setMePopupOpen, setMobileView, setMultiSelectMode, setNewGroupAvatarBlob, setNewGroupAvatarEditorOpen, setNewGroupAvatarFile, setNewGroupAvatarHover, setNewGroupAvatarPreviewUrl, setNewGroupAvatarSourceUrl, setNewGroupCrop, setNewGroupDragOver, setRejectedOutgoing, setReplyTo, setSavingGroupTitle, setSecretHistoryGate, setSelectedAvatarFile, setSelectedIds, setSelectedMessageIds, setUploadMessage, setUploadProgress, setUploadingAvatar, setUserCardUser, setVideoViewer, sortedAcceptedContacts, startEdit, uploadMessage, uploadProgress, uploadingAvatar, userCardUser, usersById, videoViewer } = ctx
  return (
    <>
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
                  <div style={{ fontSize: 18, color: 'var(--text-muted)', cursor: 'pointer', userSelect: 'none' }} onClick={() => setCrop((c: any) => ({ ...c, scale: Math.max(0.1, c.scale - 0.1) }))}>−</div>
                  <input 
                    type="range" 
                    min={0.1} 
                    max={10} 
                    step={0.05} 
                    value={crop.scale} 
                    onChange={(e) => setCrop((c: any) => ({ ...c, scale: parseFloat(e.target.value) }))} 
                    style={{ 
                      flex: 1, 
                      height: 6,
                      background: 'var(--surface-200)',
                      borderRadius: 3,
                      outline: 'none',
                      cursor: 'pointer'
                    }}
                  />
                  <div style={{ fontSize: 18, color: 'var(--text-muted)', cursor: 'pointer', userSelect: 'none' }} onClick={() => setCrop((c: any) => ({ ...c, scale: Math.min(10, c.scale + 0.1) }))}>+</div>
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
                    blobToSend = await new Promise<Blob | null>((resolve) => cropCanvasRef.current!.toBlob((b: any) => resolve(b), 'image/png'))
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
                      setNewGroupCrop((c: any) => ({
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
                        setNewGroupCrop((c: any) => ({ ...c, scale: next }))
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
                      setNewGroupCrop((c: any) => ({
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
                    canvas.toBlob((b: any) => resolve(b), 'image/png'),
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
                        setSelectedIds((prev: any) => (checked ? prev.filter((id: any) => id !== u.id) : [...prev, u.id]))
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
                {displayOutgoingWithRejected.map((item: any) =>
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
                        onClick={() => setRejectedOutgoing((p: any) => p.filter((r: any) => r.contactId !== item.id))}
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
                      const ids = getSelectedMessagesOrdered().map((m: any) => m.id)
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
                      const mine = msgs.filter((m: any) => m.senderId === me?.id)
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
                        setSelectedMessageIds((prev: any) => (prev.includes(mid) ? prev : [...prev, mid]))
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
      onClose={() => setLightbox((l: any) => ({ ...l, open: false }))}
      onIndexChange={(nextIndex) => setLightbox((l: any) => ({ ...l, index: nextIndex }))}
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
                        forwardPayloads.every((p: any) => String(p.type) === 'IMAGE')

                      setReplyTo(null)
                      setForwardComposerDraft({
                        destinationConversationId: String(c.id),
                        payloads: forwardPayloads.map((p: any) => ({ ...p })),
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
                        setAddParticipantsSelectedIds((prev: any) => (checked ? prev.filter((id: any) => id !== u.id) : [...prev, u.id]))
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
                  <div style={{ fontSize: 18, color: 'var(--text-muted)', cursor: 'pointer', userSelect: 'none' }} onClick={() => setGroupCrop((c: any) => ({ ...c, scale: Math.max(0.1, c.scale - 0.1) }))}>−</div>
                  <input 
                    type="range" 
                    min={0.1} 
                    max={10} 
                    step={0.01} 
                    value={groupCrop.scale} 
                    onChange={(e) => {
                      const newScale = parseFloat(e.target.value)
                      setGroupCrop((prev: any) => {
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
                  <div style={{ fontSize: 18, color: 'var(--text-muted)', cursor: 'pointer', userSelect: 'none' }} onClick={() => setGroupCrop((c: any) => ({ ...c, scale: Math.min(10, c.scale + 0.1) }))}>+</div>
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
                        blobToSend = await new Promise<Blob | null>((resolve) => groupCropCanvasRef.current!.toBlob((b: any) => resolve(b), 'image/png'))
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
