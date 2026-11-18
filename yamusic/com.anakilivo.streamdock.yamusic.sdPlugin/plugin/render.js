"use strict";

// SVG клавиш (144×144) и сегмента полосы над крутилкой (176×112).
// Иконки — Lucide (ISC), контурные 24×24.

const KEY = { w: 144, h: 144 };
const STRIP = { w: 176, h: 112 };

const C = {
  bg: "#0b0b12",
  text: "#ffffff",
  dim: "#9a9aa8",
  faint: "#2a2a35",
  accent: "#ffcc00", // жёлтый Яндекс Музыки
  like: "#ff4d6d",
  warn: "#ffb020",
};

const FONT = `font-family="Helvetica Neue, Helvetica, Arial, sans-serif"`;

const ICONS = {
  play: '<polygon points="6 3 20 12 6 21 6 3"/>',
  pause: '<rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>',
  next: '<polygon points="5 4 15 12 5 20 5 4"/><line x1="19" x2="19" y1="5" y2="19"/>',
  previous: '<polygon points="19 20 9 12 19 4 19 20"/><line x1="5" x2="5" y1="19" y2="5"/>',
  heart: '<path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/>',
  dislike: '<path d="M17 14V2"/><path d="M9 18.12 10 14H4.17a2 2 0 0 1-1.92-2.56l2.33-8A2 2 0 0 1 6.5 2H20a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.76a2 2 0 0 0-1.79 1.11L12 22a3.13 3.13 0 0 1-3-3.88Z"/>',
  shuffle: '<path d="m18 14 4 4-4 4"/><path d="m18 2 4 4-4 4"/><path d="M2 18h1.4c1.3 0 2.5-.6 3.3-1.7l6.1-8.6c.7-1.1 2-1.7 3.3-1.7H22"/><path d="M2 6h1.9c1.5 0 2.9.9 3.6 2.2"/><path d="M22 18h-5.9c-1.3 0-2.6-.7-3.3-1.8l-.5-.8"/>',
  repeat: '<path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/>',
  repeatOne: '<path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/><path d="M11 10h1v4"/>',
  music: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
  alert: '<circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/>',
};

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** Обрезает текст по примерной ширине в пикселях (средняя ширина символа Arial). */
function fit(text, width, size, bold = false) {
  const per = size * (bold ? 0.58 : 0.53);
  const max = Math.max(1, Math.floor(width / per));
  return text.length > max ? text.slice(0, max - 1).trimEnd() + "…" : text;
}

/** Разбивает текст на строки по словам (по примерной ширине), последняя — с многоточием. */
function wrap(text, width, size, lines) {
  const max = Math.max(1, Math.floor(width / (size * 0.58)));
  const out = [];
  let cur = "";
  for (const word of text.split(/\s+/)) {
    const next = cur ? `${cur} ${word}` : word;
    if (next.length <= max || !cur) cur = next;
    else {
      out.push(cur);
      cur = word;
    }
  }
  if (cur) out.push(cur);
  // Не влезло — последняя строка из всего остатка, обрезанная с многоточием.
  if (out.length > lines) out.splice(lines - 1, out.length, out.slice(lines - 1).join(" "));
  return out.map((line) => fit(line, width, size, true));
}

/** Обложка со скруглением или заглушка с нотой. */
function coverImage(cover, x, y, size) {
  if (!cover) return `<rect x="${x}" y="${y}" width="${size}" height="${size}" rx="6" fill="${C.faint}"/>` +
    icon("music", x + size * 0.25, y + size * 0.25, size * 0.5, C.dim);
  const id = `c${x}${y}${size}`;
  return `<clipPath id="${id}"><rect x="${x}" y="${y}" width="${size}" height="${size}" rx="6"/></clipPath>` +
    `<image x="${x}" y="${y}" width="${size}" height="${size}" clip-path="url(#${id})" preserveAspectRatio="xMidYMid slice" xlink:href="${cover.uri}"/>`;
}

function icon(name, x, y, size, color, { fill = false, width = 2 } = {}) {
  return `<g transform="translate(${x} ${y}) scale(${size / 24})" fill="${fill ? color : "none"}" stroke="${color}" ` +
    `stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</g>`;
}

function svg({ w, h }, body, defs = "") {
  return {
    svg: `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
      `<defs>${defs}</defs><rect width="${w}" height="${h}" fill="${C.bg}"/>${body}</svg>`,
    width: w,
    height: h,
  };
}

function time(seconds) {
  if (seconds === null || !Number.isFinite(seconds)) return "";
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Текст вместо плеера: Музыка закрыта / без порта / подключение. */
function problem(status) {
  return {
    closed: ["Музыка закрыта", "Нажмите — запустить"],
    nodebug: ["Нужен перезапуск", "Нажмите — перезапустить"],
    connecting: ["Подключение…", ""],
  }[status] || ["Нет данных", ""];
}

// MARK: - Волна

const gradients = (colors) =>
  `<linearGradient id="v" x1="0" y1="1" x2="0" y2="0">${colors.map((c, i) => `<stop offset="${i / (colors.length - 1)}" stop-color="${c}"/>`).join("")}</linearGradient>` +
  `<linearGradient id="h" x1="0" y1="0" x2="1" y2="0">${colors.map((c, i) => `<stop offset="${i / (colors.length - 1)}" stop-color="${c}"/>`).join("")}</linearGradient>`;

/** Гладкая кривая через точки (Catmull-Rom → кубические Безье). */
function smooth(points) {
  let d = `M${points[0][0].toFixed(1)} ${points[0][1].toFixed(1)}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i - 1] || points[i], p1 = points[i], p2 = points[i + 1], p3 = points[i + 2] || p2;
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += ` C${c1[0].toFixed(1)} ${c1[1].toFixed(1)} ${c2[0].toFixed(1)} ${c2[1].toFixed(1)} ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`;
  }
  return d;
}

/** Эквалайзер: столбики с «шапками» пиков. */
function bars({ level, peak }, { x, y, w, h }) {
  const n = 16, gap = 2, bw = (w - gap * (n - 1)) / n;
  let out = "";
  for (let i = 0; i < n; i++) {
    const band = Math.floor(i * level.length / n);
    const bh = Math.max(2, level[band] * h);
    const bx = (x + i * (bw + gap)).toFixed(1);
    out += `<rect x="${bx}" y="${(y + h - bh).toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" rx="1.5" fill="url(#v)"/>`;
    if (peak[band] > 0.02) {
      out += `<rect x="${bx}" y="${(y + h - peak[band] * h - 3).toFixed(1)}" width="${bw.toFixed(1)}" height="2" fill="#fff" opacity="0.75"/>`;
    }
  }
  return out;
}

/** Зеркальная волна: басы в центре, верхние частоты по краям. */
function mirror({ level }, { x, y, w, h }) {
  const n = level.length, mid = y + h / 2, amp = h / 2 - 1;
  const value = (i) => level[Math.round(Math.abs(i - (n - 1) / 2) / ((n - 1) / 2) * (n - 1))];
  const xs = Array.from({ length: n }, (_, i) => x + i * (w / (n - 1)));
  const upper = xs.map((px, i) => [px, mid - value(i) * amp - 0.5]);
  const lower = xs.map((px, i) => [px, mid + value(i) * amp + 0.5]).reverse();
  return `<path d="${smooth(upper)} L${smooth(lower).slice(1)} Z" fill="url(#h)" opacity="0.92"/>` +
    `<path d="${smooth(upper)}" fill="none" stroke="#fff" stroke-width="1" opacity="0.45"/>`;
}

/** Светящаяся линия: кривая колеблется вокруг центра с амплитудой полос. */
function glow({ level }, { x, y, w, h }, t) {
  const n = level.length, mid = y + h / 2, amp = h / 2 - 2;
  const pts = Array.from({ length: n }, (_, i) => [x + i * (w / (n - 1)), mid - level[i] * amp * Math.sin(i * 1.3 + t / 120)]);
  const d = smooth(pts);
  return `<path d="${d}" fill="none" stroke="url(#h)" stroke-width="9" opacity="0.16"/>` +
    `<path d="${d}" fill="none" stroke="url(#h)" stroke-width="5" opacity="0.32"/>` +
    `<path d="${d}" fill="none" stroke="url(#h)" stroke-width="2.2"/>` +
    `<path d="${d}" fill="none" stroke="#fff" stroke-width="0.8" opacity="0.65"/>`;
}

const WAVES = { bars, mirror, glow };

// MARK: - Полоса «Сейчас играет»

/**
 * @param state   состояние Music (+ position — текущая позиция)
 * @param cover   { uri, colors } | null
 * @param frame   { level, peak } | null — уровни волны
 * @param options { style: bars|mirror|glow|none, colors: cover|<css-цвет>, text: full|title|none }
 */
function nowPlaying(state, cover, frame, options, t = Date.now()) {
  if (state.status !== "ok" || !state.ready) {
    const [title, hint] = state.status === "ok" ? ["Ничего не играет", ""] : problem(state.status);
    const color = state.status === "connecting" || state.status === "ok" ? C.dim : C.warn;
    return svg(STRIP, icon(state.status === "connecting" || state.status === "ok" ? "music" : "alert", 74, 14, 28, color) +
      `<text x="88" y="70" ${FONT} font-size="15" font-weight="bold" fill="${color}" text-anchor="middle">${esc(title)}</text>` +
      (hint ? `<text x="88" y="92" ${FONT} font-size="12" fill="${C.dim}" text-anchor="middle">${esc(hint)}</text>` : ""));
  }

  const colors = options.colors === "cover" || !options.colors ? cover?.colors || ["#ffcc00", "#ffdd55", "#ffee99"] : [options.colors, options.colors, "#ffffff"];
  const style = WAVES[options.style] ? options.style : options.style === "none" ? "none" : "bars";
  const text = options.text || "full";
  let body = "";


  if (style === "none" && text !== "none") {
    // Без волны: крупная обложка, название в две строки.
    const lines = wrap(state.title, 70, 14, 2);
    body += coverImage(cover, 6, 6, 88) +
      lines.map((line, i) => `<text x="102" y="${22 + i * 17}" ${FONT} font-size="14" font-weight="bold" fill="${C.text}">${esc(line)}</text>`).join("") +
      (text === "full" ? `<text x="102" y="${24 + lines.length * 17}" ${FONT} font-size="12" fill="${C.dim}">${esc(fit(state.artist, 70, 12))}</text>` : "") +
      (state.liked ? icon("heart", 102, 76, 14, C.like, { fill: true }) : "");
  } else if (text !== "none") {
    // Шапка: обложка + текст, под ней волна.
    body += coverImage(cover, 6, 6, 38);
    const tw = state.liked ? 104 : 118;
    if (text === "title") {
      body += `<text x="52" y="30" ${FONT} font-size="15" font-weight="bold" fill="${C.text}">${esc(fit(state.title, tw, 15, true))}</text>`;
    } else {
      body += `<text x="52" y="22" ${FONT} font-size="14" font-weight="bold" fill="${C.text}">${esc(fit(state.title, tw, 14, true))}</text>` +
        `<text x="52" y="39" ${FONT} font-size="12" fill="${C.dim}">${esc(fit(state.artist, 118, 12))}</text>`;
    }
    if (state.liked) body += icon("heart", 156, 9, 14, C.like, { fill: true });
    if (frame && style !== "none") body += WAVES[style](frame, { x: 6, y: 50, w: 164, h: 44 }, t);
  } else if (style !== "none") {
    // Только волна — на всю высоту.
    if (frame) body += WAVES[style](frame, { x: 6, y: 6, w: 164, h: 88 }, t);
  } else {
    body += coverImage(cover, 50, 6, 88);
  }

  // Прогресс и время.
  const progress = state.duration ? Math.min(1, (state.position || 0) / state.duration) : 0;
  body += `<rect x="6" y="102" width="116" height="3" rx="1.5" fill="${C.faint}"/>` +
    `<rect x="6" y="102" width="${(116 * progress).toFixed(1)}" height="3" rx="1.5" fill="${colors[colors.length - 1]}"/>` +
    (state.playing ? "" : icon("pause", 125, 97, 12, C.text, { fill: true, width: 0 })) +
    `<text x="170" y="107" ${FONT} font-size="11" fill="${C.dim}" text-anchor="end">${time(state.position)}</text>`;

  return svg(STRIP, body, gradients(colors));
}

// MARK: - Клавиши

/** Обложка с полосой прогресса; на паузе — затемнение и значок паузы. */
function coverKey(state, cover) {
  if (state.status !== "ok" || !state.ready) return keyProblem(state.status);
  const progress = state.duration ? Math.min(1, (state.position || 0) / state.duration) : 0;
  const image = cover
    ? `<image width="144" height="144" preserveAspectRatio="xMidYMid slice" xlink:href="${cover.uri}"/>`
    : icon("music", 42, 36, 60, C.dim);
  return svg(KEY, image +
    (state.playing ? "" : `<rect width="144" height="144" fill="#000" opacity="0.45"/>` + icon("pause", 48, 44, 48, "#fff", { fill: true, width: 0 })) +
    `<rect x="0" y="136" width="144" height="8" fill="#000" opacity="0.55"/>` +
    `<rect x="0" y="136" width="${(144 * progress).toFixed(1)}" height="8" fill="${cover?.colors?.[cover.colors.length - 1] || C.accent}"/>`);
}

/** Клавиша без плеера: две короткие строки. */
function keyProblem(status) {
  const [line1, line2] = {
    closed: ["Музыка", "закрыта"],
    nodebug: ["Нужен", "перезапуск"],
    connecting: ["Подключение…", ""],
  }[status] || ["Ничего", "не играет"];
  const calm = status === "connecting" || status === "ok";
  const color = calm ? C.dim : C.warn;
  return svg(KEY, icon(calm ? "music" : "alert", 52, 22, 40, color) +
    `<text x="72" y="90" ${FONT} font-size="17" font-weight="bold" fill="${color}" text-anchor="middle">${esc(line1)}</text>` +
    `<text x="72" y="112" ${FONT} font-size="14" fill="${C.dim}" text-anchor="middle">${esc(line2)}</text>`);
}

/** Клавиша-кнопка плеера: большая иконка и подпись. */
function controlKey(kind, state) {
  if (state.status !== "ok") return keyProblem(state.status);
  const big = (name, color, opts) => icon(name, 40, 28, 64, color, opts);
  const label = (text, color = C.dim) => `<text x="72" y="126" ${FONT} font-size="15" fill="${color}" text-anchor="middle">${esc(text)}</text>`;
  switch (kind) {
    case "playPause":
      return svg(KEY, big(state.playing ? "pause" : "play", C.text, { fill: true, width: 0 }) + label(state.playing ? "Пауза" : "Играть"));
    case "next":
      return svg(KEY, big("next", C.text, { fill: true, width: 1.5 }) + label("Следующий"));
    case "previous":
      return svg(KEY, big("previous", C.text, { fill: true, width: 1.5 }) + label("Предыдущий"));
    case "like":
      return svg(KEY, big("heart", state.liked ? C.like : C.text, { fill: Boolean(state.liked) }) + label(state.liked ? "Нравится" : "Лайк", state.liked ? C.like : C.dim));
    case "dislike":
      return svg(KEY, big("dislike", state.disliked ? C.accent : C.text) + label("Дизлайк"));
    case "shuffle": {
      const on = state.shuffle === true, off = state.shuffle === null;
      return svg(KEY, big("shuffle", on ? C.accent : off ? C.faint : C.text) + label(off ? "Недоступно" : on ? "Вперемешку" : "По порядку", on ? C.accent : C.dim));
    }
    case "repeat": {
      const mode = state.repeat || "off";
      return svg(KEY, big(mode === "one" ? "repeatOne" : "repeat", mode === "off" ? C.text : C.accent) +
        label({ off: "Без повтора", all: "Повтор", one: "Один трек" }[mode], mode === "off" ? C.dim : C.accent));
    }
  }
  return svg(KEY, "");
}

/** Иконка действия для manifest.json и списка Stream Dock. */
function manifestIcon(name, color = C.text, opts = {}) {
  return svg(KEY, icon(name, 24, 24, 96, color, opts));
}

module.exports = { nowPlaying, coverKey, controlKey, manifestIcon, KEY, STRIP };
