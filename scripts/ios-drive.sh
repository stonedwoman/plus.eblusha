#!/usr/bin/env bash
# «Пульт» симулятора: гоняет шаги (тапы, протяжки, ввод, скриншоты) через XCUITest-раннер
# EblushaUITests. На маке нет ни idb, ни cliclick, а simctl не умеет ни тапать, ни тянуть —
# без этого экран не проверить без человека. Язык шагов — ios/EblushaUITests/DriveTests.swift.
#
#   scripts/ios-drive.sh 'launch:-connectDemo mini; sleep:3; shot:mini'
#   EBLUSHA_DRIVE_ENV='EB_PASS' scripts/ios-drive.sh '…; typeEnv:EB_PASS; …'
#       — какие переменные окружения отдать раннеру (значения берутся из текущего окружения:
#         так пароль попадает в приложение на симуляторе, не попадая ни в файлы, ни в скрипт)
#
# Скриншоты и drive.log остаются на маке в ~/builds/shots/ — забирать scp. Симулятор — тот
# же, что у стенда (EBLUSHA_SIM_UDID). Приложение ставится из той же сборки, что
# scripts/ios-build.sh sim (общий derivedData), данные приложения (сессия) сохраняются.
set -euo pipefail

MAC=${EBLUSHA_MAC_HOST:-mac}
REMOTE_DIR=${EBLUSHA_MAC_DIR:-builds/eblusha-ios}
SIM=${EBLUSHA_SIM_UDID:-2A9441D5-50FF-4F38-9D37-53C1EA5E567E}
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)

steps=${1:-}
if [ -z "$steps" ]; then
  echo "нужен сценарий шагов первым аргументом" >&2
  exit 2
fi

echo "==> заливаю исходники на $MAC"
rsync -az --delete \
  --exclude 'build/' --exclude '*.xcodeproj' --exclude '.DS_Store' \
  "$HERE/ios/" "$MAC:$REMOTE_DIR/"

# Шаги и переменные едут base64: в них кавычки, пробелы и кириллица.
STEPS_B64=$(printf %s "$steps" | base64 -w0)
extra=""
for name in ${EBLUSHA_DRIVE_ENV:-}; do
  extra+="$name=${!name}"$'\n'
done
EXTRA_B64=$(printf %s "$extra" | base64 -w0)
BUILD_TAG=$(git -C "$HERE" rev-parse --short HEAD 2>/dev/null || echo dev)

ssh "$MAC" \
  "REMOTE_DIR='$REMOTE_DIR' SIM='$SIM' STEPS_B64='$STEPS_B64' EXTRA_B64='$EXTRA_B64' BUILD_TAG='$BUILD_TAG' bash -s" <<'REMOTE'
set -euo pipefail
cd "$HOME/$REMOTE_DIR"

echo "==> генерирую Eblusha.xcodeproj (project-drive.yml)"
"$HOME/.local/bin/xcodegen" generate --spec project-drive.yml --quiet

xcrun simctl boot "$SIM" >/dev/null 2>&1 || true
xcrun simctl bootstatus "$SIM" -b >/dev/null 2>&1 || true

export TEST_RUNNER_EB_DRIVE
TEST_RUNNER_EB_DRIVE=$(printf %s "$STEPS_B64" | base64 --decode)
export TEST_RUNNER_EB_SHOTS="$HOME/builds/shots"
mkdir -p "$TEST_RUNNER_EB_SHOTS"
rm -f "$TEST_RUNNER_EB_SHOTS/drive.log"
# Переменные для раннера: xcodebuild отдаёт тесту всё с префиксом TEST_RUNNER_.
while IFS= read -r line; do
  [ -n "$line" ] && export "TEST_RUNNER_$line"
done <<< "$(printf %s "$EXTRA_B64" | base64 --decode)"

echo "==> xcodebuild test (EblushaDrive)"
set -o pipefail
xcodebuild test \
  -project Eblusha.xcodeproj \
  -scheme EblushaDrive \
  -destination "platform=iOS Simulator,id=$SIM" \
  -derivedDataPath build \
  CODE_SIGNING_ALLOWED=NO \
  EBLUSHA_BUILD_TAG="$BUILD_TAG" 2>&1 \
  | grep -E "error:|Test Case|\*\* TEST|EBDRIVE|failed" | grep -v "EBDRIVE" | tail -15 || true

echo "==> drive.log"
cat "$TEST_RUNNER_EB_SHOTS/drive.log" 2>/dev/null || echo "(лога нет — раннер не стартовал)"
REMOTE

echo "==> готово"
