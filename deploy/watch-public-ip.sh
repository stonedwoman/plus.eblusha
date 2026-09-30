#!/bin/sh
# Страж публичного IP для LiveKit. Домашний IP динамический; при его смене LiveKit
# продолжает объявлять клиентам старый адрес, и внешние звонки тихо умирают
# (июнь 2026: IP сменился .26 -> .57, звонки между сетями пропали до рестарта).
set -eu
ENV_FILE=/DATA/eblusha-plus/.env
CURRENT=$(curl -s --max-time 10 ifconfig.me || true)
case "$CURRENT" in
  *[!0-9.]*|"") exit 0 ;; # мусор/пусто — не трогаем
esac
CONFIGURED=$(grep -oP "(?<=^LIVEKIT_NODE_IP=).*" "$ENV_FILE" | tr -d "[:space:]")
if [ -n "$CONFIGURED" ] && [ "$CURRENT" != "$CONFIGURED" ]; then
  sed -i "s|^LIVEKIT_NODE_IP=.*|LIVEKIT_NODE_IP=$CURRENT|" "$ENV_FILE"
  cd /DATA/eblusha-plus && docker compose -f deploy/docker-compose.full.yml --env-file .env up -d --force-recreate livekit >/dev/null 2>&1
  echo "$(date -Is) IP сменился $CONFIGURED -> $CURRENT, livekit пересоздан"
fi
