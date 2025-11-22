# Установка Android Studio

## Linux (Ubuntu/Debian)

### Способ 1: Snap (рекомендуется)
```bash
sudo snap install android-studio --classic
```

### Способ 2: Ручная установка
1. Скачайте Android Studio с https://developer.android.com/studio
2. Распакуйте в `/opt/android-studio`
3. Запустите: `/opt/android-studio/bin/studio.sh`

### Способ 3: Через JetBrains Toolbox
1. Установите JetBrains Toolbox
2. Установите Android Studio через Toolbox

## После установки

1. Запустите Android Studio первый раз
2. Пройдите настройку (SDK, эмулятор и т.д.)
3. Откройте проект:
   ```bash
   cd /opt/eblusha-plus/capacitor
   npm run open:android
   ```

Или вручную:
- `File → Open` → выберите `/opt/eblusha-plus/capacitor/android`

## Требования

- Java 17 или выше
- Android SDK (установится автоматически при первом запуске)
- Минимум 4GB RAM для эмулятора

