// AudioHelper — долгоживущий процесс-посредник между плагином и CoreAudio.
//
// Протокол: JSON по строкам через stdin/stdout.
//   Запрос:  {"id": 1, "cmd": "list"}                       → {"devices": [...], "apps": [...]}
//            {"id": 2, "cmd": "setVolume",  "uid": "...", "scope": "output"|"input", "value": 0.0...1.0}
//            {"id": 3, "cmd": "setMute",    "uid": "...", "scope": "...", "muted": true}
//            {"id": 4, "cmd": "setDefault", "uid": "...", "scope": "..."}
//            {"id": 5, "cmd": "setApp",     "app": "<bundle id>", "volume": 0.0...1.0, "muted": false}
//            {"id": 6, "cmd": "render", "svg": "<svg ...>", "width": 176, "height": 112} → {"png": "<base64>"}
//   Ответ:   {"id": 1, "ok": true, ...} | {"id": 1, "ok": false, "error": "..."}
//   События: {"event": "changed", "devices": [...]} — устройства, громкость, mute, устройства по умолчанию;
//            {"event": "apps", "apps": [...]}       — список приложений со звуком.

import CoreAudio
import Foundation

becomeResponsibleForSelf()

// MARK: - Вывод

let outputLock = NSLock()

func send(_ message: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: message) else { return }
    outputLock.lock()
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([0x0A]))
    outputLock.unlock()
}

// MARK: - Микшер приложений (только macOS 14.2+)

let appMixerBox: AnyObject? = {
    if #available(macOS 14.2, *) { return AppMixer() }
    return nil
}()

@available(macOS 14.2, *)
var appMixer: AppMixer? { appMixerBox as? AppMixer }

func appsSnapshot() -> [[String: Any]] {
    if #available(macOS 14.2, *) { return appMixer?.snapshot() ?? [] }
    return []
}

// MARK: - Подписка на изменения

let queue = DispatchQueue(label: "audio-helper")
var pendingNotify: DispatchWorkItem?
var watchedObjects = Set<AudioObjectID>()
var lastAppsSignature = ""

/// Склеиваем пачку уведомлений CoreAudio в одно обновление.
func scheduleNotify() {
    pendingNotify?.cancel()
    let item = DispatchWorkItem {
        watchObjects()
        send(["event": "changed", "devices": deviceSnapshot()])
        if #available(macOS 14.2, *) {
            appMixer?.sync()
            let apps = appsSnapshot()
            let signature = apps.map { "\($0["id"]!)/\($0["playing"]!)" }.joined(separator: ",")
            if signature != lastAppsSignature {
                lastAppsSignature = signature
                send(["event": "apps", "apps": apps])
            }
        }
    }
    pendingNotify = item
    queue.asyncAfter(deadline: .now() + .milliseconds(40), execute: item)
}

let listener: AudioObjectPropertyListenerBlock = { _, _ in scheduleNotify() }

func listen(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector,
            _ scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal) {
    var addr = address(selector, scope, kAudioObjectPropertyElementWildcard)
    AudioObjectAddPropertyListenerBlock(object, &addr, queue, listener)
}

func watchObjects() {
    for id in allDeviceIDs() where watchedObjects.insert(id).inserted {
        for scope in [kAudioDevicePropertyScopeOutput, kAudioDevicePropertyScopeInput] {
            listen(id, kAudioDevicePropertyVolumeScalar, scope)
            listen(id, kAudioDevicePropertyMute, scope)
        }
    }
    if #available(macOS 14.2, *) {
        for id in audioProcessIDs() where watchedObjects.insert(id).inserted {
            listen(id, kAudioProcessPropertyIsRunningOutput)
        }
    }
}

func watchSystem() {
    listen(systemObject, kAudioHardwarePropertyDevices)
    listen(systemObject, kAudioHardwarePropertyDefaultOutputDevice)
    listen(systemObject, kAudioHardwarePropertyDefaultInputDevice)
    if #available(macOS 14.2, *) {
        listen(systemObject, kAudioHardwarePropertyProcessObjectList)
    }
    watchObjects()
}

// MARK: - Обработка команд

func handle(_ request: [String: Any]) -> [String: Any] {
    guard let cmd = request["cmd"] as? String else { return ["ok": false, "error": "no cmd"] }

    switch cmd {
    case "list":
        return ["ok": true, "devices": deviceSnapshot(), "apps": appsSnapshot()]

    case "render":
        guard let svg = request["svg"] as? String,
              let width = request["width"] as? Int, let height = request["height"] as? Int,
              let png = renderPNG(svg: svg, width: width, height: height) else {
            return ["ok": false, "error": "render failed"]
        }
        return ["ok": true, "png": png]

    case "setApp":
        guard #available(macOS 14.2, *), let mixer = appMixer else {
            return ["ok": false, "error": "app volume requires macOS 14.2"]
        }
        guard let app = request["app"] as? String, let volume = request["volume"] as? Double else {
            return ["ok": false, "error": "no app/volume"]
        }
        mixer.set(app: app, volume: volume, muted: request["muted"] as? Bool ?? false)
        return ["ok": true]

    default:
        return handleDevice(cmd, request)
    }
}

func handleDevice(_ cmd: String, _ request: [String: Any]) -> [String: Any] {
    guard let uid = request["uid"] as? String, let device = deviceID(uid: uid) else {
        return ["ok": false, "error": "device not found"]
    }
    guard let scope = Scope(rawValue: request["scope"] as? String ?? "") else {
        return ["ok": false, "error": "bad scope"]
    }

    let ok: Bool
    switch cmd {
    case "setVolume":
        guard let value = request["value"] as? Double else { return ["ok": false, "error": "no value"] }
        ok = setVolume(device, scope, Float32(value))
    case "setMute":
        guard let value = request["muted"] as? Bool else { return ["ok": false, "error": "no muted"] }
        ok = setMuted(device, scope, value)
    case "setDefault":
        ok = setValue(systemObject, address(scope.defaultDeviceSelector), device)
        if ok && scope == .output {
            // Системные звуки следуют за основным выходом.
            _ = setValue(systemObject, address(kAudioHardwarePropertyDefaultSystemOutputDevice), device)
        }
    default:
        return ["ok": false, "error": "unknown cmd \(cmd)"]
    }
    return ok ? ["ok": true] : ["ok": false, "error": "\(cmd) not supported by device"]
}

// MARK: - main

setvbuf(stdout, nil, _IONBF, 0)
queue.async { watchSystem() }

DispatchQueue.global().async {
    while let line = readLine() {
        guard let data = line.data(using: .utf8),
              let request = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { continue }
        queue.async {
            var response = handle(request)
            response["id"] = request["id"] ?? NSNull()
            send(response)
        }
    }
    // stdin закрыт — плагин завершился. Tap'ы macOS снимет сам вместе с процессом.
    exit(0)
}

dispatchMain()
