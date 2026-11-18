"use strict";

// Уровни частотных полос звука Яндекс Музыки для волны. Нативный помощник
// (bin/spectrum-helper-*) перехватывает звук приложения и ~30 раз в секунду пишет
// {"bands":[0..100,…]}; здесь — запуск помощника, пока волна видна, и сглаживание:
// быстрый подъём, плавный спад, «пики» для эквалайзера.

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { log } = require("./sdk");

const BANDS = 24;
const BUNDLE_ID = "ru.yandex.desktop.music";
const HELPERS = {
  darwin: "spectrum-helper-mac",
  win32: "spectrum-helper-win.exe",
};

class Spectrum {
  constructor() {
    this.users = new Set();
    this.child = null;
    this.restartTimer = null;
    this.failures = 0;
    this.target = new Float32Array(BANDS);
    this.level = new Float32Array(BANDS);
    this.peak = new Float32Array(BANDS);
    this.lastBandsAt = 0;
    this.error = null;
  }

  get helperPath() {
    const name = HELPERS[process.platform];
    return name && path.join(__dirname, "..", "bin", name);
  }

  get available() {
    return Boolean(this.helperPath && fs.existsSync(this.helperPath));
  }

  /** Звук сейчас идёт (помощник присылал полосы последние полсекунды). */
  get active() {
    return Date.now() - this.lastBandsAt < 500;
  }

  retain(context) {
    this.users.add(context);
    if (!this.child && !this.restartTimer) this.start();
  }

  release(context) {
    this.users.delete(context);
    if (this.users.size) return;
    clearTimeout(this.restartTimer);
    this.restartTimer = null;
    this.child?.kill();
  }

  start() {
    this.restartTimer = null;
    if (!this.available || !this.users.size) return;
    const child = spawn(this.helperPath, [BUNDLE_ID, String(BANDS)], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    this.child = child;
    readline.createInterface({ input: child.stdout }).on("line", (line) => this.onLine(line));
    readline.createInterface({ input: child.stderr }).on("line", (line) => log.warn("spectrum helper:", line));
    child.on("error", (e) => log.warn("spectrum helper failed", e.message));
    child.on("exit", (code) => {
      if (this.child !== child) return;
      this.child = null;
      this.target.fill(0);
      if (!this.users.size) return;
      // Упал сам — перезапускаем с нарастающей паузой.
      const wait = Math.min(30_000, 1000 * 2 ** this.failures++);
      log.warn(`spectrum helper exited (${code}), restart in ${wait} ms`);
      this.restartTimer = setTimeout(() => this.start(), wait);
    });
  }

  onLine(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (Array.isArray(msg.bands)) {
      for (let i = 0; i < BANDS; i++) this.target[i] = (msg.bands[i] || 0) / 100;
      this.lastBandsAt = Date.now();
      this.failures = 0;
      this.error = null;
    } else if (msg.status) {
      this.target.fill(0);
      this.error = msg.status === "error" ? msg.error : null;
      if (this.error) log.warn("spectrum:", this.error);
    }
  }

  /** Следующий кадр сглаженных уровней (вызывать с частотой отрисовки). */
  frame() {
    const live = this.active;
    for (let i = 0; i < BANDS; i++) {
      const target = live ? this.target[i] : 0;
      const level = this.level[i];
      this.level[i] = target > level ? level + (target - level) * 0.75 : level + (target - level) * 0.25;
      this.peak[i] = Math.max(this.level[i], this.peak[i] - 0.025);
    }
    return { level: this.level, peak: this.peak };
  }

  /** Есть что рисовать: звук идёт или волна ещё не затухла. */
  get moving() {
    return this.active || this.level.some((v) => v > 0.01) || this.peak.some((v) => v > 0.01);
  }
}

module.exports = { Spectrum, BANDS };
