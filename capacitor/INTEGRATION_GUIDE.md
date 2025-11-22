# Руководство по интеграции нативных уведомлений и звонков

## Обзор

Реализована полная поддержка нативных уведомлений и входящих звонков для Android приложения на Capacitor.

## Структура проекта

```
capacitor/
├── src/
│   ├── types/
│   │   └── socket-events.ts          # Типы всех Socket.IO событий
│   ├── services/
│   │   ├── socket-service.ts          # Socket.IO клиент с JWT авторизацией
│   │   ├── notification-service.ts    # Сервис нативных уведомлений
│   │   ├── message-handler.ts         # Обработчик входящих сообщений
│   │   └── call-handler.ts            # Обработчик входящих звонков
│   └── index.ts                       # Главный файл инициализации
└── android/
    └── app/
        └── src/
            └── main/
                ├── java/org/eblusha/plus/
                │   └── IncomingCallActivity.java  # Нативный экран звонка
                └── res/
                    └── layout/
                        └── activity_incoming_call.xml  # Layout экрана звонка
```

## Установка зависимостей

```bash
cd capacitor
npm install
```

Зависимости уже добавлены в `package.json`:
- `socket.io-client` - для WebSocket соединения
- `@capacitor/local-notifications` - для нативных уведомлений

## Интеграция в веб-приложение

### 1. Подключение модуля

В вашем веб-приложении (frontend) добавьте импорт:

```typescript
// В файле, где инициализируется приложение (например, main.tsx)
import { Capacitor } from '@capacitor/core'

if (Capacitor.isNativePlatform()) {
  // Импортируем только на нативных платформах
  import('./capacitor-services').then(({ initializeSocketConnection, initializeMessageHandlers, initializeCallHandlers }) => {
    // Инициализация будет ниже
  })
}
```

### 2. Инициализация Socket.IO

```typescript
import { getSocketService } from '../capacitor/src/services/socket-service'

// После получения accessToken
const wsUrl = 'https://ru.eblusha.org' // или из конфига
const accessToken = session.accessToken

if (Capacitor.isNativePlatform()) {
  initializeSocketConnection(wsUrl, accessToken)
} else {
  // Используйте существующий socket.ts для веб
  connectSocket()
}
```

### 3. Инициализация обработчиков сообщений

```typescript
import { initializeMessageHandlers } from '../capacitor/src'

const unsubscribeMessages = initializeMessageHandlers({
  onMessageReceived: (payload) => {
    // Сообщение получено в активной беседе
    // Добавьте сообщение в UI
    console.log('New message:', payload)
  },
  onConversationUpdated: (conversationId) => {
    // Беседа обновлена (новое сообщение в неактивной беседе)
    // Обновите список бесед
    queryClient.invalidateQueries(['conversations'])
  },
  onTypingUpdate: (conversationId, userId, typing) => {
    // Кто-то печатает
    // Покажите индикатор печати
  },
  isConversationActive: (conversationId) => {
    // Проверка, активна ли беседа
    return activeConversationId === conversationId
  },
  getConversationInfo: async (conversationId) => {
    // Получить информацию о беседе для уведомления
    const conversations = await queryClient.getQueryData(['conversations']) as any[]
    const conv = conversations?.find(c => c.conversation.id === conversationId)
    return {
      title: conv?.conversation.title,
      avatarUrl: conv?.conversation.avatarUrl,
      senderName: conv?.sender?.displayName,
    }
  },
})
```

### 4. Инициализация обработчиков звонков

```typescript
import { initializeCallHandlers } from '../capacitor/src'

const unsubscribeCalls = initializeCallHandlers({
  onIncomingCall: (payload) => {
    // Входящий звонок получен
    // Нативный экран уже открыт автоматически
    console.log('Incoming call:', payload)
  },
  onCallAccepted: (payload) => {
    // Звонок принят - открыть экран звонка (LiveKit)
    openCallOverlay(payload.conversationId, payload.video)
  },
  onCallDeclined: (payload) => {
    // Звонок отклонен
    console.log('Call declined:', payload)
  },
  onCallEnded: (payload) => {
    // Звонок завершен
    closeCallOverlay(payload.conversationId)
  },
  onCallStatusUpdate: (conversationId, status) => {
    // Обновление статуса группового звонка
    updateCallStatus(conversationId, status)
  },
  getConversationInfo: async (conversationId) => {
    // Получить информацию о беседе для экрана звонка
    const conversations = await queryClient.getQueryData(['conversations']) as any[]
    const conv = conversations?.find(c => c.conversation.id === conversationId)
    return {
      title: conv?.conversation.title,
      avatarUrl: conv?.conversation.avatarUrl,
      isGroup: conv?.conversation.isGroup,
    }
  },
})
```

### 5. Обработка действий с экрана входящего звонка

Добавьте глобальные функции для обработки действий:

```typescript
// В main.tsx или другом глобальном файле
declare global {
  interface Window {
    handleIncomingCallAnswer?: (conversationId: string, withVideo: boolean) => void
    handleIncomingCallDecline?: (conversationId: string) => void
  }
}

window.handleIncomingCallAnswer = (conversationId: string, withVideo: boolean) => {
  // Вызвать acceptCall из вашего call handler
  acceptCall(conversationId, withVideo)
}

window.handleIncomingCallDecline = (conversationId: string) => {
  // Вызвать declineCall из вашего call handler
  declineCall(conversationId)
}
```

### 6. Обновление токена

При обновлении accessToken:

```typescript
import { updateSocketToken } from '../capacitor/src'

// После получения нового токена
updateSocketToken(newAccessToken)
```

## Настройка Android

### 1. Добавить Activity в AndroidManifest.xml

```xml
<activity
    android:name=".IncomingCallActivity"
    android:theme="@style/Theme.AppCompat.NoActionBar"
    android:launchMode="singleTop"
    android:excludeFromRecents="true"
    android:showOnLockScreen="true"
    android:turnScreenOn="true"
    android:showWhenLocked="true" />
```

### 2. Разрешения

Убедитесь, что в `AndroidManifest.xml` есть:

```xml
<uses-permission android:name="android.permission.INTERNET" />
<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />
<uses-permission android:name="android.permission.WAKE_LOCK" />
<uses-permission android:name="android.permission.DISABLE_KEYGUARD" />
```

### 3. Звуки уведомлений

Поместите файлы звуков в `android/app/src/main/res/raw/`:
- `notify.mp3` - звук уведомления о сообщении
- `ring.mp3` - рингтон для звонков

## Тестирование

### Тест уведомлений о сообщениях:

1. Отправьте сообщение с другого устройства
2. Приложение должно быть в фоне
3. Должно появиться нативное уведомление

### Тест входящего звонка:

1. Позвоните с другого устройства
2. Должен открыться нативный экран входящего звонка
3. Кнопки "Ответить", "С видео", "Отклонить" должны работать

## Отладка

Логи можно посмотреть через:

```bash
adb logcat | grep -i "SocketService\|MessageHandler\|CallHandler\|NotificationService"
```

Или в Android Studio Logcat с фильтром по тегам.

## Дополнительные возможности

### Группировка уведомлений

Уведомления автоматически группируются по беседе. Можно настроить группировку в `notification-service.ts`.

### Кастомизация экрана звонка

Измените `activity_incoming_call.xml` для изменения дизайна экрана входящего звонка.

### Обработка фонового режима

Сервисы автоматически определяют, активно ли приложение, и показывают уведомления только когда приложение в фоне.

