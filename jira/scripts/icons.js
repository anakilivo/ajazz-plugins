// Рисует PNG-иконки для manifest.json тем же рендером, что и клавиши:
//   node scripts/icons.js

const fs = require("fs");
const path = require("path");

const PLUGIN = path.join(__dirname, "..", "com.anakilivo.streamdock.jira.sdPlugin");
const render = require(path.join(PLUGIN, "plugin", "render"));
const { rasterize } = require(path.join(PLUGIN, "plugin", "raster"));

const ICONS = {
  plugin: render.C.accent,
  sprint: render.C.accent,
  feed: render.C.done[0],
};

(async () => {
  const dir = path.join(PLUGIN, "static");
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, color] of Object.entries(ICONS)) {
    const png = Buffer.from(await rasterize(render.manifestIcon(color).svg), "base64");
    // 144×144 подходит и как обычная, и как @2x-версия.
    fs.writeFileSync(path.join(dir, `${name}.png`), png);
    fs.writeFileSync(path.join(dir, `${name}@2x.png`), png);
  }
})();
