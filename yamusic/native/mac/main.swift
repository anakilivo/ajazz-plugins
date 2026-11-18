// Помощник волны: перехватывает звук приложения (Core Audio Process Tap, macOS 14.2+),
// не приглушая его, раскладывает на частоты и ~30 раз в секунду пишет в stdout строку JSON:
//   {"bands":[0..100, ...]} — уровни полос от низких к высоким
//   {"status":"waiting"}    — приложение не запущено или на паузе (пишется при смене)
//   {"status":"error","error":"..."}
// Аргументы: [bundle ID приложения] [число полос]. Плагин просто завершает процесс, когда волна не нужна.

import Accelerate
import AppKit
import CoreAudio
import Foundation

setvbuf(stdout, nil, _IOLBF, 0)
becomeResponsibleForSelf()

let targetBundle = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "ru.yandex.desktop.music"
let bandCount = CommandLine.arguments.count > 2 ? max(4, min(64, Int(CommandLine.arguments[2]) ?? 32)) : 32

func emit(_ object: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: object),
          let line = String(data: data, encoding: .utf8) else { return }
    print(line)
}

var lastStatus = ""
func status(_ value: String, error: String? = nil) {
    guard value != lastStatus else { return }
    lastStatus = value
    emit(error.map { ["status": value, "error": $0] } ?? ["status": value])
}

guard #available(macOS 14.2, *) else {
    status("error", error: "Нужна macOS 14.2 или новее")
    exit(1)
}

// MARK: - Звук: ring buffer последних сэмплов (моно)

let fftSize = 2048
final class SampleRing {
    private var buffer = [Float](repeating: 0, count: fftSize)
    private var index = 0
    private var lock = os_unfair_lock()
    private(set) var lastWrite = Date.distantPast

    func write(_ samples: UnsafePointer<Float>, frames: Int, channels: Int) {
        os_unfair_lock_lock(&lock)
        for frame in 0..<frames {
            var sum: Float = 0
            for c in 0..<channels { sum += samples[frame * channels + c] }
            buffer[index] = sum / Float(channels)
            index = (index + 1) % fftSize
        }
        lastWrite = Date()
        os_unfair_lock_unlock(&lock)
    }

    func peak() -> Float {
        os_unfair_lock_lock(&lock)
        defer { os_unfair_lock_unlock(&lock) }
        var value: Float = 0
        vDSP_maxmgv(buffer, 1, &value, vDSP_Length(fftSize))
        return value
    }

    /// Последние fftSize сэмплов по порядку.
    func snapshot() -> [Float] {
        os_unfair_lock_lock(&lock)
        defer { os_unfair_lock_unlock(&lock) }
        return Array(buffer[index...] + buffer[..<index])
    }
}

let ring = SampleRing()

// MARK: - Tap на процессы приложения

func objectList(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector) -> [AudioObjectID] {
    var addr = AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal,
                                          mElement: kAudioObjectPropertyElementMain)
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(object, &addr, 0, nil, &size) == noErr else { return [] }
    var ids = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
    guard AudioObjectGetPropertyData(object, &addr, 0, nil, &size, &ids) == noErr else { return [] }
    return ids
}

func property<T>(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector, _ initial: T) -> T? {
    var addr = AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal,
                                          mElement: kAudioObjectPropertyElementMain)
    var value = initial
    var size = UInt32(MemoryLayout<T>.size)
    return AudioObjectGetPropertyData(object, &addr, 0, nil, &size, &value) == noErr ? value : nil
}

func stringProperty(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector) -> String? {
    var addr = AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal,
                                          mElement: kAudioObjectPropertyElementMain)
    var value: Unmanaged<CFString>?
    var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
    guard AudioObjectGetPropertyData(object, &addr, 0, nil, &size, &value) == noErr else { return nil }
    return value?.takeRetainedValue() as String?
}

private typealias ResponsibleFn = @convention(c) (pid_t) -> pid_t
private let responsiblePid: ResponsibleFn? = dlsym(UnsafeMutableRawPointer(bitPattern: -2),
                                                   "responsibility_get_pid_responsible_for_pid")
    .map { unsafeBitCast($0, to: ResponsibleFn.self) }

/// Аудио-процессы приложения: сам процесс, его helper'ы (Electron) или процессы, за которые оно «ответственно».
func targetProcesses() -> [AudioObjectID] {
    let pids = Set(NSRunningApplication.runningApplications(withBundleIdentifier: targetBundle).map(\.processIdentifier))
    guard !pids.isEmpty else { return [] }
    return objectList(AudioObjectID(kAudioObjectSystemObject), kAudioHardwarePropertyProcessObjectList).filter { process in
        guard let pid = property(process, kAudioProcessPropertyPID, pid_t(0)) else { return false }
        if pids.contains(pid) { return true }
        if let rpid = responsiblePid?(pid), pids.contains(rpid) { return true }
        return (stringProperty(process, kAudioProcessPropertyBundleID) ?? "").hasPrefix(targetBundle + ".")
    }.sorted()
}

func defaultOutputUID() -> String? {
    guard let device = property(AudioObjectID(kAudioObjectSystemObject),
                                kAudioHardwarePropertyDefaultOutputDevice, AudioObjectID(0)) else { return nil }
    return stringProperty(device, kAudioDevicePropertyDeviceUID)
}

@available(macOS 14.2, *)
final class Tap {
    let processes: [AudioObjectID]
    let outputUID: String
    private(set) var sampleRate: Double = 48000
    private var tapID = AudioObjectID(kAudioObjectUnknown)
    private var aggregateID = AudioObjectID(kAudioObjectUnknown)
    private var procID: AudioDeviceIOProcID?

    init?(processes: [AudioObjectID], outputUID: String) {
        self.processes = processes
        self.outputUID = outputUID

        let description = CATapDescription(stereoMixdownOfProcesses: processes)
        description.uuid = UUID()
        description.muteBehavior = .unmuted
        description.isPrivate = true
        guard AudioHardwareCreateProcessTap(description, &tapID) == noErr else { return nil }

        let aggregate: [String: Any] = [
            kAudioAggregateDeviceNameKey: "Yandex Music Dock Tap",
            kAudioAggregateDeviceUIDKey: "com.anakilivo.yamusic.tap." + UUID().uuidString,
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
        sampleRate = property(aggregateID, kAudioDevicePropertyNominalSampleRate, Float64(0)) ?? 48000

        let status = AudioDeviceCreateIOProcIDWithBlock(&procID, aggregateID, nil) { _, input, _, output, _ in
            // Выход aggregate-устройства — тишина: оригинальный звук не приглушён и играет сам.
            for buffer in UnsafeMutableAudioBufferListPointer(output) where buffer.mData != nil {
                memset(buffer.mData, 0, Int(buffer.mDataByteSize))
            }
            guard let first = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: input)).first,
                  let data = first.mData else { return }
            let channels = Int(max(first.mNumberChannels, 1))
            ring.write(data.assumingMemoryBound(to: Float.self),
                       frames: Int(first.mDataByteSize) / (4 * channels), channels: channels)
        }
        guard status == noErr, AudioDeviceStart(aggregateID, procID) == noErr else {
            destroy()
            return nil
        }
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

// MARK: - Спектр

let log2n = vDSP_Length(log2(Double(fftSize)))
let fft = vDSP_create_fftsetup(log2n, FFTRadix(kFFTRadix2))!
var window = [Float](repeating: 0, count: fftSize)
vDSP_hann_window(&window, vDSP_Length(fftSize), Int32(vDSP_HANN_NORM))

let minDb: Float = -75, maxDb: Float = -15

/// Уровни bandCount логарифмических полос 40 Гц…16 кГц, 0…1.
func bands(sampleRate: Double) -> [Float] {
    var samples = ring.snapshot()
    vDSP_vmul(samples, 1, window, 1, &samples, 1, vDSP_Length(fftSize))

    let half = fftSize / 2
    var real = [Float](repeating: 0, count: half)
    var imag = [Float](repeating: 0, count: half)
    var magnitudes = [Float](repeating: 0, count: half)
    real.withUnsafeMutableBufferPointer { re in
        imag.withUnsafeMutableBufferPointer { im in
            var split = DSPSplitComplex(realp: re.baseAddress!, imagp: im.baseAddress!)
            samples.withUnsafeBytes { raw in
                vDSP_ctoz(raw.bindMemory(to: DSPComplex.self).baseAddress!, 2, &split, 1, vDSP_Length(half))
            }
            vDSP_fft_zrip(fft, &split, 1, log2n, FFTDirection(FFT_FORWARD))
            vDSP_zvabs(&split, 1, &magnitudes, 1, vDSP_Length(half))
        }
    }
    // zrip даёт ×2, окно Ханна — ×0.5: амплитуда синуса = magnitude / (N/2).
    var scale = Float(2) / Float(fftSize)
    vDSP_vsmul(magnitudes, 1, &scale, &magnitudes, 1, vDSP_Length(half))

    let binHz = sampleRate / Double(fftSize)
    let low = 40.0, high = min(16000.0, sampleRate / 2)
    return (0..<bandCount).map { band in
        let f0 = low * pow(high / low, Double(band) / Double(bandCount))
        let f1 = low * pow(high / low, Double(band + 1) / Double(bandCount))
        let b0 = max(1, Int(f0 / binHz)), b1 = max(b0 + 1, Int(f1 / binHz))
        var peak: Float = 0
        for bin in b0..<min(b1, half) { peak = max(peak, magnitudes[bin]) }
        let db = 20 * log10(max(peak, 1e-9))
        return max(0, min(1, (db - minDb) / (maxDb - minDb)))
    }
}

// MARK: - Цикл

var tap: Tap?

func syncTap() {
    let processes = targetProcesses()
    guard !processes.isEmpty, let output = defaultOutputUID() else {
        tap?.destroy()
        tap = nil
        return
    }
    if let tap, tap.processes == processes, tap.outputUID == output { return }
    tap?.destroy()
    tap = Tap(processes: processes, outputUID: output)
    if tap == nil { status("error", error: "Не удалось перехватить звук") }
}

Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { _ in syncTap() }.fire()

Timer.scheduledTimer(withTimeInterval: 1.0 / 30, repeats: true) { _ in
    // Tap отдаёт тишину, пока приложение на паузе; нет свежего звука — не запущено.
    guard let tap, Date().timeIntervalSince(ring.lastWrite) < 0.5, ring.peak() > 1e-4 else {
        status("waiting")
        return
    }
    lastStatus = ""
    let levels = bands(sampleRate: tap.sampleRate)
    emit(["bands": levels.map { Int(($0 * 100).rounded()) }])
}

signal(SIGTERM) { _ in
    tap?.destroy()
    exit(0)
}

RunLoop.main.run()
