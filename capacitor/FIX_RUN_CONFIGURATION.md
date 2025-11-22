# Исправление ошибки запуска: java.util.prefs.Base64

## Проблема
Android Studio пытается запустить Java класс вместо Android приложения.

## Решение (пошагово):

### Шаг 1: Удалите все неправильные конфигурации

1. В Android Studio: `Run → Edit Configurations...`
2. Удалите ВСЕ конфигурации (кроме "Android JUnit" если есть)
3. Нажмите `OK`

### Шаг 2: Создайте правильную конфигурацию

1. `Run → Edit Configurations...`
2. Нажмите `+` (плюс) в левом верхнем углу
3. Выберите **Android App** (НЕ Java!)
4. Заполните:
   - **Name:** `app`
   - **Module:** `android.app` (выберите из списка)
   - **Launch:** `Default Activity`
   - **Target:** `USB Device` или `Emulator` (выберите ваше устройство)
5. Нажмите `OK`

### Шаг 3: Убедитесь, что выбрана правильная конфигурация

1. Вверху Android Studio, рядом с кнопкой Run (▶️)
2. В выпадающем списке должно быть: **app** (Android App)
3. НЕ должно быть: `java.util.prefs.Base64` или других Java классов

### Шаг 4: Запустите приложение

1. Убедитесь, что устройство/эмулятор подключен
2. Нажмите **Run** (▶️) или `Shift+F10`

## Альтернативный способ (если не помогает):

### Через Gradle напрямую:

1. В Android Studio откройте панель **Gradle** (справа)
2. Разверните: `android → Tasks → install`
3. Дважды кликните на `installDebug`
4. Приложение установится на устройство

### Через командную строку:

```bash
cd /opt/eblusha-plus/capacitor/android
./gradlew installDebug
```

## Проверка:

После правильной настройки, когда вы нажмете Run, должно появиться:
- Выбор устройства/эмулятора
- Сборка APK
- Установка на устройство
- Запуск приложения

**НЕ должно быть:** попытка запустить Java класс с ошибкой Base64.

## Если проблема остается:

1. `File → Invalidate Caches...` → `Invalidate and Restart`
2. `File → Sync Project with Gradle Files`
3. `Build → Clean Project`
4. `Build → Rebuild Project`
5. Повторите шаги 1-4 выше

