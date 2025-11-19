# Как посмотреть логи Android приложения

## Способ 1: Android Studio Logcat

1. Откройте Android Studio
2. Внизу экрана найдите вкладку **Logcat**
3. Выберите ваше устройство/эмулятор в выпадающем списке
4. В поле поиска введите теги для фильтрации:
   - `CallViewModel` - логи из ViewModel звонков
   - `CallRoute` - логи из экрана звонка
   - `MainActivity` - логи из главной активности
   - Или просто `org.eblusha.plus` для всех логов приложения

## Способ 2: Через терминал (adb)

### Просмотр всех логов:
```bash
adb logcat
```

### Фильтрация по тегам:
```bash
adb logcat -s CallViewModel CallRoute MainActivity
```

### Только ошибки:
```bash
adb logcat *:E
```

### Сохранение в файл:
```bash
adb logcat > logcat.txt
```

### Очистка логов перед просмотром:
```bash
adb logcat -c && adb logcat
```

## Способ 3: Фильтрация по уровню важности

- `V` - Verbose (все логи)
- `D` - Debug (отладочные)
- `I` - Info (информационные)
- `W` - Warning (предупреждения)
- `E` - Error (ошибки)
- `F` - Fatal (критические)

Пример:
```bash
adb logcat *:E CallViewModel:D CallRoute:D MainActivity:D
```

## Что искать при краше:

1. **FATAL EXCEPTION** - основная ошибка
2. **AndroidRuntime** - системные ошибки
3. **CallViewModel** - ошибки в ViewModel звонков
4. **LiveKit** - ошибки из LiveKit SDK
5. **Stack trace** - стек вызовов, показывающий где произошла ошибка

## Полезные команды:

```bash
# Показать только ошибки и наши теги
adb logcat *:E CallViewModel:D CallRoute:D MainActivity:D

# Показать логи за последние 5 минут
adb logcat -t "$(date -d '5 minutes ago' '+%m-%d %H:%M:%S.000')"

# Сохранить логи с временными метками
adb logcat -v time > logcat_with_time.txt
```

