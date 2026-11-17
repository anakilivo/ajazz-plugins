// Рисует PNG-иконки плагина из SF Symbols: swift scripts/icons.swift <static-dir>

import AppKit

let icons: [(name: String, symbol: String, color: NSColor)] = [
    ("plugin", "slider.vertical.3", NSColor(red: 0.22, green: 0.74, blue: 0.97, alpha: 1)),
    ("channel", "dial.medium", NSColor(red: 0.22, green: 0.74, blue: 0.97, alpha: 1)),
    ("device", "hifispeaker.and.homepod", NSColor(red: 0.20, green: 0.83, blue: 0.60, alpha: 1)),
    ("app", "macwindow.badge.plus", NSColor(red: 0.65, green: 0.55, blue: 0.98, alpha: 1)),
]

func render(symbol: String, color: NSColor, size: Int) -> Data? {
    guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size,
                                     bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                                     colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0) else { return nil }
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)

    let s = CGFloat(size)
    NSColor(red: 0.07, green: 0.07, blue: 0.09, alpha: 1).setFill()
    NSBezierPath(roundedRect: NSRect(x: 0, y: 0, width: s, height: s), xRadius: s * 0.18, yRadius: s * 0.18).fill()

    let config = NSImage.SymbolConfiguration(pointSize: s * 0.5, weight: .medium)
        .applying(.init(paletteColors: [color]))
    if let image = NSImage(systemSymbolName: symbol, accessibilityDescription: nil)?.withSymbolConfiguration(config) {
        let fit = min(s * 0.62 / image.size.width, s * 0.62 / image.size.height)
        let w = image.size.width * fit, h = image.size.height * fit
        image.draw(in: NSRect(x: (s - w) / 2, y: (s - h) / 2, width: w, height: h))
    }

    NSGraphicsContext.restoreGraphicsState()
    return rep.representation(using: .png, properties: [:])
}

let dir = URL(fileURLWithPath: CommandLine.arguments[1])
try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
for icon in icons {
    for (suffix, size) in [("", 72), ("@2x", 144)] {
        try render(symbol: icon.symbol, color: icon.color, size: size)?
            .write(to: dir.appendingPathComponent("\(icon.name)\(suffix).png"))
    }
}
