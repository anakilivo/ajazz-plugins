"use strict";

const { StreamDock, log } = require("./sdk");
const { Audio } = require("./audio");
const registerChannel = require("./actions/channel");
const registerDevice = require("./actions/device");
const registerApp = require("./actions/app");

const sd = new StreamDock();
const audio = new Audio();

registerChannel(sd, audio);
registerDevice(sd, audio);
registerApp(sd, audio);

// Громкость приложений переживает перезапуск: храним её в глобальных настройках плагина.
// Загружаем только при старте: дальше источник правды — audio.appLevels.
let saveTimer;
let loaded = false;
sd.onGlobalSettings = (settings) => {
  if (loaded) return;
  loaded = true;
  audio.loadAppLevels(settings.appLevels || {});
};
audio.on("appLevels", (appLevels) => {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => sd.setGlobalSettings({ appLevels }), 500);
});

log.info("mixer plugin started", process.platform);
