#!/bin/zsh
# Архив для Windows: тот же плагин без macOS-помощника. Волны на Windows пока нет —
# перехват звука процесса для неё ещё не сделан; управление и обложка работают.
# Запускать после build-mac.sh (npm-зависимости и иконки уже на месте).
set -euo pipefail

ROOT=${0:A:h:h}
PLUGIN_ID=com.anakilivo.streamdock.yamusic.sdPlugin

echo "→ zip (windows)"
mkdir -p "$ROOT/dist"
zip_path="$ROOT/dist/${PLUGIN_ID%.sdPlugin}-windows.zip"
rm -f "$zip_path"
(cd "$ROOT" && zip -qr "$zip_path" "$PLUGIN_ID" \
  -x "*/log/*" "*/bin/spectrum-helper-mac" "*.DS_Store")

echo "✓ $zip_path"
