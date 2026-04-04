# Deployment steps for plus.eblusha.org

These files are prefilled for your project and domain.

## eblusha.org через Cloudflare Tunnel

Основной домен и `/v` (Valheim) можно отдавать через **Cloudflare Tunnel**, запасной вход из РФ — отдельным именем/DNS без туннеля. Инструкция и пример `config.yml`: **`deploy/cloudflared/README.md`**.

## Вариант: Полный стек в Docker (включая LiveKit)

Если нужен весь стек в одном месте (Postgres, Redis, Backend, Worker, **LiveKit**, Nginx):

```
cd /DATA/eblusha-plus
# Сборка фронта
cd frontend && npm ci && npm run build && cd ..
# Запуск (обязательно --env-file для LiveKit)
docker compose -f deploy/docker-compose.full.yml --env-file .env up -d --build
```

В `.env` задайте:
- `LIVEKIT_URL=ws://stoned.local` (для HTTP) или `wss://plus.eblusha.org` (для HTTPS)
- `LIVEKIT_API_KEY=myapp` и `LIVEKIT_API_SECRET` (должны совпадать с ключами в LiveKit)

---

## 1) Copy repo to server
```
sudo mkdir -p /opt/eblusha-plus && sudo chown -R $USER:$USER /opt/eblusha-plus
cd /opt/eblusha-plus
# push your local commits, then on server:
git clone YOUR_REPO_URL .
```

## 2) Start Postgres
```
cd /opt/eblusha-plus/deploy
docker compose up -d
```

## 3) Create .env (production)
Create `/opt/eblusha-plus/.env` based on below template (values already tailored):
```
NODE_ENV=production
PORT=4000
APP_ORIGIN=https://plus.eblusha.org
DATABASE_URL=postgresql://eblusha:S3cure_DB_Pass@127.0.0.1:5432/eblusha?schema=public
JWT_SECRET=replace_with_long_random_hex_64
JWT_REFRESH_SECRET=replace_with_long_random_hex_64
LIVEKIT_URL=wss://voice.eblusha.org
LIVEKIT_API_KEY=myapp
LIVEKIT_API_SECRET=YOUR_LIVEKIT_SECRET

# Storage: local (no S3) or s3. For Romania server, use local.
STORAGE_BACKEND=local
LOCAL_STORAGE_PATH=/var/lib/eblusha/storage
STORAGE_ENC_KEY=<base64-32-bytes>
STORAGE_PREFIX=uploads
```

## 3b) Create storage directory (for STORAGE_BACKEND=local)
```bash
sudo mkdir -p /var/lib/eblusha/storage
# Ensure writable by the eblusha process (systemd usually runs as root)
```

## 4) Build backend and run migrations
```
cd /opt/eblusha-plus
# Ensure devDependencies are present for TypeScript build (some @types packages are required)
npm ci
npx prisma generate
npx prisma migrate deploy
npm run build
```

## 5) Systemd service
```
sudo cp deploy/eblusha.service /etc/systemd/system/eblusha.service
sudo systemctl daemon-reload
sudo systemctl enable --now eblusha
sudo journalctl -u eblusha -f
```

## 6) Frontend build and publish
```
cd /opt/eblusha-plus/frontend
npm ci
npm run build
sudo mkdir -p /var/www/plus.eblusha.org
sudo rsync -a dist/ /var/www/plus.eblusha.org/
```

## 7) Nginx
```
sudo cp /opt/eblusha-plus/deploy/nginx-plus.eblusha.org.conf /etc/nginx/sites-available/plus.eblusha.org
sudo ln -sf /etc/nginx/sites-available/plus.eblusha.org /etc/nginx/sites-enabled/plus.eblusha.org
sudo nginx -t && sudo systemctl reload nginx
```

## 8) HTTPS
```
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d plus.eblusha.org --redirect --agree-tos -m you@example.com -n
```

## Крупные файлы (большие не загружаются)

1. **Nginx** — любой nginx перед backend обязан иметь:
   - `client_max_body_size 1024m;` (дефолт nginx = 1MB!)
   - `proxy_read_timeout 3600s;` и `proxy_send_timeout 3600s;`
   Файл `deploy/nginx-plus.eblusha.org.conf` уже содержит это. При кастомном конфиге — добавьте.

2. **EBP2** — файлы >50 MB автоматически шифруются потоково (EBP2). `STORAGE_ENC_V2=true` включает EBP2 для всех; без флага — только для больших.


