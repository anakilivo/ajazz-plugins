"use strict";

// Связь с Яндекс Музыкой для всех действий. Пока на устройстве есть хоть одно действие
// плагина, держим CDP-соединение со страницей плеера; скрипт на странице (page.js)
// сам присылает состояние при изменениях. Эмитит "change".
//
// status: connecting | closed (Музыка не запущена) | nodebug (запущена без отладочного порта) | ok

const { EventEmitter } = require("events");
const { Cdp, findPage } = require("./cdp");
const launcher = require("./launcher");
const PAGE = require("./page");
const { log } = require("./sdk");

const RETRY_MS = 2000;
const BINDING = "ymDockNotify";

const EMPTY_TRACK = {
  ready: false, title: "", artist: "", album: "", cover: null, url: null,
  playing: false, position: null, duration: null,
  liked: null, disliked: null, shuffle: null, repeat: null,
};

class Music extends EventEmitter {
  constructor() {
    super();
    this.port = 9222;
    this.state = { status: "connecting", ...EMPTY_TRACK };
    this.positionAt = Date.now();
    this.users = new Set();
    this.cdp = null;
    this.retryTimer = null;
    this.connecting = false;
  }

  retain(context) {
    this.users.add(context);
    if (!this.cdp && !this.connecting) this.connect();
  }

  release(context) {
    this.users.delete(context);
    if (this.users.size) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.cdp?.close();
  }

  setPort(port) {
    port = Number(port);
    if (!Number.isInteger(port) || port < 1 || port > 65535 || port === this.port) return;
    this.port = port;
    this.cdp?.close(); // переподключимся по close
    if (!this.cdp && this.users.size) this.connect();
  }

  scheduleRetry() {
    clearTimeout(this.retryTimer);
    if (this.users.size) this.retryTimer = setTimeout(() => this.connect(), RETRY_MS);
  }

  async connect() {
    if (this.connecting || this.cdp || !this.users.size) return;
    this.connecting = true;
    try {
      const page = await findPage(this.port).catch(() => null);
      if (!page) {
        const app = await launcher.appState(this.port);
        this.set({ status: app === "running" ? "connecting" : app, ...EMPTY_TRACK });
        return this.scheduleRetry();
      }

      const cdp = new Cdp(page.webSocketDebuggerUrl);
      await cdp.opened();
      cdp.on("Runtime.bindingCalled", ({ name, payload }) => {
        if (name === BINDING) this.onPageState(JSON.parse(payload));
      });
      cdp.on("close", () => {
        if (this.cdp !== cdp) return;
        this.cdp = null;
        log.info("CDP disconnected");
        this.set({ status: "connecting" });
        this.scheduleRetry();
      });
      await cdp.send("Runtime.enable");
      await cdp.send("Runtime.addBinding", { name: BINDING });
      // После перезагрузки страницы скрипт поставится сам.
      await cdp.send("Page.enable");
      await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: PAGE });
      await cdp.evaluate(PAGE);
      this.cdp = cdp;
      log.info("connected to Yandex Music on port", this.port);
    } catch (e) {
      log.warn("connect failed", e.message);
      this.scheduleRetry();
    } finally {
      this.connecting = false;
    }
  }

  onPageState(page) {
    this.positionAt = Date.now();
    this.set({ status: "ok", ...page });
  }

  /** Позиция с учётом времени, прошедшего с последнего обновления. */
  position() {
    const { position, duration, playing } = this.state;
    if (position === null) return null;
    const now = playing ? position + (Date.now() - this.positionAt) / 1000 : position;
    return Math.min(duration || now, now);
  }

  /** Команда плееру. Состояние сразу меняем оптимистично, страница потом подтвердит. */
  async act(name, arg) {
    if (!this.cdp) {
      if (this.state.status === "closed" || this.state.status === "nodebug") return this.launch();
      return false;
    }
    const optimistic = {
      playPause: () => ({ playing: !this.state.playing }),
      like: () => ({ liked: !this.state.liked, disliked: false }),
      seek: () => {
        const position = Math.max(0, Math.min(this.state.duration || 0, this.position() + arg));
        this.positionAt = Date.now();
        return { position };
      },
    }[name];
    if (optimistic && this.state.ready) this.set(optimistic());
    try {
      return await this.cdp.evaluate(`window.__ymDock?.act(${JSON.stringify(name)}, ${JSON.stringify(arg ?? null)})`);
    } catch (e) {
      log.warn("action failed", name, e.message);
      return false;
    }
  }

  async launch() {
    try {
      this.set({ status: "connecting" });
      await launcher.launch(this.port);
      this.scheduleRetry();
      return true;
    } catch (e) {
      log.warn("launch failed", e.message);
      this.set({ status: "closed" });
      return false;
    }
  }

  set(patch) {
    this.state = { ...this.state, ...patch };
    this.emit("change");
  }
}

module.exports = { Music };
