# APNs: настройка пушей для iOS

Бэкенд шлёт пуши в Apple напрямую (token-based авторизация ключом `.p8`), без сторонних
SDK — см. `src/push/apns.ts`. Один ключ обслуживает и обычные alert-пуши (сообщения),
и VoIP-пуши (звонки, topic `<bundle>.voip`).

## 1. Сгенерировать ключ .p8

1. [developer.apple.com](https://developer.apple.com/account) → **Certificates, Identifiers & Profiles → Keys** → «+».
2. Имя произвольное, галочка **Apple Push Notifications service (APNs)** → Continue → Register.
3. **Download** — файл `AuthKey_XXXXXXXXXX.p8` скачивается ровно один раз, сохранить надёжно.
   На той же странице записать **Key ID** (10 символов); **Team ID** — в правом верхнем углу
   аккаунта (Membership).

Ключ общий для всех приложений команды и не различает production/sandbox — среда выбирается
хостом, на который шлёт сервер (`APNS_ENV`).

## 2. Прописать env в `.env`

```env
APNS_KEY=<base64 от AuthKey_XXXXXXXXXX.p8>      # base64 -w0 AuthKey_XXXXXXXXXX.p8
APNS_KEY_ID=XXXXXXXXXX
APNS_TEAM_ID=YYYYYYYYYY
APNS_BUNDLE_ID=org.eblusha.plus                # default, можно не указывать
APNS_ENV=production                            # или sandbox — см. ниже
```

Ключ кладём в `.env` в base64 — так же, как `FCM_SERVICE_ACCOUNT`: тома для секретов у
worker'а нет, а многострочный PEM `env_file` docker-compose не переваривает. Альтернатива —
`APNS_KEY_FILE=/путь/внутри/контейнера` (тогда файл надо пробросить томом); `APNS_KEY`
принимает и голый PEM. Наш Team ID — `4748P9MT6D` (тот же, что в `ios/project.yml`).

Ключ в git не коммитить (как и всё из «Never commit secrets»; каталог `secrets/`
гитигнорится). Без любого из трёх значений (ключ, Key ID, Team ID) APNs просто выключен —
сервер работает как раньше.

**Ключ App Store Connect API (`AuthKey_N433G64327.p8` на маке) для APNs НЕ подходит** —
проверено 2026-09-08: Apple отвечает `403 InvalidProviderToken`. Нужен именно ключ из
раздела Keys с галочкой APNs; через API его не создать, только руками в браузере.

После правки `.env` перезапустить backend и worker (пуши шлёт worker).

## 3. production vs sandbox

**Dev-сборки из Xcode (запуск на телефон по кабелю) получают SANDBOX-токены устройств.**
Прод-кластер Apple такие токены отвергает (`400 BadDeviceToken`), и сервер снимет их с
устройства как мёртвые. Поэтому для тестов с телефона ставим `APNS_ENV=sandbox`.
TestFlight и App Store — это production-токены, там `APNS_ENV=production`.

Среда одна на инстанс: смешанные dev/прод клиенты на одном сервере работать не будут.

## 4. Если пуши не доходят

Смотреть логи worker'а (`docker compose -f deploy/docker-compose.full.yml logs worker`):

- `APNs push configured` при старте — ключ загрузился; `APNs key is unusable` — кривой
  путь/файл, пуши выключены.
- `APNs: send failed` с `status`/`reason` из ответа Apple:
  - `403 InvalidProviderToken` — не совпадают Key ID / Team ID / ключ;
  - `400 BadDeviceToken` — чаще всего перепутаны production/sandbox (см. выше);
  - `400 TopicDisallowed` / `403 MissingTopic` — bundle id не совпадает с приложением,
    для VoIP проверить, что у App ID включён Push Notifications capability;
  - `410` — токен протух (переустановка приложения), сервер сам снимет его с устройства
    (`APNs: token is dead, dropping`).
- `APNs: connection error` / `connect timeout` — сеть до `api.push.apple.com:443` (egress,
  firewall).
