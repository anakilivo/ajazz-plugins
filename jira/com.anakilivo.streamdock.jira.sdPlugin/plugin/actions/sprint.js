"use strict";

// Клавиша «Мой спринт»: сколько моих тикетов в открытых спринтах ещё не сделано и из скольких.
// Нажатие открывает этот список в Jira.

const render = require("../render");
const { paint, forget, handlePiMessage } = require("./common");

const UUID = "com.anakilivo.streamdock.jira.sprint";

module.exports = function registerSprint(sd, jira) {
  const contexts = new Set();

  function draw(context) {
    const { status, error, items, total, done } = jira.state;
    paint(sd, context, render.sprint({ status, open: items.length, total, done, stale: Boolean(error) }));
  }

  jira.on("change", () => contexts.forEach(draw));

  sd.register(UUID, {
    willAppear({ context }) {
      contexts.add(context);
      jira.retain();
      draw(context);
    },
    willDisappear({ context }) {
      if (contexts.delete(context)) jira.release();
      forget(context);
    },
    keyDown() {
      if (jira.settings.site) sd.openUrl(jira.searchUrl());
      jira.refresh();
    },
    sendToPlugin: (msg) => handlePiMessage(sd, jira, UUID, msg),
  });
};
