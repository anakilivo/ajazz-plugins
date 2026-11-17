"use strict";

// Переключение устройства по умолчанию.
//  - Клавиша: нажатие — следующее устройство из списка.
//  - Крутилка: поворот листает устройства (предпросмотр), нажатие — применить.
// Настройки: scope ("output" | "input"), devices (список UID; пустой = все).

const render = require("../render");
const { createPressGuard, handlePiMessage, paint, forget } = require("./common");

const KEY_UUID = "com.anakilivo.streamdock.mixer.device-key";
const KNOB_UUID = "com.anakilivo.streamdock.mixer.device-knob";
const DEFAULTS = { scope: "output", devices: [] };
const PREVIEW_MS = 4000;

module.exports = function registerDevice(sd, audio) {
  const contexts = new Map(); // context -> { settings, onKey, preview, timer }
  const isPress = createPressGuard();

  function candidates(settings) {
    const all = audio.list(settings.scope);
    if (!settings.devices?.length) return all;
    // Порядок — как выбрал пользователь; отключённые устройства пропускаем.
    return settings.devices.map((uid) => all.find((d) => d.uid === uid)).filter(Boolean);
  }

  function currentIndex(list, scope) {
    return list.findIndex((d) => d[scope].isDefault);
  }

  function draw(context) {
    const state = contexts.get(context);
    const { scope } = state.settings;
    const list = candidates(state.settings);
    const index = state.preview ?? currentIndex(list, scope);
    const shown = list[index] || audio.defaultDevice(scope);
    paint(sd, audio, context, render.device({
      scope,
      name: shown?.name,
      index: Math.max(index, 0),
      total: list.length,
      preview: state.preview != null,
      onKey: state.onKey,
    }));
  }

  audio.on("change", () => contexts.forEach((_, c) => draw(c)));

  function endPreview(context) {
    const state = contexts.get(context);
    if (!state) return;
    clearTimeout(state.timer);
    state.preview = null;
    draw(context);
  }

  async function apply(context, device) {
    const { scope } = contexts.get(context).settings;
    try {
      await audio.setDefault(device.uid, scope);
    } catch {
      sd.showAlert(context);
    }
  }

  function make(onKey) {
    return {
      willAppear({ context, payload }) {
        contexts.set(context, { settings: { ...DEFAULTS, ...payload.settings }, onKey, preview: null });
        draw(context);
      },
      didReceiveSettings({ context, payload }) {
        const state = contexts.get(context);
        if (!state) return;
        state.settings = { ...DEFAULTS, ...payload.settings };
        endPreview(context);
      },
      willDisappear({ context }) {
        clearTimeout(contexts.get(context)?.timer);
        contexts.delete(context);
        forget(context);
      },
      sendToPlugin: (msg) => handlePiMessage(sd, audio, onKey ? KEY_UUID : KNOB_UUID, msg),
    };
  }

  sd.register(KEY_UUID, {
    ...make(true),
    keyDown({ context }) {
      const { settings } = contexts.get(context);
      const list = candidates(settings);
      if (list.length < 2) return sd.showAlert(context);
      const next = list[(currentIndex(list, settings.scope) + 1) % list.length];
      return apply(context, next);
    },
  });

  async function knobPress({ context }) {
    if (!isPress(context)) return;
    const state = contexts.get(context);
    if (state.preview == null) return;
    const device = candidates(state.settings)[state.preview];
    endPreview(context);
    if (device && !device[state.settings.scope].isDefault) await apply(context, device);
  }

  sd.register(KNOB_UUID, {
    ...make(false),
    dialRotate({ context, payload }) {
      const state = contexts.get(context);
      const list = candidates(state.settings);
      const ticks = payload?.ticks || 0;
      if (!list.length || !ticks) return;
      const from = state.preview ?? Math.max(currentIndex(list, state.settings.scope), 0);
      state.preview = (((from + ticks) % list.length) + list.length) % list.length;
      clearTimeout(state.timer);
      state.timer = setTimeout(() => endPreview(context), PREVIEW_MS);
      draw(context);
    },
    dialDown: knobPress,
    keyDown: knobPress,
  });
};
