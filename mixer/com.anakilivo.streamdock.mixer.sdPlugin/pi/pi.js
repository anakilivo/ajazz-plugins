// Общий код Property Inspector: соединение со Stream Dock, настройки, список устройств.
// Страница задаёт window.PI = { defaults, render(settings, devices, apps) }.

let socket, piUUID, actionUUID;
let settings = {};
let devices = [];
let apps = [];

function sendJSON(msg) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
}

function saveSettings(patch) {
  Object.assign(settings, patch);
  sendJSON({ event: "setSettings", context: piUUID, payload: settings });
  window.PI.render(settings, devices, apps);
}

function requestDevices() {
  sendJSON({ event: "sendToPlugin", action: actionUUID, context: piUUID, payload: { type: "getDevices" } });
}

// Имя функции задано SDK Stream Dock / Elgato.
function connectElgatoStreamDeckSocket(port, uuid, registerEvent, _appInfo, actionInfo) {
  piUUID = uuid;
  const info = JSON.parse(actionInfo);
  actionUUID = info.action;
  settings = { ...window.PI.defaults, ...(info.payload?.settings || {}) };
  window.PI.render(settings, devices, apps);

  socket = new WebSocket(`ws://127.0.0.1:${port}`);
  socket.onopen = () => {
    sendJSON({ event: registerEvent, uuid });
    requestDevices();
  };
  socket.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.event === "didReceiveSettings") {
      settings = { ...window.PI.defaults, ...msg.payload.settings };
      window.PI.render(settings, devices, apps);
    } else if (msg.event === "sendToPropertyInspector" && msg.payload?.type === "devices") {
      devices = msg.payload.devices;
      apps = msg.payload.apps || [];
      window.PI.render(settings, devices, apps);
    }
  };
}

window.connectElgatoStreamDeckSocket = connectElgatoStreamDeckSocket;
window.connectSocket = connectElgatoStreamDeckSocket;

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "on") Object.entries(v).forEach(([ev, fn]) => node.addEventListener(ev, fn));
    else if (k in node) node[k] = v;
    else node.setAttribute(k, v);
  }
  for (const child of [].concat(children)) node.append(child);
  return node;
}

/** Ряд «подпись — контрол» в стиле Stream Dock. */
function row(label, control) {
  return el("div", { className: "row" }, [el("label", { textContent: label }), control]);
}

function scopeSelect() {
  return el("select", {
    value: settings.scope,
    on: { change: (e) => saveSettings({ scope: e.target.value, device: "", devices: [] }) },
  }, [
    el("option", { value: "output", textContent: "Выход (звук)", selected: settings.scope === "output" }),
    el("option", { value: "input", textContent: "Вход (микрофон)", selected: settings.scope === "input" }),
  ]);
}
