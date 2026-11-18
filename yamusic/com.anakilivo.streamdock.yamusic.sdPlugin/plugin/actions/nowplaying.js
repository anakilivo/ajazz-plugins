"use strict";

// Крутилка «Сейчас играет»: на полосе — обложка, трек, волна и прогресс.
// Поворот — перемотка, нажатие крутилки — пауза/играть, касание экрана — лайк.
// Музыка закрыта или без отладочного порта — нажатие/касание запускает её.
// Настройки: style (bars | mirror | glow | none), colors ("cover" | css-цвет),
// text (full | title | none), step — секунд перемотки на щелчок.

const render = require("../render");
const { paint, forget, createPressClassifier, handlePiMessage } = require("./common");

const UUID = "com.anakilivo.streamdock.yamusic.nowplaying";
const DEFAULTS = { style: "bars", colors: "cover", text: "full", step: 5 };
const FPS = 20;
const SEEK_DEBOUNCE_MS = 150;

module.exports = function registerNowPlaying(sd, music, spectrum) {
  const contexts = new Map(); // context -> { settings, seek: { delta, timer }, painting, dirty, drawnAt }

  const wantsWave = (state) => state.settings.style !== "none";

  function updateSpectrum(context) {
    const state = contexts.get(context);
    if (state && wantsWave(state)) spectrum.retain(context);
    else spectrum.release(context);
  }

  async function draw(context, frame) {
    const state = contexts.get(context);
    if (!state) return;
    // Предыдущий кадр ещё рисуется — нарисуем ещё раз сразу после него.
    if (state.painting) {
      state.dirty = true;
      return;
    }
    state.painting = true;
    state.dirty = false;
    state.drawnAt = Date.now();
    try {
      // Пока крутят, показываем позицию с учётом ещё не отправленной перемотки.
      const position = music.position() === null ? null
        : Math.max(0, Math.min(music.state.duration || Infinity, music.position() + state.seek.delta));
      const image = render.nowPlaying({ ...music.state, position }, music.cover,
        wantsWave(state) ? frame : null, state.settings);
      await paint(sd, context, image);
    } finally {
      state.painting = false;
    }
    if (state.dirty) draw(context, frame);
  }

  // Один таймер на все крутилки: пока волна движется — 20 кадров в секунду,
  // иначе — раз в секунду (время трека) и сразу при изменениях (music "change").
  let frame = spectrum.frame();
  setInterval(() => {
    if (!contexts.size) return;
    const animating = music.state.status === "ok" && spectrum.moving;
    if (animating) frame = spectrum.frame();
    for (const [context, state] of contexts) {
      if ((animating && wantsWave(state)) || Date.now() - state.drawnAt >= 1000) draw(context, frame);
    }
  }, 1000 / FPS);

  music.on("change", () => contexts.forEach((_, c) => draw(c, frame)));

  function setSettings({ context, payload }) {
    const settings = { ...DEFAULTS, ...payload.settings };
    const state = contexts.get(context);
    if (state) state.settings = settings;
    else {
      contexts.set(context, { settings, seek: { delta: 0, timer: null }, painting: false, dirty: false, drawnAt: 0 });
      music.retain(context);
    }
    updateSpectrum(context);
    draw(context, frame);
  }

  // Не играет — нажатие запускает Музыку (music.act сам решает).
  const presses = createPressClassifier({
    onKnob: () => music.act("playPause"),
    onTouch: () => music.act("like"),
  });

  sd.register(UUID, {
    willAppear: setSettings,
    didReceiveSettings: setSettings,
    willDisappear({ context }) {
      const state = contexts.get(context);
      if (state) clearTimeout(state.seek.timer);
      contexts.delete(context);
      music.release(context);
      spectrum.release(context);
      forget(context);
    },
    dialRotate(msg) {
      // Поворот, пришедший вместе с нажатием, — не перемотка.
      if (presses.dialRotate(msg)) return;
      const state = contexts.get(msg.context);
      const ticks = msg.payload?.ticks || 0;
      if (!state || !ticks || music.state.status !== "ok") return;
      // Быстрые щелчки копим и перематываем одним шагом.
      const { seek } = state;
      seek.delta += ticks * (Number(state.settings.step) || DEFAULTS.step);
      draw(msg.context, frame);
      clearTimeout(seek.timer);
      seek.timer = setTimeout(() => {
        const delta = seek.delta;
        seek.delta = 0;
        music.act("seek", delta);
      }, SEEK_DEBOUNCE_MS);
    },
    dialDown: presses.dialDown,
    dialUp: presses.dialUp,
    sendToPlugin: (msg) => handlePiMessage(sd, music, UUID, msg),
  });
};
