// Разрешение на запись системного звука (TCC) macOS выдаёт «ответственному» процессу —
// обычно это приложение, запустившее нас (Stream Dock). У него нет нужного права,
// и перехват звука тихо отдаёт тишину. Поэтому при старте перезапускаем себя
// (тот же pid и stdin/stdout) с флагом disclaim: тогда ответственны мы сами,
// и macOS спрашивает разрешение для «Audio Mixer» (см. Info.plist).

import Darwin
import Foundation

func becomeResponsibleForSelf() {
    guard getenv("MIXER_DISCLAIMED") == nil,
          let symbol = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "responsibility_spawnattrs_setdisclaim") else { return }
    typealias Disclaim = @convention(c) (UnsafeMutablePointer<posix_spawnattr_t?>, Int32) -> Int32

    var attr: posix_spawnattr_t?
    posix_spawnattr_init(&attr)
    _ = unsafeBitCast(symbol, to: Disclaim.self)(&attr, 1)
    posix_spawnattr_setflags(&attr, Int16(POSIX_SPAWN_SETEXEC))
    setenv("MIXER_DISCLAIMED", "1", 1)

    var size = UInt32(PATH_MAX)
    var path = [CChar](repeating: 0, count: Int(size))
    guard _NSGetExecutablePath(&path, &size) == 0 else { return }
    // При успехе posix_spawn с SETEXEC не возвращается.
    let status = posix_spawn(nil, path, nil, &attr, CommandLine.unsafeArgv, environ)
    FileHandle.standardError.write("disclaim respawn failed: \(status)\n".data(using: .utf8)!)
}
