// Растеризация SVG в PNG: Stream Dock не умеет показывать SVG на полосе и клавишах.

import AppKit

func renderPNG(svg: String, width: Int, height: Int) -> String? {
    guard let image = NSImage(data: Data(svg.utf8)) else { return nil }
    return pngBase64(image, width: width, height: height)
}

func pngBase64(_ image: NSImage, width: Int, height: Int) -> String? {
    guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: width, pixelsHigh: height,
                                     bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                                     colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0) else { return nil }
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    image.draw(in: NSRect(x: 0, y: 0, width: width, height: height))
    NSGraphicsContext.restoreGraphicsState()
    return rep.representation(using: .png, properties: [:])?.base64EncodedString()
}
