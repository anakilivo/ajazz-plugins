#!/bin/zsh
# Собирает плагин для macOS: нативный помощник, иконки, npm-зависимости.
# --install  — дополнительно ставит плагин в Stream Dock (симлинк) и перезапускает приложение.
set -euo pipefail

ROOT=${0:A:h:h}
PLUGIN_ID=com.anakilivo.streamdock.mixer.sdPlugin
PLUGIN="$ROOT/$PLUGIN_ID"
PLUGINS_DIR="$HOME/Library/Application Support/HotSpot/StreamDock/plugins"

echo "→ audio helper (universal)"
mkdir -p "$PLUGIN/bin" "$ROOT/build"
for arch in arm64 x86_64; do
  # Info.plist вшивается в бинарник: без NSAudioCaptureUsageDescription
  # macOS молча отказывает в записи звука приложений.
  swiftc -O -swift-version 5 -target "$arch-apple-macos10.15" \
    -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker "$ROOT/native/mac/Info.plist" \
    "$ROOT"/native/mac/*.swift -o "$ROOT/build/audio-helper-$arch"
done
lipo -create "$ROOT"/build/audio-helper-{arm64,x86_64} -output "$PLUGIN/bin/audio-helper-mac"
codesign -f -s - -i com.anakilivo.streamdock.mixer.helper "$PLUGIN/bin/audio-helper-mac"

echo "→ icons"
swift "$ROOT/scripts/icons.swift" "$PLUGIN/static"

echo "→ npm"
(cd "$PLUGIN/plugin" && npm install --omit=dev --no-audit --no-fund --silent)

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

echo "✓ done"
