#!/bin/zsh
# Собирает плагин для macOS: помощник волны (перехват звука Музыки), иконки,
# npm-зависимости, и упаковывает в dist/<plugin>-macos.zip.
# --install  — дополнительно ставит плагин в Stream Dock (симлинк) и перезапускает приложение.
set -euo pipefail

ROOT=${0:A:h:h}
PLUGIN_ID=com.anakilivo.streamdock.yamusic.sdPlugin
PLUGIN="$ROOT/$PLUGIN_ID"
PLUGINS_DIR="$HOME/Library/Application Support/HotSpot/StreamDock/plugins"

echo "→ spectrum helper (universal)"
mkdir -p "$PLUGIN/bin" "$ROOT/build"
for arch in arm64 x86_64; do
  # Info.plist вшивается в бинарник: без NSAudioCaptureUsageDescription
  # macOS молча отказывает в записи звука приложений. Process Tap — с macOS 14.2.
  swiftc -O -swift-version 5 -target "$arch-apple-macos14.2" \
    -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker "$ROOT/native/mac/Info.plist" \
    "$ROOT"/native/mac/*.swift -o "$ROOT/build/spectrum-helper-$arch"
done
lipo -create "$ROOT"/build/spectrum-helper-{arm64,x86_64} -output "$PLUGIN/bin/spectrum-helper-mac"
codesign -f -s - -i com.anakilivo.streamdock.yamusic.helper "$PLUGIN/bin/spectrum-helper-mac"

echo "→ npm"
(cd "$PLUGIN/plugin" && npm install --omit=dev --no-audit --no-fund --silent)

echo "→ icons"
node "$ROOT/scripts/icons.js"

echo "→ zip"
mkdir -p "$ROOT/dist"
zip_path="$ROOT/dist/${PLUGIN_ID%.sdPlugin}-macos.zip"
rm -f "$zip_path"
(cd "$ROOT" && zip -qr "$zip_path" "$PLUGIN_ID" \
  -x "*/log/*" "*/bin/spectrum-helper-win.exe" "*.DS_Store")

if [[ "${1:-}" == "--install" ]]; then
  echo "→ install into Stream Dock"
  target="$PLUGINS_DIR/$PLUGIN_ID"
  if [[ -e "$target" && ! -L "$target" ]]; then
    echo "  $target уже существует и это не симлинк — удалите вручную" >&2
    exit 1
  fi
  ln -sfn "$PLUGIN" "$target"
  osascript -e 'quit app "Stream Dock AJAZZ"' 2>/dev/null || true
  sleep 2
  open -a "Stream Dock AJAZZ"
fi

echo "✓ $zip_path"
