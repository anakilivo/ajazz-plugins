"use strict";

// Скрипт, который выполняется на странице Яндекс Музыки.
//
// Данные трека — из Media Session (их же приложение отдаёт системе: название,
// артист, обложка, играет/пауза). Позиция, лайки и режимы — из плеера внизу окна
// по data-test-id и aria-атрибутам (не по CSS-классам, которые меняются от сборки к сборке).
// Раз в 250 мс собирает состояние и, если оно изменилось, отдаёт его плагину через
// binding window.ymDockNotify. Команды — window.__ymDock.act(name, arg).

module.exports = String.raw`
(() => {
  if (window.__ymDock) window.__ymDock.dispose();

  const bar = () => document.querySelector('[data-test-id="PLAYERBAR_DESKTOP"]');
  // Сначала в плеере внизу окна (на странице плейлиста тоже есть PLAY_BUTTON), потом где угодно.
  const find = (id) => bar()?.querySelector('[data-test-id="' + id + '"]') || document.querySelector('[data-test-id="' + id + '"]');
  const findPrefix = (prefix) => bar()?.querySelector('[data-test-id^="' + prefix + '"]') || document.querySelector('[data-test-id^="' + prefix + '"]');
  const pressed = (el) => el ? el.getAttribute("aria-pressed") === "true" : null;

  function cover(metadata) {
    const art = [...(metadata?.artwork || [])].sort((a, b) => parseInt(b.sizes) - parseInt(a.sizes))[0];
    // Обложки Яндекса: .../<id>/400x400 — берём 200×200, этого хватает и полосе, и клавише.
    return art ? art.src.replace(/\/\d+x\d+$/, "/200x200") : null;
  }

  function repeatMode() {
    const button = findPrefix("REPEAT_BUTTON");
    if (!button) return null;
    const id = button.dataset.testId;
    if (/NO_REPEAT|OFF/.test(id)) return "off";
    return /ONE/.test(id) ? "one" : "all";
  }

  function state() {
    const metadata = navigator.mediaSession.metadata;
    const slider = find("TIMECODE_SLIDER");
    const shuffle = find("SHUFFLE_BUTTON");
    const link = find("TRACK_TITLE");
    return {
      ready: Boolean(metadata?.title),
      title: metadata?.title || "",
      artist: metadata?.artist || "",
      album: metadata?.album || "",
      cover: cover(metadata),
      url: link?.href || null,
      playing: navigator.mediaSession.playbackState === "playing" || Boolean(find("PAUSE_BUTTON")),
      position: slider ? Number(slider.value) : null,
      duration: slider ? Number(slider.max) : null,
      liked: pressed(find("LIKE_BUTTON")),
      disliked: pressed(find("DISLIKE_BUTTON")),
      shuffle: shuffle && !shuffle.disabled ? pressed(shuffle) : null,
      repeat: repeatMode(),
    };
  }

  function click(id) {
    const el = find(id);
    if (!el || el.disabled) return false;
    el.click();
    return true;
  }

  function seek(delta) {
    const slider = find("TIMECODE_SLIDER");
    if (!slider) return false;
    const value = Math.max(0, Math.min(Number(slider.max), Number(slider.value) + delta));
    // Ползунок управляется React: значение ставим через нативный setter и шлём события.
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(slider, String(value));
    slider.dispatchEvent(new Event("input", { bubbles: true }));
    slider.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }

  const actions = {
    playPause: () => click("PAUSE_BUTTON") || click("PLAY_BUTTON"),
    next: () => click("NEXT_TRACK_BUTTON"),
    previous: () => click("PREVIOUS_TRACK_BUTTON"),
    like: () => click("LIKE_BUTTON"),
    dislike: () => click("DISLIKE_BUTTON"),
    shuffle: () => click("SHUFFLE_BUTTON"),
    repeat: () => { const b = findPrefix("REPEAT_BUTTON"); if (!b) return false; b.click(); return true; },
    seek,
  };

  let last = "";
  function publish(force) {
    const json = JSON.stringify(state());
    if (!force && json === last) return;
    last = json;
    if (typeof window.ymDockNotify === "function") window.ymDockNotify(json);
  }

  const timer = setInterval(publish, 250);
  window.__ymDock = {
    dispose: () => clearInterval(timer),
    act(name, arg) {
      const ok = actions[name]?.(arg) ?? false;
      setTimeout(publish, 60);
      return ok;
    },
    publish: () => publish(true),
  };
  publish(true);
})();
`;
