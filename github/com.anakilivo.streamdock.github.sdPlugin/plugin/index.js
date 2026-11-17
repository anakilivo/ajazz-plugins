"use strict";

const { StreamDock, log } = require("./sdk");
const { GitHub } = require("./github");
const registerCounters = require("./actions/counter");
const registerFeed = require("./actions/feed");
const { watchInspectors } = require("./actions/common");

const sd = new StreamDock();
const github = new GitHub();

registerCounters(sd, github);
registerFeed(sd, github);
watchInspectors(sd, github);

// Токен, репозитории и скрытые PR живут в глобальных настройках плагина.
// Загружаем один раз при старте, дальше источник правды — github.settings.
let loaded = false;
sd.onGlobalSettings = (settings) => {
  if (loaded) return;
  loaded = true;
  github.load(settings);
};
github.on("settings", (settings) => sd.setGlobalSettings(settings));

log.info("github plugin started", process.platform);
