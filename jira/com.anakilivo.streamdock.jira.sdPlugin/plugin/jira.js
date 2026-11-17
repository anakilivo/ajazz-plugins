"use strict";

// Данные Jira Cloud для всех действий: раз в POLL_MS получаем мои тикеты
// в открытых спринтах — всех или только выбранных бордов (тогда сначала берём
// активные спринты этих бордов через Agile API). Опрашиваем, только пока на
// устройстве видно хотя бы одно действие плагина. Эмитит "change", при изменении
// настроек — "settings".
//
// Вход: сайт (company.atlassian.net), email и API-токен (Basic auth).

const { EventEmitter } = require("events");
const { log } = require("./sdk");

const POLL_MS = 60_000;
const ALL_SPRINTS_JQL = "assignee = currentUser() AND sprint in openSprints() ORDER BY rank";
const FIELDS = ["summary", "status", "issuetype", "priority"];
const MAX_BOARDS = 500;

function sprintsJql(sprintIds) {
  return `assignee = currentUser() AND sprint in (${sprintIds.join(", ")}) ORDER BY rank`;
}

// Сначала то, что в работе, потом «к выполнению»; внутри — порядок спринта (rank).
const CATEGORY_ORDER = { indeterminate: 0, new: 1 };

function normalizeSite(site) {
  return (site || "").trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
}

function toItem(site, issue) {
  const f = issue.fields || {};
  return {
    key: issue.key,
    title: f.summary || "",
    status: f.status?.name || "",
    category: f.status?.statusCategory?.key || "new", // new | indeterminate | done
    type: f.issuetype?.name || "",
    priority: f.priority?.name || "",
    url: `https://${site}/browse/${issue.key}`,
  };
}

class Jira extends EventEmitter {
  constructor() {
    super();
    // status: loading | ok | auth (нет/неверные данные входа) | error (сеть/API)
    this.state = { status: "loading", user: null, error: null, total: 0, done: 0, items: [] };
    this.settings = { site: "", email: "", token: "", boards: [] }; // boards: [{ id, name }]
    this.jql = ALL_SPRINTS_JQL;
    this.users = 0;
    this.timer = null;
    this.inFlight = null;
  }

  /** Настройки из глобальных настроек плагина (один раз при старте). */
  load(settings) {
    this.settings = {
      site: normalizeSite(settings.site),
      email: (settings.email || "").trim(),
      token: (settings.token || "").trim(),
      boards: Array.isArray(settings.boards) ? settings.boards : [],
    };
    this.refresh();
  }

  setBoards(boards) {
    this.updateSettings({ boards: boards.map(({ id, name }) => ({ id: Number(id), name: String(name || id) })) });
  }

  /**
   * Доски со спринтами — для выбора в настройках: scrum (company-managed проекты)
   * и simple (team-managed проекты). Kanban-доски без спринтов не показываем.
   */
  async listBoards() {
    const boards = [];
    for (let startAt = 0; boards.length < MAX_BOARDS; ) {
      const page = await this.api(`/rest/agile/1.0/board?startAt=${startAt}&maxResults=50`);
      const values = page.values || [];
      boards.push(...values.filter((b) => b.type !== "kanban").map((b) => ({
        id: b.id,
        name: b.name,
        project: b.location?.projectKey || b.location?.displayName || "",
      })));
      if (page.isLast || !values.length) break;
      startAt += values.length;
    }
    return boards.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Активные спринты выбранных досок. */
  async activeSprintIds() {
    const lists = await Promise.all(this.settings.boards.map((board) =>
      this.api(`/rest/agile/1.0/board/${board.id}/sprint?state=active&maxResults=50`)
        .then((page) => (page.values || []).map((s) => s.id))
        .catch((e) => {
          // Доску могли удалить или закрыть доступ — остальные доски не ломаем.
          if (e.auth) throw e;
          log.warn("board sprints failed", board.id, e.message);
          return [];
        })));
    return [...new Set(lists.flat())];
  }

  updateSettings(patch) {
    const next = { ...this.settings, ...patch };
    next.site = normalizeSite(next.site);
    next.email = next.email.trim();
    next.token = next.token.trim();
    this.settings = next;
    this.emit("settings", this.settings);
    this.state = { ...this.state, user: null };
    this.refresh();
  }

  /** URL поиска моих тикетов спринта — для клавиши. */
  searchUrl() {
    return `https://${this.settings.site}/issues/?jql=${encodeURIComponent(this.jql)}`;
  }

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

  async api(path, body) {
    const { site, email, token } = this.settings;
    const res = await fetch(`https://${site}${path}`, {
      method: body ? "POST" : "GET",
      headers: {
        Authorization: `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`,
        Accept: "application/json",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 401 || res.status === 403) {
      const err = new Error(`Jira не принимает email/токен (${res.status})`);
      err.auth = true;
      throw err;
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.errorMessages?.[0] || `HTTP ${res.status}`);
    return data;
  }

  async fetch() {
    const { site, email, token } = this.settings;
    if (!site || !email || !token) {
      return this.set({ status: "auth", user: null, error: "Укажите сайт, email и API-токен в настройках" });
    }

    try {
      const user = this.state.user || (await this.api("/rest/api/3/myself")).displayName;

      if (this.settings.boards.length) {
        const sprintIds = await this.activeSprintIds();
        if (!sprintIds.length) {
          // У выбранных досок сейчас нет активных спринтов.
          this.jql = ALL_SPRINTS_JQL;
          return this.set({ status: "ok", user, error: null, total: 0, done: 0, items: [] });
        }
        this.jql = sprintsJql(sprintIds);
      } else {
        this.jql = ALL_SPRINTS_JQL;
      }

      const issues = [];
      let nextPageToken;
      do {
        const page = await this.api("/rest/api/3/search/jql", { jql: this.jql, fields: FIELDS, maxResults: 100, nextPageToken });
        issues.push(...(page.issues || []));
        nextPageToken = page.nextPageToken;
      } while (nextPageToken && issues.length < 500);

      const all = issues.map((i) => toItem(site, i));
      const open = all
        .map((item, rank) => ({ item, rank }))
        .filter(({ item }) => item.category !== "done")
        .sort((a, b) => (CATEGORY_ORDER[a.item.category] ?? 2) - (CATEGORY_ORDER[b.item.category] ?? 2) || a.rank - b.rank)
        .map(({ item }) => item);

      this.set({ status: "ok", user, error: null, total: all.length, done: all.length - open.length, items: open });
    } catch (e) {
      log.warn("jira request failed", e.message);
      if (e.auth) return this.set({ status: "auth", user: null, error: e.message });
      // Оставляем последние данные, только помечаем ошибку.
      this.set({ status: this.state.user ? "ok" : "error", error: e.message });
    }
  }

  set(patch) {
    this.state = { ...this.state, ...patch };
    this.emit("change");
  }
}

module.exports = { Jira };
