"use strict";

// SVG-разметка сегмента сенсорной полосы (под крутилкой) и клавиш.
// Stream Dock не умеет показывать SVG, поэтому помощник растеризует её в PNG (см. common.paint).

const STRIP = { w: 176, h: 112 };
const KEY = { w: 144, h: 144 };

const C = {
  bg: "rgb(18,18,22)",
  track: "rgb(52,52,60)",
  text: "rgb(240,240,245)",
  dim: "rgb(150,150,162)",
  mute: "rgb(239,68,68)",
  output: "rgb(56,189,248)",
  input: "rgb(52,211,153)",
  app: "rgb(167,139,250)",
};

const FONT = `font-family="Helvetica Neue, Helvetica, Arial, sans-serif"`;

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function truncate(s, max) {
  return s.length > max ? s.slice(0, max - 1).trimEnd() + "…" : s;
}

/** Разбивает имя на строки по словам, не длиннее max символов. */
function wrap(s, max, lines) {
  const out = [];
  let cur = "";
  for (const word of s.split(/\s+/)) {
    const next = cur ? `${cur} ${word}` : word;
    if (next.length <= max) cur = next;
    else {
      if (cur) out.push(cur);
      cur = word;
    }
  }
  if (cur) out.push(cur);
  if (out.length > lines) {
    out.length = lines;
    out[lines - 1] = truncate(out[lines - 1] + " …", max);
  }
  return out.map((l) => truncate(l, max));
}

/** Иконка колонки или микрофона в квадрате 24×24, при muted — перечёркнута. */
function icon(scope, x, y, size, color, muted) {
  const k = size / 24;
  const body =
    scope === "output"
      ? `<path d="M3 9h4l5-4v14l-5-4H3z" fill="${color}"/>` +
        (muted
          ? ""
          : `<path d="M15.5 8.5a5 5 0 0 1 0 7M18 6a8.5 8.5 0 0 1 0 12" stroke="${color}" stroke-width="2" fill="none" stroke-linecap="round"/>`)
      : `<rect x="9" y="2" width="6" height="12" rx="3" fill="${color}"/>` +
        `<path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M8.5 21h7" stroke="${color}" stroke-width="2" fill="none" stroke-linecap="round"/>`;
  const slash = muted
    ? `<path d="M3 3l18 18" stroke="${C.mute}" stroke-width="2.5" stroke-linecap="round"/>`
    : "";
  return `<g transform="translate(${x} ${y}) scale(${k})">${body}${slash}</g>`;
}

function svg({ w, h }, body) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
    `<rect width="${w}" height="${h}" fill="${C.bg}"/>${body}</svg>`;
  return { svg, width: w, height: h };
}

/**
 * Канал микшера на сегменте полосы.
 * state: { scope, name, volume (0..1 | null), muted, missing }
 */
function channel({ scope, name, volume, muted, missing }) {
  const accent = muted ? C.mute : C[scope];
  const head =
    icon(scope, 12, 10, 22, missing ? C.dim : accent, muted) +
    `<text x="42" y="28" ${FONT} font-size="15" fill="${C.dim}">${esc(truncate(name, 15))}</text>`;

  if (missing) {
    return svg(STRIP, head +
      `<text x="88" y="76" ${FONT} font-size="16" fill="${C.dim}" text-anchor="middle">Нет устройства</text>`);
  }
  if (volume == null) {
    const label = muted ? "MUTE" : "Без регулятора";
    return svg(STRIP, head +
      `<text x="88" y="76" ${FONT} font-size="16" fill="${muted ? C.mute : C.dim}" text-anchor="middle">${label}</text>`);
  }

  return svg(STRIP, head + meter({ volume, muted, accent }));
}

/** Крупные проценты (или MUTE) и шкала уровня в нижней части сегмента. */
function meter({ volume, muted, accent, idle = false }) {
  const pct = Math.round(volume * 100);
  const barW = 152;
  const fill = Math.round(barW * volume);
  const value = muted
    ? `<text x="164" y="74" ${FONT} font-size="26" font-weight="bold" fill="${C.mute}" text-anchor="end">MUTE</text>`
    : `<text x="164" y="74" ${FONT} font-size="34" font-weight="bold" fill="${idle ? C.dim : C.text}" text-anchor="end">${pct}<tspan font-size="18" fill="${C.dim}">%</tspan></text>`;

  return value +
    `<rect x="12" y="88" width="${barW}" height="10" rx="5" fill="${C.track}"/>` +
    (fill > 0 ? `<rect x="12" y="88" width="${Math.max(fill, 10)}" height="10" rx="5" fill="${accent}" opacity="${muted || idle ? 0.5 : 1}"/>` : "");
}

/**
 * Громкость приложения на сегменте полосы.
 * state: { name, icon (PNG base64 | null), volume, muted, running, unset }
 */
function app({ name, icon: png, volume, muted, running, unset }) {
  const accent = muted ? C.mute : C.app;
  const image = png
    ? `<image x="10" y="6" width="28" height="28" href="data:image/png;base64,${png}" opacity="${running ? 1 : 0.5}"/>`
    : `<rect x="12" y="9" width="22" height="22" rx="6" fill="none" stroke="${C.dim}" stroke-width="2"/>`;
  const slash = muted ? `<path d="M10 6l28 28" stroke="${C.mute}" stroke-width="3" stroke-linecap="round"/>` : "";
  const head = image + slash +
    `<text x="44" y="27" ${FONT} font-size="15" fill="${running ? C.text : C.dim}">${esc(truncate(name, 14))}</text>`;

  if (unset) {
    return svg(STRIP, head +
      `<text x="88" y="76" ${FONT} font-size="15" fill="${C.dim}" text-anchor="middle">Выберите в настройках</text>`);
  }
  const status = running ? "" :
    `<text x="44" y="44" ${FONT} font-size="11" fill="${C.dim}">не запущено</text>`;
  return svg(STRIP, head + status + meter({ volume, muted, accent, idle: !running }));
}

/**
 * Выбор устройства. На крутилке — с точками позиции и режимом предпросмотра,
 * на клавише — крупная иконка и имя.
 * state: { scope, name, index, total, preview, onKey }
 */
function device({ scope, name, index, total, preview, onKey }) {
  const accent = C[scope];
  const title = scope === "output" ? "Выход" : "Вход";

  if (onKey) {
    const lines = wrap(name || "—", 12, 3);
    const text = lines
      .map((l, i) => `<text x="72" y="${92 + i * 20}" ${FONT} font-size="17" fill="${C.text}" text-anchor="middle">${esc(l)}</text>`)
      .join("");
    return svg(KEY, icon(scope, 50, 18, 44, accent, false) + text);
  }

  const lines = wrap(name || "—", 17, 2);
  const text = lines
    .map((l, i) => `<text x="88" y="${lines.length === 1 ? 64 : 56 + i * 20}" ${FONT} font-size="17" font-weight="${preview ? "bold" : "normal"}" fill="${C.text}" text-anchor="middle">${esc(l)}</text>`)
    .join("");

  const dotsCount = Math.min(total, 8);
  const start = 88 - ((dotsCount - 1) * 12) / 2;
  const active = total > 8 ? Math.round((index / (total - 1)) * 7) : index;
  const dots = Array.from({ length: dotsCount }, (_, i) =>
    `<circle cx="${start + i * 12}" cy="96" r="${i === active ? 4 : 3}" fill="${i === active ? accent : C.track}"/>`).join("");

  const frame = preview
    ? `<rect x="1.5" y="1.5" width="173" height="109" rx="8" fill="none" stroke="${accent}" stroke-width="3"/>`
    : "";
  const hint = preview ? "Нажмите — выбор" : title;

  return svg(STRIP, frame + icon(scope, 12, 10, 20, accent, false) +
    `<text x="40" y="26" ${FONT} font-size="14" fill="${preview ? accent : C.dim}">${hint}</text>` +
    text + (total > 1 ? dots : ""));
}

module.exports = { channel, device, app };
