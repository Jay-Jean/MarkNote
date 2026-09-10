#!/bin/zsh

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="${ROOT}/dist/MarkNote.app"
RESOURCES="${APP}/Contents/Resources"
CACHE_ROOT="/private/tmp/marknote-swift-cache"
NATIVE_BUILD="${CACHE_ROOT}/native"

mkdir -p "${APP}/Contents/MacOS" "${RESOURCES}"
mkdir -p "${NATIVE_BUILD}" "${CACHE_ROOT}/arm64-module-cache" "${CACHE_ROOT}/arm64-swift-module-cache" "${CACHE_ROOT}/x86-module-cache" "${CACHE_ROOT}/x86-swift-module-cache"

/usr/bin/swiftc -O -parse-as-library -target arm64-apple-macosx10.15 \
  -Xcc -fmodules-cache-path="${CACHE_ROOT}/arm64-module-cache" \
  -module-cache-path "${CACHE_ROOT}/arm64-swift-module-cache" \
  -framework Cocoa -framework WebKit \
  "${ROOT}/native/MarkNoteNative.swift" \
  -o "${NATIVE_BUILD}/MarkNote-arm64"

/usr/bin/swiftc -O -parse-as-library -target x86_64-apple-macosx10.15 \
  -Xcc -fmodules-cache-path="${CACHE_ROOT}/x86-module-cache" \
  -module-cache-path "${CACHE_ROOT}/x86-swift-module-cache" \
  -framework Cocoa -framework WebKit \
  "${ROOT}/native/MarkNoteNative.swift" \
  -o "${NATIVE_BUILD}/MarkNote-x86_64"

/usr/bin/lipo -create \
  "${NATIVE_BUILD}/MarkNote-arm64" \
  "${NATIVE_BUILD}/MarkNote-x86_64" \
  -output "${APP}/Contents/MacOS/MarkNote"

cp "${ROOT}/MarkNote.app/Contents/Info.plist" "${APP}/Contents/Info.plist"
cp "${ROOT}/index.html" "${ROOT}/app.js" "${ROOT}/styles.css" "${RESOURCES}/"
cp "${ROOT}/MarkNote.app/Contents/Resources/MarkNote.icns" "${RESOURCES}/MarkNote.icns"
cp "${ROOT}/MarkNote.app/Contents/Resources/MarkNote-icon.png" "${RESOURCES}/MarkNote-icon.png"
/usr/bin/rsync -a --delete "${ROOT}/vendor/" "${RESOURCES}/vendor/"

/usr/bin/codesign --force --deep --sign - "${APP}"
/usr/bin/ditto -c -k --sequesterRsrc --keepParent "${APP}" "${ROOT}/dist/MarkNote-macOS-standalone.zip"

echo "Built: ${APP}"
echo "Packaged: ${ROOT}/dist/MarkNote-macOS-standalone.zip"
