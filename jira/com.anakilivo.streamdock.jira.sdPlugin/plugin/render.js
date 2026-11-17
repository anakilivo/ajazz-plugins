"use strict";

// SVG клавиши (144×144) и сегмента полосы над крутилкой (176×112).

const KEY = { w: 144, h: 144 };
const STRIP = { w: 176, h: 112 };

const C = {
  bg: "rgb(22,26,29)",
  text: "rgb(222,228,234)",
  dim: "rgb(140,155,171)",
  track: "rgb(56,65,74)",
  accent: "rgb(87,157,255)",
  warn: "rgb(245,205,71)",
  // Цвета категорий статусов, как у «лозунгов» в Jira: фон и текст.
  new: ["rgb(56,65,74)", "rgb(222,228,234)"],
  indeterminate: ["rgb(87,157,255)", "rgb(22,26,29)"],
  done: ["rgb(75,206,151)", "rgb(22,26,29)"],
};

const FONT = `font-family="Helvetica Neue, Helvetica, Arial, sans-serif"`;

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function truncate(s, max) {
  return s.length > max ? s.slice(0, max - 1).trimEnd() + "…" : s;
}

/** Разбивает текст на строки по словам, не длиннее max символов. */
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

/** Иконка «список задач» в квадрате size×size. */
function taskIcon(x, y, size, color) {
  const k = size / 24;
  return `<g transform="translate(${x} ${y}) scale(${k})" fill="none" stroke="${color}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">` +
    `<path d="M3 5.5l1.8 1.8L8 4M3 12.5l1.8 1.8L8 11"/><rect x="3" y="17.5" width="4.5" height="4.5" rx="1"/>` +
    `<path d="M11.5 6h9.5M11.5 13h9.5M11.5 20h9.5"/></g>`;
}

function svg({ w, h }, body, background = true) {
  return {
    svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
      (background ? `<rect width="${w}" height="${h}" fill="${C.bg}"/>` : "") + `${body}</svg>`,
    width: w,
    height: h,
  };
}

function problemText(status) {
  return status === "auth" ? "Нет входа" : status === "loading" ? "Загрузка…" : "Нет связи";
}

/**
 * Клавиша «Мой спринт»: сколько осталось, из скольких, полоска прогресса.
 * state: { status, open, total, done, stale }
 */
function sprint({ status, open, total, done, stale }) {
  if (status !== "ok") {
    const color = status === "loading" ? C.dim : C.warn;
    return svg(KEY, taskIcon(16, 16, 28, C.dim) +
      `<text x="72" y="86" ${FONT} font-size="18" fill="${color}" text-anchor="middle">${problemText(status)}</text>` +
      `<text x="72" y="126" ${FONT} font-size="15" fill="${C.dim}" text-anchor="middle">спринт</text>`);
  }

  const color = open > 0 ? C.text : C.dim;
  const barW = 112;
  const fill = total ? Math.round((barW * done) / total) : 0;
  const staleMark = stale ? `<circle cx="128" cy="16" r="5" fill="${C.warn}"/>` : "";

  return svg(KEY, taskIcon(16, 16, 28, C.accent) + staleMark +
    `<text x="72" y="92" ${FONT} font-size="56" font-weight="bold" fill="${color}" text-anchor="middle">${open > 99 ? "99+" : open}</text>` +
    `<text x="72" y="118" ${FONT} font-size="16" fill="${C.dim}" text-anchor="middle">из ${total} в спринте</text>` +
    `<rect x="16" y="128" width="${barW}" height="6" rx="3" fill="${C.track}"/>` +
    (fill > 0 ? `<rect x="16" y="128" width="${Math.max(fill, 6)}" height="6" rx="3" fill="${C.done[0]}"/>` : ""));
}

/** «Лозунг» статуса: цветная плашка с названием заглавными буквами. */
function lozenge(x, y, category, name) {
  const [bg, fg] = C[category] || C.new;
  const label = esc(truncate(name.toUpperCase(), 14));
  const w = Math.min(100, 12 + name.length * 7);
  return `<rect x="${x}" y="${y}" width="${w}" height="17" rx="3" fill="${bg}"/>` +
    `<text x="${x + 6}" y="${y + 12.5}" ${FONT} font-size="11" font-weight="bold" fill="${fg}" textLength="${w - 12}" lengthAdjust="spacingAndGlyphs">${label}</text>`;
}

/**
 * Лента тикетов на сегменте полосы.
 * state: { status, item, index, total }
 */
function feed({ status, item, index, total }) {
  if (status !== "ok" || !item) {
    const text = status !== "ok" ? problemText(status) : "Всё сделано";
    const color = status === "ok" || status === "loading" ? C.dim : C.warn;
    return svg(STRIP, taskIcon(12, 10, 18, C.dim) +
      `<text x="38" y="25" ${FONT} font-size="14" fill="${C.dim}">Мой спринт</text>` +
      `<text x="88" y="72" ${FONT} font-size="16" fill="${color}" text-anchor="middle">${text}</text>`);
  }

  const head = `<text x="10" y="22" ${FONT} font-size="13" font-weight="bold" fill="${C.accent}">${esc(item.key)}</text>` +
    `<text x="166" y="22" ${FONT} font-size="13" fill="${C.dim}" text-anchor="end">${index + 1}/${total}</text>`;
  const lines = wrap(item.title, 19, 3)
    .map((l, i) => `<text x="10" y="${42 + i * 17}" ${FONT} font-size="14" font-weight="bold" fill="${C.text}">${esc(l)}</text>`)
    .join("");
  const foot = lozenge(10, 88, item.category, item.status) +
    `<text x="166" y="101" ${FONT} font-size="11" fill="${C.dim}" text-anchor="end">${esc(truncate(item.type, 10))}</text>`;

  return svg(STRIP, head + lines + foot);
}

/** Иконки для manifest.json (scripts/icons.js). */
function manifestIcon(color) {
  return svg({ w: 144, h: 144 },
    `<rect width="144" height="144" rx="26" fill="${C.bg}"/>` + taskIcon(30, 30, 84, C[color] || color), false);
}

module.exports = { sprint, feed, manifestIcon, C };
