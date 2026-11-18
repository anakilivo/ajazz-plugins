"use strict";

// Обложка трека: загрузка в data: URI (для <image> в SVG) и цвета для волны —
// самые насыщенные оттенки обложки, осветлённые, чтобы читались на тёмном фоне.

const { pixels } = require("./raster");
const { log } = require("./sdk");

const FALLBACK = ["#ff3d6e", "#ff8a3d", "#ffd23d"]; // нет обложки
const MONO = ["hsl(0,0%,62%)", "hsl(0,0%,80%)", "hsl(0,0%,96%)"]; // чёрно-белая обложка
const cache = new Map(); // url → Promise<{ uri, colors }>
const MAX_CACHE = 20;

function hsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}

const css = (h, s, l) => `hsl(${Math.round(h)},${Math.round(s * 100)}%,${Math.round(l * 100)}%)`;

/** 2–3 доминирующих насыщенных оттенка; для чёрно-белых обложек — оттенки серого. */
async function palette(uri) {
  const size = 24;
  const { data } = await pixels(`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${size}" height="${size}">` +
    `<image width="${size}" height="${size}" preserveAspectRatio="xMidYMid slice" xlink:href="${uri}"/></svg>`);
  const bins = Array.from({ length: 12 }, () => ({ weight: 0, h: 0, s: 0 }));
  for (let i = 0; i < data.length; i += 4) {
    const [h, s, l] = hsl(data[i], data[i + 1], data[i + 2]);
    const weight = s * (1 - Math.abs(l - 0.5) * 2); // яркие цвета, а не чёрное/белое
    if (weight < 0.15) continue;
    const bin = bins[Math.floor(h / 30) % 12];
    bin.weight += weight;
    bin.h += h * weight;
    bin.s += s * weight;
  }
  const top = bins.filter((b) => b.weight > 2).sort((a, b) => b.weight - a.weight).slice(0, 3);
  if (!top.length) return MONO;
  const colors = top.map((b) => [b.h / b.weight, Math.max(0.6, b.s / b.weight)]);
  // Один оттенок — делаем градиент из его светлот.
  if (colors.length === 1) return [css(colors[0][0], colors[0][1], 0.5), css(colors[0][0], colors[0][1], 0.62), css(colors[0][0], colors[0][1], 0.75)];
  return colors.map(([h, s], i) => css(h, s, 0.55 + i * 0.08));
}

async function fetchCover(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const type = res.headers.get("content-type") || "image/jpeg";
  const uri = `data:${type};base64,${Buffer.from(await res.arrayBuffer()).toString("base64")}`;
  return { uri, colors: await palette(uri).catch(() => FALLBACK) };
}

/** Обложка и цвета по URL (с кешем). null — нет обложки или не загрузилась. */
function loadCover(url) {
  if (!url) return Promise.resolve(null);
  if (!cache.has(url)) {
    if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value);
    cache.set(url, fetchCover(url).catch((e) => {
      log.warn("cover failed", url, e.message);
      cache.delete(url);
      return null;
    }));
  }
  return cache.get(url);
}

/**
 * Держит music.cover = { uri, colors } для текущего трека: при смене обложки
 * загружает новую (старая остаётся до загрузки) и снова эмитит "change".
 */
function followCover(music) {
  let url = null;
  music.cover = null;
  music.on("change", () => {
    const next = music.state.cover;
    if (next === url) return;
    url = next;
    if (!next) {
      music.cover = null;
      return;
    }
    loadCover(next).then((cover) => {
      if (url !== next) return;
      music.cover = cover;
      music.emit("change");
    });
  });
}

module.exports = { loadCover, followCover, FALLBACK };
