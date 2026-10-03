#!/usr/bin/env bash
# Модульные тесты iOS-клиента (XCTest, ios/EblushaTests) на симуляторе мака.
#
#   scripts/ios-test.sh                         — все тесты
#   scripts/ios-test.sh SecretHolesTests        — один класс (или Класс/testМетод)
#
# Тесты без сети и без боевых данных: транспорт подменён, «сервер» — в памяти теста.
# Симулятор — ОТДЕЛЬНЫЙ от стенда ios-drive.sh (EBLUSHA_TEST_SIM_UDID): хост-приложение
# тестов ставится поверх, и сессию стенда трогать незачем. Сборка — тот же derivedData,
# что у scripts/ios-build.sh sim.
set -euo pipefail

MAC=${EBLUSHA_MAC_HOST:-mac}
REMOTE_DIR=${EBLUSHA_MAC_DIR:-builds/eblusha-ios}
SIM=${EBLUSHA_TEST_SIM_UDID:-7C8AAE75-3552-490D-8461-21D5ED0810AD}
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
ONLY=${1:-}

echo "==> заливаю исходники на $MAC"
rsync -az --delete \
  --exclude 'build/' --exclude '*.xcodeproj' --exclude '.DS_Store' \
  "$HERE/ios/" "$MAC:$REMOTE_DIR/"

BUILD_TAG=$(git -C "$HERE" rev-parse --short HEAD 2>/dev/null || echo dev)

ssh "$MAC" \
  "REMOTE_DIR='$REMOTE_DIR' SIM='$SIM' ONLY='$ONLY' BUILD_TAG='$BUILD_TAG' caffeinate -dimsu bash -s" <<'REMOTE'
set -euo pipefail
cd "$HOME/$REMOTE_DIR"

echo "==> генерирую Eblusha.xcodeproj (project-tests.yml)"
"$HOME/.local/bin/xcodegen" generate --spec project-tests.yml --quiet

xcrun simctl boot "$SIM" >/dev/null 2>&1 || true
xcrun simctl bootstatus "$SIM" -b >/dev/null 2>&1 || true

only=
if [ -n "$ONLY" ]; then
  only="-only-testing:EblushaTests/$ONLY"
fi

echo "==> xcodebuild test (EblushaTests)"
log="$HOME/builds/ios-test-last.log"
set +e
xcodebuild test \
  -project Eblusha.xcodeproj \
  -scheme EblushaTests \
  -destination "platform=iOS Simulator,id=$SIM" \
  -derivedDataPath build \
  EBLUSHA_BUILD_TAG="$BUILD_TAG" \
  $only > "$log" 2>&1
code=$?
set -e
grep -E "error:|Test Case .*(passed|failed)|\*\* TEST|Executed [0-9]+ test|XCTAssert|failed \(" "$log" | tail -120
echo "(полный лог: ~/builds/ios-test-last.log, код $code)"
xcrun simctl shutdown "$SIM" >/dev/null 2>&1 || true
exit $code
REMOTE

echo "==> готово"
