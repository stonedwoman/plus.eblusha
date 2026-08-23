#!/usr/bin/env bash
#
# Установка отдельного Cloudflare Tunnel под cloud.eblusha.org.
#
# Токен читается со STDIN, а не из аргумента: аргументы командной строки видны
# в `ps` любому пользователю машины и оседают в истории шелла. Именно так сейчас
# запущен cloudflared-huila — его токен виден в /proc всем.
#
#   Использование:
#     sudo ./deploy/cloud-tunnel-install.sh
#     <вставить токен, Enter, Ctrl+D>
#
#   или из менеджера паролей:
#     pass show cf/eblusha-cloud | sudo ./deploy/cloud-tunnel-install.sh
set -euo pipefail

UNIT=/etc/systemd/system/cloudflared-cloud.service
TOKEN_FILE=/etc/cloudflared/cloud.token
METRICS_PORT=20343
SRC="$(cd "$(dirname "$0")" && pwd)"

die() { echo "ОШИБКА: $*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "нужен root (sudo)"
[[ -x /usr/local/bin/cloudflared ]] || die "cloudflared не найден в /usr/local/bin"
# Ставить cloudflared из apt по инструкции дашборда НЕ надо: бинарь уже есть в
# /usr/local/bin, а пакет положит второй в /usr/bin — потом не разберёшь, какой
# из них обслуживает какой тоннель.
if [[ -x /usr/bin/cloudflared ]]; then
  echo "ВНИМАНИЕ: найден второй cloudflared в /usr/bin — юнит использует /usr/local/bin" >&2
fi
[[ -f "$SRC/cloudflared-cloud.service.example" ]] || die "рядом нет cloudflared-cloud.service.example"

if ss -lnt "sport = :$METRICS_PORT" 2>/dev/null | grep -q LISTEN; then
  die "порт метрик $METRICS_PORT уже занят — поправьте --metrics в юните"
fi

cat >&2 <<'PROMPT'
Вставьте токен тоннеля и нажмите Ctrl+D.
Можно вставить целиком строку из дашборда — например
  sudo cloudflared service install eyJhIjoi...
или
  cloudflared tunnel run --token eyJhIjoi...
токен будет извлечён сам.
PROMPT
RAW="$(cat)"

# Из дашборда копируется вся команда, а не голый токен. Вырезаем его сами:
# один шанс на опечатку меньше, чем при ручном выделении длинной строки мышью.
TOKEN="$(printf '%s' "$RAW" | tr -s '[:space:]' '\n' | grep -E '^ey[A-Za-z0-9_-]{40,}$' | tail -n1 || true)"
if [[ -z "$TOKEN" ]]; then
  # Не команда, а просто вставленный токен — чистим пробелы и переводы строк.
  TOKEN="$(printf '%s' "$RAW" | tr -d '[:space:]')"
fi
[[ -n "$TOKEN" ]] || die "пустой токен"
[[ "$TOKEN" == ey* ]] || die "это не похоже на токен тоннеля (ожидается строка, начинающаяся с 'ey')"
# Токен тоннеля — base64url JSON с полями a/t/s. Проверяем грубо, чтобы не
# записать в файл случайно вставленный мусор и не гадать потом при отладке.
[[ ${#TOKEN} -ge 100 ]] || die "токен подозрительно короткий (${#TOKEN} символов) — скопировалась не вся строка?"

mkdir -p /etc/cloudflared
install -m 600 /dev/null "$TOKEN_FILE"
printf '%s' "$TOKEN" > "$TOKEN_FILE"
echo "токен записан в $TOKEN_FILE (600)"

install -m 644 "$SRC/cloudflared-cloud.service.example" "$UNIT"
systemctl daemon-reload
systemctl enable --now cloudflared-cloud

echo "ждём подключения к edge…"
for _ in $(seq 1 20); do
  sleep 1
  if curl -fsS "http://127.0.0.1:$METRICS_PORT/metrics" 2>/dev/null | grep -q 'cloudflared_tunnel_ha_connections [1-9]'; then
    echo
    echo "тоннель поднят:"
    curl -s "http://127.0.0.1:$METRICS_PORT/metrics" | grep -E 'server_locations|ha_connections' | grep -v '^#'
    echo
    echo "Осталось в Zero Trust у ЭТОГО тоннеля добавить Public Hostname:"
    echo "  hostname:       cloud.eblusha.org"
    echo "  origin service: http://127.0.0.1:80"
    exit 0
  fi
done

echo "тоннель ещё не сообщил о подключении — смотрите: journalctl -u cloudflared-cloud -n 50" >&2
exit 1
