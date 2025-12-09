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
import { LiveKitRoom, VideoConference } from '@livekit/components-react'
import '@livekit/components-styles'
import { api } from '../../utils/api'
import { joinCallRoom, requestCallStatuses, leaveCallRoom } from '../../utils/socket'
import { useAppStore } from '../../domain/store/appStore'
import { Minimize2 } from 'lucide-react'

type Props = {
  open: boolean
  conversationId: string | null
  onClose: (options?: { manual?: boolean }) => void
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

export function CallOverlay({ open, conversationId, onClose, onMinimize, minimized = false, initialVideo = false, initialAudio = true, peerAvatarUrl = null, avatarsByName = {}, avatarsById = {}, localUserId = null, isGroup = false }: Props) {
  const [token, setToken] = useState<string | null>(null)
  const [serverUrl, setServerUrl] = useState<string | null>(null)
  const [muted, setMuted] = useState(!initialAudio)
  const [camera, setCamera] = useState(!!initialVideo)
  const [isDesktop, setIsDesktop] = useState<boolean>(() => (typeof window !== 'undefined' ? window.innerWidth > 768 : true))
  const [wasConnected, setWasConnected] = useState(false)
  const me = useAppStore((s) => s.session?.user)

  const closingRef = useRef(false)
  const manualCloseRef = useRef(false)
  const myAvatar = useMemo(() => me?.avatarUrl ?? null, [me?.avatarUrl])
  const handleClose = useCallback((options?: { manual?: boolean }) => {
    // Позволяем повторные вызовы, чтобы не зависать в состоянии закрытия.
    // Дополнительные вызовы idempotent, но обеспечивают выход из оверлея,
    // даже если первый вызов был прерван.
    if (!closingRef.current) {
      closingRef.current = true
    }
    if (options?.manual) {
      manualCloseRef.current = true
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
    const effectiveOptions = manualCloseRef.current ? { ...(options ?? {}), manual: true } : options
    onClose(effectiveOptions)
  }, [conversationId, isGroup, onClose])
  const videoContainCss = `
    /* Force videos to fit tile without cropping on all layouts */
    .call-container video { object-fit: contain !important; background: #000 !important; }
    .call-container .lk-participant-tile video,
    .call-container .lk-participant-media video,
    .call-container .lk-video-tile video,
    .call-container .lk-stage video,
    .call-container .lk-grid-stage video { object-fit: contain !important; background: #000 !important; }
    
    /* Ensure placeholder stays circular and doesn't stretch */
    .call-container .lk-participant-placeholder {
      aspect-ratio: 1 !important;
      border-radius: 50% !important;
      margin: auto !important;
      align-self: center !important;
      flex-shrink: 0 !important;
    }
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
    if (!open) {
      closingRef.current = false
      manualCloseRef.current = false
    }
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
                setTimeout(() => handleClose({ manual: true }), 0)
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
    const peerAvatarRef = peerAvatarUrl || null
    
    // Логируем словари один раз при открытии оверлея с полным содержимым
    const byIdEntries = Object.entries(byIdRef)
    const byNameEntries = Object.entries(byNameRef)
    console.log('[CallOverlay] Avatar maps initialized:', {
      byId: byIdEntries.length,
      byName: byNameEntries.length,
      byIdEntries: byIdEntries.map(([id, url]) => ({ id, url: url ? 'present' : 'null' })), // Упрощенный вид для читаемости
      byNameEntries: byNameEntries.map(([name, url]) => ({ name, url: url ? 'present' : 'null' })), // Упрощенный вид для читаемости
      localIdRef: localIdRef || '(empty)',
      myAvatar: myAvatarRef ? 'present' : 'missing',
      peerAvatar: peerAvatarRef ? 'present' : 'missing',
      // Полные словари для детальной проверки (раскомментировать при необходимости)
      // byIdMap: byIdRef,
      // byNameMap: byNameRef
    })
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
        // Проверяем несколько мест, где может быть identity
        let identity = ''
        
        // Собираем все data-атрибуты для отладки
        const allDataAttrs: Record<string, string> = {}
        for (let i = 0; i < tile.attributes.length; i++) {
          const attr = tile.attributes[i]
          if (attr.name.startsWith('data-')) {
            allDataAttrs[attr.name] = attr.value
          }
        }
        
        // 1. Проверяем data-lk-participant-identity на самом элементе
        const idAttrOnTile = tile.getAttribute('data-lk-participant-identity')
        if (idAttrOnTile) {
          identity = idAttrOnTile.trim()
        }
        
        // 2. Ищем в дочерних элементах
        if (!identity) {
          const idAttrEl = tile.querySelector('[data-lk-participant-identity]') as HTMLElement | null
          if (idAttrEl) {
            identity = (idAttrEl.getAttribute('data-lk-participant-identity') || '').trim()
          }
        }
        
        // 3. Проверяем dataset напрямую
        if (!identity) {
          const datasetId = (tile.dataset as any)?.lkParticipantIdentity || (tile as any).dataset?.lkParticipantIdentity
          if (datasetId) {
            identity = String(datasetId).trim()
          }
        }
        
        // 4. Проверяем другие возможные варианты атрибутов
        if (!identity) {
          const altAttrs = ['data-participant-identity', 'data-identity', 'data-participant-id', 'data-user-id']
          for (const attrName of altAttrs) {
            const val = tile.getAttribute(attrName)
            if (val) {
              identity = val.trim()
              break
            }
          }
        }
        
        // 5. Извлекаем метаданные
        const metadataAttr = tile.getAttribute('data-lk-participant-metadata') || (tile.dataset ? tile.dataset.lkParticipantMetadata : '') || ''
        let participantMeta: Record<string, any> | null = null
        if (metadataAttr) {
          try {
            participantMeta = JSON.parse(metadataAttr)
          } catch {
            participantMeta = null
          }
        }
        // 6. Извлекаем identity из метаданных (приоритет метаданных)
        if (participantMeta?.userId) {
          identity = String(participantMeta.userId).trim()
        }
        
        // 7. Если identity все еще пустой, логируем только один раз (не для каждого обновления)
        // Логирование отключено для уменьшения шума, включаем только при необходимости
        // if (!identity) {
        //   console.log('[CallOverlay] Identity not found in tile, all data attributes:', allDataAttrs, 'metadata:', participantMeta, 'tile classes:', tile.className)
        // }
        let name = (nameEl.textContent || nameEl.getAttribute('data-lk-participant-name') || '').trim()
        if (!name && participantMeta?.displayName) {
          name = String(participantMeta.displayName).trim()
        }
        if (!name) {
          const meta = tile.querySelector('.lk-participant-metadata') as HTMLElement | null
          if (meta?.textContent?.trim()) name = meta.textContent.trim()
        }
        if (!name) name = identity || ''
        
        // Определяем локального участника СТРОГО: только если identity точно совпадает с localUserId
        // Это критически важно, чтобы не показывать мой аватар для других участников
        const identityMatchesLocal = !!(identity && localIdRef && identity === localIdRef)
        const isLocal = identityMatchesLocal
        
        // Сначала пытаемся найти аватар по identity (самый надежный способ)
        const idUrl = identity ? (byIdRef[identity] ?? null) : null
        
        // Затем по имени (case-insensitive)
        const key = Object.keys(byNameRef).find((k) => k.toLowerCase() === name.toLowerCase())
        const url = key ? byNameRef[key] : null
        
        // Используем мой аватар ТОЛЬКО если это точно локальный участник (identity совпадает)
        // И только если не нашли аватар по identity или имени
        const myUrl = myAvatarRef
        // Если это не локальный участник и не нашли аватар, используем peerAvatarUrl как fallback
        // (полезно для 1:1 звонков, когда передается peerAvatarUrl)
        // Также используем peerAvatarUrl если имя найдено, но аватар не найден в словаре
        const peerUrl = !isLocal ? peerAvatarRef : null
        // Приоритет: idUrl > url > (для локального: myUrl) > (для нелокального: peerUrl)
        let finalUrl = idUrl ?? url ?? (isLocal ? (myUrl || (localIdRef ? byIdRef[localIdRef] ?? null : null)) : peerUrl)
        const fallbackUrl = buildLetterDataUrl(name || identity || 'U', identity || name || 'U')
        
        // Логирование для отладки - всегда включено для диагностики проблемы
        if (!finalUrl && (identity || name)) {
          const nameKeys = Object.keys(byNameRef)
          const nameMatch = name ? nameKeys.find(k => k.toLowerCase() === name.toLowerCase()) : null
          console.log('[CallOverlay Avatar Debug] Avatar not found:', {
            identity: identity || '(empty)',
            name: name || '(empty)',
            isLocal,
            localIdRef: localIdRef || '(empty)',
            idUrl: idUrl || '(not found)',
            url: url || '(not found)',
            peerUrl: peerUrl || '(not found)',
            peerAvatarRef: peerAvatarRef || '(not set)',
            finalUrl: finalUrl || '(using fallback)',
            byIdEntries: Object.entries(byIdRef), // [id, avatarUrl] пары
            byNameEntries: Object.entries(byNameRef), // [name, avatarUrl] пары
            byIdHasIdentity: identity ? (identity in byIdRef) : false,
            byNameHasName: !!nameMatch,
            nameMatch: nameMatch || '(no match)',
            allNameKeys: nameKeys, // Все ключи в словаре имен
            participantMeta: participantMeta ? { userId: participantMeta.userId, displayName: participantMeta.displayName } : null
          })
        }
        
        // Remove default svg completely and any background
        placeholder.querySelectorAll('svg').forEach((svg) => svg.remove())
        placeholder.querySelectorAll('svg').forEach((svg) => ((svg as SVGElement).style.display = 'none'))
        // Create or update img
        let img = placeholder.querySelector('img.eb-ph') as HTMLImageElement | null
        if (!img) {
          img = document.createElement('img')
          img.className = 'eb-ph'
          placeholder.appendChild(img)
          // Обработчик ошибок загрузки - если аватар не загрузился, показываем fallback
          img.onerror = () => {
            if (img && img.src !== fallbackUrl) {
              console.log('[CallOverlay] Avatar image failed to load, using fallback:', img.src)
              img.src = fallbackUrl
            }
          }
        }
        // Обновляем src только если он изменился, чтобы избежать лишних перезагрузок
        if (img.src !== (finalUrl || fallbackUrl)) {
          img.src = finalUrl || fallbackUrl
        }
        // Calculate size based on smaller dimension of tile to ensure circle
        const tileRect = tile.getBoundingClientRect()
        const tileMinDimension = Math.min(tileRect.width, tileRect.height)
        // Use 95% of the smaller dimension for placeholder
        const placeholderSize = Math.floor(tileMinDimension * 0.95)
        
        // Set placeholder size to ensure it's always circular
        placeholder.style.width = `${placeholderSize}px`
        placeholder.style.height = `${placeholderSize}px`
        placeholder.style.maxWidth = `${placeholderSize}px`
        placeholder.style.maxHeight = `${placeholderSize}px`
        placeholder.style.minWidth = `${placeholderSize}px`
        placeholder.style.minHeight = `${placeholderSize}px`
        placeholder.style.flexShrink = '0'
        ;(placeholder.style as any).display = 'flex'
        placeholder.style.alignItems = 'center'
        placeholder.style.justifyContent = 'center'
        placeholder.style.background = 'transparent'
        placeholder.style.backgroundImage = 'none'
        placeholder.style.color = 'transparent'
        placeholder.style.fontSize = '0'
        placeholder.style.overflow = 'hidden'
        placeholder.style.margin = 'auto'
        // keep placeholder circular - always use smaller dimension
        placeholder.style.borderRadius = '50%'
        placeholder.style.aspectRatio = '1'
        
        img.alt = name
        // Ensure avatar fills the placeholder and stays circular
        img.style.aspectRatio = '1' // Ensure square shape
        img.style.width = '100%'
        img.style.height = '100%'
        img.style.maxWidth = '100%'
        img.style.maxHeight = '100%'
        img.style.objectFit = 'cover'
        img.style.borderRadius = '50%'
        img.style.display = 'block'
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
            console.log('[CallOverlay] onDisconnected:', reason, 'wasConnected:', wasConnected, 'isGroup:', isGroup, 'minimized:', minimized)
            const hadConnection = wasConnected
            setWasConnected(false)
            const manual = reason === 1 || manualCloseRef.current
            // Если оверлей минимизирован, не закрываем его при отключении - это может быть временное отключение
            if (minimized) {
              return
            }
            // Для 1:1 звонков закрываем только при ручном закрытии (когда пользователь нажал "Leave")
            // Для временных отключений полагаемся на события с сервера (call:ended)
            if (isGroup) {
              // Для групповых звонков закрываем при любом отключении, если было подключение
              if (hadConnection) {
                handleClose({ manual })
              }
            } else {
              // Для 1:1 звонков закрываем только при явном ручном закрытии
              // Временные отключения обрабатываются через call:ended событие с сервера
              if (manual) {
                handleClose({ manual: true })
              }
              // Если не было подключения и это не ручное закрытие, не закрываем
              // (может быть ошибка подключения, но звонок еще активен на сервере)
            }
          }}
        >
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


