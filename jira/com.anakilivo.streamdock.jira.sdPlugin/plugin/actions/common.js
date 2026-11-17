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

// Открытые Property Inspector'ы: action context → action UUID. Им шлём статус входа при изменениях.
const inspectors = new Map();

function status(jira) {
  const { status, user, error } = jira.state;
  const { site, email, token, boards } = jira.settings;
  return { type: "status", status, user, error, site, email, hasToken: Boolean(token), boards };
}

/** Сообщения от Property Inspector: статус, данные входа, доски, обновление. */
function handlePiMessage(sd, jira, uuid, { context, payload }) {
  switch (payload?.type) {
    case "status":
      inspectors.set(context, uuid);
      sd.sendToPropertyInspector(uuid, context, status(jira));
      break;
    case "setAuth": {
      // Пустое поле токена — оставить сохранённый.
      const patch = { site: payload.site ?? jira.settings.site, email: payload.email ?? jira.settings.email };
      if (payload.token) patch.token = payload.token;
      jira.updateSettings(patch);
      break;
    }
    case "getBoards":
      jira.listBoards()
        .then((boards) => sd.sendToPropertyInspector(uuid, context, { type: "boards", boards }))
        .catch((e) => sd.sendToPropertyInspector(uuid, context, { type: "boards", boards: [], error: e.message }));
      break;
    case "setBoards":
      jira.setBoards(Array.isArray(payload.boards) ? payload.boards : []);
      break;
    case "refresh":
      jira.refresh();
      break;
  }
}

function watchInspectors(sd, jira) {
  jira.on("change", () => {
    for (const [context, uuid] of inspectors) sd.sendToPropertyInspector(uuid, context, status(jira));
  });
}

/** Действие исчезло с устройства. */
function forget(context) {
  lastImage.delete(context);
  inspectors.delete(context);
}

module.exports = { paint, forget, handlePiMessage, watchInspectors };
