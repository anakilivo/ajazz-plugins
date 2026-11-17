// Устройства CoreAudio: громкость, mute, устройство по умолчанию, снимок состояния.

import AudioToolbox
import CoreAudio
import Foundation

// MARK: - Низкоуровневые обёртки CoreAudio

let systemObject = AudioObjectID(kAudioObjectSystemObject)

enum Scope: String {
    case output, input

    var coreAudio: AudioObjectPropertyScope {
        self == .output ? kAudioDevicePropertyScopeOutput : kAudioDevicePropertyScopeInput
    }

    var defaultDeviceSelector: AudioObjectPropertySelector {
        self == .output ? kAudioHardwarePropertyDefaultOutputDevice : kAudioHardwarePropertyDefaultInputDevice
    }
}

func address(_ selector: AudioObjectPropertySelector,
             _ scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal,
             _ element: AudioObjectPropertyElement = kAudioObjectPropertyElementMain) -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress(mSelector: selector, mScope: scope, mElement: element)
}

func getValue<T>(_ object: AudioObjectID, _ addr: AudioObjectPropertyAddress, _ initial: T) -> T? {
    var addr = addr
    guard AudioObjectHasProperty(object, &addr) else { return nil }
    var value = initial
    var size = UInt32(MemoryLayout<T>.size)
    let status = AudioObjectGetPropertyData(object, &addr, 0, nil, &size, &value)
    return status == noErr ? value : nil
}

func setValue<T>(_ object: AudioObjectID, _ addr: AudioObjectPropertyAddress, _ value: T) -> Bool {
    var addr = addr
    guard AudioObjectHasProperty(object, &addr) else { return false }
    var settable: DarwinBoolean = false
    guard AudioObjectIsPropertySettable(object, &addr, &settable) == noErr, settable.boolValue else { return false }
    var value = value
    let size = UInt32(MemoryLayout<T>.size)
    return AudioObjectSetPropertyData(object, &addr, 0, nil, size, &value) == noErr
}

func isSettable(_ object: AudioObjectID, _ addr: AudioObjectPropertyAddress) -> Bool {
    var addr = addr
    guard AudioObjectHasProperty(object, &addr) else { return false }
    var settable: DarwinBoolean = false
    return AudioObjectIsPropertySettable(object, &addr, &settable) == noErr && settable.boolValue
}

func getString(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector) -> String? {
    var addr = address(selector)
    guard AudioObjectHasProperty(object, &addr) else { return nil }
    var value: Unmanaged<CFString>?
    var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
    guard AudioObjectGetPropertyData(object, &addr, 0, nil, &size, &value) == noErr,
          let string = value?.takeRetainedValue() else { return nil }
    return string as String
}

func objectList(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector) -> [AudioObjectID] {
    var addr = address(selector)
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(object, &addr, 0, nil, &size) == noErr else { return [] }
    var ids = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
    guard AudioObjectGetPropertyData(object, &addr, 0, nil, &size, &ids) == noErr else { return [] }
    return ids
}

func allDeviceIDs() -> [AudioObjectID] {
    objectList(systemObject, kAudioHardwarePropertyDevices)
}

func channelCount(_ device: AudioObjectID, _ scope: Scope) -> Int {
    var addr = address(kAudioDevicePropertyStreamConfiguration, scope.coreAudio)
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(device, &addr, 0, nil, &size) == noErr, size > 0 else { return 0 }
    let raw = UnsafeMutableRawPointer.allocate(byteCount: Int(size), alignment: MemoryLayout<AudioBufferList>.alignment)
    defer { raw.deallocate() }
    guard AudioObjectGetPropertyData(device, &addr, 0, nil, &size, raw) == noErr else { return 0 }
    let list = UnsafeMutableAudioBufferListPointer(raw.assumingMemoryBound(to: AudioBufferList.self))
    return list.reduce(0) { $0 + Int($1.mNumberChannels) }
}

func defaultDevice(_ scope: Scope) -> AudioObjectID? {
    getValue(systemObject, address(scope.defaultDeviceSelector), AudioObjectID(0))
}

/// Элементы, через которые можно управлять громкостью/mute:
/// сначала главный (main), иначе отдельные каналы (1, 2, ...).
func controlElements(_ device: AudioObjectID, _ scope: Scope, _ selector: AudioObjectPropertySelector) -> [AudioObjectPropertyElement] {
    if isSettable(device, address(selector, scope.coreAudio, kAudioObjectPropertyElementMain)) {
        return [kAudioObjectPropertyElementMain]
    }
    let channels = max(channelCount(device, scope), 2)
    return (1...channels).map { AudioObjectPropertyElement($0) }
        .filter { isSettable(device, address(selector, scope.coreAudio, $0)) }
}

func volume(_ device: AudioObjectID, _ scope: Scope) -> Float32? {
    let values = controlElements(device, scope, kAudioDevicePropertyVolumeScalar)
        .compactMap { getValue(device, address(kAudioDevicePropertyVolumeScalar, scope.coreAudio, $0), Float32(0)) }
    return values.max()
}

func setVolume(_ device: AudioObjectID, _ scope: Scope, _ value: Float32) -> Bool {
    let clamped = min(max(value, 0), 1)
    let elements = controlElements(device, scope, kAudioDevicePropertyVolumeScalar)
    guard !elements.isEmpty else { return false }
    return elements.map { setValue(device, address(kAudioDevicePropertyVolumeScalar, scope.coreAudio, $0), clamped) }
        .contains(true)
}

func muted(_ device: AudioObjectID, _ scope: Scope) -> Bool? {
    let values = controlElements(device, scope, kAudioDevicePropertyMute)
        .compactMap { getValue(device, address(kAudioDevicePropertyMute, scope.coreAudio, $0), UInt32(0)) }
    return values.isEmpty ? nil : values.allSatisfy { $0 != 0 }
}

func setMuted(_ device: AudioObjectID, _ scope: Scope, _ value: Bool) -> Bool {
    let elements = controlElements(device, scope, kAudioDevicePropertyMute)
    guard !elements.isEmpty else { return false }
    return elements.map { setValue(device, address(kAudioDevicePropertyMute, scope.coreAudio, $0), UInt32(value ? 1 : 0)) }
        .contains(true)
}

func deviceID(uid: String) -> AudioObjectID? {
    allDeviceIDs().first { getString($0, kAudioDevicePropertyDeviceUID) == uid }
}

func isHidden(_ device: AudioObjectID) -> Bool {
    (getValue(device, address(kAudioDevicePropertyIsHidden), UInt32(0)) ?? 0) != 0
}

// MARK: - Снимок состояния

func deviceSnapshot() -> [[String: Any]] {
    let defaultOut = defaultDevice(.output)
    let defaultIn = defaultDevice(.input)
    return allDeviceIDs().filter { !isHidden($0) }.compactMap { id in
        // Служебные aggregate-устройства микшера приложений (см. AppTap) не показываем.
        guard let uid = getString(id, kAudioDevicePropertyDeviceUID), !uid.hasPrefix(tapDevicePrefix) else { return nil }
        var device: [String: Any] = [
            "uid": uid,
            "name": getString(id, kAudioObjectPropertyName) ?? uid,
        ]
        for scope in [Scope.output, Scope.input] where channelCount(id, scope) > 0 {
            device[scope.rawValue] = [
                "volume": volume(id, scope).map { Double($0) } ?? NSNull(),
                "muted": muted(id, scope) ?? NSNull(),
                "isDefault": id == (scope == .output ? defaultOut : defaultIn),
            ] as [String: Any]
        }
        return device["output"] == nil && device["input"] == nil ? nil : device
    }
}
