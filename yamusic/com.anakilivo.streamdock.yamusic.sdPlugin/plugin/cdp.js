"use strict";

// Минимальный клиент Chrome DevTools Protocol: страница Яндекс Музыки
// (приложение запущено с --remote-debugging-port).

const { EventEmitter } = require("events");
const WebSocket = require("ws");

/** Страница плеера среди целей отладки: music-application://desktop/… */
function isMusicPage(target) {
  if (target?.type !== "page") return false;
  try {
    const url = new URL(target.url);
    return url.protocol === "music-application:" || /^music\.yandex\.[a-z]+$/i.test(url.hostname);
  } catch {
    return false;
  }
}

async function findPage(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000) });
  return (await res.json()).find(isMusicPage) || null;
}

class Cdp extends EventEmitter {
  constructor(url) {
    super();
    this.nextId = 1;
    this.pending = new Map();
    this.ws = new WebSocket(url, { perMessageDeflate: false });
    this.ws.on("message", (raw) => this.onMessage(raw));
    this.ws.on("close", () => {
      for (const { reject } of this.pending.values()) reject(new Error("CDP closed"));
      this.pending.clear();
      this.emit("close");
    });
    this.ws.on("error", () => {}); // за ним всегда следует close
  }

  opened() {
    return new Promise((resolve, reject) => {
      this.ws.once("open", resolve);
      this.ws.once("close", () => reject(new Error("CDP closed")));
    });
  }

  onMessage(raw) {
    const msg = JSON.parse(raw.toString());
    if (msg.id === undefined) return this.emit(msg.method, msg.params);
    const call = this.pending.get(msg.id);
    if (!call) return;
    this.pending.delete(msg.id);
    if (msg.error) call.reject(new Error(msg.error.message));
    else call.resolve(msg.result);
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      if (this.ws.readyState !== WebSocket.OPEN) return reject(new Error("CDP closed"));
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Выполняет выражение на странице и возвращает значение. */
  async evaluate(expression) {
    const { result, exceptionDetails } = await this.send("Runtime.evaluate", {
      expression, returnByValue: true, awaitPromise: true,
    });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || exceptionDetails.text);
    return result.value;
  }

  close() {
    this.ws.close();
  }
}

module.exports = { Cdp, findPage };
