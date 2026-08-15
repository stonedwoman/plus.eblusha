#!/usr/bin/env bash
# Сборка iOS-клиента. Исходники живут в этом репозитории (ios/), а Xcode есть только
# на маке — поэтому скрипт заливает дерево на мак, генерирует там .xcodeproj из
# project.yml и собирает. Обратно ничего не едет: всё генерируемое одноразовое.
#
#   scripts/ios-build.sh              — собрать под устройство
#   scripts/ios-build.sh sim          — собрать под симулятор (быстрее, без подписи)
#   scripts/ios-build.sh --install    — собрать и поставить на подключённый iPhone
#   scripts/ios-build.sh --clean      — снести кеш сборки и пересобрать с нуля
set -euo pipefail

MAC=${EBLUSHA_MAC_HOST:-mac}
REMOTE_DIR=${EBLUSHA_MAC_DIR:-builds/eblusha-ios}   # относительно $HOME на маке
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)

target=device
install=0
clean=0
for arg in "$@"; do
  case "$arg" in
    sim|simulator) target=sim ;;
    device) target=device ;;
    --install) install=1 ;;
    --clean) clean=1 ;;
    *) echo "неизвестный аргумент: $arg" >&2; exit 2 ;;
  esac
done

if [ "$target" = sim ]; then
  destination='generic/platform=iOS Simulator'
  products=Debug-iphonesimulator
  signing=NO
else
  destination='generic/platform=iOS'
  products=Debug-iphoneos
  signing=YES
fi

echo "==> заливаю исходники на $MAC"
# --delete: удалённый здесь файл должен исчезнуть и там, иначе xcodegen подберёт
# давно выброшенный Swift-файл и сборка будет врать. build/ и .xcodeproj живут
# только на маке, поэтому их исключаем — иначе rsync снесёт их каждый раз.
rsync -az --delete \
  --exclude 'build/' --exclude '*.xcodeproj' --exclude '.DS_Store' \
  "$HERE/ios/" "$MAC:$REMOTE_DIR/"

ssh "$MAC" \
  "REMOTE_DIR='$REMOTE_DIR' DESTINATION='$destination' SIGNING='$signing' CLEAN='$clean' bash -s" <<'REMOTE'
set -euo pipefail
cd "$HOME/$REMOTE_DIR"

if [ "$CLEAN" = 1 ]; then
  rm -rf build Eblusha.xcodeproj
fi

echo "==> генерирую Eblusha.xcodeproj"
"$HOME/.local/bin/xcodegen" generate --quiet

echo "==> xcodebuild ($DESTINATION)"
# На маке bash 3.2: пустой массив под set -u там ломается, поэтому обычная строка.
extra=
if [ "$SIGNING" = NO ]; then
  extra=CODE_SIGNING_ALLOWED=NO
fi

set -o pipefail
xcodebuild build \
  -project Eblusha.xcodeproj \
  -scheme Eblusha \
  -configuration Debug \
  -destination "$DESTINATION" \
  -derivedDataPath build \
  -allowProvisioningUpdates \
  $extra 2>&1 | tail -40
REMOTE

if [ "$install" = 1 ]; then
  if [ "$target" = sim ]; then
    echo "--install работает только со сборкой под устройство" >&2
    exit 2
  fi
  echo "==> ставлю на телефон"
  ssh "$MAC" "REMOTE_DIR='$REMOTE_DIR' PRODUCTS='$products' bash -s" <<'REMOTE'
set -euo pipefail
# Первая строка таблицы devicectl со словом available — наш спаренный iPhone.
device=$(xcrun devicectl list devices 2>/dev/null | awk '/available/ {print $3; exit}')
if [ -z "$device" ]; then
  echo "iPhone не найден: подключите кабелем и разблокируйте" >&2
  exit 1
fi
xcrun devicectl device install app --device "$device" \
  "$HOME/$REMOTE_DIR/build/Build/Products/$PRODUCTS/Eblusha.app"
REMOTE
fi

echo "==> готово"
