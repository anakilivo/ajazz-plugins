"use strict";

// Лента тикетов спринта на крутилке: поворот листает незакрытые тикеты,
// нажатие крутилки или касание экрана открывает выбранный в браузере.
// Позицию запоминаем по ключу тикета, чтобы после обновления остаться на нём.

const render = require("../render");
const { paint, forget, handlePiMessage } = require("./common");

const UUID = "com.anakilivo.streamdock.jira.feed";

module.exports = function registerFeed(sd, jira) {
  const contexts = new Map(); // context -> { key }

  function position(state) {
    const { items } = jira.state;
    const index = items.findIndex((i) => i.key === state.key);
    return { items, index: index >= 0 ? index : 0 };
  }

  function draw(context) {
    const state = contexts.get(context);
    const { items, index } = position(state);
    state.key = items[index]?.key;
    paint(sd, context, render.feed({ status: jira.state.status, item: items[index], index, total: items.length }));
  }

  jira.on("change", () => contexts.forEach((_, c) => draw(c)));

  function open({ context }) {
    const state = contexts.get(context);
    if (!state) return;
    const { items, index } = position(state);
    const url = items[index]?.url || (jira.settings.site && jira.searchUrl());
    if (url) sd.openUrl(url);
  }

  sd.register(UUID, {
    willAppear({ context }) {
      if (!contexts.has(context)) {
        contexts.set(context, { key: null });
        jira.retain();
      }
      draw(context);
    },
    willDisappear({ context }) {
      if (contexts.delete(context)) jira.release();
      forget(context);
    },
    dialRotate({ context, payload }) {
      // При нажатии крутилки AKP05E Pro присылает ещё и «поворот» с pressed: true — это не поворот.
      if (payload?.pressed) return;
      const state = contexts.get(context);
      const { items, index } = position(state);
      const ticks = payload?.ticks || 0;
      if (!items.length || !ticks) return;
      state.key = items[Math.min(items.length - 1, Math.max(0, index + ticks))].key;
      draw(context);
    },
    // И нажатие крутилки, и касание экрана приходят как dialDown — оба открывают тикет.
    dialDown: open,
    sendToPlugin: (msg) => handlePiMessage(sd, jira, UUID, msg),
  });
};
