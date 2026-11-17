"use strict";

const { rasterize } = require("../raster");
const { log } = require("../sdk");

const lastImage = new Map();

/** Растеризует SVG и отправляет PNG на клавишу/полосу (повторы пропускаем). */
async function paint(sd, context, image) {
  if (lastImage.get(context) === image.svg) return;
  lastImage.set(context, image.svg);
  try {
    const png = await rasterize(image.svg);
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

/**
 * Различает нажатие крутилки и касание экрана над ней — Stream Dock (AKP05E Pro)
 * присылает оба как dialDown:
 *   - крутилка: dialDown + одновременно dialRotate { pressed: true, ticks: 1 }, dialUp нет;
 *   - экран:    dialDown, через ~50 мс dialUp, поворота нет.
 * Возвращает обработчики событий; dialRotate возвращает true, если поворот — часть нажатия
 * и его нужно игнорировать.
 */
function createPressClassifier({ onKnob, onTouch, windowMs = 300 }) {
  const pending = new Map(); // context -> { msg, timer }

  function settle(context, handler) {
    const press = pending.get(context);
    if (!press) return;
    clearTimeout(press.timer);
    pending.delete(context);
    handler(press.msg);
  }

  return {
    dialDown(msg) {
      settle(msg.context, onKnob);
      // Ни dialUp, ни поворота не пришло — значит, крутилка.
      const timer = setTimeout(() => settle(msg.context, onKnob), windowMs);
      pending.set(msg.context, { msg, timer });
    },
    dialUp(msg) {
      settle(msg.context, onTouch);
    },
    dialRotate(msg) {
      if (!msg.payload?.pressed) return false;
      settle(msg.context, onKnob);
      return true;
    },
  };
}

// Открытые Property Inspector'ы: action context → action UUID. Им шлём статус входа при изменениях.
const inspectors = new Map();

function authStatus(github) {
  const { status, user, source, error } = github.state;
  return {
    type: "status",
    status,
    user,
    source,
    error,
    hasToken: Boolean(github.settings.token),
    repos: github.settings.repos,
    hidden: github.hiddenCount(),
  };
}

/** Сообщения от Property Inspector: статус, токен, репозитории, скрытые PR. */
function handlePiMessage(sd, github, uuid, { context, payload }) {
  switch (payload?.type) {
    case "status":
      inspectors.set(context, uuid);
      sd.sendToPropertyInspector(uuid, context, authStatus(github));
      break;
    case "setToken":
      github.setToken(payload.token);
      break;
    case "setRepos":
      github.setRepos(Array.isArray(payload.repos) ? payload.repos : []);
      break;
    case "clearDismissed":
      github.clearDismissed();
      break;
    case "refresh":
      github.refresh();
      break;
  }
}

function watchInspectors(sd, github) {
  github.on("change", () => {
    for (const [context, uuid] of inspectors) sd.sendToPropertyInspector(uuid, context, authStatus(github));
  });
}

function forgetInspector(context) {
  inspectors.delete(context);
}

module.exports = { paint, forget, createPressClassifier, handlePiMessage, watchInspectors, forgetInspector };
