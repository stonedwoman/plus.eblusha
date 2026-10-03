#!/usr/bin/env bash
# test/secret-env/secret-test.sh — изолированная среда интеграционных тестов бэкенда.
#
# Зачем. test/*.integration.test.ts поднимают app прямо в своём процессе. Запущенные из
# /DATA/eblusha-plus, они читают БОЕВОЙ .env дважды — src/config/env.ts (dotenv из cwd) и сам
# Prisma-клиент (node_modules/.prisma/client/../../../.env) — и пишут в боевые Postgres/Redis,
# а Socket.IO redis-adapter разносит их события живым сокетам. Поэтому тесты гоняются только здесь.
#
# Как устроено.
#   - Свой compose-проект eb-secret-test (test/secret-env/docker-compose.yml): Postgres
#     127.0.0.1:55433 (БД eblusha_secret_test, пользователь ebtest, cluster_name=eb-secret-test)
#     и Redis 127.0.0.1:56380, данные в tmpfs, общих сетей/томов с боевым стеком нет.
#   - Своя копия кода и node_modules: $EB_TEST_HOME/work (по умолчанию /DATA/eb-secret-test/work).
#     Там .env = копия $EB_TEST_HOME/.env.test, так что и dotenv, и Prisma-клиент читают тестовый файл;
#     до боевого .env из этого дерева не дотянуться. Prisma-клиент генерируется свой.
#   - Тест стартует через `env -i` только с переменными .env.test и с предохранителем
#     `-r ./test/secret-env/guard.ts`, который роняет процесс при любом признаке прода.
#   - up/sync/run/reset/down сериализуются через flock $EB_TEST_HOME/.lock (параллельные агенты ждут).
#
# Команды:
#   up [--ref REF]          поднять Postgres+Redis, создать .env.test, sync, migrate deploy
#   sync [--ref REF]        код → work/ (по умолчанию рабочее дерево, с незакоммиченными правками;
#                           --ref REF = git archive REF, рабочее дерево не трогается);
#                           node_modules — при смене package-lock.json; prisma generate — при смене схемы;
#                           prisma migrate deploy — всегда
#   run [--ref REF] [--no-sync] [--timeout SEC] FILE...
#                           прогнать тест(ы); пути относительно корня репозитория (test/xxx.test.ts);
#                           таймаут на файл по умолчанию 900 с (EB_TEST_TIMEOUT)
#   reset                   пустая тестовая БД (drop schema + migrate deploy) и пустой тестовый Redis
#   psql [ARGS...]          psql в ТЕСТОВУЮ БД;   redis-cli [ARGS...] — в ТЕСТОВЫЙ Redis
#   prod-proof [PROOF_JSON] ТОЛЬКО ЧТЕНИЕ боевых: счётчики (транзакция READ ONLY) и проверка,
#                           что id из строки EB_PROOF (env-proof.test.ts) в боевых Postgres/Redis нет
#   status                  что запущено и куда смотрит
#   down [--purge]          снести контейнеры (tmpfs — данные исчезают); --purge — ещё и $EB_TEST_HOME
set -euo pipefail

REPO="${EB_REPO:-/DATA/eblusha-plus}"
TEST_HOME="${EB_TEST_HOME:-/DATA/eb-secret-test}"
WORK="$TEST_HOME/work"
ENV_TEST="$TEST_HOME/.env.test"
PROJECT=eb-secret-test
DC_FILE="$REPO/test/secret-env/docker-compose.yml"
PG_PORT=55433
REDIS_PORT=56380
MARKER_KEY="eb-secret-test:marker"
MARKER="eb-secret-test"
# Боевые контейнеры — только для prod-proof, только чтение.
PROD_PG_CONTAINER=eblusha-postgres
PROD_REDIS_CONTAINER=eblusha-redis
PROD_DB=eblusha
PROD_DB_USER=eblusha

log() { printf '[secret-test] %s\n' "$*" >&2; }
fail() { printf '[secret-test] ОШИБКА: %s\n' "$*" >&2; exit 1; }
dc() { EB_TEST_PG_PORT="$PG_PORT" EB_TEST_REDIS_PORT="$REDIS_PORT" docker compose -p "$PROJECT" -f "$DC_FILE" "$@"; }
rnd() { openssl rand -hex 32; }

sanity() {
  case "$TEST_HOME" in
    "" | / | "$REPO" | "$REPO"/*) fail "EB_TEST_HOME=$TEST_HOME недопустим (пусто, корень или внутри боевого дерева)" ;;
  esac
  [[ "$(basename "$TEST_HOME")" == *eb-secret-test* ]] || fail "имя EB_TEST_HOME должно содержать eb-secret-test (страховка для rm -rf)"
  [[ -f "$DC_FILE" ]] || fail "нет $DC_FILE"
}

ensure_env_test() {
  mkdir -p "$TEST_HOME" "$WORK" "$TEST_HOME/storage" "$TEST_HOME/cloud"
  chmod 700 "$TEST_HOME"
  if [[ ! -f "$ENV_TEST" ]]; then
    log "создаю $ENV_TEST (случайные тестовые секреты)"
    umask 077
    cat >"$ENV_TEST" <<EOF
# eb-secret-test — ТЕСТОВОЕ окружение, создан secret-test.sh $(date -Is).
# Боевых значений здесь нет и быть не должно. Без строки EB_SECRET_TEST=1 guard.ts откажется работать.
EB_SECRET_TEST=1
NODE_ENV=test
LOG_LEVEL=warn
PORT=0
DATABASE_URL=postgresql://ebtest:ebtest@127.0.0.1:${PG_PORT}/eblusha_secret_test?schema=public
REDIS_URL=redis://127.0.0.1:${REDIS_PORT}/0
EB_TEST_PG_PORT=${PG_PORT}
EB_TEST_REDIS_PORT=${REDIS_PORT}
JWT_SECRET=$(rnd)
JWT_REFRESH_SECRET=$(rnd)
LIVEKIT_API_KEY=ebtest
LIVEKIT_API_SECRET=$(rnd)
LIVEKIT_URL=ws://127.0.0.1:9
STORAGE_BACKEND=local
LOCAL_STORAGE_PATH=${TEST_HOME}/storage
STORAGE_ENC_KEY=$(rnd)
CHAT_ENC_KEK=$(rnd)
CLOUD_ENABLED=0
CLOUD_STORAGE_ROOT=${TEST_HOME}/cloud
CHECKPOINT_DISABLE=1
PRISMA_HIDE_UPDATE_MESSAGE=1
EOF
  fi
  grep -qx 'EB_SECRET_TEST=1' "$ENV_TEST" || fail "$ENV_TEST без строки EB_SECRET_TEST=1"
  grep -q "^DATABASE_URL=postgresql://ebtest:ebtest@127.0.0.1:${PG_PORT}/eblusha_secret_test" "$ENV_TEST" ||
    fail "$ENV_TEST: DATABASE_URL не на тестовую БД"
  grep -q "^REDIS_URL=redis://127.0.0.1:${REDIS_PORT}/" "$ENV_TEST" || fail "$ENV_TEST: REDIS_URL не на тестовый Redis"
}

# Команда в work/ с окружением ТОЛЬКО из .env.test (env -i: ни одной унаследованной переменной).
# EXEC_TIMEOUT=N — убить через N секунд (тесты, которые не закрывают Redis/Prisma, иначе висят вечно).
test_exec() {
  local nodebin
  nodebin="$(dirname "$(command -v node)")"
  local -a pre=()
  [[ -n "${EXEC_TIMEOUT:-}" ]] && pre=(timeout -k 10 "$EXEC_TIMEOUT")
  (cd "$WORK" && "${pre[@]}" env -i PATH="$nodebin:/usr/local/bin:/usr/bin:/bin" HOME="$TEST_HOME" LANG=C.UTF-8 \
    bash -c 'set -a; . "$0"; set +a; exec "$@"' "$ENV_TEST" "$@")
}

require_running() {
  dc ps --status running --services 2>/dev/null | grep -qx postgres || fail "среда не поднята: $0 up"
  dc ps --status running --services 2>/dev/null | grep -qx redis || fail "среда не поднята: $0 up"
}

set_markers() {
  dc exec -T postgres psql -U ebtest -d eblusha_secret_test -X -q -v ON_ERROR_STOP=1 \
    -c "COMMENT ON DATABASE eblusha_secret_test IS '$MARKER'" >/dev/null
  dc exec -T redis redis-cli SET "$MARKER_KEY" "$MARKER" >/dev/null
}

do_sync() {
  local ref="${1:-}"
  sanity
  ensure_env_test
  if [[ -n "$ref" ]]; then
    local sha
    sha="$(git -C "$REPO" rev-parse --verify "${ref}^{commit}")" || fail "нет такого ref: $ref"
    log "код из git $ref ($sha) → $WORK"
    rm -rf "${WORK:?}/src" "${WORK:?}/test" "${WORK:?}/prisma"
    git -C "$REPO" archive "$sha" src test prisma package.json package-lock.json tsconfig.json prisma.config.ts |
      tar -x -C "$WORK"
    # харнесс — всегда из рабочего дерева: в старых коммитах его может не быть
    mkdir -p "$WORK/test/secret-env"
    cp -a "$REPO/test/secret-env/." "$WORK/test/secret-env/"
    echo "git $ref $sha" >"$WORK/.synced-from"
  else
    log "код из рабочего дерева $REPO (с незакоммиченными правками) → $WORK"
    local d f
    for d in src test prisma; do rsync -a --delete "$REPO/$d/" "$WORK/$d/"; done
    for f in package.json package-lock.json tsconfig.json prisma.config.ts; do cp -a "$REPO/$f" "$WORK/$f"; done
    echo "worktree HEAD=$(git -C "$REPO" rev-parse HEAD) +uncommitted, $(date -Is)" >"$WORK/.synced-from"
  fi

  if [[ ! -d "$WORK/node_modules" ]] || ! cmp -s "$REPO/package-lock.json" "$WORK/.deps-lock"; then
    log "копирую node_modules (без .prisma — клиент генерируем свой)"
    rsync -a --delete --exclude '/.prisma/' "$REPO/node_modules/" "$WORK/node_modules/"
    cp "$REPO/package-lock.json" "$WORK/.deps-lock"
    rm -f "$WORK/.schema-generated"
  fi

  # dotenv (cwd) и Prisma-клиент (work/node_modules/.prisma/client/../../../.env) читают ЭТОТ файл
  cp "$ENV_TEST" "$WORK/.env"
  chmod 600 "$WORK/.env"
  rm -f "$WORK/.env.local"

  if [[ ! -f "$WORK/node_modules/.prisma/client/index.js" ]] || ! cmp -s "$WORK/prisma/schema.prisma" "$WORK/.schema-generated"; then
    log "prisma generate → $WORK/node_modules/.prisma/client"
    test_exec node_modules/.bin/prisma generate >/dev/null
    cp "$WORK/prisma/schema.prisma" "$WORK/.schema-generated"
  fi
  log "prisma migrate deploy → тестовая БД"
  test_exec node_modules/.bin/prisma migrate deploy
}

do_up() {
  local ref=""
  [[ "${1:-}" == "--ref" ]] && ref="${2:?--ref REF}"
  sanity
  ensure_env_test
  log "поднимаю $PROJECT (Postgres 127.0.0.1:$PG_PORT, Redis 127.0.0.1:$REDIS_PORT)"
  dc up -d --wait
  set_markers
  do_sync "$ref"
  do_status
}

do_run() {
  local ref="" nosync=0 tmo="${EB_TEST_TIMEOUT:-900}"
  local -a files=()
  while (($#)); do
    case "$1" in
      --ref) ref="${2:?--ref REF}"; shift 2 ;;
      --no-sync) nosync=1; shift ;;
      --timeout) tmo="${2:?--timeout SEC}"; shift 2 ;;
      *) files+=("$1"); shift ;;
    esac
  done
  ((${#files[@]})) || fail "укажите файл(ы) теста, например test/secret-env/env-proof.test.ts"
  sanity
  require_running
  ((nosync)) || do_sync "$ref"
  set_markers
  local rc=0 one f
  for f in "${files[@]}"; do
    [[ -f "$WORK/$f" ]] || fail "нет $WORK/$f"
    log "=== run $f ($(cat "$WORK/.synced-from" 2>/dev/null))"
    one=0
    EXEC_TIMEOUT="$tmo" test_exec node_modules/.bin/ts-node -r ./test/secret-env/guard.ts "$f" || one=$?
    if ((one == 124 || one == 137)); then
      log "ТАЙМАУТ ${tmo}s: $f не завершил процесс (незакрытые Redis/Prisma/Socket.IO). Если выше напечатано «ok» —"
      log "проверки прошли, но тесту нужен явный process.exit(0) в конце."
    elif ((one == 97)); then
      log "ОТКАЗ предохранителя guard.ts — см. сообщение выше"
    fi
    ((one == 0)) || rc=$one
    log "=== $f: exit=$one"
  done
  return "$rc"
}

do_reset() {
  sanity
  require_running
  log "сброс ТЕСТОВОЙ БД и ТЕСТОВОГО Redis (проект $PROJECT)"
  dc exec -T postgres psql -U ebtest -d eblusha_secret_test -X -q -v ON_ERROR_STOP=1 \
    -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;'
  dc exec -T redis redis-cli FLUSHALL >/dev/null
  set_markers
  test_exec node_modules/.bin/prisma migrate deploy
}

do_status() {
  dc ps
  [[ -f "$WORK/.synced-from" ]] && log "work/: $(cat "$WORK/.synced-from")"
  log "тестовая БД: $(dc exec -T postgres psql -U ebtest -d eblusha_secret_test -X -At -F ' ' -c \
    "SELECT current_database(), current_user, current_setting('cluster_name'), shobj_description(oid,'pg_database') FROM pg_database WHERE datname=current_database()")"
  log "тестовый Redis: $MARKER_KEY=$(dc exec -T redis redis-cli GET "$MARKER_KEY") dbsize=$(dc exec -T redis redis-cli DBSIZE)"
}

# ---------- prod-proof: только чтение боевых Postgres/Redis ----------
prod_sql() {
  # default_transaction_read_only=on на уровне сессии + BEGIN READ ONLY в самом SQL
  docker exec -i -e PGOPTIONS='-c default_transaction_read_only=on' "$PROD_PG_CONTAINER" \
    psql -U "$PROD_DB_USER" -d "$PROD_DB" -X -q -At -F ' | ' -v ON_ERROR_STOP=1
}

sql_list() { # JSON-массив → 'a','b' (только безопасные символы)
  local out="" v
  while IFS= read -r v; do
    [[ "$v" =~ ^[A-Za-z0-9_.:-]+$ ]] || fail "подозрительный id в EB_PROOF: $v"
    out+="${out:+,}'$v'"
  done
  printf '%s' "${out:-''}"
}

do_prod_proof() {
  local proof="${1:-}"
  log "ТОЛЬКО ЧТЕНИЕ: $PROD_PG_CONTAINER/$PROD_DB (READ ONLY), $PROD_REDIS_CONTAINER (EXISTS/DBSIZE)"
  prod_sql <<'SQL'
BEGIN READ ONLY;
SELECT 'now', to_char(clock_timestamp(), 'YYYY-MM-DD"T"HH24:MI:SS.MS');
SELECT 'database/cluster_name/read_only', current_database() || ' / ' || coalesce(nullif(current_setting('cluster_name'), ''), '<empty>') || ' / ' || current_setting('transaction_read_only');
SELECT 'messages_secret', count(*), coalesce(max("createdAt")::text, '-') FROM messages_secret;
SELECT 'deliveries_secret', count(*) FROM deliveries_secret;
SELECT 'User', count(*) FROM "User";
SELECT 'UserDevice', count(*) FROM "UserDevice";
SELECT 'User LIKE ebst_%', count(*) FROM "User" WHERE username LIKE 'ebst\_%';
SELECT 'UserDevice LIKE ebst_%', count(*) FROM "UserDevice" WHERE id LIKE 'ebst\_%';
ROLLBACK;
SQL
  if [[ -n "$proof" ]]; then
    local users unames devs thread msg keys
    users="$(jq -r '.userIds[]' <<<"$proof" | sql_list)"
    unames="$(jq -r '.usernames[]' <<<"$proof" | sql_list)"
    devs="$(jq -r '.deviceIds[]' <<<"$proof" | sql_list)"
    thread="$(jq -r '.threadId' <<<"$proof" | sql_list)"
    msg="$(jq -r '.msgId' <<<"$proof" | sql_list)"
    prod_sql <<SQL
BEGIN READ ONLY;
SELECT 'proof: User by id/username', count(*) FROM "User" WHERE id IN ($users) OR username IN ($unames);
SELECT 'proof: UserDevice by id', count(*) FROM "UserDevice" WHERE id IN ($devs);
SELECT 'proof: Conversation by threadId', count(*) FROM "Conversation" WHERE id IN ($thread);
SELECT 'proof: messages_secret by msgId/threadId/sender', count(*) FROM messages_secret WHERE "msgId" IN ($msg) OR "threadId" IN ($thread) OR "senderUserId" IN ($users);
SELECT 'proof: deliveries_secret by msgId', count(*) FROM deliveries_secret WHERE "msgId" IN ($msg);
ROLLBACK;
SQL
    mapfile -t keys < <(jq -r '.redisKeys[]' <<<"$proof")
    printf 'prod redis: EXISTS %s = %s\n' "${keys[*]}" "$(docker exec "$PROD_REDIS_CONTAINER" redis-cli EXISTS "${keys[@]}")"
  fi
  printf 'prod redis: EXISTS %s = %s, DBSIZE = %s\n' "$MARKER_KEY" \
    "$(docker exec "$PROD_REDIS_CONTAINER" redis-cli EXISTS "$MARKER_KEY")" \
    "$(docker exec "$PROD_REDIS_CONTAINER" redis-cli DBSIZE)"
}

do_down() {
  sanity
  log "сношу $PROJECT (контейнеры, сеть, tmpfs-данные)"
  dc down -v --remove-orphans
  if [[ "${1:-}" == "--purge" ]]; then
    log "удаляю $TEST_HOME"
    rm -rf -- "$TEST_HOME"
  fi
}

# Один изменяющий прогон за раз: sync переписывает work/, параллельный run увидел бы полуразобранное дерево.
lock() {
  sanity
  mkdir -p "$TEST_HOME"
  exec 9>"$TEST_HOME/.lock"
  if ! flock -n 9; then
    log "work/ занят другим прогоном — жду (до ${EB_TEST_LOCK_WAIT:-1800} с)…"
    flock -w "${EB_TEST_LOCK_WAIT:-1800}" 9 || fail "не дождался освобождения $TEST_HOME/.lock"
  fi
}

cmd="${1:-}"
shift || true
case "$cmd" in
  up | sync | run | reset | down) lock ;;
esac
case "$cmd" in
  up) do_up "$@" ;;
  sync)
    if [[ "${1:-}" == "--ref" ]]; then do_sync "${2:?--ref REF}"; else do_sync ""; fi
    ;;
  run) do_run "$@" ;;
  reset) do_reset ;;
  psql)
    sanity
    if [[ -t 0 ]]; then dc exec postgres psql -U ebtest -d eblusha_secret_test "$@"; else dc exec -T postgres psql -U ebtest -d eblusha_secret_test "$@"; fi
    ;;
  redis-cli)
    sanity
    if [[ -t 0 ]]; then dc exec redis redis-cli "$@"; else dc exec -T redis redis-cli "$@"; fi
    ;;
  prod-proof) do_prod_proof "$@" ;;
  status) sanity; do_status ;;
  down) do_down "$@" ;;
  *) sed -n '2,/^set -euo/p' "$0" | sed '$d'; exit 2 ;;
esac
