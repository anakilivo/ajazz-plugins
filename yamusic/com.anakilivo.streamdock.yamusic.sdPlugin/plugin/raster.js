"use strict";

// SVG → PNG (base64) через resvg (WebAssembly) с системными шрифтами.
// Stream Dock не показывает SVG на клавишах и полосе.

const fs = require("fs");
const path = require("path");

const FONTS = {
  win32: ["segoeui.ttf", "segoeuib.ttf", "arial.ttf", "arialbd.ttf"]
    .map((f) => path.join(process.env.WINDIR || "C:\\Windows", "Fonts", f)),
  darwin: ["Arial.ttf", "Arial Bold.ttf"].map((f) => path.join("/System/Library/Fonts/Supplemental", f)),
};

let resvg;

function loadResvg() {
  resvg ??= (async () => {
    const { initWasm, Resvg } = require("@resvg/resvg-wasm");
    await initWasm(fs.readFileSync(require.resolve("@resvg/resvg-wasm/index_bg.wasm")));
    const fontBuffers = (FONTS[process.platform] || []).filter((f) => fs.existsSync(f)).map((f) => fs.readFileSync(f));
    return { Resvg, fontBuffers };
  })();
  return resvg;
}

// После падения WebAssembly (нехватка памяти и т. п.) экземпляр испорчен навсегда:
// выкидываем модуль из кэша require, следующий рендер загрузит свежий.
function resetResvg() {
  resvg = null;
  const dir = path.dirname(require.resolve("@resvg/resvg-wasm"));
  for (const key of Object.keys(require.cache)) if (key.startsWith(dir)) delete require.cache[key];
}

/** Рендерит SVG и отдаёт картинку в use(); память WebAssembly освобождаем сразу, не дожидаясь GC. */
async function render(svg, use) {
  const { Resvg, fontBuffers } = await loadResvg();
  let resvgInstance, image;
  try {
    resvgInstance = new Resvg(svg, { font: { fontBuffers, loadSystemFonts: false, defaultFontFamily: "Arial" } });
    image = resvgInstance.render();
    return use(image);
  } catch (e) {
    if (e instanceof WebAssembly.RuntimeError) resetResvg();
    throw e;
  } finally {
    try {
      image?.free();
      resvgInstance?.free();
    } catch {}
  }
}

async function rasterize(svg) {
  return render(svg, (image) => Buffer.from(image.asPng()).toString("base64"));
}

/** RGBA-пиксели картинки (для цветов обложки). */
async function pixels(svg) {
  return render(svg, (image) => ({ width: image.width, height: image.height, data: Uint8Array.from(image.pixels) }));
}

module.exports = { rasterize, pixels };
