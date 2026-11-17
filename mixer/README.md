# Audio Mixer (`com.anakilivo.streamdock.mixer`)

Микшер звука и микрофонов для AJAZZ AKP05E Pro (и других Stream Dock с крутилками).

| Действие | Где | Управление |
|---|---|---|
| Канал (громкость / mute) | крутилка | поворот — громкость, нажатие — mute; на полосе имя, % и уровень |
| Приложение (громкость / mute) | крутилка | громкость отдельного приложения (macOS 14.2+, Windows); на полосе иконка, имя, % |
| Выбор устройства (крутилка) | крутилка | поворот — листать устройства, нажатие — сделать основным |
| Следующее устройство | клавиша | нажатие — следующее устройство из списка |

## Устройство

```
com.anakilivo.streamdock.mixer.sdPlugin/
  manifest.json
  plugin/            Node-часть (запускается node20 из Stream Dock)
    index.js         точка входа
    sdk.js           WebSocket-протокол Stream Dock, логи в log/
    audio.js         клиент нативного помощника, кэш устройств
    render.js        SVG для полосы (176×112) и клавиш (144×144)
    raster.js        SVG → PNG (macOS — помощник, Windows — resvg)
    actions/         действия
  pi/                Property Inspector (настройки действий)
  bin/               собранные помощники (не в git)
native/mac/                    Swift-помощник, JSON по строкам через stdin/stdout (протокол — в main.swift)
  Devices.swift                громкость/mute/выбор устройств
  Apps.swift                   громкость приложений через Process Taps
  Disclaim.swift               чтобы macOS спрашивал разрешение у помощника, а не у Stream Dock
  Render.swift                 SVG → PNG (Stream Dock не показывает SVG)
  Info.plist                   вшивается в бинарник (NSAudioCaptureUsageDescription)
native/win/audio-helper.cpp    помощник для Windows (WASAPI)
scripts/build-mac.sh           сборка; --install — симлинк в Stream Dock и перезапуск
scripts/build-win.sh           сборка Windows-архива в dist/
```

## Сборка (macOS)

```sh
./scripts/build-mac.sh            # собрать
./scripts/build-mac.sh --install  # собрать, установить симлинком и перезапустить Stream Dock
```

Плагин установлен симлинком, поэтому правки в `com.anakilivo.streamdock.mixer.sdPlugin/` подхватываются после перезапуска Stream Dock.
Логи: `com.anakilivo.streamdock.mixer.sdPlugin/log/`, логи приложения: `~/Library/Application Support/HotSpot/StreamDock/logs/`.

## Громкость приложений: как устроено

Для приложения с громкостью ниже 100% или выключенным звуком помощник создаёт Process Tap на все его
аудио-процессы (helper'ы браузеров группируются с приложением). macOS сам глушит оригинал, а мы проигрываем
перехваченный звук с нужной громкостью на текущий выход. На 100% tap снимается, звук идёт напрямую.
Если помощник завершится, macOS снимет tap и звук вернётся как был.

Нужно разрешение «Запись системного звука» для **Audio Mixer** (Настройки → Конфиденциальность →
Запись экрана и системного звука). Бинарник подписан ad-hoc, поэтому после пересборки macOS может спросить снова.

## Windows

Помощник — `native/win/audio-helper.cpp` (WASAPI, тот же JSON-протокол). Громкость приложений — штатные
аудиосессии Windows, как в «Микшере громкости»: без перехвата и без разрешений. Картинки на Windows рисует
сам плагин через `@resvg/resvg-wasm` с системными шрифтами (`plugin/raster.js`).

Сборка на macOS (нужен `brew install zig`):

```sh
./scripts/build-win.sh   # → dist/com.anakilivo.streamdock.mixer-windows.zip
```

Установка: распаковать архив в `%APPDATA%\HotSpot\StreamDock\plugins\` и перезапустить Stream Dock.
Проверить Windows-рендер на Mac: `MIXER_RASTER=resvg`.
