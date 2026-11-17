#!/bin/zsh
# Собирает GitHub-плагин (один архив для macOS и Windows — нативного кода нет):
# npm-зависимости, иконки, dist/<plugin>.zip.
# --install  — дополнительно ставит плагин в Stream Dock на macOS (симлинк).
set -euo pipefail

ROOT=${0:A:h:h}
PLUGIN_ID=com.anakilivo.streamdock.github.sdPlugin
PLUGIN="$ROOT/$PLUGIN_ID"
PLUGINS_DIR="$HOME/Library/Application Support/HotSpot/StreamDock/plugins"

echo "→ npm"
(cd "$PLUGIN/plugin" && npm install --omit=dev --no-audit --no-fund --silent)

echo "→ icons"
node "$ROOT/scripts/icons.js"

echo "→ zip"
mkdir -p "$ROOT/dist"
zip_path="$ROOT/dist/${PLUGIN_ID%.sdPlugin}.zip"
rm -f "$zip_path"
(cd "$ROOT" && zip -qr "$zip_path" "$PLUGIN_ID" -x "*/log/*" "*.DS_Store")

if [[ "${1:-}" == "--install" ]]; then
  echo "→ install into Stream Dock"
  target="$PLUGINS_DIR/$PLUGIN_ID"
  if [[ -e "$target" && ! -L "$target" ]]; then
    echo "  $target уже существует и это не симлинк — удалите вручную" >&2
    exit 1
  fi
  ln -sfn "$PLUGIN" "$target"
  echo "  перезапустите Stream Dock, чтобы он увидел новый плагин"
fi

echo "✓ $zip_path"
