"use strict";

// Данные GitHub для всех действий: одним GraphQL-запросом раз в POLL_MS получаем
// PR для ревью и мои открытые PR со статусом CI. Опрашиваем, только пока
// на устройстве видно хотя бы одно действие плагина. Эмитит "change", а при
// изменении настроек (токен, репозитории, скрытые PR) — "settings" для сохранения.
//
// «На ревью» = PR, где запрошено моё ревью, + все открытые PR из выбранных
// репозиториев/организаций (кроме моих); черновики не показываем. «Мои PR» — мои PR в тех же
// репозиториях (если список пуст — по всему GitHub). PR на ревью скрыт, если:
//   - я отметил его «посмотрел» на крутилке, или
//   - я уже оставил ревью на текущий последний коммит.
// В обоих случаях PR вернётся, когда автор запушит новые коммиты.
//
// Токен: из настроек плагина (если введён), иначе из `gh auth token`.

const { execFile } = require("child_process");
const { EventEmitter } = require("events");
const { log } = require("./sdk");

const POLL_MS = 60_000;
const PAGE = 30;

const GH_CANDIDATES = [
  "gh",
  "/opt/homebrew/bin/gh",
  "/usr/local/bin/gh",
  "C:\\Program Files\\GitHub CLI\\gh.exe",
  `${process.env.LOCALAPPDATA || ""}\\Programs\\GitHub CLI\\gh.exe`,
];

function prFields(login) {
  return `
  ... on PullRequest {
    number title url isDraft headRefOid updatedAt
    repository { nameWithOwner }
    author { login }
    commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
    reviews(author: ${JSON.stringify(login)}, last: 1) { nodes { commit { oid } } }
  }`;
}

function search(alias, query, login) {
  return `${alias}: search(query: ${JSON.stringify(query)}, type: ISSUE, first: ${PAGE}) {
    issueCount nodes { ${prFields(login)} }
  }`;
}

/** "owner/repo" → repo:owner/repo, "org" → org:org. */
function scopeQualifiers(repos) {
  return repos.map((r) => (r.includes("/") ? `repo:${r}` : `org:${r}`)).join(" ");
}

function buildQuery(login, repos) {
  // Выбранные репозитории ограничивают и «мои PR»: забытые PR в чужих проектах не мешают.
  const scope = scopeQualifiers(repos);
  const parts = [
    "viewer { login }",
    search("requested", "is:open is:pr draft:false review-requested:@me archived:false sort:updated-desc", login),
    search("mine", `is:open is:pr author:@me archived:false sort:updated-desc ${scope}`.trim(), login),
  ];
  if (repos.length) {
    parts.push(search("team", `is:open is:pr draft:false -author:@me archived:false sort:updated-desc ${scope}`, login));
  }
  return `query { ${parts.join("\n")} }`;
}

function run(file, args) {
  return new Promise((resolve, reject) =>
    execFile(file, args, { timeout: 5000, windowsHide: true }, (err, stdout) => (err ? reject(err) : resolve(stdout.trim()))));
}

async function ghToken() {
  for (const file of GH_CANDIDATES) {
    try {
      const token = await run(file, ["auth", "token"]);
      if (token) return token;
    } catch {
      // нет такого gh или не выполнен вход — пробуем следующий
    }
  }
  return null;
}

/** SUCCESS | FAILURE | ERROR | PENDING | EXPECTED | null → success | failure | pending | none */
function ciState(pr) {
  const state = pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state;
  if (state === "SUCCESS") return "success";
  if (state === "FAILURE" || state === "ERROR") return "failure";
  if (state === "PENDING" || state === "EXPECTED") return "pending";
  return "none";
}

/** Общий статус набора PR: хоть один упал → failure, хоть один идёт → pending. */
function overallCi(items) {
  const states = new Set(items.map((i) => i.ci));
  for (const s of ["failure", "pending", "success"]) if (states.has(s)) return s;
  return "none";
}

function toItem(pr, extra = {}) {
  return {
    number: pr.number,
    title: pr.title,
    url: pr.url,
    draft: pr.isDraft,
    head: pr.headRefOid,
    updatedAt: pr.updatedAt,
    repo: pr.repository?.nameWithOwner || "",
    author: pr.author?.login || "",
    ci: ciState(pr),
    // Моё последнее ревью сделано на текущий последний коммит.
    reviewed: pr.reviews?.nodes?.[0]?.commit?.oid === pr.headRefOid,
    ...extra,
  };
}

function nodes(result) {
  return (result?.nodes || []).filter((n) => n?.url);
}

function summary(items, count = items.length) {
  return { count, items, ci: overallCi(items) };
}

class GitHub extends EventEmitter {
  constructor() {
    super();
    // status: loading | ok | auth (нет/неверный токен) | error (сеть/API)
    this.state = { status: "loading", user: null, source: null, error: null, review: summary([]), mine: summary([]) };
    this.settings = { token: "", repos: [], dismissed: {} };
    this.reviewAll = []; // все кандидаты на ревью, включая скрытые — для пересчёта без запроса
    this.users = 0;
    this.timer = null;
    this.inFlight = null;
  }

  /** Настройки из глобальных настроек плагина (один раз при старте). */
  load(settings) {
    this.settings = {
      token: (settings.token || "").trim(),
      repos: Array.isArray(settings.repos) ? settings.repos : [],
      dismissed: settings.dismissed && typeof settings.dismissed === "object" ? settings.dismissed : {},
    };
    this.refresh();
  }

  updateSettings(patch, { refetch = true } = {}) {
    this.settings = { ...this.settings, ...patch };
    this.emit("settings", this.settings);
    if (refetch) this.refresh();
  }

  setToken(token) {
    this.updateSettings({ token: (token || "").trim() });
  }

  setRepos(repos) {
    const clean = [...new Set(repos.map((r) => r.trim().replace(/^https:\/\/github\.com\//, "").replace(/\/$/, "")).filter(Boolean))];
    this.updateSettings({ repos: clean });
  }

  /** «Посмотрел»: скрыть PR до новых коммитов. */
  dismiss(item) {
    this.updateSettings({ dismissed: { ...this.settings.dismissed, [item.url]: item.head } }, { refetch: false });
    this.applyReviewFilter();
  }

  clearDismissed() {
    this.updateSettings({ dismissed: {} }, { refetch: false });
    this.applyReviewFilter();
  }

  hiddenCount() {
    return this.reviewAll.filter((i) => this.isHidden(i)).length;
  }

  isHidden(item) {
    return item.reviewed || this.settings.dismissed[item.url] === item.head;
  }

  /** Действие появилось на устройстве — начинаем опрос. */
  retain() {
    if (this.users++ === 0) {
      this.refresh();
      this.timer = setInterval(() => this.refresh(), POLL_MS);
    }
  }

  release() {
    if (--this.users === 0) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  refresh() {
    this.inFlight ??= this.fetch().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  async graphql(token, query) {
    const res = await fetch("https://api.github.com/graphql", {
      method: "POST",
      headers: { Authorization: `bearer ${token}`, "Content-Type": "application/json", "User-Agent": "ajazz-github-plugin" },
      body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 401) {
      const err = new Error("Токен не подходит (401)");
      err.auth = true;
      throw err;
    }
    const body = await res.json();
    if (!res.ok || body.errors) throw new Error(body.errors?.[0]?.message || `HTTP ${res.status}`);
    return body.data;
  }

  async fetch() {
    const token = this.settings.token || (await ghToken());
    const source = this.settings.token ? "token" : token ? "gh" : null;
    if (!token) return this.set({ status: "auth", source: null, user: null, error: "Нет токена: войдите в gh или введите токен" });

    try {
      // Логин нужен заранее: по нему ищем моё последнее ревью в каждом PR.
      const login = this.state.user || (await this.graphql(token, "query { viewer { login } }")).viewer.login;
      const data = await this.graphql(token, buildQuery(login, this.settings.repos));

      const byUrl = new Map();
      for (const pr of nodes(data.requested)) byUrl.set(pr.url, toItem(pr, { requested: true }));
      for (const pr of nodes(data.team)) if (!byUrl.has(pr.url)) byUrl.set(pr.url, toItem(pr, { requested: false }));
      // Сначала PR, где ревью запросили явно, затем — свежие по обновлению.
      this.reviewAll = [...byUrl.values()].sort((a, b) =>
        Number(b.requested) - Number(a.requested) || b.updatedAt.localeCompare(a.updatedAt));

      // Отметки о закрытых PR больше не нужны.
      const dismissed = Object.fromEntries(Object.entries(this.settings.dismissed).filter(([url]) => byUrl.has(url)));
      if (Object.keys(dismissed).length !== Object.keys(this.settings.dismissed).length) {
        this.updateSettings({ dismissed }, { refetch: false });
      }

      const mine = nodes(data.mine).map((pr) => toItem(pr));
      this.set({ status: "ok", source, error: null, user: data.viewer.login, mine: summary(mine, data.mine.issueCount) });
      this.applyReviewFilter();
    } catch (e) {
      log.warn("github request failed", e.message);
      if (e.auth) return this.set({ status: "auth", source, user: null, error: e.message });
      // Оставляем последние данные, только помечаем ошибку.
      this.set({ status: this.state.user ? "ok" : "error", source, error: e.message });
    }
  }

  applyReviewFilter() {
    this.set({ review: summary(this.reviewAll.filter((i) => !this.isHidden(i))) });
  }

  set(patch) {
    this.state = { ...this.state, ...patch };
    this.emit("change");
  }
}

module.exports = { GitHub };
