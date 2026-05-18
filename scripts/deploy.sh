#!/bin/bash
# Deploy frontend + backend: build, rsync to web root, reload nginx, build backend
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/frontend"

# Актуальный код из docker logs Valheim → public/v/ до vite build (иначе на сайте вечный старый JSON)
if command -v docker >/dev/null 2>&1 && docker ps --format '{{.Names}}' 2>/dev/null | grep -qx 'valheim'; then
  echo "→ Valheim join code: обновляю public/v/valheim-join-code.json из docker logs..."
  /DATA/valheim/scripts/publish-valheim-join-code.py || echo "  (предупреждение: publish-valheim-join-code не выполнился)"
else
  echo "→ Valheim join code: контейнер valheim не найден — JSON не трогаем (обнови вручную или cron на хосте с Valheim)"
fi

echo "→ Building frontend..."
npm run build

echo "→ Syncing to /var/www/eblusha.org/"
sudo rsync -a dist/ /var/www/eblusha.org/

echo "→ Syncing public/ overlay (живые статики по тем же URL, что у Vite public/)..."
sudo mkdir -p /var/www/eblusha.org-public
sudo rsync -a --delete public/ /var/www/eblusha.org-public/

echo "→ Reloading nginx..."
sudo systemctl reload nginx

echo "→ Building backend..."
cd "$ROOT"
npm run build

echo "✓ Deploy complete"
