"use strict";

// Канал микшера на крутилке: поворот — громкость, нажатие — mute.
// Настройки: scope ("output" | "input"), device (UID или "" = системное по умолчанию),
// step (шаг в %), label (своё имя на полосе).

const render = require("../render");
const { createPressGuard, handlePiMessage, paint, forget } = require("./common");

const UUID = "com.anakilivo.streamdock.mixer.channel";
const DEFAULTS = { scope: "output", device: "", step: 2, label: "" };

module.exports = function registerChannel(sd, audio) {
  const contexts = new Map();
  // Для устройств без аппаратного mute глушим через громкость 0 и помним прежнюю.
  const softMuted = new Map();
  const isPress = createPressGuard();

  function resolve(settings) {
    const device = settings.device ? audio.find(settings.device) : audio.defaultDevice(settings.scope);
    return device?.[settings.scope] ? device : null;
  }

  function draw(context) {
    const settings = contexts.get(context);
    const device = resolve(settings);
    const ch = device?.[settings.scope];
    const key = device && `${device.uid}/${settings.scope}`;
    paint(sd, audio, context, render.channel({
      scope: settings.scope,
      name: settings.label || device?.name || "Устройство отключено",
      volume: ch?.volume ?? null,
      muted: Boolean(ch?.muted) || softMuted.has(key),
      missing: !device,
    }));
  }

  audio.on("change", () => contexts.forEach((_, c) => draw(c)));

  function setSettings({ context, payload }) {
    contexts.set(context, { ...DEFAULTS, ...payload.settings });
    draw(context);
  }

  async function rotate(context, ticks) {
    const settings = contexts.get(context);
    const device = resolve(settings);
    const ch = device?.[settings.scope];
    if (!ch || ch.volume == null || !ticks) return sd.showAlert(context);

    const key = `${device.uid}/${settings.scope}`;
    const step = Number(settings.step) || DEFAULTS.step;
    // Округляем к сетке шага, чтобы значения были "ровными".
    const current = Math.round((ch.volume * 100) / step) * step;
    const next = Math.min(100, Math.max(0, current + ticks * step)) / 100;

    // Поворот снимает программный mute.
    softMuted.delete(key);
    if (ch.muted && ticks > 0) await audio.setMute(device.uid, settings.scope, false).catch(() => {});
    await audio.setVolume(device.uid, settings.scope, next);
  }

  async function toggleMute(context) {
    const settings = contexts.get(context);
    const device = resolve(settings);
    const ch = device?.[settings.scope];
    if (!ch) return sd.showAlert(context);

    const key = `${device.uid}/${settings.scope}`;
    if (ch.muted != null) return audio.setMute(device.uid, settings.scope, !ch.muted);
    if (ch.volume == null) return sd.showAlert(context);

    if (softMuted.has(key)) {
      const restore = softMuted.get(key);
      softMuted.delete(key);
      await audio.setVolume(device.uid, settings.scope, restore);
    } else {
      softMuted.set(key, ch.volume);
      await audio.setVolume(device.uid, settings.scope, 0);
    }
  }

  async function press({ context }) {
    if (!isPress(context)) return;
    try {
      await toggleMute(context);
    } catch {
      sd.showAlert(context);
    }
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
    // Некоторые прошивки присылают нажатие крутилки как keyDown.
    keyDown: press,
    sendToPlugin: (msg) => handlePiMessage(sd, audio, UUID, msg),
  });
};
