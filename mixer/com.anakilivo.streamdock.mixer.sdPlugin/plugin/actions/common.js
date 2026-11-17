"use strict";

/**
 * Нажатие крутилки может прийти и как dialDown, и как keyDown —
 * пропускаем повтор в пределах короткого окна.
 */
function createPressGuard(windowMs = 200) {
  const last = new Map();
  return (context) => {
    const now = Date.now();
    if (now - (last.get(context) || 0) < windowMs) return false;
    last.set(context, now);
    return true;
  };
}

const { rasterize } = require("../raster");
const { log } = require("../sdk");

const lastImage = new Map();

/** Растеризует SVG и отправляет PNG на клавишу/полосу. */
async function paint(sd, audio, context, image) {
  if (lastImage.get(context) === image.svg) return;
  lastImage.set(context, image.svg);
  try {
    const png = await rasterize(audio, image);
    // Пока рендерили, могла прийти более свежая картинка.
    if (lastImage.get(context) === image.svg) sd.setImage(context, `data:image/png;base64,${png}`);
  } catch (e) {
    log.warn("render failed", e.message);
    lastImage.delete(context);
  }
}

function forget(context) {
  lastImage.delete(context);
}

/** Отвечает Property Inspector'у списком устройств. */
function handlePiMessage(sd, audio, uuid, { context, payload }) {
  if (payload?.type !== "getDevices") return;
  // Помощник ещё не прислал первый список — ответим, как только он появится.
  if (!audio.devices.length) {
    return audio.once("change", () => handlePiMessage(sd, audio, uuid, { context, payload }));
  }
  const devices = audio.devices.map((d) => ({
    uid: d.uid,
    name: d.name,
    output: Boolean(d.output),
    input: Boolean(d.input),
  }));
  const apps = audio.apps.map(({ id, name, playing }) => ({ id, name, playing }));
  sd.sendToPropertyInspector(uuid, context, { type: "devices", devices, apps });
}

module.exports = { createPressGuard, handlePiMessage, paint, forget };
