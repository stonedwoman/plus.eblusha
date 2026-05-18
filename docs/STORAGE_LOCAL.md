# Локальное хранилище вложений (STORAGE_BACKEND=local)

Перевод хранилища файлов с S3 на локальный диск.

## Когда использовать

- Сервер в Румынии (или другом месте без блокировок)
- Нет необходимости в облачном S3
- Файлы хранятся на диске сервера

## Настройка

### 1. Переменные окружения (.env)

```env
STORAGE_BACKEND=local
LOCAL_STORAGE_PATH=/var/lib/eblusha/storage
STORAGE_ENC_KEY=<base64 или hex, 32 байта>
STORAGE_PREFIX=uploads
```

S3-переменные (STORAGE_S3_*) не требуются.

### 2. Создание директории

```bash
sudo mkdir -p /var/lib/eblusha/storage
```

Директория должна быть доступна для записи процессу backend. По умолчанию systemd запускает сервис от root — права по умолчанию достаточны.

### 3. Права

Если backend запускается от пользователя `www-data` или другим:

```bash
sudo chown -R www-data:www-data /var/lib/eblusha
```

### 4. Перезапуск

```bash
sudo systemctl restart eblusha
```

## Структура на диске

```
/var/lib/eblusha/storage/
  uploads/
    1234567890-uuid.eblusha      # зашифрованный файл
    1234567890-uuid.eblusha.meta.json  # метаданные (content-type, enc, aad)
```

Формат файлов не меняется: тот же `.eblusha` с EBP1/EBP2, тот же контракт API.

## Проверка

1. **Загрузка:** отправьте файл в чат — в логах должно быть `Local storage provider initialized`
2. **Скачивание:** откройте вложение — файл должен открыться
3. **Проверка на диске:**

   ```bash
   ls -la /var/lib/eblusha/storage/uploads/
   ```

## Миграция с S3 на local

Если файлы уже в S3, перенесите их локально:

```bash
# Убедитесь, что STORAGE_BACKEND=local и S3-переменные ещё в .env
cd /DATA/eblusha-plus
npm run migrate:s3-to-local
```

Проверка перед миграцией (без записи):
```bash
npm run migrate:s3-to-local -- --dry-run
```

Миграция первых 10 объектов (тест):
```bash
npm run migrate:s3-to-local -- --limit 10
```

Скрипт идемпотентен: уже скопированные файлы пропускаются. После миграции все ссылки в БД (`/api/files/uploads/xxx.eblusha`) продолжат работать без изменений.

## Переключение обратно на S3

```env
STORAGE_BACKEND=s3
STORAGE_S3_ENDPOINT=...
STORAGE_S3_REGION=...
STORAGE_S3_BUCKET=...
# и т.д.
```

Старые файлы в LOCAL_STORAGE_PATH останутся на диске; новые будут писать в S3.
