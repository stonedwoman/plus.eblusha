import React from 'react'
import ReactDOM from 'react-dom/client'
import './style.css'
import { RouterProvider } from 'react-router-dom'
import { Suspense, useEffect, useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import './utils/i18n'
import { router } from './router'
import { useAppStore } from './domain/store/appStore'
import { connectSocket, acceptCall, declineCall } from './utils/socket'
import { api } from './utils/api'
import { ensureDeviceBootstrap } from './domain/device/deviceManager'
import { Capacitor } from '@capacitor/core' // Import Capacitor

// Глобальное логирование для отладки
if (typeof window !== 'undefined') {
  const originalLog = console.log
  console.log = (...args: any[]) => {
    originalLog(...args)
    // Также отправляем в Capacitor для видимости в logcat
    if (typeof (window as any).Capacitor !== 'undefined') {
      try {
        (window as any).Capacitor.Plugins?.Console?.log?.({
          level: 'info',
          message: args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')
        })
      } catch (e) {
        // Игнорируем ошибки
      }
    }
  }
  
  console.log('[Main] Script loaded, Capacitor available:', typeof (window as any).Capacitor !== 'undefined')
}

const queryClient = new QueryClient()

function getAccessExpMs(token: string | undefined | null): number | null {
  if (!token) return null
  try {
    const [, payload] = token.split('.')
    const json = JSON.parse(atob(payload))
    if (typeof json?.exp === 'number') {
      return json.exp * 1000
    }
    return null
  } catch {
    return null
  }
}

// Проверка валидности сохраненной сессии при загрузке приложения
async function validateStoredSession(): Promise<boolean> {
  const session = useAppStore.getState().session
  
  // Если нет сохраненной сессии, пытаемся восстановить через refresh token из cookie
  if (!session) {
    try {
      // Пытаемся обновить токены через refresh (refresh token в httpOnly cookie)
      const response = await api.post('/auth/refresh')
      if (response.data?.accessToken) {
        // Получаем данные пользователя
        const userResponse = await api.get('/status/me')
        if (userResponse.data?.user) {
          useAppStore.getState().setSession({
            user: {
              id: userResponse.data.user.id,
              username: userResponse.data.user.username,
              displayName: userResponse.data.user.displayName,
              avatarUrl: userResponse.data.user.avatarUrl,
            },
            accessToken: response.data.accessToken,
          })
          return true
        }
      }
    } catch {
      // Refresh token невалиден или отсутствует
      return false
    }
    return false
  }

  try {
    // Проверяем валидность токена через запрос к /status/me
    const response = await api.get('/status/me')
    if (response.data?.user) {
      // Обновляем данные пользователя из ответа (на случай если они изменились)
      useAppStore.getState().setSession({
        ...session,
        user: {
          id: response.data.user.id,
          username: response.data.user.username,
          displayName: response.data.user.displayName,
          avatarUrl: response.data.user.avatarUrl,
        },
      })
      return true
    }
    return false
  } catch (error) {
    // Если access токен невалиден, пытаемся обновить через refresh
    try {
      const refreshResponse = await api.post('/auth/refresh')
      if (refreshResponse.data?.accessToken) {
        const userResponse = await api.get('/status/me')
        if (userResponse.data?.user) {
          useAppStore.getState().setSession({
            user: {
              id: userResponse.data.user.id,
              username: userResponse.data.user.username,
              displayName: userResponse.data.user.displayName,
              avatarUrl: userResponse.data.user.avatarUrl,
            },
            accessToken: refreshResponse.data.accessToken,
          })
          return true
        }
      }
    } catch {
      // Refresh тоже невалиден, очищаем сессию
      useAppStore.getState().setSession(null)
      return false
    }
    return false
  }
}

function AppRoot() {
  const session = useAppStore((state) => state.session)
  const hydrated = useAppStore((state) => state.hydrated)
  const [isCheckingAuth, setIsCheckingAuth] = useState(true)
  
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
            console.log('[AppRoot] Initializing store from storage...')
    // Синхронно гидрируем токены перед любыми guard'ами
    useAppStore.getState().initFromStorage()
            console.log('[AppRoot] Store initialized, validating session...')
            validateStoredSession().then((valid) => {
              console.log('[AppRoot] Session validation result:', valid)
              setIsCheckingAuth(false)
            }).catch((error) => {
              console.error('[AppRoot] Session validation error:', error)
      setIsCheckingAuth(false)
    })
  }, [])

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
          import('./capacitor').then((module) => {
            console.log('[Main] ✅ Capacitor module loaded successfully!')
            console.log('[Main] Module exports:', Object.keys(module))
            const { initializeSocketConnection, initializeMessageHandlers, initializeCallHandlers, updateSocketToken } = module
            // Для Capacitor используем URL из конфигурации или ru.eblusha.org
            const wsUrl = 'https://ru.eblusha.org'
            console.log('[Main] Connecting native Socket.IO to:', wsUrl)
            initializeSocketConnection(wsUrl, session.accessToken)
            
            // Инициализация обработчиков сообщений
            initializeMessageHandlers({
              onMessageReceived: (payload: any) => {
                // Сообщение получено - будет обработано в ChatsPage
                console.log('[Native] Message received:', payload)
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
              getConversationInfo: async (
                conversationId: string,
                context?: { senderId?: string; messageId?: string }
              ) => {
                const fetchConversations = async () => {
                  const response = await api.get('/conversations')
                  queryClient.setQueryData(['conversations'], response.data.conversations)
                  return response.data.conversations as any[]
                }

                const findConversation = (list?: any[]) =>
                  list?.find((c: any) => c.conversation?.id === conversationId)

                let conversations = queryClient.getQueryData(['conversations']) as any[] | undefined
                let row = findConversation(conversations)

                if (!row) {
                  conversations = await fetchConversations()
                  row = findConversation(conversations)
                } else {
                  fetchConversations().catch((error) => {
                    console.warn('[Native] Failed to refresh conversations list', error)
                  })
                }

                const conversation = row?.conversation
                const participants = conversation?.participants || []
                const currentUserId = useAppStore.getState().session?.user?.id

                const senderParticipant = context?.senderId
                  ? participants.find((p: any) => p.user.id === context.senderId)
                  : undefined

                const counterpart =
                  !conversation?.isGroup && currentUserId
                    ? participants.find((p: any) => p.user.id !== currentUserId)
                    : undefined

                const senderName =
                  senderParticipant?.user?.displayName ||
                  senderParticipant?.user?.username ||
                  counterpart?.user?.displayName ||
                  counterpart?.user?.username ||
                  conversation?.title ||
                  'Новое сообщение'

                const avatarUrl =
                  senderParticipant?.user?.avatarUrl ||
                  counterpart?.user?.avatarUrl ||
                  conversation?.avatarUrl ||
                  undefined

                let messageText: string | undefined
                const latestMessage = conversation?.messages?.[0]
                if (latestMessage?.content) {
                  messageText = latestMessage.content
                }

                return {
                  title: conversation?.title,
                  avatarUrl,
                  senderName,
                  messageText,
                }
              },
            })
            
            // Инициализация обработчиков звонков
            initializeCallHandlers({
              onIncomingCall: (payload: any) => {
                // Входящий звонок - нативный экран уже открыт
                console.log('[Native] Incoming call:', payload)
              },
              onCallAccepted: (payload: any) => {
                // Звонок принят - будет обработано в ChatsPage
                console.log('[Native] Call accepted:', payload)
              },
              onCallDeclined: (payload: any) => {
                console.log('[Native] Call declined:', payload)
              },
              onCallEnded: (payload: any) => {
                console.log('[Native] Call ended:', payload)
              },
              onCallStatusUpdate: (conversationId: string, status: any) => {
                // Обновление статуса звонка - будет обработано в ChatsPage
                console.log('[Native] Call status update:', conversationId, status)
              },
              getConversationInfo: async (conversationId: string) => {
                const conversations = queryClient.getQueryData(['conversations']) as any[] | undefined
                const conv = conversations?.find((c: any) => c.conversation?.id === conversationId)
                return {
                  title: conv?.conversation?.title,
                  avatarUrl: conv?.conversation?.avatarUrl,
                  isGroup: conv?.conversation?.isGroup,
                }
              },
            })
            
            // Глобальные обработчики для нативного экрана звонка
            ;(window as any).handleIncomingCallAnswer = (conversationId: string, withVideo: boolean) => {
              acceptCall(conversationId, withVideo)
            }
            
            ;(window as any).handleIncomingCallDecline = (conversationId: string) => {
              declineCall(conversationId)
            }
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

  // Автоматическое обновление токена по его exp и при возврате в приложение
  useEffect(() => {
    let timeoutId: number | undefined
    let intervalId: number | undefined
    let visibilityHandler: (() => void) | null = null
    let onlineHandler: (() => void) | null = null
    let focusHandler: (() => void) | null = null
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
          const response = await api.post('/auth/refresh')
          if (response.data?.accessToken) {
            const updated = useAppStore.getState().session
            if (updated) {
              useAppStore.getState().setSession({
                ...updated,
                accessToken: response.data.accessToken,
              })
              // Обновляем токен в нативных сервисах
              if (typeof (window as any).Capacitor !== 'undefined') {
                const Capacitor = (window as any).Capacitor
                if (Capacitor.isNativePlatform()) {
                  import('./capacitor').then(({ updateSocketToken }) => {
                    updateSocketToken(response.data.accessToken)
                  }).catch(() => {})
                }
              }
              // Успешно обновили - перепланируем следующую проверку
              scheduleNext()
            }
          }
        } catch (error) {
          // Если refresh не удался - проверяем, может быть это просто временная ошибка
          console.warn('Token refresh failed:', error)
          // Если токен уже истек (timeLeft <= 0), очищаем сессию
          if (timeLeft !== null && timeLeft <= 0) {
          useAppStore.getState().setSession(null)
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

    // Подписки на возврат и онлайн
    visibilityHandler = () => {
      if (document.visibilityState === 'visible') {
        // Когда окно снова становится видимым - сразу проверяем токен
        void doRefreshIfNeeded(true)
      }
    }
    
    focusHandler = () => {
      // При возврате фокуса - проверяем токен
      void doRefreshIfNeeded(true)
    }
    
    onlineHandler = () => { 
      // При восстановлении соединения - проверяем токен
      void doRefreshIfNeeded(true) 
    }
    
    document.addEventListener('visibilitychange', visibilityHandler)
    window.addEventListener('focus', focusHandler)
    window.addEventListener('online', onlineHandler)

    if (session) {
      scheduleNext()
      startInterval()
    }

    return () => {
      cancelled = true
      if (timeoutId) clearTimeout(timeoutId)
      if (intervalId) clearInterval(intervalId)
      if (visibilityHandler) document.removeEventListener('visibilitychange', visibilityHandler)
      if (focusHandler) window.removeEventListener('focus', focusHandler)
      if (onlineHandler) window.removeEventListener('online', onlineHandler)
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
        color: 'var(--text-muted)'
      }}>
        Загрузка...
      </div>
    )
  }

  return (
    <Suspense fallback={null}>
      <RouterProvider router={router} />
    </Suspense>
  )
}

console.log('[Main] Creating React root...')
const rootElement = document.getElementById('app')
if (!rootElement) {
  console.error('[Main] ❌ Root element not found!')
} else {
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





