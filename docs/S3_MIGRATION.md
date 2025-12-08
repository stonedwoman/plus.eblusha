# Инструкция по переносу файлов на S3

## Что нужно перенести

Все загруженные файлы из локальной папки `uploads/` нужно перенести в S3-совместимое хранилище:
- Изображения (`.png`, `.jpg`, `.jpeg`, `.webp`)
- Голосовые сообщения (`.webm`, `.ogg`, `.mp4`, `.mpeg`)
- Другие файлы (`.pdf`, документы и т.д.)

**Текущее расположение файлов:**
- `/opt/eblusha-plus/uploads/` - корневая папка
- `/opt/eblusha-plus/uploads/uploads/` - подпапка (там лежат голосовые сообщения)

## Настройка S3

### 1. Создайте бакет в S3

Выберите провайдера S3-совместимого хранилища:
- **Hetzner Object Storage** (рекомендуется для EU)
- **AWS S3**
- **MinIO** (self-hosted)
- Другой S3-совместимый провайдер

Создайте бакет и получите:
- Endpoint URL
- Access Key
- Secret Key
- Bucket name
- Public URL для доступа к файлам

### 2. Настройте переменные в `.env`

Откройте файл `/opt/eblusha-plus/.env` и добавьте/обновите следующие переменные:

```env
# S3 Storage Configuration
STORAGE_S3_ENDPOINT=https://hel1.your-objectstorage.com
STORAGE_S3_REGION=us-east-1
STORAGE_S3_BUCKET=eblusha-uploads
STORAGE_S3_ACCESS_KEY=ваш-access-key
STORAGE_S3_SECRET_KEY=ваш-secret-key
STORAGE_PUBLIC_BASE_URL=https://eblusha-uploads.hel1.your-objectstorage.com
STORAGE_PREFIX=uploads
STORAGE_S3_FORCE_PATH_STYLE=true
STORAGE_S3_ACL=public-read
STORAGE_S3_SSE=AES256
```

#### Примеры для разных провайдеров:

**Hetzner Object Storage:**
```env
STORAGE_S3_ENDPOINT=https://hel1.your-objectstorage.com
STORAGE_S3_REGION=us-east-1
STORAGE_S3_BUCKET=eblusha-uploads
STORAGE_PUBLIC_BASE_URL=https://eblusha-uploads.hel1.your-objectstorage.com
STORAGE_S3_FORCE_PATH_STYLE=true
```

**AWS S3:**
```env
STORAGE_S3_ENDPOINT=https://s3.amazonaws.com
STORAGE_S3_REGION=us-east-1
STORAGE_S3_BUCKET=eblusha-uploads
STORAGE_PUBLIC_BASE_URL=https://eblusha-uploads.s3.amazonaws.com
STORAGE_S3_FORCE_PATH_STYLE=false
```

**MinIO (self-hosted):**
```env
STORAGE_S3_ENDPOINT=https://minio.yourdomain.com
STORAGE_S3_REGION=us-east-1
STORAGE_S3_BUCKET=eblusha-uploads
STORAGE_PUBLIC_BASE_URL=https://minio.yourdomain.com/eblusha-uploads
STORAGE_S3_FORCE_PATH_STYLE=true
```

### 3. Настройте права доступа к бакету

Убедитесь, что:
- Бакет настроен на публичный доступ для чтения (или используйте `STORAGE_S3_ACL=public-read`)
- CORS настроен для доступа с вашего домена
- Если используете политики бакета вместо ACL, можно убрать `STORAGE_S3_ACL`

## Запуск миграции

### 1. Остановите бэкенд (важно!)

Чтобы избежать загрузки новых файлов в локальную папку во время миграции:

```bash
sudo systemctl stop eblusha
# или если запущен через npm:
# pkill -f "node.*server.js"
```

### 2. Проверьте количество файлов для миграции

```bash
cd /opt/eblusha-plus
find uploads/ -type f | wc -l
```

### 3. Запустите миграцию

```bash
cd /opt/eblusha-plus
npm run migrate:uploads
```

Скрипт:
- ✅ Загрузит все файлы из `uploads/` (включая подпапки) в S3
- ✅ Обновит ссылки в базе данных (MessageAttachment, User.avatarUrl, Conversation.avatarUrl)
- ✅ Переместит файлы в архив `uploads/_migrated/` (чтобы не удалять сразу)

### 4. Опции миграции

**Оставить локальные копии файлов:**
```bash
npm run migrate:uploads -- --keep-local
```

**Только обновить БД (если файлы уже загружены в S3 вручную):**
```bash
npm run migrate:uploads -- --skip-upload
```

### 5. Проверьте результат

После миграции проверьте:
- Файлы загружены в S3 бакет
- Ссылки в базе обновлены (можно проверить через Prisma Studio или SQL)
- Новые файлы загружаются в S3 (перезапустите бэкенд и попробуйте загрузить файл)

### 6. Перезапустите бэкенд

```bash
sudo systemctl start eblusha
# или
npm run start
```

## Проверка работы

1. **Проверьте загрузку нового файла:**
   - Загрузите тестовый файл через интерфейс
   - Проверьте, что он появился в S3 бакете
   - Проверьте, что ссылка в БД указывает на S3 URL

2. **Проверьте доступ к старым файлам:**
   - Откройте старые сообщения с вложениями
   - Убедитесь, что файлы открываются по новым S3 ссылкам

## Откат (если что-то пошло не так)

Если нужно вернуться к локальному хранилищу:

1. Удалите или закомментируйте все `STORAGE_S3_*` переменные в `.env`
2. Перезапустите бэкенд
3. Файлы остались в `uploads/_migrated/` (если не использовали `--keep-local`)

## Важные замечания

- ⚠️ **Шифрование:** Для секретных чатов файлы дополнительно шифруются на клиенте перед загрузкой в S3
- ⚠️ **Server-Side Encryption:** Все файлы в S3 шифруются с помощью AES256 (если `STORAGE_S3_SSE=AES256`)
- ⚠️ **Структура папок:** Структура папок из `uploads/` сохраняется в S3 (например, `uploads/uploads/file.webm` → `uploads/uploads/file.webm` в S3)
- ⚠️ **Публичный доступ:** Убедитесь, что бакет настроен на публичное чтение или используйте подписанные URL для приватных файлов

## Поддержка

Если возникли проблемы:
1. Проверьте логи миграции на наличие ошибок
2. Убедитесь, что все переменные S3 заполнены правильно
3. Проверьте доступность S3 endpoint и права доступа
4. Проверьте, что бакет существует и доступен

