#!/usr/bin/env bash
# Установка ключа APNs одной командой (см. docs/apns-setup.md):
#
#   scripts/apns-install-key.sh ~/Downloads/AuthKey_XXXXXXXXXX.p8 [sandbox|production]
#
# Key ID берётся из имени файла (AuthKey_<KEY_ID>.p8), ключ кладётся в .env как base64
# (APNS_KEY), файл копируется в secrets/ (гитигнорится), затем перезапускаются backend и
# worker и проверяется строка «APNs push configured» в логе worker'а.
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$HERE"

file=${1:-}
apns_env=${2:-}
if [ -z "$file" ] || [ ! -f "$file" ]; then
  echo "использование: $0 /путь/AuthKey_XXXXXXXXXX.p8 [sandbox|production]" >&2
  exit 2
fi

base=$(basename "$file")
key_id=$(printf '%s' "$base" | sed -nE 's/^AuthKey_([A-Z0-9]{10})\.p8$/\1/p')
if [ -z "$key_id" ]; then
  echo "не могу вытащить Key ID из имени «$base» — ожидаю AuthKey_<10 символов>.p8" >&2
  exit 2
fi
if ! grep -q 'BEGIN PRIVATE KEY' "$file"; then
  echo "файл не похож на .p8 (нет BEGIN PRIVATE KEY)" >&2
  exit 2
fi

mkdir -p secrets && chmod 700 secrets
install -m 600 "$file" "secrets/$base"
key_b64=$(base64 -w0 "$file")

# Правим .env на месте: раскомментируем/перезаписываем три строки, остальное не трогаем.
set_var() {
  local name=$1 value=$2
  if grep -qE "^#?${name}=" .env; then
    sed -i -E "s|^#?${name}=.*|${name}=${value}|" .env
  else
    printf '%s=%s\n' "$name" "$value" >> .env
  fi
}
set_var APNS_KEY_ID "$key_id"
set_var APNS_KEY "$key_b64"
if [ -n "$apns_env" ]; then
  case "$apns_env" in sandbox|production) set_var APNS_ENV "$apns_env" ;; *) echo "APNS_ENV: sandbox|production" >&2; exit 2 ;; esac
fi
grep -qE '^APNS_TEAM_ID=' .env || set_var APNS_TEAM_ID 4748P9MT6D

echo "==> .env: APNS_KEY_ID=$key_id, APNS_ENV=$(sed -nE 's/^APNS_ENV=//p' .env), ключ $base"
echo "==> перезапускаю backend и worker"
docker compose -f deploy/docker-compose.full.yml --env-file .env up -d backend worker >/dev/null

# Провайдер ленивый: конфиг читается при первой отправке, поэтому дёргаем его сами —
# кривой ключ должен быть виден сразу, а не при первом звонке.
echo "==> проверяю ключ внутри worker'а"
for _ in $(seq 1 20); do
  if docker exec eblusha-worker node -e '
    const crypto=require("crypto");
    const raw=(process.env.APNS_KEY||"").trim();
    const pem=raw.startsWith("-----BEGIN")?raw:Buffer.from(raw,"base64").toString("utf8");
    const k=crypto.createPrivateKey(pem);
    if(k.asymmetricKeyType!=="ec") throw new Error("ожидался EC-ключ, а это "+k.asymmetricKeyType);
    console.log("ключ читается: EC", k.asymmetricKeyDetails&&k.asymmetricKeyDetails.namedCurve);
  ' 2>/dev/null; then
    echo "==> готово. Дальше — тест с телефона: свернуть приложение и написать/позвонить с веба."
    echo "    Лог доставки: docker logs -f eblusha-worker | grep -i apns"
    exit 0
  fi
  sleep 1
done
echo "worker не поднялся или ключ не читается — смотри: docker logs eblusha-worker" >&2
exit 1
