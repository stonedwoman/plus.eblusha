# valheim-ops — руки бота для сервера Valheim (только по команде владельца)

Бот в контейнере не может и не должен трогать docker или файлы `/DATA/valheim`.
Команды владельца (`/eb рестарт`, `/eb бэкап`, `/eb мир …`) после его «да»
уходят сюда, в маленький сервис на хосте stoned:

- `valheim-ops.py` — HTTP поверх unix-сокета `/run/valheim-ops/ops.sock`,
  только Python stdlib, от root;
- белый список действий: `status`, `restart_when_empty`, `restart_cancel`,
  `restart_now`, `backup_now`, `options_set`. Аргументы проверяются здесь
  (ключ и значение настройки — по списку `/options` самой карты), команды
  запускаются списком аргументов, без shell;
- токен правки настроек мира (`/DATA/koban-hub/valheim-options.token`) читает
  только помощник; бот его не видит;
- журнал действий: `/var/log/valheim-ops.log` (время, действие, аргументы, итог).

Чего нет и не будет: adminlist/banlist, удаление бэкапов, смена мира,
`docker compose up -d` (меняет join-код), произвольные команды.

## Установка (ещё НЕ сделана — шаг выкладки)

```bash
install -d -m 755 /opt/valheim-ops
install -m 755 /DATA/eblusha-plus/bot/ops/valheim-ops.py /opt/valheim-ops/
python3 /opt/valheim-ops/valheim-ops.py --selftest
install -m 644 /DATA/eblusha-plus/bot/ops/valheim-ops.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now valheim-ops
ls -l /run/valheim-ops/   # сокет root:1000, 0660
```

Бот получает сокет томом `/run/valheim-ops:/run/valheim-ops` (сервис
`eblusha-bot` в `deploy/docker-compose.full.yml`). Пользователь бота в
контейнере — `node` (uid/gid 1000), поэтому группа сокета — 1000
(`OPS_SOCKET_GID`). Код копируется в `/opt`, а не запускается из репозитория:
сервис от root исполняет только проверенную копию.

## Проверка без последствий

```bash
python3 valheim-ops.py --selftest
OPS_DRY_RUN=1 OPS_SOCKET=/tmp/vo.sock OPS_LOG=/tmp/vo.log python3 valheim-ops.py &
curl -s --unix-socket /tmp/vo.sock -X POST http://x/v1/status -d '{}'
curl -s --unix-socket /tmp/vo.sock -X POST http://x/v1/options_set -d '{"key":"ResourceRate","value":"3"}'
```

В режиме `OPS_DRY_RUN=1` команды, меняющие сервер, не запускаются (только
журнал), а чтение (статус, `/options`) — настоящее.

## Что делает каждое действие

| Действие | Что на самом деле |
|---|---|
| `restart_when_empty` | `systemd-run --unit=valheim-restart-when-empty --collect /DATA/valheim/restart-when-empty.sh` (ждёт три проверки подряд с нулём игроков в `/time`) |
| `restart_cancel` | `systemctl stop valheim-restart-when-empty` |
| `restart_now` | снимает ожидание «когда опустеет» и в фоне `docker compose -f /DATA/valheim/docker-compose.yml restart valheim` (unit `valheim-restart-now`); join-код при этом не меняется |
| `backup_now` | `tar.gz` каталога мира `config/worlds_local/<WORLD_NAME>` в `/DATA/valheim/backups-manual/bot-<время>/` + `SHA256SUMS`; не меньше 5 ГБ свободного места |
| `options_set` | `GET /options` карты → сверка ключа и значения → `POST /options` с `X-WebMap-Token`; применяется без рестарта |
| `status` | `docker inspect valheim`, активны ли units рестарта, часовые бэкапы, последний ручной, место на `/DATA`, плагины из `LogOutput.log` |
