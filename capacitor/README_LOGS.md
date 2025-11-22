# Как посмотреть логи Capacitor Android приложения

## Фильтрация логов для нашего приложения

### По package name (org.eblusha.plus):
```bash
adb logcat | grep "org.eblusha.plus"
```

### Только логи нашего приложения:
```bash
adb logcat --pid=$(adb shell pidof -s org.eblusha.plus)
```

### Логи приложения + ошибки системы:
```bash
adb logcat *:E org.eblusha.plus:* *:S
```

### Логи Capacitor:
```bash
adb logcat | grep -i capacitor
```

### Логи WebView (где работает наше веб-приложение):
```bash
adb logcat | grep -i "chromium\|webview\|console"
```

## Способ 1: Android Studio Logcat

1. Откройте Android Studio
2. Внизу экрана найдите вкладку **Logcat**
3. Выберите ваше устройство/эмулятор
4. В поле поиска введите:
   - `org.eblusha.plus` - все логи приложения
   - `Capacitor` - логи Capacitor
   - `chromium` - логи WebView
   - `console` - JavaScript консоль

## Способ 2: Через терминал (adb)

### Просмотр логов приложения:
```bash
# Все логи приложения
adb logcat | grep "org.eblusha.plus"

# Только ошибки приложения
adb logcat *:E | grep "org.eblusha.plus"

# Логи + JavaScript консоль
adb logcat chromium:V org.eblusha.plus:* *:S
```

### Фильтрация по уровню:
```bash
# Только ошибки и предупреждения
adb logcat *:E *:W org.eblusha.plus:* *:S

# Все уровни для приложения
adb logcat org.eblusha.plus:V *:S
```

### Сохранение в файл:
```bash
adb logcat | grep "org.eblusha.plus" > app_logs.txt
```

### Очистка и просмотр:
```bash
adb logcat -c && adb logcat | grep "org.eblusha.plus"
```

## Способ 3: JavaScript консоль в WebView

Capacitor использует WebView для отображения веб-приложения. JavaScript логи можно увидеть:

```bash
# Логи Chromium WebView (JavaScript console.log)
adb logcat chromium:V *:S

# Или более широкий фильтр
adb logcat | grep -i "console\|chromium"
```

## Что искать при проблемах:

### 1. Ошибки загрузки приложения:
```bash
adb logcat | grep -i "capacitor\|webview\|network"
```

### 2. Ошибки JavaScript:
```bash
adb logcat chromium:V *:S
```

### 3. Проблемы с сетью (ru.eblusha.org):
```bash
adb logcat | grep -i "network\|ssl\|certificate\|ru.eblusha"
```

### 4. Ошибки Capacitor плагинов:
```bash
adb logcat | grep -i "capacitor\|plugin"
```

## Полезные команды:

```bash
# Все логи приложения с временными метками
adb logcat -v time | grep "org.eblusha.plus"

# Логи за последние 5 минут
adb logcat -t "$(date -d '5 minutes ago' '+%m-%d %H:%M:%S.000')" | grep "org.eblusha.plus"

# Мониторинг в реальном времени
adb logcat -v time org.eblusha.plus:* chromium:V *:S

# Сохранить все логи приложения
adb logcat -v time | grep "org.eblusha.plus" > capacitor_logs_$(date +%Y%m%d_%H%M%S).txt
```

## Отладка проблем:

### Приложение не загружается:
```bash
# Проверить, запущено ли приложение
adb shell ps | grep "org.eblusha.plus"

# Проверить логи запуска
adb logcat | grep -i "org.eblusha.plus\|MainActivity"
```

### Проблемы с сетью:
```bash
# Проверить сетевые запросы
adb logcat | grep -i "network\|http\|https\|ru.eblusha"
```

### Проблемы с WebView:
```bash
# Логи WebView
adb logcat chromium:V *:S
```

## Примечание

Если вы видите системные логи (WifiScanner, Bluetooth, SatelliteController и т.д.), это нормально - это логи Android системы, не связанные с нашим приложением. Используйте фильтры выше, чтобы видеть только логи нашего приложения.

