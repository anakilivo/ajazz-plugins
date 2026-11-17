// Громкость отдельных приложений через Core Audio Process Taps (macOS 14.2+).
//
// Для приложения с громкостью < 100% или mute создаём tap на все его аудио-процессы
// (muteBehavior = mutedWhenTapped — macOS сам глушит оригинал), приватное
// aggregate-устройство «tap → текущий выход» и IOProc, который копирует звук,
// умножая на gain. При 100% tap удаляется — звук идёт напрямую, без задержки.
// Если помощник завершится, macOS снимет tap и звук приложения вернётся как был.

import AppKit
import CoreAudio
import Foundation

// MARK: - Аудио-процессы, сгруппированные по приложениям

struct AudioApp {
    let id: String
    let name: String
    var processes: [AudioObjectID]
    var playing: Bool
}

private typealias ResponsibleFn = @convention(c) (pid_t) -> pid_t
private let responsiblePid: ResponsibleFn? = dlsym(UnsafeMutableRawPointer(bitPattern: -2),
                                                   "responsibility_get_pid_responsible_for_pid")
    .map { unsafeBitCast($0, to: ResponsibleFn.self) }

private func regularApp(_ app: NSRunningApplication?) -> NSRunningApplication? {
    app?.activationPolicy == .regular && app?.bundleIdentifier != nil ? app : nil
}

/// Приложение из Dock, которому принадлежит аудио-процесс: сам процесс,
/// «ответственный» за него (helper'ы браузеров, WebKit) или приложение по префиксу bundle ID.
private func owningApp(pid: pid_t, bundleID: String) -> NSRunningApplication? {
    if let app = regularApp(NSRunningApplication(processIdentifier: pid)) { return app }
    if let rpid = responsiblePid?(pid), rpid > 0, rpid != pid,
       let app = regularApp(NSRunningApplication(processIdentifier: rpid)) { return app }
    let parts = bundleID.split(separator: ".")
    if let i = parts.firstIndex(where: { $0.lowercased().hasPrefix("helper") }), i > 0 {
        let base = parts[..<i].joined(separator: ".")
        return NSRunningApplication.runningApplications(withBundleIdentifier: base).lazy.compactMap(regularApp).first
    }
    return nil
}

@available(macOS 14.2, *)
func audioProcessIDs() -> [AudioObjectID] {
    objectList(systemObject, kAudioHardwarePropertyProcessObjectList)
}

@available(macOS 14.2, *)
func audioApps() -> [String: AudioApp] {
    var apps: [String: AudioApp] = [:]
    for process in audioProcessIDs() {
        guard let pid = getValue(process, address(kAudioProcessPropertyPID), pid_t(0)),
              let app = owningApp(pid: pid, bundleID: getString(process, kAudioProcessPropertyBundleID) ?? ""),
              let id = app.bundleIdentifier else { continue }
        let playing = (getValue(process, address(kAudioProcessPropertyIsRunningOutput), UInt32(0)) ?? 0) != 0
        apps[id, default: AudioApp(id: id, name: app.localizedName ?? id, processes: [], playing: false)]
            .processes.append(process)
        if playing { apps[id]?.playing = true }
    }
    return apps
}

private var iconCache: [String: String] = [:]

func appIcon(_ bundleID: String) -> String? {
    if let cached = iconCache[bundleID] { return cached }
    guard let icon = NSRunningApplication.runningApplications(withBundleIdentifier: bundleID).first?.icon,
          let png = pngBase64(icon, width: 64, height: 64) else { return nil }
    iconCache[bundleID] = png
    return png
}

// MARK: - Tap одного приложения

let tapDevicePrefix = "com.anakilivo.mixer.tap."

/// Громкость, которую IOProc плавно (за один буфер) доводит до target — без щелчков.
final class Gain {
    var target: Float
    var current: Float
    init(_ value: Float) { target = value; current = value }
}

@available(macOS 14.2, *)
final class AppTap {
    let processes: [AudioObjectID]
    let outputUID: String
    let gain: Gain
    private var tapID = AudioObjectID(kAudioObjectUnknown)
    private var aggregateID = AudioObjectID(kAudioObjectUnknown)
    private var procID: AudioDeviceIOProcID?

    init?(processes: [AudioObjectID], outputUID: String, gain: Float) {
        self.processes = processes
        self.outputUID = outputUID
        self.gain = Gain(gain)

        let description = CATapDescription(stereoMixdownOfProcesses: processes)
        description.uuid = UUID()
        description.muteBehavior = .mutedWhenTapped
        description.isPrivate = true
        guard AudioHardwareCreateProcessTap(description, &tapID) == noErr else { return nil }

        let aggregate: [String: Any] = [
            kAudioAggregateDeviceNameKey: "Audio Mixer Tap",
            kAudioAggregateDeviceUIDKey: tapDevicePrefix + UUID().uuidString,
            kAudioAggregateDeviceMainSubDeviceKey: outputUID,
            kAudioAggregateDeviceIsPrivateKey: true,
            kAudioAggregateDeviceIsStackedKey: false,
            kAudioAggregateDeviceTapAutoStartKey: true,
            kAudioAggregateDeviceSubDeviceListKey: [[kAudioSubDeviceUIDKey: outputUID]],
            kAudioAggregateDeviceTapListKey: [[kAudioSubTapDriftCompensationKey: true,
                                               kAudioSubTapUIDKey: description.uuid.uuidString]],
        ]
        guard AudioHardwareCreateAggregateDevice(aggregate as CFDictionary, &aggregateID) == noErr else {
            destroy()
            return nil
        }

        let box = self.gain
        let status = AudioDeviceCreateIOProcIDWithBlock(&procID, aggregateID, nil) { _, input, _, output, _ in
            AppTap.process(input: input, output: output, gain: box)
        }
        guard status == noErr, AudioDeviceStart(aggregateID, procID) == noErr else {
            destroy()
            return nil
        }
    }

    /// Копирует стерео из tap'а во все выходные буферы с плавным изменением громкости.
    private static func process(input: UnsafePointer<AudioBufferList>,
                                output: UnsafeMutablePointer<AudioBufferList>, gain: Gain) {
        let ins = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: input))
        let outs = UnsafeMutableAudioBufferListPointer(output)
        for buffer in outs where buffer.mData != nil {
            memset(buffer.mData, 0, Int(buffer.mDataByteSize))
        }
        guard let inBuffer = ins.first, let inData = inBuffer.mData else { return }

        let src = inData.assumingMemoryBound(to: Float.self)
        let inChannels = Int(max(inBuffer.mNumberChannels, 1))
        let inFrames = Int(inBuffer.mDataByteSize) / (4 * inChannels)
        let totalOut = outs.reduce(0) { $0 + Int($1.mNumberChannels) }
        let from = gain.current, to = gain.target

        var channelBase = 0
        for buffer in outs {
            let outChannels = Int(max(buffer.mNumberChannels, 1))
            defer { channelBase += outChannels }
            guard let outData = buffer.mData else { continue }
            let dst = outData.assumingMemoryBound(to: Float.self)
            let frames = min(Int(buffer.mDataByteSize) / (4 * outChannels), inFrames)
            guard frames > 0 else { continue }

            for frame in 0..<frames {
                let g = from + (to - from) * Float(frame) / Float(frames)
                if totalOut == 1 {
                    // Моно-выход: сводим стерео.
                    let right = inChannels > 1 ? src[frame * inChannels + 1] : src[frame * inChannels]
                    dst[frame] = (src[frame * inChannels] + right) * 0.5 * g
                    continue
                }
                for c in 0..<outChannels where channelBase + c < inChannels {
                    dst[frame * outChannels + c] = src[frame * inChannels + channelBase + c] * g
                }
            }
        }
        gain.current = to
    }

    func destroy() {
        if aggregateID != kAudioObjectUnknown {
            if let procID {
                AudioDeviceStop(aggregateID, procID)
                AudioDeviceDestroyIOProcID(aggregateID, procID)
            }
            AudioHardwareDestroyAggregateDevice(aggregateID)
            aggregateID = AudioObjectID(kAudioObjectUnknown)
        }
        if tapID != kAudioObjectUnknown {
            AudioHardwareDestroyProcessTap(tapID)
            tapID = AudioObjectID(kAudioObjectUnknown)
        }
    }
}

// MARK: - Микшер приложений

@available(macOS 14.2, *)
final class AppMixer {
    private var levels: [String: (volume: Double, muted: Bool)] = [:]
    private var taps: [String: AppTap] = [:]

    func set(app: String, volume: Double, muted: Bool) {
        levels[app] = (min(max(volume, 0), 1), muted)
        sync()
    }

    /// Приводит tap'ы в соответствие с уровнями, запущенными процессами и текущим выходом.
    /// Вызывается при изменении уровня, списка процессов и устройства вывода.
    func sync() {
        let apps = audioApps()
        let output = defaultDevice(.output).flatMap { getString($0, kAudioDevicePropertyDeviceUID) }

        for app in Set(levels.keys).union(taps.keys) {
            let level = levels[app] ?? (1, false)
            // Квадратичная кривая: на слух ближе к линейной шкале громкости.
            let gain = level.muted ? 0 : Float(level.volume * level.volume)
            guard gain < 0.999, let processes = apps[app]?.processes.sorted(), let output else {
                taps.removeValue(forKey: app)?.destroy()
                continue
            }
            if let tap = taps[app], tap.processes == processes, tap.outputUID == output {
                tap.gain.target = gain
                continue
            }
            taps.removeValue(forKey: app)?.destroy()
            taps[app] = AppTap(processes: processes, outputUID: output, gain: gain)
        }
    }

    func snapshot() -> [[String: Any]] {
        audioApps().values.sorted { $0.name.localizedCompare($1.name) == .orderedAscending }.map { app in
            ["id": app.id, "name": app.name, "playing": app.playing, "icon": appIcon(app.id) ?? NSNull()]
        }
    }
}
