# Eblusha Plus - Capacitor Android App

Этот проект содержит конфигурацию Capacitor для создания Android приложения на основе веб-версии из `/frontend`.

## Структура

- `capacitor.config.ts` - основная конфигурация Capacitor
- `package.json` - зависимости и скрипты для работы с Capacitor
- `android/` - нативный Android проект (генерируется автоматически)

## Установка

```bash
cd capacitor
npm install
```

## Настройка

1. Убедитесь, что frontend собран:
   ```bash
   cd ../frontend
   npm run build
   ```

2. Синхронизация с Android:
   ```bash
   cd ../capacitor
   npm run sync:android
   ```

## Разработка

### Открыть Android Studio

```bash
npm run open:android
```

### Синхронизация изменений

После изменений в frontend или конфигурации:

```bash
# Собрать frontend
cd ../frontend && npm run build

# Синхронизировать с Capacitor
cd ../capacitor && npm run sync:android
```

## Конфигурация

В `capacitor.config.ts` можно настроить:

- `appId` - идентификатор приложения (org.eblusha.plus)
- `appName` - название приложения
- `webDir` - директория с собранным веб-приложением (../frontend/dist)
- `server.url` - URL веб-приложения (опционально)

### Режимы работы

#### 1. Встроенное приложение (по умолчанию)
Приложение использует файлы из `webDir` (../frontend/dist), встроенные в APK.
- ✅ Работает офлайн
- ✅ Быстрая загрузка
- ✅ Не зависит от интернета

#### 2. Загрузка с сервера (ru.eblusha.org)
Раскомментируйте в `capacitor.config.ts`:
```typescript
server: {
  url: 'https://ru.eblusha.org',
  cleartext: false,
}
```

И закомментируйте `webDir` или оставьте для fallback.

#### 3. Для разработки (localhost)
Раскомментируйте в `capacitor.config.ts`:
```typescript
server: {
  url: 'http://localhost:5173',
  cleartext: true,
}
```

**Важно:** Для работы с localhost нужно запустить frontend dev server:
```bash
cd ../frontend && npm run dev
```

## Сборка APK/AAB

1. Откройте проект в Android Studio:
   ```bash
   npm run open:android
   ```

2. В Android Studio:
   - Build → Generate Signed Bundle / APK
   - Выберите AAB или APK
   - Следуйте инструкциям для создания ключа подписи (если первый раз)

## Полезные команды

- `npm run sync` - синхронизировать все платформы
- `npm run sync:android` - синхронизировать только Android
- `npm run copy` - скопировать веб-ресурсы
- `npm run update` - обновить Capacitor зависимости
- `npm run open:android` - открыть в Android Studio

