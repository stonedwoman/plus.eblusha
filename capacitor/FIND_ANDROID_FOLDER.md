# Как найти папку android

## Папка android существует!

Папка `android` находится по пути:
```
C:\projects\plus.eblusha\capacitor\android
```

## Почему её может быть не видно:

### 1. Проводник не обновился
- Нажмите `F5` для обновления
- Или закройте и откройте папку заново

### 2. Скрытые файлы/папки
- В проводнике: `Вид → Показать → Скрытые элементы`
- Или нажмите `Alt + V → H`

### 3. Откройте напрямую через путь

В адресной строке проводника введите:
```
C:\projects\plus.eblusha\capacitor\android
```

Или через "Выполнить" (Win+R):
```
explorer C:\projects\plus.eblusha\capacitor\android
```

## Как открыть в Android Studio:

### Способ 1: Через File → Open
1. В Android Studio: `File → Open`
2. В адресной строке введите или перейдите к:
   ```
   C:\projects\plus.eblusha\capacitor\android
   ```
3. Нажмите `OK`

### Способ 2: Перетащить папку
1. Откройте проводник
2. Перейдите к: `C:\projects\plus.eblusha\capacitor`
3. Найдите папку `android`
4. Перетащите её в окно Android Studio

### Способ 3: Через командную строку
```cmd
cd C:\projects\plus.eblusha\capacitor\android
start "" "C:\Program Files\Android\Android Studio\bin\studio64.exe" .
```

## Проверка через командную строку:

Откройте командную строку (cmd) и выполните:
```cmd
cd C:\projects\plus.eblusha\capacitor
dir
```

Должна быть видна папка `android`.

Если её нет - возможно, это другой проект или другая папка.

## Если папки действительно нет:

Выполните в терминале (в папке capacitor):
```bash
cd C:\projects\plus.eblusha\capacitor
npx cap add android
```

Это создаст папку android заново.

