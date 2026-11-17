"use strict";

// Громкость отдельного приложения на крутилке: поворот — громкость, нажатие — mute.
// Настройки: app (bundle id), appName (имя на случай, если приложение не запущено),
// step (шаг в %), label (своё имя на полосе).
// Уровень хранится не в настройках действия, а в audio.appLevels: одно приложение
// может стоять на нескольких крутилках/профилях, и все они показывают одно значение.

const render = require("../render");
const { createPressGuard, handlePiMessage, paint, forget } = require("./common");

const UUID = "com.anakilivo.streamdock.mixer.app";
const DEFAULTS = { app: "", appName: "", step: 2, label: "" };

module.exports = function registerApp(sd, audio) {
  const contexts = new Map();
  const isPress = createPressGuard();

  function draw(context) {
    const settings = contexts.get(context);
    const running = audio.findApp(settings.app);
    const level = audio.appLevel(settings.app);
    paint(sd, audio, context, render.app({
      name: settings.label || running?.name || settings.appName || "Приложение",
      icon: running?.icon,
      volume: level.volume,
      muted: level.muted,
      running: Boolean(running),
      unset: !settings.app,
    }));
  }

  audio.on("change", () => contexts.forEach((_, c) => draw(c)));

  function setSettings({ context, payload }) {
    contexts.set(context, { ...DEFAULTS, ...payload.settings });
    draw(context);
  }

  async function rotate(context, ticks) {
    const settings = contexts.get(context);
    if (!settings.app || !ticks) return sd.showAlert(context);

    const level = audio.appLevel(settings.app);
    const step = Number(settings.step) || DEFAULTS.step;
    const current = Math.round((level.volume * 100) / step) * step;
    const volume = Math.min(100, Math.max(0, current + ticks * step)) / 100;
    // Прибавление громкости снимает mute, как и у каналов устройств.
    const muted = ticks > 0 ? false : level.muted;
    await audio.setAppLevel(settings.app, { volume, muted, name: settings.appName });
  }

  async function press({ context }) {
    if (!isPress(context)) return;
    const settings = contexts.get(context);
    if (!settings.app) return sd.showAlert(context);
    const level = audio.appLevel(settings.app);
    await audio.setAppLevel(settings.app, { muted: !level.muted, name: settings.appName });
  }

  sd.register(UUID, {
    willAppear: setSettings,
    didReceiveSettings: setSettings,
    willDisappear: ({ context }) => {
      contexts.delete(context);
      forget(context);
    },
    dialRotate: ({ context, payload }) => {
      // При нажатии крутилки AKP05E Pro присылает ещё и «поворот» с pressed: true — это не поворот.
      if (payload?.pressed) return;
      return rotate(context, payload?.ticks || 0).catch(() => sd.showAlert(context));
    },
    dialDown: press,
    keyDown: press,
    sendToPlugin: (msg) => handlePiMessage(sd, audio, UUID, msg),
  });
};
