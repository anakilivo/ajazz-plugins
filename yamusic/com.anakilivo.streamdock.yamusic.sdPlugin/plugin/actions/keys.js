"use strict";

// Клавиши плеера: обложка (с прогрессом, нажатие — пауза/играть), пауза/играть,
// следующий/предыдущий, лайк, дизлайк, вперемешку, повтор. Каждая показывает текущее состояние.
// Музыка закрыта или без отладочного порта — нажатие запускает её (music.act сам решает).

const render = require("../render");
const { paint, forget, handlePiMessage } = require("./common");

const PREFIX = "com.anakilivo.streamdock.yamusic.";
const KEYS = {
  cover: "playPause",
  playpause: "playPause",
  next: "next",
  previous: "previous",
  like: "like",
  dislike: "dislike",
  shuffle: "shuffle",
  repeat: "repeat",
};

module.exports = function registerKeys(sd, music) {
  const contexts = new Map(); // context -> key

  function image(key) {
    if (key === "cover") return render.coverKey({ ...music.state, position: music.position() }, music.cover);
    return render.controlKey(KEYS[key], music.state);
  }

  const draw = (context) => paint(sd, context, image(contexts.get(context)));

  music.on("change", () => contexts.forEach((_, c) => draw(c)));
  // Прогресс на обложке.
  setInterval(() => {
    if (!music.state.playing) return;
    for (const [context, key] of contexts) if (key === "cover") draw(context);
  }, 1000);

  for (const [key, action] of Object.entries(KEYS)) {
    const uuid = PREFIX + key;
    sd.register(uuid, {
      willAppear({ context }) {
        contexts.set(context, key);
        music.retain(context);
        draw(context);
      },
      willDisappear({ context }) {
        contexts.delete(context);
        music.release(context);
        forget(context);
      },
      keyDown() {
        music.act(action);
      },
      sendToPlugin: (msg) => handlePiMessage(sd, music, uuid, msg),
    });
  }
};
