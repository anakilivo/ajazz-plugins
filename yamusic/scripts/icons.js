// Рисует PNG-иконки для manifest.json из тех же иконок, что и на клавишах:
//   node scripts/icons.js

const fs = require("fs");
const path = require("path");

const PLUGIN = path.join(__dirname, "..", "com.anakilivo.streamdock.yamusic.sdPlugin");
const render = require(path.join(PLUGIN, "plugin", "render"));
const { rasterize } = require(path.join(PLUGIN, "plugin", "raster"));

const YELLOW = "#ffcc00";
const ICONS = {
  plugin: ["music", YELLOW],
  nowplaying: ["music", YELLOW],
  cover: ["music", "#ffffff"],
  playpause: ["play", "#ffffff", { fill: true, width: 0 }],
  next: ["next", "#ffffff", { fill: true, width: 1.5 }],
  previous: ["previous", "#ffffff", { fill: true, width: 1.5 }],
  like: ["heart", "#ff4d6d", { fill: true }],
  dislike: ["dislike", "#ffffff"],
  shuffle: ["shuffle", YELLOW],
  repeat: ["repeat", YELLOW],
};

(async () => {
  const dir = path.join(PLUGIN, "static");
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, [icon, color, opts]] of Object.entries(ICONS)) {
    const png = Buffer.from(await rasterize(render.manifestIcon(icon, color, opts).svg), "base64");
    // 144×144 подходит и как обычная, и как @2x-версия.
    fs.writeFileSync(path.join(dir, `${name}.png`), png);
    fs.writeFileSync(path.join(dir, `${name}@2x.png`), png);
  }
})();
