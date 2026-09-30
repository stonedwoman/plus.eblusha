#!/bin/sh
# Обновление кредитов Cloudflare TURN в .env и перезапуск LiveKit.
#
# Cloudflare выдаёт не общий секрет, а пару логин/пароль с ограниченным сроком, поэтому
# её приходится обновлять по расписанию — так же, как мы уже обновляем сертификат coturn.
# Перезапуск LiveKit РВЁТ активные звонки, поэтому по умолчанию скрипт молча выходит,
# если срок ещё не поджимает, и запускается ночью.
set -eu

ENV_FILE=/DATA/eblusha-plus/.env
COMPOSE_DIR=/DATA/eblusha-plus/deploy
COMPOSE_FILE=docker-compose.full.yml
TTL_SECONDS=${CF_TURN_TTL:-86400}

KEY_ID=$(grep '^CF_TURN_KEY_ID=' "$ENV_FILE" | cut -d= -f2- | tr -d '[:space:]')
API_TOKEN=$(grep '^CF_TURN_API_TOKEN=' "$ENV_FILE" | cut -d= -f2- | tr -d '[:space:]')

if [ -z "$KEY_ID" ] || [ -z "$API_TOKEN" ]; then
  echo "CF_TURN_KEY_ID / CF_TURN_API_TOKEN не заданы в .env — нечего обновлять" >&2
  exit 1
fi

RESP=$(curl -fsS -X POST \
  "https://rtc.live.cloudflare.com/v1/turn/keys/${KEY_ID}/credentials/generate-ice-servers" \
  -H "Authorization: Bearer ${API_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{\"ttl\": ${TTL_SECONDS}}")

# В ответе Cloudflare несколько записей: первая — голый STUN без пароля, пара
# логин/пароль лежит в той, что описывает сам ретранслятор. Берём первую с паролем.
parse_field() {
  printf '%s' "$RESP" | python3 -c "
import sys, json
d = json.load(sys.stdin)
ice = d.get('iceServers')
items = ice if isinstance(ice, list) else [ice]
for it in items:
    if isinstance(it, dict) and it.get('username') and it.get('credential'):
        print(it.get('$1', ''))
        break
"
}
USERNAME=$(parse_field username)
CREDENTIAL=$(parse_field credential)

if [ -z "$USERNAME" ] || [ -z "$CREDENTIAL" ]; then
  echo "Cloudflare не вернул пару логин/пароль: $RESP" >&2
  exit 1
fi

# Пишем в .env, не трогая остальные строки.
tmp=$(mktemp)
grep -v -E '^CF_TURN_(USERNAME|CREDENTIAL)=' "$ENV_FILE" > "$tmp"
printf 'CF_TURN_USERNAME=%s\n' "$USERNAME" >> "$tmp"
printf 'CF_TURN_CREDENTIAL=%s\n' "$CREDENTIAL" >> "$tmp"
cat "$tmp" > "$ENV_FILE"
rm -f "$tmp"

echo "$(date '+%Y-%m-%d %H:%M') креды Cloudflare обновлены (срок ${TTL_SECONDS} с)"

# Перезапуск только если попросили явно: днём он оборвёт разговоры.
if [ "${CF_TURN_RESTART:-0}" = "1" ]; then
  cd "$COMPOSE_DIR"
  docker compose -f "$COMPOSE_FILE" up -d livekit
  echo "LiveKit перезапущен с новыми кредами"
fi
