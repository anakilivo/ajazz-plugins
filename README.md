# AJAZZ Stream Dock plugins

Плагины для AJAZZ Stream Dock (проверяются на AKP05E Pro). Каждый плагин — в своей папке
со своими исходниками, скриптами сборки и README.

| Папка | Плагин | Платформы |
|---|---|---|
| [`mixer/`](mixer/README.md) | Audio Mixer — громкость/mute устройств и приложений, переключение устройств | macOS, Windows |

## Структура плагина

```
<plugin>/
  <id>.sdPlugin/   то, что устанавливается в Stream Dock (manifest.json, код, картинки)
  native/          нативные помощники, если нужны
  scripts/         сборка и установка
  README.md
```

## Полезное про Stream Dock

- Плагины: macOS `~/Library/Application Support/HotSpot/StreamDock/plugins/`, Windows `%APPDATA%\HotSpot\StreamDock\plugins\`.
- Логи приложения: `…/HotSpot/StreamDock/logs/`.
- Картинки для клавиш и полосы отдавать в PNG: SVG Stream Dock не показывает (чёрный квадрат).
- Сегмент сенсорной полосы над крутилкой — 176×112, клавиша — 144×144.
- В `manifest.json` пути к иконкам указывать с расширением `.png`.
- Плагин запускается встроенным Node 20; если убить его процесс, Stream Dock перезапустит плагин сам.
  Изменения в `manifest.json` подхватываются только при перезапуске приложения.
