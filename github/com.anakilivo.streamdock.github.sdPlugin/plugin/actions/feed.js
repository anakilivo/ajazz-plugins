"use strict";

// Лента PR на крутилке: поворот листает PR на полосе, касание экрана открывает выбранный.
// Нажатие крутилки на списке «на ревью» — «посмотрел»: PR скрывается до новых коммитов;
// на списке «мои PR» — тоже открывает PR.
// Настройки: source ("review" | "mine").
// Позицию запоминаем по URL, чтобы после обновления списка остаться на том же PR.

const render = require("../render");
const { paint, forget, createPressClassifier, handlePiMessage, forgetInspector } = require("./common");

const UUID = "com.anakilivo.streamdock.github.feed";
const DEFAULTS = { source: "review" };
const LIST_URLS = { review: "https://github.com/pulls/review-requested", mine: "https://github.com/pulls" };

module.exports = function registerFeed(sd, github) {
  const contexts = new Map(); // context -> { settings, url }

  function position(state) {
    const { items } = github.state[state.settings.source];
    const index = items.findIndex((i) => i.url === state.url);
    return { items, index: index >= 0 ? index : 0 };
  }

  function draw(context) {
    const state = contexts.get(context);
    const { items, index } = position(state);
    state.url = items[index]?.url;
    paint(sd, context, render.feed({
      kind: state.settings.source,
      status: github.state.status,
      item: items[index],
      index,
      total: items.length,
    }));
  }

  github.on("change", () => contexts.forEach((_, c) => draw(c)));

  function setSettings({ context, payload }) {
    const state = contexts.get(context);
    const settings = { ...DEFAULTS, ...payload.settings };
    if (state) {
      if (state.settings.source !== settings.source) state.url = null;
      state.settings = settings;
    } else {
      contexts.set(context, { settings, url: null });
      github.retain(context);
    }
    draw(context);
  }

  function open({ context }) {
    const state = contexts.get(context);
    if (!state) return;
    const { items, index } = position(state);
    sd.openUrl(items[index]?.url || LIST_URLS[state.settings.source]);
  }

  function knobPress(msg) {
    const { context } = msg;
    const state = contexts.get(context);
    if (!state) return;
    if (state.settings.source !== "review") return open(msg);

    const { items, index } = position(state);
    const item = items[index];
    if (!item) return sd.showAlert(context);
    // Остаёмся на той же позиции — там окажется следующий PR.
    state.url = (items[index + 1] || items[index - 1])?.url || null;
    github.dismiss(item);
  }

  const presses = createPressClassifier({ onKnob: knobPress, onTouch: open });

  sd.register(UUID, {
    willAppear: setSettings,
    didReceiveSettings: setSettings,
    willDisappear({ context }) {
      contexts.delete(context);
      github.release(context);
      forget(context);
      forgetInspector(context);
    },
    dialRotate(msg) {
      // Поворот, пришедший вместе с нажатием, — не листание.
      if (presses.dialRotate(msg)) return;
      const { context, payload } = msg;
      const state = contexts.get(context);
      if (!state) return;
      github.refreshIfStale();
      const { items, index } = position(state);
      const ticks = payload?.ticks || 0;
      if (!items.length || !ticks) return;
      const next = Math.min(items.length - 1, Math.max(0, index + ticks));
      state.url = items[next].url;
      draw(context);
    },
    dialDown: presses.dialDown,
    dialUp: presses.dialUp,
    touchTap: open,
    sendToPlugin: (msg) => handlePiMessage(sd, github, UUID, msg),
  });
};
