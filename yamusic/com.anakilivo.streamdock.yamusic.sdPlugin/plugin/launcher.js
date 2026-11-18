"use strict";

// Запуск Яндекс Музыки с отладочным портом, через который плагин ею управляет.
// Если Музыка уже запущена без порта — закрываем и запускаем заново (только по нажатию).

const { execFile, spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const { log } = require("./sdk");

const BUNDLE_ID = "ru.yandex.desktop.music";
const WIN_EXE = "Яндекс Музыка.exe";

function run(file, args, timeout = 5000) {
  return new Promise((resolve, reject) =>
    execFile(file, args, { encoding: "utf8", timeout, windowsHide: true }, (err, stdout) => (err ? reject(err) : resolve(stdout))));
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/** Командные строки запущенных главных процессов Музыки (без helper'ов). */
async function processes() {
  if (process.platform === "win32") {
    const script = "[Console]::OutputEncoding = [Text.Encoding]::UTF8; " +
      `@(Get-CimInstance Win32_Process -Filter "Name = '${WIN_EXE}'" | ForEach-Object { $_.CommandLine }) | ConvertTo-Json -Compress`;
    const out = (await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]).catch(() => "")).trim();
    if (!out) return [];
    const parsed = JSON.parse(out);
    // У Electron главный процесс — без --type=
    return [].concat(parsed).filter((cmd) => typeof cmd === "string" && !cmd.includes("--type="));
  }
  const out = await run("ps", ["-axo", "args="]).catch(() => "");
  return out.split("\n").filter((line) => line.includes(".app/Contents/MacOS/Яндекс Музыка"));
}

/** closed — не запущена, nodebug — запущена без отладочного порта, running — с портом. */
async function appState(port) {
  const list = await processes();
  if (!list.length) return "closed";
  return list.some((cmd) => cmd.includes(`--remote-debugging-port=${port}`)) ? "running" : "nodebug";
}

function windowsExe() {
  const roots = [process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs"),
    process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"]].filter(Boolean);
  return roots.map((root) => path.join(root, "YandexMusic", WIN_EXE)).find((file) => fs.existsSync(file));
}

async function quit() {
  if (process.platform === "win32") await run("taskkill.exe", ["/IM", WIN_EXE, "/T"]).catch(() => {});
  else await run("osascript", ["-e", `quit app id "${BUNDLE_ID}"`]).catch(() => {});
  for (let i = 0; i < 20; i++) {
    if (!(await processes()).length) return;
    await delay(500);
  }
  throw new Error("Яндекс Музыка не закрылась");
}

/** Запускает Музыку с портом; запущенную без порта — перезапускает. */
async function launch(port) {
  const state = await appState(port);
  if (state === "running") return;
  if (state === "nodebug") {
    log.info("restarting Yandex Music with debug port", port);
    await quit();
  }
  const arg = `--remote-debugging-port=${port}`;
  if (process.platform === "win32") {
    const exe = windowsExe();
    if (!exe) throw new Error("Яндекс Музыка не найдена");
    spawn(exe, [arg], { detached: true, stdio: "ignore", windowsHide: false }).unref();
  } else {
    await run("open", ["-b", BUNDLE_ID, "--args", arg]);
  }
}

module.exports = { appState, launch };
