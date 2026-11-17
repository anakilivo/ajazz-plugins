"use strict";

// SVG → PNG (base64). Stream Dock не показывает SVG на полосе и клавишах.
// macOS: растеризует нативный помощник (AppKit). Windows: resvg (WebAssembly)
// с системными шрифтами — встроенного рендера SVG с текстом в Windows нет.
// MIXER_RASTER=resvg включает resvg и на macOS (для проверки Windows-рендера).

const fs = require("fs");
const path = require("path");

const FONTS = {
  win32: ["segoeui.ttf", "segoeuib.ttf", "arial.ttf", "arialbd.ttf", "seguisym.ttf"]
    .map((f) => path.join(process.env.WINDIR || "C:\\Windows", "Fonts", f)),
  darwin: ["Arial.ttf", "Arial Bold.ttf"].map((f) => path.join("/System/Library/Fonts/Supplemental", f)),
};

const useResvg = process.platform === "win32" || process.env.MIXER_RASTER === "resvg";
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

async function rasterize(audio, { svg, width, height }) {
  if (!useResvg) return (await audio.request({ cmd: "render", svg, width, height })).png;

  const { Resvg, fontBuffers } = await loadResvg();
  const image = new Resvg(svg, {
    font: { fontBuffers, loadSystemFonts: false, defaultFontFamily: process.platform === "win32" ? "Segoe UI" : "Arial" },
  });
  return Buffer.from(image.render().asPng()).toString("base64");
}

module.exports = { rasterize };
