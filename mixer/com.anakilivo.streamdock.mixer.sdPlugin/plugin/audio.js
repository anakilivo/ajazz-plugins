"use strict";

// Клиент нативного помощника (bin/audio-helper-*). Держит актуальный снимок
// устройств и приложений, эмитит "change" при любом изменении.
// Уровни приложений хранит плагин (помощник их не помнит): при изменении эмитит
// "appLevels" для сохранения и заново отправляет их помощнику после его перезапуска.

const { spawn } = require("child_process");
const { EventEmitter } = require("events");
const path = require("path");
const readline = require("readline");
const { log } = require("./sdk");

const HELPERS = {
  darwin: "audio-helper-mac",
  win32: "audio-helper-win.exe",
};

// После локального изменения громкости игнорируем значения от помощника
// для этого канала, чтобы быстрые повороты крутилки не "дёргались" назад.
const LOCAL_WINS_MS = 300;

class Audio extends EventEmitter {
  constructor() {
    super();
    this.devices = [];
    this.apps = [];
    this.appLevels = {}; // bundle id -> { volume, muted, name }
    this.pending = new Map();
    this.nextId = 1;
    this.localUntil = new Map();
    this.restartDelay = 500;
    this.start();
  }

  start() {
    const binary = HELPERS[process.platform];
    if (!binary) return log.error("unsupported platform", process.platform);

    const file = path.join(__dirname, "..", "bin", binary);
    this.proc = spawn(file, [], { stdio: ["pipe", "pipe", "pipe"] });
    this.proc.on("error", (e) => log.error("helper spawn failed", file, e));
    this.proc.stderr.on("data", (d) => log.warn("helper:", d.toString().trim()));
    this.proc.on("exit", (code) => {
      log.warn("helper exited", code);
      for (const { reject } of this.pending.values()) reject(new Error("helper exited"));
      this.pending.clear();
      setTimeout(() => this.start(), this.restartDelay);
      this.restartDelay = Math.min(this.restartDelay * 2, 10000);
    });

    readline.createInterface({ input: this.proc.stdout }).on("line", (line) => this.onLine(line));
    this.request({ cmd: "list" })
      .then((res) => {
        this.restartDelay = 500;
        this.apps = res.apps || [];
        this.update(res.devices);
        for (const id of Object.keys(this.appLevels)) this.sendAppLevel(id);
      })
      .catch((e) => log.error("initial list failed", e));
  }

  onLine(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return log.warn("helper bad line", line);
    }
    if (msg.event === "changed") return this.update(msg.devices);
    if (msg.event === "apps") {
      this.apps = msg.apps;
      return this.emit("change");
    }

    const waiter = this.pending.get(msg.id);
    if (!waiter) return;
    this.pending.delete(msg.id);
    msg.ok ? waiter.resolve(msg) : waiter.reject(new Error(msg.error));
  }

  request(body) {
    return new Promise((resolve, reject) => {
      if (!this.proc?.stdin.writable) return reject(new Error("helper not running"));
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this.proc.stdin.write(JSON.stringify({ id, ...body }) + "\n");
    });
  }

  update(devices) {
    const now = Date.now();
    // Сохраняем оптимистичные значения каналов, которые только что крутили.
    for (const device of devices) {
      for (const scope of ["output", "input"]) {
        const key = `${device.uid}/${scope}`;
        const old = this.find(device.uid)?.[scope];
        if (device[scope] && old && this.localUntil.get(key) > now) {
          device[scope].volume = old.volume;
        }
      }
    }
    this.devices = devices;
    this.emit("change");
  }

  find(uid) {
    return this.devices.find((d) => d.uid === uid);
  }

  defaultDevice(scope) {
    return this.devices.find((d) => d[scope]?.isDefault);
  }

  list(scope) {
    return this.devices.filter((d) => d[scope]);
  }

  async setVolume(uid, scope, value) {
    const channel = this.find(uid)?.[scope];
    if (channel) {
      channel.volume = value;
      this.localUntil.set(`${uid}/${scope}`, Date.now() + LOCAL_WINS_MS);
      this.emit("change");
    }
    await this.request({ cmd: "setVolume", uid, scope, value });
  }

  async setMute(uid, scope, muted) {
    await this.request({ cmd: "setMute", uid, scope, muted });
  }

  async setDefault(uid, scope) {
    await this.request({ cmd: "setDefault", uid, scope });
  }

  findApp(id) {
    return this.apps.find((a) => a.id === id);
  }

  appLevel(id) {
    return this.appLevels[id] || { volume: 1, muted: false };
  }

  /** Восстанавливает сохранённые уровни приложений (из глобальных настроек плагина). */
  loadAppLevels(levels) {
    this.appLevels = { ...levels };
    for (const id of Object.keys(this.appLevels)) this.sendAppLevel(id);
    this.emit("change");
  }

  async setAppLevel(id, patch) {
    this.appLevels[id] = { ...this.appLevel(id), ...patch };
    this.emit("change");
    this.emit("appLevels", this.appLevels);
    await this.sendAppLevel(id);
  }

  sendAppLevel(id) {
    const { volume, muted } = this.appLevel(id);
    return this.request({ cmd: "setApp", app: id, volume, muted }).catch((e) =>
      log.warn("setApp failed", id, e.message));
  }
}

module.exports = { Audio };
