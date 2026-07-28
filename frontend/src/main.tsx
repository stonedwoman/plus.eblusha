import React from 'react'
import ReactDOM from 'react-dom/client'
import './style.css'
import { RouterProvider } from 'react-router-dom'
import { Suspense, useEffect, useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import './utils/i18n'
import { router } from './router'
import { useAppStore } from './domain/store/appStore'
import { connectSocket } from './core/realtime'
import { api } from './core/api'
import { forceRefreshSession, getAccessExpMs, validateStoredSession } from './core/auth'
import { ensureDeviceBootstrap } from './domain/device/deviceManager'
import { Capacitor } from '@capacitor/core' // Import Capacitor
import NativeSocket from './capacitor/plugins/native-socket-plugin'
import LoadingSpinner from './ui/components/LoadingSpinner'
import { appLifecycle } from './core/lifecycle/appLifecycle'
import { nativeBridge } from './platform/native-bridge/bridge'
import { startHangWatchdog } from './core/diagnostics/hangWatchdog'

// Quiet console by default (prod + web): keep warn/error, suppress log/info/debug unless explicitly enabled.
// Enable with: localStorage.setItem('eb-debug', '1') or ?debug=1
if (typeof window !== 'undefined' && !(window as any).__ebConsolePatched) {
  ;(window as any).__ebConsolePatched = true
  const isDebugEnabled = (() => {
    try {
      const qs = new URLSearchParams(window.location.search)
      const q = qs.get('debug')
      if (q === '1' || q === 'true') return true
      const raw = window.localStorage.getItem('eb-debug')
      return raw === '1' || raw === 'true'
    } catch {
      return false
    }
  })()

  const originalLog = console.log.bind(console)
  const originalInfo = (console.info ? console.info.bind(console) : originalLog)
  const originalDebug = (console.debug ? console.debug.bind(console) : originalLog)

  if (!isDebugEnabled) {
    console.log = () => {}
    console.info = () => {}
    console.debug = () => {}
  } else {
    // Optional: also forward logs to Capacitor logcat when debugging on native.
    console.log = (...args: any[]) => {
      originalLog(...args)
      if (typeof (window as any).Capacitor !== 'undefined') {
        try {
          ;(window as any).Capacitor.Plugins?.Console?.log?.({
            level: 'info',
            message: args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' '),
          })
        } catch {
          // ignore
        }
      }
    }
    console.info = (...args: any[]) => originalInfo(...args)
    console.debug = (...args: any[]) => originalDebug(...args)
  }
}

// Пробуждение вкладки раньше запускало ~10 одновременных рефетчей (голый клиент =
// staleTime 0 + refetchOnWindowFocus), и КАЖДЫЙ ответ дёргал каскад рендеров тяжёлой
// страницы чатов. Свежесть на возврате обеспечивает syncAfterResume (адресные
// invalidate + socket-события), поэтому автo-рефетч по фокусу выключен, а короткий
// staleTime гасит дубли запросов, летящие подряд.
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      staleTime: 30_000,
    },
  },
})
appLifecycle.bindBrowserLifecycle()
nativeBridge.installGlobals()
startHangWatchdog()
let initialSessionPrepared = false

async function prepareInitialSessionState() {
  if (initialSessionPrepared) return
  useAppStore.getState().initFromStorage()
  try {
    await validateStoredSession()
  } catch (error) {
    console.error('[Main] Initial session bootstrap failed:', error)
  } finally {
    initialSessionPrepared = true
  }
}

function AppRoot() {
  const session = useAppStore((state) => state.session)
  const hydrated = useAppStore((state) => state.hydrated)
  const [isCheckingAuth, setIsCheckingAuth] = useState(!initialSessionPrepared)
  
  console.log('[AppRoot] Component rendered, session:', !!session, 'hydrated:', hydrated, 'isCheckingAuth:', isCheckingAuth)

  // Инициализация высоты viewport при монтировании приложения
  useEffect(() => {
    function setVh() {
      try {
        const vv = window.visualViewport ? window.visualViewport.height : null;
        const ih = window.innerHeight;
        const ch = document.documentElement ? document.documentElement.clientHeight : null;
        
        // Используем visualViewport.height если доступно, иначе innerHeight
        let base = vv || ih || ch || 0;
        
        // Если значение слишком мало, используем innerHeight как fallback
        if (base < 300 && ih && ih > base) {
          base = ih;
        }
        
        if (base <= 0) base = ih || ch || vv || window.screen.height || 800;
        
        const h = base * 0.01;
        document.documentElement.style.setProperty('--vh', h + 'px');
      } catch (e) {}
    }
    
    const handleOrientationChange = () => {
      setTimeout(setVh, 100);
      setTimeout(setVh, 300);
    };
    
    // Вызываем сразу и после небольших задержек для мобильных устройств
    setVh();
    const timeouts = [
      setTimeout(setVh, 0),
      setTimeout(setVh, 50),
      setTimeout(setVh, 100),
      setTimeout(setVh, 300)
    ];
    
    // Также вызываем при изменении размеров и ориентации
    window.addEventListener('resize', setVh, { passive: true });
    window.addEventListener('orientationchange', handleOrientationChange, { passive: true });
    
    let vvResizeHandler: ((e: Event) => void) | null = null;
    if (window.visualViewport) {
      vvResizeHandler = setVh;
      window.visualViewport.addEventListener('resize', vvResizeHandler, { passive: true });
    }
    
    return () => {
      timeouts.forEach(t => clearTimeout(t));
      window.removeEventListener('resize', setVh);
      window.removeEventListener('orientationchange', handleOrientationChange);
      if (window.visualViewport && vvResizeHandler) {
        window.visualViewport.removeEventListener('resize', vvResizeHandler);
      }
    };
  }, []);

  // Инициализация стора из localStorage и проверка авторизации
  useEffect(() => {
    if (initialSessionPrepared) {
      setIsCheckingAuth(false)
      return
    }
    console.log('[AppRoot] Initializing store from storage...')
    // Синхронно гидрируем токены перед любыми guard'ами
    useAppStore.getState().initFromStorage()
    console.log('[AppRoot] Store initialized, validating session...')
    validateStoredSession()
      .then((valid) => {
        console.log('[AppRoot] Session validation result:', valid)
        setIsCheckingAuth(false)
      })
      .catch((error) => {
        console.error('[AppRoot] Session validation error:', error)
        setIsCheckingAuth(false)
      })
  }, [])

  // Сохранение токена в нативный сервис сразу после загрузки (для Android)
  useEffect(() => {
    if (!hydrated || isCheckingAuth) return
    
    const currentSession = useAppStore.getState().session
    if (!currentSession?.accessToken) return
    
    if (typeof (window as any).Capacitor !== 'undefined') {
      const Capacitor = (window as any).Capacitor
      if (Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android') {
        console.log('[AppRoot] Saving token to native service immediately, length:', currentSession.accessToken.length)
        // Пытаемся использовать плагин напрямую, если он доступен
        const NativeSocket = Capacitor.Plugins?.NativeSocket
        if (NativeSocket && typeof NativeSocket.updateToken === 'function') {
          NativeSocket.updateToken({ token: currentSession.accessToken }).then(() => {
            console.log('[AppRoot] ✅ Token saved to native service immediately')
          }).catch((error: any) => {
            console.error('[AppRoot] ❌ Failed to save token immediately:', error)
          })
        } else {
          // Если плагин еще не загружен, пробуем через динамический импорт
          import('./capacitor/plugins/native-socket-plugin').then((module) => {
            const NativeSocket = module.NativeSocket || module.default
            if (NativeSocket && typeof NativeSocket.updateToken === 'function') {
              NativeSocket.updateToken({ token: currentSession.accessToken }).then(() => {
                console.log('[AppRoot] ✅ Token saved to native service (via import)')
              }).catch((error: any) => {
                console.error('[AppRoot] ❌ Failed to save token (via import):', error)
              })
            }
          }).catch((error) => {
            console.warn('[AppRoot] Failed to import NativeSocket plugin:', error)
          })
        }
      }
    }
  }, [hydrated, isCheckingAuth])

  useEffect(() => {
    console.log('[Main] useEffect triggered, isCheckingAuth:', isCheckingAuth, 'session:', !!session)
    if (!isCheckingAuth && session) {
      console.log('[Main] ✅ Session available, checking platform...')
      console.log('[Main] window.Capacitor:', typeof (window as any).Capacitor)
      console.log('[Main] window.Capacitor object:', (window as any).Capacitor)
      
      // Инициализация нативных сервисов для Android
      if (typeof (window as any).Capacitor !== 'undefined') {
        const Capacitor = (window as any).Capacitor
        const isNative = Capacitor.isNativePlatform()
        console.log('[Main] Capacitor found, isNative:', isNative)
        console.log('[Main] Capacitor platform:', Capacitor.getPlatform())
        
        if (isNative) {
          console.log('[Main] ✅ Initializing native services for Android...')
          
          // Синхронно сохраняем токен сразу, до асинхронного импорта
          if (session?.accessToken) {
            console.log('[Main] Saving token synchronously, length:', session.accessToken.length)
            // Используем прямой вызов через Capacitor, если плагин уже зарегистрирован
            try {
              const NativeSocket = (Capacitor as any).Plugins?.NativeSocket
              if (NativeSocket && typeof NativeSocket.updateToken === 'function') {
                console.log('[Main] Calling NativeSocket.updateToken() synchronously')
                NativeSocket.updateToken({ token: session.accessToken }).then(() => {
                  console.log('[Main] ✅ Token saved synchronously')
                }).catch((error: any) => {
                  console.error('[Main] ❌ Failed to save token synchronously:', error)
                })
              } else {
                console.warn('[Main] NativeSocket plugin not available yet, will try async')
              }
            } catch (error) {
              console.warn('[Main] Failed to access NativeSocket plugin:', error)
            }
          }
          
          import('./capacitor').then((module) => {
            console.log('[Main] ✅ Capacitor module loaded successfully!')
            console.log('[Main] Module exports:', Object.keys(module))
            const { initializeSocketConnection, initializeMessageHandlers, initializeCallHandlers, updateSocketToken } = module

            const resolveAvatarUrl = (url?: string | null): string | undefined => {
              if (!url) return undefined
              if (/^https?:\/\//i.test(url)) {
                return url
              }
              const originFallback = typeof window !== 'undefined' ? window.location.origin : 'https://ru.eblusha.org'
              const base = api.defaults.baseURL ? new URL(api.defaults.baseURL, originFallback).origin : originFallback
              const normalizedPath = url.startsWith('/') ? url.slice(1) : url
              return `${base.replace(/\/$/, '')}/${normalizedPath}`
            }

            const conversationsKey = ['conversations']

            type MessagePreview = {
              id: string
              content?: string | null
              attachments?: Array<{ id: string; type: string }>
            }

            const fetchMessagePreview = async (messageId: string): Promise<MessagePreview | null> => {
              try {
                const response = await api.get(`/messages/${messageId}/preview`)
                return response.data.message as MessagePreview
              } catch (error) {
                console.warn('[Native] Failed to fetch message preview', messageId, error)
                return null
              }
            }

            const getAttachmentPreviewText = (type?: string | null): string => {
              if (type === 'IMAGE') {
                return '📷 Фото'
              }
              return '📎 Вложение'
            }

            const fetchConversations = async () => {
              const response = await api.get('/conversations')
              queryClient.setQueryData(conversationsKey, response.data.conversations)
              return response.data.conversations as any[]
            }

            const findConversationRow = (conversationId: string, list?: any[]) =>
              list?.find((c: any) => c.conversation?.id === conversationId)

            const getConversationRow = async (
              conversationId: string,
              options?: { forceRefresh?: boolean }
            ) => {
              let conversations = queryClient.getQueryData(conversationsKey) as any[] | undefined
              let row = findConversationRow(conversationId, conversations)

              const needsFreshData = options?.forceRefresh || !row

              if (needsFreshData) {
                try {
                  conversations = await fetchConversations()
                  const refreshed = findConversationRow(conversationId, conversations)
                  if (refreshed) {
                    row = refreshed
                  }
                } catch (error) {
                  console.warn('[Native] Failed to fetch fresh conversations list', error)
                }
              } else {
                fetchConversations().catch((error) => {
                  console.warn('[Native] Failed to refresh conversations list', error)
                })
              }

              return row
            }

            const buildConversationInfo = async (
              conversationId: string,
              context?: { senderId?: string; messageId?: string }
            ) => {
              const row = await getConversationRow(conversationId, { forceRefresh: !!context?.messageId })
              const conversation = row?.conversation
              if (!conversation) {
                return null
              }

              const participants = conversation.participants || []
              const currentUserId = useAppStore.getState().session?.user?.id

              const senderParticipant = context?.senderId
                ? participants.find((p: any) => p.user.id === context.senderId)
                : undefined

              const counterpart =
                !conversation.isGroup && currentUserId
                  ? participants.find((p: any) => p.user.id !== currentUserId)
                  : undefined

              const senderName =
                senderParticipant?.user?.displayName ||
                senderParticipant?.user?.username ||
                counterpart?.user?.displayName ||
                counterpart?.user?.username ||
                conversation.title ||
                'Новое сообщение'

              const avatarCandidate =
                senderParticipant?.user?.avatarUrl ||
                counterpart?.user?.avatarUrl ||
                conversation.avatarUrl ||
                undefined

              const avatarUrl = resolveAvatarUrl(avatarCandidate)

              let messageText: string | undefined

              if (context?.messageId) {
                const preview = await fetchMessagePreview(context.messageId)
                if (preview?.content) {
                  messageText = preview.content
                } else if (preview?.attachments?.length) {
                  messageText = getAttachmentPreviewText(preview.attachments[0]?.type)
                }
              }

              if (!messageText) {
                const latestMessage = conversation?.messages?.[0]
                if (latestMessage?.content) {
                  messageText = latestMessage.content
                } else if (latestMessage?.attachments?.length) {
                  messageText = getAttachmentPreviewText(latestMessage.attachments[0]?.type)
                }
              }

              return {
                title: conversation.title,
                avatarUrl,
                senderName,
                messageText,
                isGroup: !!conversation.isGroup,
              }
            }
            // Запрос игнорирования оптимизации батареи для работы в фоне
            import('./capacitor/plugins/native-socket-plugin').then((module) => {
              const NativeSocket = module.NativeSocket || module.default
              if (NativeSocket && typeof NativeSocket.requestBatteryOptimizationExemption === 'function') {
                NativeSocket.requestBatteryOptimizationExemption().catch((error: any) => {
                  console.warn('[Main] Failed to request battery optimization exemption:', error)
                })
              }
              // Обновляем токен в нативном сервисе
              console.log('[Main] Checking NativeSocket plugin availability...')
              if (NativeSocket && typeof NativeSocket.updateToken === 'function') {
                console.log('[Main] Calling NativeSocket.updateToken() with token length:', session.accessToken?.length || 0)
                NativeSocket.updateToken({ token: session.accessToken }).then(() => {
                  console.log('[Main] ✅ Native socket token updated successfully')
                }).catch((error: any) => {
                  console.error('[Main] ❌ Failed to update native socket token:', error)
                })
              } else {
                console.warn('[Main] NativeSocket.updateToken is not available')
              }
            }).catch((error) => {
              console.warn('[Main] NativeSocket plugin not available:', error)
            })
            
            // Для Capacitor нужен абсолютный origin для нативного сокета.
            // Берём из VITE_WS_URL (если задан) → иначе из origin API baseURL → иначе window.location.origin.
            let wsUrl: string = ''
            try {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const envWs = String((import.meta as any).env?.VITE_WS_URL ?? '').trim()
              if (envWs) {
                wsUrl = envWs
              } else {
                const originFallback =
                  typeof window !== 'undefined' ? window.location.origin : 'https://ru.eblusha.org'
                const apiOrigin = api.defaults.baseURL
                  ? new URL(api.defaults.baseURL, originFallback).origin
                  : originFallback
                wsUrl = apiOrigin
              }
            } catch {
              wsUrl = 'https://ru.eblusha.org'
            }
            console.log('[Main] Connecting native Socket.IO to:', wsUrl)
            
            initializeSocketConnection(wsUrl, session.accessToken)
              .then(() => {
                console.log('[Main] ✅ Socket connection initialized successfully')
              })
              .catch((error) => {
                console.error('[Main] ❌ Failed to initialize socket connection:', error)
              })
            
            // Инициализация обработчиков сообщений
            initializeMessageHandlers({
              onMessageReceived: (payload: any) => {
                console.log('[Native] Message received:', payload)
                const conversationId = String(payload?.conversationId ?? '').trim()
                const messageId = String(payload?.messageId ?? payload?.message?.id ?? '').trim()
                const senderId = String(payload?.senderId ?? payload?.message?.senderId ?? '').trim()
                if (conversationId && messageId && senderId) {
                  nativeBridge.emit('pushMessage', {
                    version: 1,
                    conversationId,
                    messageId,
                    senderId,
                    receivedAt: Date.now(),
                    preview:
                      typeof payload?.message?.content === 'string' ? payload.message.content : undefined,
                  })
                }
              },
              onConversationUpdated: (conversationId: string) => {
                // Беседа обновлена - инвалидируем кэш
                queryClient.invalidateQueries({ queryKey: ['conversations'] })
              },
              onTypingUpdate: (conversationId: string, userId: string, typing: boolean) => {
                // Индикатор печати - будет обработан в ChatsPage
                console.log('[Native] Typing update:', conversationId, userId, typing)
              },
              isConversationActive: (conversationId: string) => {
                // Проверка активной беседы - будет реализовано через глобальное состояние
                return false
              },
              getConversationInfo: async (conversationId: string, context?: { senderId?: string; messageId?: string }) => {
                return buildConversationInfo(conversationId, {
                  senderId: context?.senderId,
                  messageId: context?.messageId,
                })
              },
            })
            
            // Инициализация обработчиков звонков
            initializeCallHandlers({
              onIncomingCall: (payload: any) => {
                console.log('[Native] Incoming call:', payload)
                const conversationId = String(payload?.conversationId ?? '').trim()
                const fromUserId = String(payload?.from?.id ?? '').trim()
                if (conversationId && fromUserId) {
                  nativeBridge.emit('incomingCall', {
                    version: 1,
                    conversationId,
                    fromUserId,
                    fromName:
                      typeof payload?.from?.name === 'string' ? payload.from.name : undefined,
                    video: !!payload?.video,
                    startedAt: Date.now(),
                  })
                }
              },
              onCallAccepted: (payload: any) => {
                // Звонок принят - будет обработано в ChatsPage
                console.log('[Native] Call accepted:', payload)
              },
              onCallDeclined: (payload: any) => {
                console.log('[Native] Call declined:', payload)
                const conversationId = String(payload?.conversationId ?? '').trim()
                if (conversationId) {
                  nativeBridge.emit('callCanceled', {
                    version: 1,
                    conversationId,
                    byUserId:
                      typeof payload?.by?.id === 'string' ? payload.by.id : undefined,
                    reason: 'declined',
                  })
                }
              },
              onCallEnded: (payload: any) => {
                console.log('[Native] Call ended:', payload)
                const conversationId = String(payload?.conversationId ?? '').trim()
                if (conversationId) {
                  nativeBridge.emit('callCanceled', {
                    version: 1,
                    conversationId,
                    byUserId:
                      typeof payload?.by?.id === 'string' ? payload.by.id : undefined,
                    reason: 'ended',
                  })
                }
              },
              onCallStatusUpdate: (conversationId: string, status: any) => {
                // Обновление статуса звонка - будет обработано в ChatsPage
                console.log('[Native] Call status update:', conversationId, status)
              },
              getConversationInfo: async (conversationId: string) => {
                const info = await buildConversationInfo(conversationId)
                return info
                  ? {
                      title: info.title,
                      avatarUrl: info.avatarUrl,
                      isGroup: info.isGroup,
                    }
                  : null
              },
            })
            
            const flushNativeCallActions = () => {
              const queue = (window as any).__pendingCallActions
              if (!Array.isArray(queue) || queue.length === 0) {
                return
              }

              while (queue.length > 0) {
                const action = queue.shift()
                if (!action || !action.conversationId) {
                  continue
                }

                if (action.action === 'accept' && typeof window.acceptIncomingCallFromNative === 'function') {
                  window.acceptIncomingCallFromNative({
                    version: 1,
                    callId: action.conversationId,
                    conversationId: action.conversationId,
                    isVideo: !!action.withVideo,
                    source: 'android_native',
                  })
                } else if (
                  action.action === 'decline' &&
                  typeof window.declineIncomingCallFromNative === 'function'
                ) {
                  window.declineIncomingCallFromNative({
                    version: 1,
                    callId: action.conversationId,
                    conversationId: action.conversationId,
                    source: 'android_native',
                  })
                }
              }
            }

            ;(window as any).__flushNativeCallActions = flushNativeCallActions

            // Глобальные обработчики для нативного экрана звонка
            ;(window as any).handleIncomingCallAnswer = (conversationId: string, withVideo: boolean) => {
              if (typeof window.acceptIncomingCallFromNative === 'function') {
                window.acceptIncomingCallFromNative({
                  version: 1,
                  callId: conversationId,
                  conversationId,
                  isVideo: !!withVideo,
                  source: 'android_native',
                })
              }
            }
            
            ;(window as any).handleIncomingCallDecline = (conversationId: string) => {
              if (typeof window.declineIncomingCallFromNative === 'function') {
                window.declineIncomingCallFromNative({
                  version: 1,
                  callId: conversationId,
                  conversationId,
                  source: 'android_native',
                })
              }
            }

            flushNativeCallActions()
            console.log('[Main] ✅ All native services initialized')
          }).catch((error) => {
            console.error('[Main] ❌ Failed to initialize native services:', error)
            console.error('[Main] Error stack:', error.stack)
            console.error('[Main] Error message:', error.message)
          })
        } else {
          // Веб-платформа - используем обычный socket
          console.log('[Main] ⚠️ Web platform detected, using web socket')
          connectSocket()
        }
      } else {
        // Capacitor не загружен - используем веб socket
        console.log('[Main] ⚠️ Capacitor not available, using web socket')
      connectSocket()
      }
    }
  }, [session, isCheckingAuth])

  useEffect(() => {
    if (!isCheckingAuth && session) {
      void ensureDeviceBootstrap()
    }
  }, [session, isCheckingAuth])

  useEffect(() => {
    if (!Capacitor.isNativePlatform()) {
      return
    }
    const token = session?.accessToken ?? ''
    console.log('[Main] useEffect: session token changed, length:', token.length)
    if (token) {
      import('./capacitor/plugins/native-socket-plugin').then((module) => {
        const NativeSocket = module.NativeSocket || module.default
        if (NativeSocket && typeof NativeSocket.updateToken === 'function') {
          console.log('[Main] useEffect: Calling NativeSocket.updateToken()')
          NativeSocket.updateToken({ token }).then(() => {
            console.log('[Main] ✅ useEffect: Native socket token updated')
          }).catch((error: any) => {
            console.error('[Main] ❌ useEffect: Failed to update native socket token:', error)
          })
        } else {
          console.warn('[Main] useEffect: NativeSocket.updateToken is not available')
        }
      }).catch((error) => {
        console.error('[Main] ❌ useEffect: Failed to import NativeSocket plugin:', error)
      })
    } else {
      console.warn('[Main] useEffect: Token is empty, skipping update')
    }
  }, [session?.accessToken])

  // Автоматическое обновление токена по его exp и при возврате в приложение
  useEffect(() => {
    let timeoutId: number | undefined
    let intervalId: number | undefined
    let offForeground: (() => void) | null = null
    let offNetwork: (() => void) | null = null
    let offFocus: (() => void) | null = null
    let cancelled = false

    async function doRefreshIfNeeded(force?: boolean) {
      if (cancelled) return
      const current = useAppStore.getState().session
      if (!current) return
      const expMs = getAccessExpMs(current.accessToken)
      const now = Date.now()
      const timeLeft = expMs ? expMs - now : null
      // Обновляем заранее за 3 минуты до истечения, либо по принуждению
      if (force || (timeLeft !== null && timeLeft < 3 * 60 * 1000)) {
        try {
          const refreshed = await forceRefreshSession()
          if (refreshed) {
            if (typeof (window as any).Capacitor !== 'undefined') {
              const Capacitor = (window as any).Capacitor
              if (Capacitor.isNativePlatform()) {
                import('./capacitor').then(({ updateSocketToken }) => {
                  updateSocketToken(refreshed.accessToken)
                }).catch(() => {})
              }
            }
            scheduleNext()
          }
        } catch (error) {
          // Если refresh не удался - проверяем, может быть это просто временная ошибка
          console.warn('Token refresh failed:', error)
          const status = (error as { response?: { status?: number } })?.response?.status
          // Очищаем сессию только при явной невалидности refresh (401/403)
          if (status === 401 || status === 403) {
            useAppStore.getState().setSession(null)
          } else {
            scheduleNext()
          }
        }
      }
    }

    function scheduleNext() {
      if (cancelled) return
      const current = useAppStore.getState().session
      if (!current) return
      const expMs = getAccessExpMs(current.accessToken)
      const now = Date.now()
      // Вычисляем время до истечения минус 3 минуты (запас)
      const target = expMs ? Math.max(now, expMs - 3 * 60 * 1000) : now + 5 * 60 * 1000
      const delay = Math.min(Math.max(30_000, target - now), 10 * 60 * 1000) // минимум 30 секунд, максимум 10 минут
      
      if (timeoutId) clearTimeout(timeoutId)
      timeoutId = window.setTimeout(() => { void doRefreshIfNeeded() }, delay)
    }

    // Периодическая проверка токена (каждые 2 минуты)
    // Это обеспечит обновление даже если таймеры замедлились в background
    function startInterval() {
      if (intervalId) clearInterval(intervalId)
      intervalId = window.setInterval(() => {
        if (!cancelled) {
          void doRefreshIfNeeded(false)
        }
      }, 2 * 60 * 1000) // Проверяем каждые 2 минуты
    }

    offForeground = appLifecycle.on('foreground', () => {
      void doRefreshIfNeeded(true)
    })

    offFocus = appLifecycle.on('focus', () => {
      void doRefreshIfNeeded(true)
    })

    offNetwork = appLifecycle.on('networkChange', (payload) => {
      if (payload.online) {
        void doRefreshIfNeeded(true)
      }
    })

    if (session) {
      scheduleNext()
      startInterval()
    }

    return () => {
      cancelled = true
      if (timeoutId) clearTimeout(timeoutId)
      if (intervalId) clearInterval(intervalId)
      if (offForeground) offForeground()
      if (offFocus) offFocus()
      if (offNetwork) offNetwork()
    }
  }, [session])

  // Показываем загрузку пока проверяем авторизацию
  if (isCheckingAuth || !hydrated) {
    return (
      <div style={{ 
        display: 'flex', 
        justifyContent: 'center', 
        alignItems: 'center', 
        height: 'calc(var(--vh, 1vh) * 100)',
        fontSize: '16px',
        color: 'var(--text-muted)',
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 9999,
        background: 'var(--paper)'
      }}>
        <LoadingSpinner />
      </div>
    )
  }

  // После проверки авторизации показываем роутер с загрузкой в Suspense
  return (
    <Suspense fallback={
      <div style={{ 
        display: 'flex', 
        justifyContent: 'center', 
        alignItems: 'center', 
        height: 'calc(var(--vh, 1vh) * 100)',
        fontSize: '16px',
        color: 'var(--text-muted)',
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 9999,
        background: 'var(--paper)'
      }}>
        <LoadingSpinner />
      </div>
    }>
      <RouterProvider router={router} />
    </Suspense>
  )
}

console.log('[Main] Creating React root...')
async function bootstrapAndRender() {
  const rootElement = document.getElementById('app')
  if (!rootElement) {
    console.error('[Main] ❌ Root element not found!')
    return
  }

  await prepareInitialSessionState()

  console.log('[Main] Root element found, rendering...')
  ReactDOM.createRoot(rootElement).render(
    <React.StrictMode>
      <QueryClientProvider client={queryClient}>
        <AppRoot />
      </QueryClientProvider>
    </React.StrictMode>,
  )
  console.log('[Main] ✅ React app rendered')
}

void bootstrapAndRender()









