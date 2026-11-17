"use strict";

// Минимальная обёртка над WebSocket-протоколом Stream Dock (совместим с Elgato SDK).
// Stream Dock запускает плагин с аргументами: -port N -pluginUUID X -registerEvent Y -info JSON

const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length - 1; i++) {
    if (argv[i].startsWith("-")) args[argv[i].slice(1)] = argv[++i];
  }
  return args;
}

const LOG_DIR = path.join(__dirname, "..", "log");
fs.mkdirSync(LOG_DIR, { recursive: true });
const logFile = path.join(LOG_DIR, `${new Date().toISOString().slice(0, 10)}.log`);

function write(level, args) {
  const text = args
    .map((a) => (a instanceof Error ? a.stack : typeof a === "string" ? a : JSON.stringify(a)))
    .join(" ");
  const line = `[${new Date().toISOString()}] ${level} ${text}\n`;
  fs.appendFile(logFile, line, () => {});
  if (process.stdout.isTTY) process.stdout.write(line);
}

const log = {
  info: (...a) => write("INFO", a),
  warn: (...a) => write("WARN", a),
  error: (...a) => write("ERROR", a),
};

process.on("uncaughtException", (e) => log.error("uncaughtException", e));
process.on("unhandledRejection", (e) => log.error("unhandledRejection", e));

class StreamDock {
  constructor() {
    this.args = parseArgs(process.argv);
    this.info = JSON.parse(this.args.info || "{}");
    this.actions = new Map();
    this.ws = new WebSocket(`ws://127.0.0.1:${this.args.port}`);

    this.ws.on("open", () => {
      log.info("connected, port", this.args.port);
      this.ws.send(JSON.stringify({ event: this.args.registerEvent, uuid: this.args.pluginUUID }));
      this.send("getGlobalSettings", this.args.pluginUUID);
    });
    this.ws.on("close", () => {
      log.info("socket closed, exiting");
      process.exit(0);
    });
    this.ws.on("error", (e) => log.error("socket error", e));
    this.ws.on("message", (raw) => this.dispatch(raw));
  }

  /** Регистрирует обработчики событий для action UUID. */
  register(uuid, handlers) {
    this.actions.set(uuid, handlers);
  }

  dispatch(raw) {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (e) {
      return log.error("bad message", raw.toString());
    }
    if (msg.event === "didReceiveGlobalSettings") {
      return this.onGlobalSettings?.(msg.payload?.settings || {});
    }
    const handler = this.actions.get(msg.action)?.[msg.event];
    if (!handler) return;
    Promise.resolve()
      .then(() => handler(msg))
      .catch((e) => log.error(`${msg.event} failed`, e));
  }

  send(event, context, payload) {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ event, context, payload }));
  }

  setImage(context, image) {
    this.send("setImage", context, { target: 0, image });
  }

  setTitle(context, title) {
    this.send("setTitle", context, { target: 0, title });
  }

  setSettings(context, settings) {
    this.send("setSettings", context, settings);
  }

  setGlobalSettings(settings) {
    this.send("setGlobalSettings", this.args.pluginUUID, settings);
  }

  showAlert(context) {
    this.send("showAlert", context);
  }

  sendToPropertyInspector(action, context, payload) {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ event: "sendToPropertyInspector", action, context, payload }));
  }
}

module.exports = { StreamDock, log };
