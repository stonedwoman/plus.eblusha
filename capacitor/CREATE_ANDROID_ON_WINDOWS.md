# Создание папки android на Windows

## Проблема
Папка `android` не видна в проводнике Windows, хотя должна существовать.

## Решение: Создать папку android заново

### Способ 1: Через терминал (PowerShell или CMD)

1. Откройте PowerShell или CMD
2. Перейдите в папку capacitor:
   ```cmd
   cd C:\projects\plus.eblusha\capacitor
   ```
3. Выполните команду для создания Android проекта:
   ```cmd
   npx cap add android
   ```

Это создаст папку `android` с полной структурой проекта.

### Способ 2: Через Android Studio напрямую

Если у вас уже открыт проект в Android Studio:

1. В Android Studio: `File → Open`
2. Выберите папку: `C:\projects\plus.eblusha\capacitor`
3. Android Studio может предложить создать Android проект
4. Или выполните в терминале Android Studio:
   ```
   npx cap add android
   ```

### Способ 3: Если команда не работает

Убедитесь, что вы в правильной папке и зависимости установлены:

```cmd
cd C:\projects\plus.eblusha\capacitor
npm install
npx cap add android
```

## После создания папки android:

1. Откройте Android Studio
2. `File → Open`
3. Выберите: `C:\projects\plus.eblusha\capacitor\android`
4. Дождитесь синхронизации Gradle
5. Создайте конфигурацию запуска (теперь модуль `app` должен появиться)

## Проверка:

После выполнения `npx cap add android` проверьте:

```cmd
dir C:\projects\plus.eblusha\capacitor\android
```

Должны быть видны:
- `app/`
- `build.gradle`
- `settings.gradle`
- `gradlew.bat`

## Если ошибки при создании:

1. Убедитесь, что Node.js установлен: `node --version`
2. Убедитесь, что npm работает: `npm --version`
3. Установите зависимости: `npm install` (в папке capacitor)
4. Попробуйте снова: `npx cap add android`

