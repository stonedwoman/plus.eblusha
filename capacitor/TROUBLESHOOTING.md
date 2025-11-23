# Решение проблем

## Ошибка: `java.util.prefs.Base64 ArrayIndexOutOfBoundsException`

Эта ошибка возникает при проблемах с конфигурацией Java или неправильном запуске.

### Решение 1: Проверьте конфигурацию запуска

1. В Android Studio: `Run → Edit Configurations...`
2. Убедитесь, что выбрана конфигурация **app** (не какой-то класс)
3. **Main activity** должна быть: `org.eblusha.plus.MainActivity`
4. **Launch:** `Default Activity`

### Решение 2: Синхронизация Gradle

1. `File → Sync Project with Gradle Files`
2. Или нажмите на иконку 🐘 (Gradle Sync) в панели инструментов

### Решение 3: Очистка и пересборка

```bash
cd /opt/eblusha-plus/capacitor/android
./gradlew clean
./gradlew build
```

Или в Android Studio:
- `Build → Clean Project`
- `Build → Rebuild Project`

### Решение 4: Проверка Java версии

1. `File → Project Structure → SDK Location`
2. Убедитесь, что **JDK location** указывает на Java 17 или выше
3. Обычно: `C:\Program Files\Android\Android Studio\jbr`

### Решение 5: Инвалидация кэша

1. `File → Invalidate Caches...`
2. Выберите **Invalidate and Restart**
3. Дождитесь перезапуска Android Studio

### Решение 6: Пересоздание конфигурации запуска

1. Удалите все конфигурации запуска: `Run → Edit Configurations...` → удалите все
2. Создайте новую: `Run → Edit Configurations...` → `+` → `Android App`
3. Название: `app`
4. Module: `android.app`
5. Launch: `Default Activity`

## Другие проблемы

### Gradle не синхронизируется

```bash
cd /opt/eblusha-plus/capacitor/android
./gradlew --stop
./gradlew clean
```

### Ошибки компиляции

1. Проверьте версию Java (нужна 17+)
2. Обновите Gradle: `File → Settings → Build → Gradle`
3. Используйте Gradle wrapper из проекта

### Приложение не запускается

1. Убедитесь, что устройство/эмулятор подключен
2. Проверьте: `adb devices`
3. Перезапустите adb: `adb kill-server && adb start-server`


