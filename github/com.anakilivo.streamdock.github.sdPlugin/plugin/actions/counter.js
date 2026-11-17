"use strict";

// Клавиши-счётчики: «На ревью» (PR, где запрошено моё ревью) и «Мои PR» (со статусом CI).
// Нажатие открывает список на github.com, а если PR ровно один — сразу его.

const render = require("../render");
const { paint, forget, handlePiMessage, forgetInspector } = require("./common");

const KINDS = {
  review: {
    uuid: "com.anakilivo.streamdock.github.review",
    url: "https://github.com/pulls/review-requested",
  },
  mine: {
    uuid: "com.anakilivo.streamdock.github.mine",
    url: "https://github.com/pulls",
  },
};

module.exports = function registerCounters(sd, github) {
  for (const [kind, { uuid, url }] of Object.entries(KINDS)) {
    const contexts = new Set();

    const draw = (context) => {
      const { status, error } = github.state;
      const data = github.state[kind];
      paint(sd, context, render.counter({ kind, status, count: data.count, ci: data.ci, stale: Boolean(error) }));
    };

    github.on("change", () => contexts.forEach(draw));

    sd.register(uuid, {
      willAppear({ context }) {
        contexts.add(context);
        github.retain(context);
        draw(context);
      },
      willDisappear({ context }) {
        contexts.delete(context);
        github.release(context);
        forget(context);
        forgetInspector(context);
      },
      keyDown() {
        const { items, count } = github.state[kind];
        sd.openUrl(count === 1 && items[0] ? items[0].url : url);
        // Открыли — заодно обновим, вдруг что-то уже поменялось.
        github.refresh();
      },
      sendToPlugin: (msg) => handlePiMessage(sd, github, uuid, msg),
    });
  }
};
