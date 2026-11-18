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

async function render(svg) {
  const { Resvg, fontBuffers } = await loadResvg();
  return new Resvg(svg, { font: { fontBuffers, loadSystemFonts: false, defaultFontFamily: "Arial" } }).render();
}

async function rasterize(svg) {
  return Buffer.from((await render(svg)).asPng()).toString("base64");
}

/** RGBA-пиксели картинки (для цветов обложки). */
async function pixels(svg) {
  const image = await render(svg);
  return { width: image.width, height: image.height, data: image.pixels };
}

module.exports = { rasterize, pixels };
