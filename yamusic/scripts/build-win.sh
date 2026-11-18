#!/bin/zsh
# Собирает Windows-версию на macOS: помощник волны (кросс-компиляция через zig)
# и dist/<plugin>-windows.zip. Запускать после build-mac.sh (npm-зависимости и иконки уже на месте).
set -euo pipefail

ROOT=${0:A:h:h}
PLUGIN_ID=com.anakilivo.streamdock.yamusic.sdPlugin
PLUGIN="$ROOT/$PLUGIN_ID"

echo "→ spectrum helper (x64)"
mkdir -p "$PLUGIN/bin"
zig c++ -target x86_64-windows-gnu -O2 -std=c++17 -static -municode \
  "$ROOT/native/win/spectrum-helper.cpp" -o "$PLUGIN/bin/spectrum-helper-win.exe" \
  -lole32 -luuid -lshell32
rm -f "$PLUGIN/bin/spectrum-helper-win.pdb"

echo "→ zip (windows)"
mkdir -p "$ROOT/dist"
zip_path="$ROOT/dist/${PLUGIN_ID%.sdPlugin}-windows.zip"
rm -f "$zip_path"
(cd "$ROOT" && zip -qr "$zip_path" "$PLUGIN_ID" \
  -x "*/log/*" "*/bin/spectrum-helper-mac" "*.DS_Store")

echo "✓ $zip_path"
