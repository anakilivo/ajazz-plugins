#!/bin/zsh
# Собирает Windows-версию плагина на macOS (кросс-компиляция через zig)
# и упаковывает её в dist/<plugin>-windows.zip для установки на Windows.
set -euo pipefail

ROOT=${0:A:h:h}
PLUGIN_ID=com.anakilivo.streamdock.mixer.sdPlugin
PLUGIN="$ROOT/$PLUGIN_ID"

echo "→ audio helper (x64)"
mkdir -p "$PLUGIN/bin"
zig c++ -target x86_64-windows-gnu -O2 -std=c++17 -static \
  "$ROOT/native/win/audio-helper.cpp" -o "$PLUGIN/bin/audio-helper-win.exe" \
  -lole32 -luuid -lshell32 -lshlwapi -lwindowscodecs -lversion -lpropsys
rm -f "$PLUGIN/bin/audio-helper-win.pdb"

echo "→ icons"
swift "$ROOT/scripts/icons.swift" "$PLUGIN/static"

echo "→ npm"
(cd "$PLUGIN/plugin" && npm install --omit=dev --no-audit --no-fund --silent)

echo "→ zip"
mkdir -p "$ROOT/dist"
zip_path="$ROOT/dist/${PLUGIN_ID%.sdPlugin}-windows.zip"
rm -f "$zip_path"
(cd "$ROOT" && zip -qr "$zip_path" "$PLUGIN_ID" \
  -x "*/log/*" "*/bin/audio-helper-mac" "*.DS_Store")
echo "✓ $zip_path"
