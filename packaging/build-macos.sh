#!/usr/bin/env bash
# Build, sign, notarize, and package Local LLM Studio.app into a DMG on macOS.
#
# Prerequisites (you provide these — I can't enter your credentials):
#   • A "Developer ID Application" certificate in your login keychain.
#   • A notarytool keychain profile (one-time):
#       xcrun notarytool store-credentials lls-notary \
#         --apple-id "you@example.com" --team-id "ABCDE12345" --password "app-specific-pw"
#
# Usage:
#   DEVELOPER_ID="Developer ID Application: Your Name (TEAMID)" \
#   NOTARY_PROFILE="lls-notary" \
#   packaging/build-macos.sh
#
# Set LLS_TARGET_ARCH=universal2 if your Python is universal2 (else it builds native).
set -euo pipefail
cd "$(dirname "$0")/.."

APP="dist/Local LLM Studio.app"
DMG="dist/Local-LLM-Studio.dmg"
ENTITLEMENTS="packaging/entitlements.plist"
: "${DEVELOPER_ID:?Set DEVELOPER_ID to your 'Developer ID Application: …' identity}"

echo "==> Fetching Ollama engine"
[ -f vendor_bin/ollama ] || packaging/fetch-ollama.sh

echo "==> Installing build deps"
python3 -m pip install --quiet --upgrade pip pyinstaller
python3 -m pip install --quiet -r requirements.txt

echo "==> PyInstaller build"
rm -rf build dist
pyinstaller --noconfirm --clean lls.spec

echo "==> Code signing (hardened runtime, deep, with entitlements)"
# Sign nested binaries first (the bundled ollama), then the app deeply.
codesign --force --options runtime --timestamp --entitlements "$ENTITLEMENTS" \
  --sign "$DEVELOPER_ID" "$APP/Contents/MacOS/ollama" 2>/dev/null || true
codesign --force --options runtime --timestamp --entitlements "$ENTITLEMENTS" \
  --deep --sign "$DEVELOPER_ID" "$APP"
codesign --verify --strict --verbose=2 "$APP"

echo "==> Building DMG"
rm -f "$DMG"
hdiutil create -volname "Local LLM Studio" -srcfolder "$APP" -ov -format UDZO "$DMG"
codesign --force --timestamp --sign "$DEVELOPER_ID" "$DMG"

if [ -n "${NOTARY_PROFILE:-}" ]; then
  echo "==> Notarizing (this can take a few minutes)"
  xcrun notarytool submit "$DMG" --keychain-profile "$NOTARY_PROFILE" --wait
  echo "==> Stapling"
  xcrun stapler staple "$DMG"
  xcrun stapler staple "$APP"
else
  echo "!! NOTARY_PROFILE not set — built + signed but NOT notarized."
  echo "   Users would see Gatekeeper warnings. Set NOTARY_PROFILE to notarize."
fi

echo "==> Done: $DMG"
spctl --assess --type open --context context:primary-signature -v "$DMG" 2>&1 || true
