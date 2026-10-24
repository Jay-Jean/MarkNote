#!/bin/zsh

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="${ROOT}/MarkNote.app"
ZIP="${ROOT}/dist/MarkNote-macOS-standalone.zip"
RELEASE_ZIP="${ROOT}/MarkNote-macOS-standalone.zip"
RESOURCES="${APP}/Contents/Resources"
CACHE_ROOT="/private/tmp/marknote-swift-cache"
NATIVE_BUILD="${CACHE_ROOT}/native"

mkdir -p "${APP}/Contents/MacOS" "${RESOURCES}"
mkdir -p "${NATIVE_BUILD}" "${CACHE_ROOT}/arm64-module-cache" "${CACHE_ROOT}/arm64-swift-module-cache" "${CACHE_ROOT}/x86-module-cache" "${CACHE_ROOT}/x86-swift-module-cache"

/usr/bin/swiftc -O -parse-as-library -target arm64-apple-macosx10.15 \
  -Xcc -fmodules-cache-path="${CACHE_ROOT}/arm64-module-cache" \
  -module-cache-path "${CACHE_ROOT}/arm64-swift-module-cache" \
  -framework Cocoa -framework WebKit -framework PDFKit \
  "${ROOT}/native/MarkNoteNative.swift" \
  "${ROOT}/tests/StorageCompatibility.swift" \
  -o "${NATIVE_BUILD}/MarkNote-arm64"

/usr/bin/swiftc -O -parse-as-library -target x86_64-apple-macosx10.15 \
  -Xcc -fmodules-cache-path="${CACHE_ROOT}/x86-module-cache" \
  -module-cache-path "${CACHE_ROOT}/x86-swift-module-cache" \
  -framework Cocoa -framework WebKit -framework PDFKit \
  "${ROOT}/native/MarkNoteNative.swift" \
  "${ROOT}/tests/StorageCompatibility.swift" \
  -o "${NATIVE_BUILD}/MarkNote-x86_64"

/usr/bin/lipo -create \
  "${NATIVE_BUILD}/MarkNote-arm64" \
  "${NATIVE_BUILD}/MarkNote-x86_64" \
  -output "${APP}/Contents/MacOS/MarkNote"

cp "${ROOT}/index.html" "${ROOT}/app.js" "${ROOT}/styles.css" "${RESOURCES}/"
cp "${ROOT}/tests/compatibility.js" "${RESOURCES}/compatibility-tests.js"
/usr/bin/rsync -a --delete "${ROOT}/vendor/" "${RESOURCES}/vendor/"

/usr/bin/codesign --force --deep --sign - "${APP}"
mkdir -p "${ROOT}/dist"
/usr/bin/ditto -c -k --sequesterRsrc --keepParent "${APP}" "${ZIP}"
cp "${ZIP}" "${RELEASE_ZIP}"

echo "Built: ${APP}"
echo "Packaged: ${ZIP}"
echo "Release copy: ${RELEASE_ZIP}"
