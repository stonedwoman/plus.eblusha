#!/usr/bin/env bash
# Релизная сборка iOS-клиента и отправка в TestFlight (App Store Connect).
# Схема та же, что у scripts/ios-build.sh: исходники rsync'ом на мак → xcodegen →
# xcodebuild archive (Release) → export app-store-connect с загрузкой через ASC API-ключ.
# Подпись — из build.keychain (login-связка по ssh заперта, см. ios-build.sh); профиль
# App Store Xcode создаёт сам по API-ключу (-allowProvisioningUpdates).
#
#   scripts/ios-release.sh               — собрать, подписать и загрузить в App Store Connect
#   scripts/ios-release.sh --no-upload   — только архив + .ipa (остаются на маке в build/export)
#   scripts/ios-release.sh --upload-only — не пересобирать: загрузить уже готовый архив
#   EBLUSHA_BUILD_NUMBER=123 …           — свой номер сборки (по умолчанию — число коммитов)
set -euo pipefail

MAC=${EBLUSHA_MAC_HOST:-mac}
REMOTE_DIR=${EBLUSHA_MAC_DIR:-builds/eblusha-ios}
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)

upload=1
archive=1
for arg in "$@"; do
  case "$arg" in
    --no-upload) upload=0 ;;
    --upload-only) archive=0 ;;
    *) echo "неизвестный аргумент: $arg" >&2; exit 2 ;;
  esac
done

# Номер сборки обязан расти от загрузки к загрузке — иначе App Store Connect отвергнет
# дубль. Число коммитов монотонно на ветке; для ручного управления — EBLUSHA_BUILD_NUMBER.
BUILD_NUMBER=${EBLUSHA_BUILD_NUMBER:-$(git -C "$HERE" rev-list --count HEAD)}
echo "==> номер сборки: $BUILD_NUMBER"

if [ "$archive" = 1 ]; then
  echo "==> заливаю исходники на $MAC"
  rsync -az --delete \
    --exclude 'build/' --exclude '*.xcodeproj' --exclude '.DS_Store' \
    "$HERE/ios/" "$MAC:$REMOTE_DIR/"
fi

ssh "$MAC" \
  "REMOTE_DIR='$REMOTE_DIR' BUILD_NUMBER='$BUILD_NUMBER' UPLOAD='$upload' ARCHIVE='$archive' bash -s" <<'REMOTE'
set -euo pipefail
cd "$HOME/$REMOTE_DIR"

BK="$HOME/Library/Keychains/build.keychain-db"
LK="$HOME/Library/Keychains/login.keychain-db"
restore_keychains() {
  security list-keychains -d user -s "$LK" "$BK" >/dev/null 2>&1 || true
  security default-keychain -d user -s "$LK" >/dev/null 2>&1 || true
}
PW=$(cat "$HOME/.keys/build-keychain-pass")
trap restore_keychains EXIT
security unlock-keychain -p "$PW" "$BK"
security list-keychains -d user -s "$BK"
security default-keychain -d user -s "$BK"
security set-key-partition-list -S apple-tool:,apple: -s -k "$PW" "$BK" >/dev/null 2>&1 || true

P8="$HOME/.appstoreconnect/private_keys/AuthKey_N433G64327.p8"
KID=N433G64327
ISS=16defce3-2569-44b9-ab9f-e22fcfb630e2
auth="-authenticationKeyPath $P8 -authenticationKeyID $KID -authenticationKeyIssuerID $ISS"

set -o pipefail
if [ "$ARCHIVE" = 1 ]; then
  echo "==> генерирую Eblusha.xcodeproj"
  "$HOME/.local/bin/xcodegen" generate --quiet

  rm -rf build/archive build/export
  echo "==> xcodebuild archive (Release)"
  xcodebuild archive \
    -project Eblusha.xcodeproj \
    -scheme Eblusha \
    -configuration Release \
    -destination 'generic/platform=iOS' \
    -archivePath build/archive/Eblusha.xcarchive \
    -derivedDataPath build/release \
    -allowProvisioningUpdates \
    $auth \
    CURRENT_PROJECT_VERSION="$BUILD_NUMBER" \
    EBLUSHA_BUILD_TAG="$BUILD_NUMBER" 2>&1 | grep -E 'error:|warning: .*(entitlement|provision)|ARCHIVE (SUCCEEDED|FAILED)|\*\* ' | tail -20
else
  [ -d build/archive/Eblusha.xcarchive ] || { echo "архива нет — сначала без --upload-only" >&2; exit 1; }
  rm -rf build/export
fi

# destination=upload: Xcode сам загружает сборку в App Store Connect по API-ключу
# (и заводит запись приложения, если её ещё нет). Без загрузки — просто .ipa.
if [ "$UPLOAD" = 1 ]; then destination=upload; else destination=export; fi
cat > build/ExportOptions.plist <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>method</key>                         <string>app-store-connect</string>
    <key>destination</key>                    <string>$destination</string>
    <key>teamID</key>                         <string>4748P9MT6D</string>
    <key>signingStyle</key>                   <string>automatic</string>
    <key>uploadSymbols</key>                  <true/>
    <key>manageAppVersionAndBuildNumber</key> <false/>
</dict>
</plist>
PLIST

echo "==> xcodebuild -exportArchive ($destination)"
xcodebuild -exportArchive \
  -archivePath build/archive/Eblusha.xcarchive \
  -exportOptionsPlist build/ExportOptions.plist \
  -exportPath build/export \
  -allowProvisioningUpdates \
  $auth 2>&1 | grep -v '^$' | tail -25

if [ "$UPLOAD" != 1 ]; then
  ls -la build/export/*.ipa
fi
REMOTE

echo "==> готово"
