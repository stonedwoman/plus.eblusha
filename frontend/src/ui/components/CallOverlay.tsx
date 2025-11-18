import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

declare global {
  interface Window {
    __eblushaEnumeratePatched?: boolean
  }
}

if (typeof window !== 'undefined' && typeof navigator !== 'undefined' && navigator.mediaDevices && !window.__eblushaEnumeratePatched) {
  const originalEnumerate = navigator.mediaDevices.enumerateDevices.bind(navigator.mediaDevices)
  navigator.mediaDevices.enumerateDevices = async () => {
    const devices = await originalEnumerate()
    const ua = navigator.userAgent || ''
    const isIOS = /iP(ad|hone|od)/i.test(ua)
    if (!isIOS) return devices

    const fronts: MediaDeviceInfo[] = []
    const backs: MediaDeviceInfo[] = []
    const others: MediaDeviceInfo[] = []

    const classify = (label: string, id: string) => {
      const lowered = label.toLowerCase()
      if (/(front|перед|selfie|true depth|ultra wide front)/.test(lowered)) return 'front'
      if (/(back|rear|зад|tele|wide|камера на задней панели|камера на задней|задняя)/.test(lowered) || /(back|rear)/.test(id.toLowerCase())) return 'back'
      return 'other'
    }

    devices.forEach((d) => {
      if (d.kind !== 'videoinput') {
        others.push(d)
        return
      }
      const category = classify(d.label || '', d.deviceId || '')
      if (category === 'front') fronts.push(d)
      else if (category === 'back') backs.push(d)
      else backs.push(d) // treat unknown as back to keep at least one rear option
    })

    const result: MediaDeviceInfo[] = []
    if (fronts.length > 0) result.push(fronts[0])
    if (backs.length > 0) result.push(backs[0])
    if (result.length === 0 && devices.some((d) => d.kind === 'videoinput')) {
      // fallback: keep first video device if nothing classified
      const firstVideo = devices.find((d) => d.kind === 'videoinput')
      if (firstVideo) result.push(firstVideo)
    }
    // keep all non video devices
    others.forEach((d) => {
      if (d.kind !== 'videoinput') result.push(d)
    })

    return result
  }
  window.__eblushaEnumeratePatched = true
}
import { createPortal } from 'react-dom'
import { LiveKitRoom, VideoConference, useParticipants, useRoomContext } from '@livekit/components-react'
import '@livekit/components-styles'
import { api } from '../../utils/api'
import { joinCallRoom, requestCallStatuses, leaveCallRoom } from '../../utils/socket'
import { useAppStore } from '../../domain/store/appStore'
import { Minimize2 } from 'lucide-react'

type Props = {
  open: boolean
  conversationId: string | null
  onClose: () => void
  onMinimize?: () => void
  minimized?: boolean
  initialVideo?: boolean
  initialAudio?: boolean
  peerAvatarUrl?: string | null
  avatarsByName?: Record<string, string | null>
  avatarsById?: Record<string, string | null>
  localUserId?: string | null
  isGroup?: boolean
}

// Компонент для отслеживания участников и автоматического завершения звонка при отключении собеседника
function CallParticipantsTracker({ conversationId, isGroup, onPeerDisconnected }: { conversationId: string; isGroup: boolean; onPeerDisconnected: () => void }) {
  const room = useRoomContext()
  const participants = useParticipants()
  const me = useAppStore((s) => s.session?.user)
  const wasConnectedRef = useRef(false)
  const hadOtherParticipantsRef = useRef(false)
  
  useEffect(() => {
    if (!room || !me) return
    
    const handleConnected = () => {
      wasConnectedRef.current = true
      hadOtherParticipantsRef.current = false
    }
    
    const handleDisconnected = () => {
      wasConnectedRef.current = false
      hadOtherParticipantsRef.current = false
    }
    
    room.on('connected', handleConnected)
    room.on('disconnected', handleDisconnected)
    
    return () => {
      room.off('connected', handleConnected)
      room.off('disconnected', handleDisconnected)
    }
  }, [room, me])
  
  // Отслеживаем количество участников (исключая себя)
  useEffect(() => {
    if (!room || !wasConnectedRef.current || !me) return
    
    // Получаем локального участника
    const localParticipant = room.localParticipant
    if (!localParticipant) return
    
    // Фильтруем участников, исключая себя (локального участника)
    const otherParticipants = participants.filter(p => {
      // Проверяем, является ли участник локальным
      if (p.identity === localParticipant.identity || p.sid === localParticipant.sid) {
        return false
      }
      // Дополнительная проверка по metadata
      try {
        const metadata = p.metadata ? JSON.parse(p.metadata) : {}
        return metadata.userId !== me.id
      } catch {
        return true
      }
    })
    
    // Запоминаем, что был другой участник
    if (otherParticipants.length > 0) {
      hadOtherParticipantsRef.current = true
    }
    
    // Логика завершения звонка зависит от типа:
    // - Для 1:1 звонков: завершаем, когда остается только мы (1 участник)
    // - Для групповых звонков: завершаем только когда остается 0 участников (все вышли)
    if (otherParticipants.length === 0 && participants.length > 0 && room.state === 'connected' && hadOtherParticipantsRef.current) {
      if (isGroup) {
        // Для групп: завершаем только когда остается 0 участников (все вышли)
        // Если остался только один участник (мы), это нормально - не завершаем
        // Звонок завершится только когда последний участник выйдет
        // (это обрабатывается через onClose, когда пользователь нажимает "Сбросить")
      } else {
        // Для 1:1 звонков: завершаем, когда остается только мы (1 участник)
        if (participants.length === 1) {
          console.log('[CallOverlay] Peer disconnected in 1:1 call, ending call')
          hadOtherParticipantsRef.current = false // Сбрасываем флаг, чтобы не вызывать повторно
          onPeerDisconnected()
        }
      }
    }
  }, [participants, room, me, isGroup, onPeerDisconnected])
  
  return null
}

export function CallOverlay({ open, conversationId, onClose, onMinimize, minimized = false, initialVideo = false, initialAudio = true, peerAvatarUrl = null, avatarsByName = {}, avatarsById = {}, localUserId = null, isGroup = false }: Props) {
  const [token, setToken] = useState<string | null>(null)
  const [serverUrl, setServerUrl] = useState<string | null>(null)
  const [muted, setMuted] = useState(!initialAudio)
  const [camera, setCamera] = useState(!!initialVideo)
  const [isDesktop, setIsDesktop] = useState<boolean>(() => (typeof window !== 'undefined' ? window.innerWidth > 768 : true))
  const [wasConnected, setWasConnected] = useState(false)
  const me = useAppStore((s) => s.session?.user)

  const closingRef = useRef(false)
  const myAvatar = useMemo(() => me?.avatarUrl ?? null, [me?.avatarUrl])
  const handleClose = useCallback(() => {
    // Позволяем повторные вызовы, чтобы не зависать в состоянии закрытия.
    // Дополнительные вызовы idempotent, но обеспечивают выход из оверлея,
    // даже если первый вызов был прерван.
    if (!closingRef.current) {
      closingRef.current = true
    }
    if (conversationId && isGroup) {
      try {
        leaveCallRoom(conversationId)
      } catch (err) {
        console.error('Error leaving call room:', err)
      }
      try {
        requestCallStatuses([conversationId])
      } catch (err) {
        console.error('Error requesting call status update:', err)
      }
    }
    onClose()
  }, [conversationId, isGroup, onClose])
  const videoContainCss = `
    /* Force videos to fit tile without cropping on all layouts */
    .call-container video { object-fit: contain !important; background: #000 !important; }
    .call-container .lk-participant-tile video,
    .call-container .lk-participant-media video,
    .call-container .lk-video-tile video,
    .call-container .lk-stage video,
    .call-container .lk-grid-stage video { object-fit: contain !important; background: #000 !important; }
  `

  useEffect(() => {
    let mounted = true
    async function fetchToken() {
      if (!open || !conversationId) return
      const room = `conv-${conversationId}`
      const resp = await api.post('/livekit/token', { room, participantMetadata: { app: 'eblusha', userId: me?.id, displayName: me?.displayName ?? me?.username, avatarUrl: myAvatar } })
      if (!mounted) return
      setToken(resp.data.token)
      setServerUrl(resp.data.url)
    }
    fetchToken()
    return () => {
      mounted = false
      setToken(null)
      setServerUrl(null)
    }
  }, [open, conversationId])

  // Sync initial media flags on every open
  useEffect(() => {
    if (open) {
      setCamera(!!initialVideo)
      setMuted(!initialAudio)
      setWasConnected(false) // Reset connection state when opening
    }
  }, [open, initialVideo, initialAudio])

  // Lock body scroll on mobile during call
  useEffect(() => {
    if (!open) return
    const isMobile = typeof window !== 'undefined' && window.innerWidth <= 768
    if (isMobile) {
      const prevOverflow = document.body.style.overflow
      const prevTouch = (document.body.style as any).touchAction
      document.body.style.overflow = 'hidden'
      ;(document.body.style as any).touchAction = 'none'
      return () => {
        document.body.style.overflow = prevOverflow
        ;(document.body.style as any).touchAction = prevTouch
      }
    }
  }, [open])

  useEffect(() => {
    if (!open) closingRef.current = false
  }, [open])

  // track desktop/resize
  useEffect(() => {
    const onResize = () => setIsDesktop(typeof window !== 'undefined' ? window.innerWidth > 768 : true)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // Hide chat UI and localize tooltips, and add minimize button
  useEffect(() => {
    if (!open) return
    const root = document.body
    if (!root) return
    const translate = () => {
      const nodes = root.querySelectorAll('.call-container [aria-label], .call-container [title]')
      nodes.forEach((el) => {
        const a = (el as HTMLElement).getAttribute('aria-label') || (el as HTMLElement).getAttribute('title') || ''
        let ru = ''
        const s = a.toLowerCase()
        if (s.includes('microphone')) ru = a.includes('mute') ? 'Выключить микрофон' : 'Включить микрофон'
        else if (s.includes('camera')) ru = a.includes('disable') || s.includes('off') ? 'Выключить камеру' : 'Включить камеру'
        else if (s.includes('screen')) ru = s.includes('stop') ? 'Остановить показ экрана' : 'Поделиться экраном'
        else if (s.includes('flip')) ru = 'Сменить камеру'
        else if (s.includes('participants')) ru = 'Участники'
        else if (s.includes('settings')) ru = 'Настройки'
        else if (s.includes('leave') || s.includes('hang')) ru = 'Выйти'
        else if (s.includes('chat')) ru = 'Чат'
        if (ru) {
          ;(el as HTMLElement).setAttribute('aria-label', ru)
          ;(el as HTMLElement).setAttribute('title', ru)
        }
      })
      // hide chat toggle and panel (more robust)
      const chatNodes = root.querySelectorAll('.call-container .lk-chat, .call-container [data-lk-chat], .call-container [data-lk-chat-toggle], .call-container .lk-chat-toggle, .call-container .lk-button.lk-chat-toggle, .call-container button.lk-chat-toggle, .call-container [aria-label*="chat" i], .call-container [title*="chat" i]')
      chatNodes.forEach((el) => {
        const node = el as HTMLElement
        node.style.display = 'none'
        try { node.remove() } catch {}
      })
      
      // Add minimize button to control bar
      const controlBar = root.querySelector('.call-container .lk-control-bar, .call-container [data-lk-control-bar]') as HTMLElement | null
      if (controlBar && onMinimize) {
        // Check if minimize button already exists
        let minimizeBtn = controlBar.querySelector('.eb-minimize-btn') as HTMLElement | null
        if (!minimizeBtn) {
          minimizeBtn = document.createElement('button')
          minimizeBtn.className = 'eb-minimize-btn lk-button'
          minimizeBtn.setAttribute('aria-label', 'Свернуть')
          minimizeBtn.setAttribute('title', 'Свернуть')
          // Use ChevronDown icon (arrow down)
          minimizeBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>'
          minimizeBtn.style.cssText = 'display: flex; align-items: center; justify-content: center; background: var(--surface-100); color: var(--text-primary); border: 1px solid var(--surface-border); border-radius: 8px; padding: 8px; cursor: pointer; transition: background 0.2s ease;'
          minimizeBtn.onmouseenter = () => { minimizeBtn!.style.background = 'var(--surface-200)' }
          minimizeBtn.onmouseleave = () => { minimizeBtn!.style.background = 'var(--surface-100)' }
          minimizeBtn.onclick = (e) => { e.stopPropagation(); onMinimize() }
          
          // Insert before leave button (or at the end if not found)
          const leaveBtn = controlBar.querySelector('[aria-label*="Выйти" i], [title*="Выйти" i], [aria-label*="leave" i], [title*="leave" i]') as HTMLElement | null
          if (leaveBtn && leaveBtn.parentNode) {
            if (!(leaveBtn as any).__ebLeaveBound) {
              const handler = () => {
                // Даем LiveKit завершить обработку клика и только затем синхронизируем наш стейт
                setTimeout(() => handleClose(), 0)
              }
              leaveBtn.addEventListener('click', handler)
              ;(leaveBtn as any).__ebLeaveBound = handler
            }
            leaveBtn.parentNode.insertBefore(minimizeBtn, leaveBtn)
          } else {
            controlBar.appendChild(minimizeBtn)
          }
        }
      }
    }
    const mo = new MutationObserver(() => translate())
    mo.observe(root, { childList: true, subtree: true, attributes: true })
    translate()
    return () => mo.disconnect()
  }, [open, onMinimize, handleClose])

  // Inject avatars into participant placeholders using names
  useEffect(() => {
    if (!open) return
    const root = document.body
    if (!root) return
    // freeze props into locals to avoid any temporal dead zone/minifier aliasing issues
    const byNameRef = avatarsByName || {}
    const byIdRef = avatarsById || {}
    const localIdRef = localUserId || null
    const myAvatarRef = myAvatar || null
    const colorFromId = (id: string) => {
      let hash = 0
      for (let i = 0; i < id.length; i++) hash = id.charCodeAt(i) + ((hash << 5) - hash)
      const hue = Math.abs(hash) % 360
      return `hsl(${hue} 70% 45%)`
    }
    const buildLetterDataUrl = (label: string, id: string) => {
      const bg = colorFromId(id || label || 'x')
      const letter = (label || '?').trim().charAt(0).toUpperCase()
      const svg = `<?xml version="1.0" encoding="UTF-8"?><svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 256 256\"><defs/><rect width=\"256\" height=\"256\" rx=\"128\" fill=\"${bg}\"/><text x=\"50%\" y=\"54%\" dominant-baseline=\"middle\" text-anchor=\"middle\" font-size=\"140\" font-family=\"Inter, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif\" fill=\"#ffffff\">${letter}</text></svg>`
      return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`
    }
    const apply = () => {
      const tiles = root.querySelectorAll('.call-container .lk-participant-tile, .call-container [data-participant]') as NodeListOf<HTMLElement>
      tiles.forEach((tile) => {
        const nameEl = tile.querySelector('.lk-participant-name, [data-lk-participant-name]') as HTMLElement | null
        const placeholder = tile.querySelector('.lk-participant-placeholder') as HTMLElement | null
        if (!nameEl || !placeholder) return
        // identity lookup preferred (must compute before using as a fallback for name)
        const idAttrEl = tile.getAttribute('data-lk-participant-identity') ? tile : (tile.querySelector('[data-lk-participant-identity]') as HTMLElement | null)
        const identity = idAttrEl ? (idAttrEl.getAttribute('data-lk-participant-identity') || '').trim() : ''
        let name = (nameEl.textContent || nameEl.getAttribute('data-lk-participant-name') || '').trim()
        if (!name) {
          const meta = tile.querySelector('.lk-participant-metadata') as HTMLElement | null
          if (meta?.textContent?.trim()) name = meta.textContent.trim()
        }
        if (!name) name = identity || ''
        const idUrl = identity ? (byIdRef[identity] ?? null) : null
        // normalize and lookup case-insensitive
        const key = Object.keys(byNameRef).find((k) => k.toLowerCase() === name.toLowerCase())
        const url = key ? byNameRef[key] : null
        const myUrl = myAvatarRef
        // fallback: если это локальная плитка (есть значок self/микрофона с подсказкой), подставим мой аватар
        const hasLocalAttr = tile.hasAttribute('data-lk-local-participant') || tile.hasAttribute('data-lk-local') || tile.classList.contains('lk-local-participant')
        const isLocal = !!(hasLocalAttr || tile.querySelector('.lk-local-indicator') || /\b(you|вы)\b/i.test(name) || (identity && localIdRef && identity === localIdRef))
        let finalUrl = idUrl ?? url ?? (isLocal ? (myUrl || (localIdRef ? byIdRef[localIdRef] ?? null : null)) : null)
        const fallbackUrl = buildLetterDataUrl(name || identity || 'U', identity || name || 'U')
        // Remove default svg completely and any background
        placeholder.querySelectorAll('svg').forEach((svg) => svg.remove())
        placeholder.querySelectorAll('svg').forEach((svg) => ((svg as SVGElement).style.display = 'none'))
        // Create or update img
        let img = placeholder.querySelector('img.eb-ph') as HTMLImageElement | null
        if (!img) {
          img = document.createElement('img')
          img.className = 'eb-ph'
          placeholder.appendChild(img)
        }
        img.src = finalUrl || fallbackUrl
        img.alt = name
        // Ensure avatar never overflows tile bounds
        img.style.width = 'auto'
        img.style.height = 'auto'
        img.style.maxWidth = '85%'
        img.style.maxHeight = '85%'
        img.style.objectFit = 'cover'
        img.style.borderRadius = '50%'
        img.style.display = 'block'
        ;(placeholder.style as any).display = 'flex'
        placeholder.style.alignItems = 'center'
        placeholder.style.justifyContent = 'center'
        placeholder.style.background = 'transparent'
        placeholder.style.backgroundImage = 'none'
        placeholder.style.color = 'transparent'
        placeholder.style.fontSize = '0'
        placeholder.style.overflow = 'hidden'
        // keep placeholder circular if LiveKit tile uses round placeholders
        try { (placeholder.style as any).borderRadius = '50%' } catch {}
        Array.from(placeholder.childNodes).forEach((n) => {
          if (n.nodeType === Node.TEXT_NODE) {
            (n as any).textContent = ''
          }
        })
      })
    }
    const mo = new MutationObserver(apply)
    mo.observe(root, { childList: true, subtree: true })
    apply()
    return () => mo.disconnect()
  }, [open, avatarsByName, avatarsById, localUserId, myAvatar])

  if (!open || !conversationId || !token || !serverUrl) return null

  const overlay = (
    <div className="call-overlay" style={{
      position: 'fixed', inset: 0, background: minimized ? 'transparent' : 'rgba(10,12,16,0.55)', backdropFilter: minimized ? 'none' : 'blur(4px) saturate(110%)', display: minimized ? 'none' : 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
      pointerEvents: minimized ? 'none' : 'auto',
    }}>
      <div data-lk-theme="default" style={{ 
        width: minimized ? 0 : '90vw', 
        height: minimized ? 0 : '80vh', 
        maxWidth: minimized ? 0 : 1200, 
        background: 'var(--surface-200)', 
        borderRadius: 16, 
        overflow: minimized ? 'hidden' : 'hidden', 
        position: 'relative', 
        border: '1px solid var(--surface-border)', 
        boxShadow: minimized ? 'none' : 'var(--shadow-sharp)',
        opacity: minimized ? 0 : 1,
        visibility: minimized ? 'hidden' : 'visible',
      }} className="call-container">
        <style>{videoContainCss}</style>
        <LiveKitRoom 
          serverUrl={serverUrl} 
          token={token} 
          connect 
          video={camera} 
          audio={!muted} 
          onConnected={() => { 
            setWasConnected(true)
            try { 
              if (conversationId && isGroup) { 
                console.log('[CallOverlay] joinCallRoom emit', { conversationId, video: initialVideo })
                joinCallRoom(conversationId, initialVideo)
                requestCallStatuses([conversationId]) 
              } 
            } catch (err) {
              console.error('Error joining call room:', err)
            }
          }}
          onDisconnected={(reason) => {
            console.log('[CallOverlay] onDisconnected:', reason, 'wasConnected:', wasConnected, 'isGroup:', isGroup)
            const hadConnection = wasConnected
            setWasConnected(false)
            if (hadConnection) {
              handleClose()
            } else if (!isGroup) {
              handleClose()
            }
          }}
        >
          <CallParticipantsTracker 
            conversationId={conversationId}
            isGroup={isGroup}
            onPeerDisconnected={() => {
              handleClose()
            }}
          />
          <div style={{ width: '100%', height: '100%' }}>
            <VideoConference />
          </div>
        </LiveKitRoom>
        {/* avatar overlay removed; avatars are injected into placeholders */}
      </div>
    </div>
  )

  return createPortal(overlay, document.body)
}


