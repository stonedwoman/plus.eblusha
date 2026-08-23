#!/usr/bin/env bash
#
# Резервное копирование Eblusha Cloud через restic.
#
# ЧТО БЭКАПИМ И ПОЧЕМУ:
#   objects/    ДА  — оригиналы. Единственное, что нельзя восстановить ничем.
#   PostgreSQL  ДА  — метаданные: без них objects/ это мешок безымянных блобов.
#   derived/    НЕТ — превью, постеры, web-версии видео. Кэш: пересоздаётся джобой.
#   staging/    НЕТ — незавершённые загрузки, живут максимум CLOUD_UPLOAD_TTL_HOURS.
#   tmp/        НЕТ — рабочие файлы ffmpeg.
#
# Почему restic, а не «rsync --delete»: rsync с зеркалированием уничтожает
# резервную копию ровно так же, как оригинал — случайное удаление или шифровальщик
# доедут до бэкапа при первом же прогоне. restic хранит версии и умеет проверять
# целостность.
#
# ВНЕШНИЙ ДИСК ЕЩЁ НЕ ПОДКЛЮЧЁН. Путь репозитория НЕ выдуман: скрипт откажется
# работать, пока RESTIC_REPOSITORY не задан явно в /etc/eblusha-cloud-backup.env.
# Когда диск появится — примонтируйте его и впишите путь, больше ничего не нужно.
#
# Установка расписания (после подключения диска):
#   sudo cp deploy/cloud-backup.sh /usr/local/bin/eblusha-cloud-backup
#   sudo chmod +x /usr/local/bin/eblusha-cloud-backup
#   sudo cp deploy/cloud-backup-env.example /etc/eblusha-cloud-backup.env  # и заполнить
#   sudo chmod 600 /etc/eblusha-cloud-backup.env
#   sudo crontab -e
#     30 3 * * *  /usr/local/bin/eblusha-cloud-backup backup   >> /var/log/eblusha-cloud-backup.log 2>&1
#     15 5 * * 0  /usr/local/bin/eblusha-cloud-backup check    >> /var/log/eblusha-cloud-backup.log 2>&1
set -euo pipefail

ENV_FILE="${EBLUSHA_BACKUP_ENV:-/etc/eblusha-cloud-backup.env}"
if [[ -f "$ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  set -a; source "$ENV_FILE"; set +a
fi

CLOUD_ROOT="${CLOUD_STORAGE_ROOT:-/var/lib/eblusha/cloud}"
PG_CONTAINER="${PG_CONTAINER:-eblusha-postgres}"
PG_USER="${PG_USER:-eblusha}"
PG_DB="${PG_DB:-eblusha}"
DUMP_DIR="${DUMP_DIR:-/var/lib/eblusha/backup-staging}"
KEEP_DAILY="${KEEP_DAILY:-7}"
KEEP_WEEKLY="${KEEP_WEEKLY:-5}"
KEEP_MONTHLY="${KEEP_MONTHLY:-12}"

log() { printf '%s  %s\n' "$(date -Is)" "$*"; }
die() { log "ОШИБКА: $*"; exit 1; }

require_repo() {
  [[ -n "${RESTIC_REPOSITORY:-}" ]] || die "RESTIC_REPOSITORY не задан. Внешний диск ещё не подключён — см. комментарий в начале скрипта и deploy/cloud-backup-env.example."
  [[ -n "${RESTIC_PASSWORD:-}${RESTIC_PASSWORD_FILE:-}" ]] || die "Нужен RESTIC_PASSWORD или RESTIC_PASSWORD_FILE."
  command -v restic >/dev/null || die "restic не установлен: apt install restic"
}

cmd_init() {
  require_repo
  restic snapshots >/dev/null 2>&1 && { log "репозиторий уже инициализирован"; return; }
  restic init
  log "репозиторий создан: $RESTIC_REPOSITORY"
}

cmd_backup() {
  require_repo
  [[ -d "$CLOUD_ROOT/objects" ]] || die "нет каталога $CLOUD_ROOT/objects"

  mkdir -p "$DUMP_DIR"
  chmod 700 "$DUMP_DIR"
  local dump="$DUMP_DIR/eblusha-$(date +%Y%m%d-%H%M%S).dump"

  log "дамп PostgreSQL → $dump"
  docker exec "$PG_CONTAINER" pg_dump -U "$PG_USER" -d "$PG_DB" -Fc > "$dump" \
    || die "pg_dump не отработал"

  log "restic backup: objects + дамп БД"
  # derived/staging/tmp не входят сюда сознательно (см. шапку файла).
  restic backup \
    --tag eblusha-cloud \
    --exclude-caches \
    "$CLOUD_ROOT/objects" \
    "$dump" \
    || die "restic backup упал"

  rm -f "$dump"

  log "прореживание истории: $KEEP_DAILY дневных / $KEEP_WEEKLY недельных / $KEEP_MONTHLY месячных"
  restic forget \
    --tag eblusha-cloud \
    --keep-daily "$KEEP_DAILY" \
    --keep-weekly "$KEEP_WEEKLY" \
    --keep-monthly "$KEEP_MONTHLY" \
    --prune

  log "готово"
}

# Полная проверка целостности дорогая, поэтому по расписанию раз в неделю и
# только на выборке данных — не на каждый бэкап.
cmd_check() {
  require_repo
  log "restic check --read-data-subset=5%"
  restic check --read-data-subset=5%
  log "проверка завершена"
}

cmd_snapshots() {
  require_repo
  restic snapshots --tag eblusha-cloud
}

cmd_restore() {
  require_repo
  local snapshot="${1:-latest}"
  local target="${2:-}"
  [[ -n "$target" ]] || die "использование: $0 restore <snapshot|latest> <каталог-назначения>"
  log "восстановление $snapshot → $target"
  restic restore "$snapshot" --target "$target"
  cat <<'EOF'

Дальше вручную:
  1) остановить backend и cloud-worker;
  2) вернуть objects/ на место (rsync -a восстановленный/objects/ /var/lib/eblusha/cloud/objects/);
  3) восстановить БД:  docker exec -i eblusha-postgres pg_restore -U eblusha -d eblusha --clean <дамп>;
  4) запустить сервисы. derived/ восстанавливать НЕ нужно — превью пересоздадутся:
     превью строятся заново при обращении, а массово — через
     npm run cloud:maintenance и повторный enqueue (кнопка «Перегенерировать» у файла).
EOF
}

case "${1:-}" in
  init)      cmd_init ;;
  backup)    cmd_backup ;;
  check)     cmd_check ;;
  snapshots) cmd_snapshots ;;
  restore)   shift; cmd_restore "$@" ;;
  *)
    cat <<EOF
Использование: $0 {init|backup|check|snapshots|restore <snapshot> <каталог>}

Настройка — в $ENV_FILE (см. deploy/cloud-backup-env.example).
Внешний диск сейчас не подключён: пока RESTIC_REPOSITORY не задан, скрипт
намеренно ничего не делает и не придумывает путь монтирования.
EOF
    exit 1
    ;;
esac
