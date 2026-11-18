"use strict";

const { StreamDock, log } = require("./sdk");
const { Music } = require("./music");
const { Spectrum } = require("./spectrum");
const { followCover } = require("./cover");
const registerNowPlaying = require("./actions/nowplaying");
const registerKeys = require("./actions/keys");
const { watchInspectors } = require("./actions/common");

const sd = new StreamDock();
const music = new Music();
const spectrum = new Spectrum();

followCover(music);
registerNowPlaying(sd, music, spectrum);
registerKeys(sd, music);
watchInspectors(sd, music);

// Порт отладки Музыки — в глобальных настройках плагина.
let loaded = false;
sd.onGlobalSettings = (settings) => {
  if (loaded) return;
  loaded = true;
  if (settings.port) music.setPort(settings.port);
};
music.on("settings", () => sd.setGlobalSettings({ port: music.port }));

log.info("yamusic plugin started", process.platform, spectrum.available ? "with spectrum" : "without spectrum");
