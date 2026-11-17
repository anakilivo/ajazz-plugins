// Рисует PNG-иконки для manifest.json из тех же Octicons, что и на клавишах:
//   node scripts/icons.js

const fs = require("fs");
const path = require("path");

const PLUGIN = path.join(__dirname, "..", "com.anakilivo.streamdock.github.sdPlugin");
const render = require(path.join(PLUGIN, "plugin", "render"));
const { rasterize } = require(path.join(PLUGIN, "plugin", "raster"));

const ICONS = {
  plugin: ["pr", "accent"],
  review: ["eye", "review"],
  mine: ["pr", "success"],
  feed: ["pr", "accent"],
};

(async () => {
  const dir = path.join(PLUGIN, "static");
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, [icon, color]] of Object.entries(ICONS)) {
    const png = Buffer.from(await rasterize(render.manifestIcon(icon, color).svg), "base64");
    // 144×144 подходит и как обычная, и как @2x-версия.
    fs.writeFileSync(path.join(dir, `${name}.png`), png);
    fs.writeFileSync(path.join(dir, `${name}@2x.png`), png);
  }
})();
