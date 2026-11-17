"use strict";

// SVG клавиш (144×144) и сегмента полосы над крутилкой (176×112).
// Иконки — Octicons (MIT), 16×16.

const KEY = { w: 144, h: 144 };
const STRIP = { w: 176, h: 112 };

const C = {
  bg: "rgb(13,17,23)",
  text: "rgb(230,237,243)",
  dim: "rgb(125,133,144)",
  track: "rgb(48,54,61)",
  accent: "rgb(88,166,255)",
  review: "rgb(219,109,40)",
  success: "rgb(63,185,80)",
  failure: "rgb(248,81,73)",
  pending: "rgb(210,153,34)",
  none: "rgb(110,118,129)",
};

const FONT = `font-family="Helvetica Neue, Helvetica, Arial, sans-serif"`;

const ICONS = {
  pr: "M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z",
  eye: "M8 2c1.981 0 3.671.992 4.933 2.078 1.27 1.091 2.187 2.345 2.637 3.023a1.62 1.62 0 0 1 0 1.798c-.45.678-1.367 1.932-2.637 3.023C11.67 13.008 9.981 14 8 14c-1.981 0-3.671-.992-4.933-2.078C1.797 10.83.88 9.576.43 8.898a1.62 1.62 0 0 1 0-1.798c.45-.677 1.367-1.931 2.637-3.022C4.33 2.992 6.019 2 8 2ZM1.679 7.932a.12.12 0 0 0 0 .136c.411.622 1.241 1.75 2.366 2.717C5.176 11.758 6.527 12.5 8 12.5c1.473 0 2.825-.742 3.955-1.715 1.124-.967 1.954-2.096 2.366-2.717a.12.12 0 0 0 0-.136c-.412-.621-1.242-1.75-2.366-2.717C10.824 4.242 9.473 3.5 8 3.5c-1.473 0-2.825.742-3.955 1.715-1.124.967-1.954 2.096-2.366 2.717ZM8 10a2 2 0 1 1-.001-3.999A2 2 0 0 1 8 10Z",
  alert: "M6.457 1.047c.659-1.234 2.427-1.234 3.086 0l6.082 11.378A1.75 1.75 0 0 1 14.082 15H1.918a1.75 1.75 0 0 1-1.543-2.575Zm1.763.707a.25.25 0 0 0-.44 0L1.698 13.132a.25.25 0 0 0 .22.368h12.164a.25.25 0 0 0 .22-.368Zm.53 3.996v2.5a.75.75 0 0 1-1.5 0v-2.5a.75.75 0 0 1 1.5 0ZM9 11a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z",
};

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

function icon(name, x, y, size, color) {
  return `<path transform="translate(${x} ${y}) scale(${size / 16})" d="${ICONS[name]}" fill="${color}"/>`;
}

function svg({ w, h }, body, background = true) {
  return {
    svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
      (background ? `<rect width="${w}" height="${h}" fill="${C.bg}"/>` : "") + `${body}</svg>`,
    width: w,
    height: h,
  };
}

/** Заглушка «нет входа» / «ошибка» для клавиши. */
function keyProblem(status, label) {
  const text = status === "auth" ? "Нет входа" : status === "loading" ? "Загрузка…" : "Нет связи";
  const color = status === "loading" ? C.dim : C.pending;
  return svg(KEY, (status === "loading" ? "" : icon("alert", 52, 30, 40, color)) +
    `<text x="72" y="${status === "loading" ? 80 : 98}" ${FONT} font-size="18" fill="${color}" text-anchor="middle">${text}</text>` +
    `<text x="72" y="128" ${FONT} font-size="15" fill="${C.dim}" text-anchor="middle">${esc(label)}</text>`);
}

/**
 * Клавиша-счётчик.
 * state: { kind: "review" | "mine", status, count, ci, stale }
 */
function counter({ kind, status, count, ci, stale }) {
  const label = kind === "review" ? "на ревью" : "мои PR";
  if (status !== "ok") return keyProblem(status, label);

  const active = count > 0;
  const color = kind === "review" ? (active ? C.review : C.dim) : active ? C.text : C.dim;
  const ciBar = kind === "mine" && active
    ? `<rect x="24" y="134" width="96" height="6" rx="3" fill="${C[ci]}"/>`
    : "";
  const staleMark = stale ? `<circle cx="128" cy="16" r="5" fill="${C.pending}"/>` : "";

  return svg(KEY, icon(kind === "review" ? "eye" : "pr", 16, 16, 28, color) + staleMark +
    `<text x="72" y="100" ${FONT} font-size="56" font-weight="bold" fill="${color}" text-anchor="middle">${count > 99 ? "99+" : count}</text>` +
    `<text x="72" y="126" ${FONT} font-size="17" fill="${C.dim}" text-anchor="middle">${label}</text>` + ciBar);
}

/**
 * Лента PR на сегменте полосы.
 * state: { kind, status, item, index, total }
 */
function feed({ kind, status, item, index, total }) {
  const title = kind === "review" ? "На ревью" : "Мои PR";
  if (status !== "ok") {
    const text = status === "auth" ? "Нет входа в GitHub" : status === "loading" ? "Загрузка…" : "Нет связи с GitHub";
    return svg(STRIP, icon(kind === "review" ? "eye" : "pr", 12, 10, 18, C.dim) +
      `<text x="38" y="25" ${FONT} font-size="14" fill="${C.dim}">${title}</text>` +
      `<text x="88" y="72" ${FONT} font-size="15" fill="${status === "loading" ? C.dim : C.pending}" text-anchor="middle">${text}</text>`);
  }
  if (!item) {
    return svg(STRIP, icon(kind === "review" ? "eye" : "pr", 12, 10, 18, C.dim) +
      `<text x="38" y="25" ${FONT} font-size="14" fill="${C.dim}">${title}</text>` +
      `<text x="88" y="72" ${FONT} font-size="16" fill="${C.dim}" text-anchor="middle">Нет открытых PR</text>`);
  }

  const repo = item.repo.split("/").pop();
  const head = `<circle cx="16" cy="19" r="6" fill="${C[item.ci]}"/>` +
    `<text x="28" y="24" ${FONT} font-size="13" fill="${C.dim}">${esc(truncate(`${repo} #${item.number}`, 17))}</text>` +
    `<text x="166" y="24" ${FONT} font-size="13" fill="${C.dim}" text-anchor="end">${index + 1}/${total}</text>`;
  const lines = wrap(item.title, 19, 3)
    .map((l, i) => `<text x="10" y="${50 + i * 19}" ${FONT} font-size="15" font-weight="bold" fill="${C.text}">${esc(l)}</text>`)
    .join("");
  const tag = item.draft ? "черновик · " : item.requested ? "вас просят · " : "";
  const foot = `<text x="10" y="104" ${FONT} font-size="12" fill="${item.requested ? C.review : C.dim}">` +
    `${tag}@${esc(truncate(item.author, 24 - tag.length))}</text>`;

  return svg(STRIP, head + lines + foot);
}

/** Иконки для manifest.json (scripts/icons.js). */
function manifestIcon(name, color) {
  return svg({ w: 144, h: 144 },
    `<rect width="144" height="144" rx="26" fill="${C.bg}"/>` + icon(name, 32, 32, 80, C[color] || color), false);
}

module.exports = { counter, feed, manifestIcon, ICONS, C };
