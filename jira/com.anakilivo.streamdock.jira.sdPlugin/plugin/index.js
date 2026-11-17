"use strict";

const { StreamDock, log } = require("./sdk");
const { Jira } = require("./jira");
const registerSprint = require("./actions/sprint");
const registerFeed = require("./actions/feed");
const { watchInspectors } = require("./actions/common");

const sd = new StreamDock();
const jira = new Jira();

registerSprint(sd, jira);
registerFeed(sd, jira);
watchInspectors(sd, jira);

// Сайт, email и токен живут в глобальных настройках плагина.
// Загружаем один раз при старте, дальше источник правды — jira.settings.
let loaded = false;
sd.onGlobalSettings = (settings) => {
  if (loaded) return;
  loaded = true;
  jira.load(settings);
};
jira.on("settings", (settings) => sd.setGlobalSettings(settings));

log.info("jira plugin started", process.platform);
