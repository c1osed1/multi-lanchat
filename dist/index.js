// src/index.ts
import fs3 from "node:fs";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";

// src/config.ts
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
var here = path.dirname(fileURLToPath(import.meta.url));
var ROOT_DIR = path.resolve(here, "..");
function loadDotenv() {
  const file = path.join(ROOT_DIR, ".env");
  if (!fs.existsSync(file)) return;
  const raw = fs.readFileSync(file, "utf8");
  for (const line of raw.split("\n")) {
    const trimmed2 = line.trim();
    if (!trimmed2 || trimmed2.startsWith("#")) continue;
    const eq = trimmed2.indexOf("=");
    if (eq < 1) continue;
    const key = trimmed2.slice(0, eq).trim();
    let value = trimmed2.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') || value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === void 0) process.env[key] = value;
  }
}
loadDotenv();
function readEnv(name, fallback = "") {
  const raw = process.env[name];
  return typeof raw === "string" ? raw.trim() : fallback;
}
var HOST = readEnv("HOST", "127.0.0.1");
var PORT = Number(readEnv("PORT", "3040")) || 3040;
var DATA_DIR = path.resolve(ROOT_DIR, readEnv("DATA_DIR", "./data"));
var DB_PATH = path.join(DATA_DIR, "bridge.sqlite");
var WEB_DIST = path.join(ROOT_DIR, "web/dist");
var BRIDGE_UI_TOKEN = readEnv("BRIDGE_UI_TOKEN");

// src/api/handlers.ts
import { randomUUID } from "node:crypto";
import { z as z2 } from "zod";

// src/db/repo.ts
import fs2 from "node:fs";
import path2 from "node:path";
import Database from "better-sqlite3";

// src/security.ts
var TOKENISH = /\b(?:lpat_|chantop_|vk1\.a\.|bot)[A-Za-z0-9._\-]+|\d{8,}:[A-Za-z0-9_-]{20,}/g;
function maskSecret(value) {
  const v = (value ?? "").trim();
  if (!v) return "";
  if (v.length <= 8) return "\u2022\u2022\u2022\u2022";
  return `${v.slice(0, 4)}\u2026${v.slice(-4)}`;
}
function redactSecrets(text) {
  return text.replace(TOKENISH, (m) => maskSecret(m));
}
function trimCfg(value) {
  const s = (value ?? "").trim();
  if (!s || s.endsWith("...")) return "";
  return s;
}
function httpBase(url) {
  let u = url.trim().replace(/\/+$/, "");
  if (u.endsWith("/v1")) u = u.slice(0, -3).replace(/\/+$/, "");
  return u;
}
function defaultWsUrl(http) {
  const u = httpBase(http).replace(/^https:/, "wss:").replace(/^http:/, "ws:");
  return `${u}/wsapi`;
}

// src/types.ts
function asMessengerKind(value) {
  if (value === "tg" || value === "max" || value === "vk") return value;
  return "vk";
}
function messengerLabel(kind) {
  if (kind === "vk") return "VK";
  if (kind === "max") return "Max";
  return "Telegram";
}

// src/db/schema.ts
var SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('vk', 'tg', 'max')),
  label TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  token TEXT NOT NULL,
  group_id TEXT NOT NULL DEFAULT '',
  topic_title TEXT NOT NULL DEFAULT '',
  topic_emoji TEXT NOT NULL DEFAULT '',
  topic_token TEXT NOT NULL DEFAULT '',
  topic_chat_id TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS routes (
  message_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  messenger TEXT NOT NULL CHECK (messenger IN ('vk', 'tg', 'max')),
  peer_id TEXT NOT NULL,
  user_id TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  level TEXT NOT NULL CHECK (level IN ('info', 'warn', 'error')),
  source TEXT NOT NULL,
  account_id TEXT,
  message TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('in', 'out')),
  account_id TEXT,
  messenger TEXT NOT NULL CHECK (messenger IN ('vk', 'tg', 'max')),
  peer_id TEXT NOT NULL,
  preview TEXT NOT NULL,
  lan_message_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs (id DESC);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events (id DESC);
CREATE INDEX IF NOT EXISTS idx_routes_account ON routes (account_id);
`;

// src/db/repo.ts
var DEFAULT_SETTINGS = {
  baseUrl: "https://msgpublic.langame.ru",
  lpat: "",
  parentChatId: "",
  wsUrl: "",
  vkApiVersion: "5.199",
  pollEmptySec: 1.2
};
function nowIso() {
  return (/* @__PURE__ */ new Date()).toISOString();
}
function asAccount(row) {
  return {
    id: String(row.id),
    kind: asMessengerKind(row.kind),
    label: String(row.label ?? ""),
    enabled: Number(row.enabled) === 1,
    token: String(row.token ?? ""),
    groupId: String(row.group_id ?? ""),
    topicTitle: String(row.topic_title ?? ""),
    topicEmoji: String(row.topic_emoji ?? ""),
    topicToken: String(row.topic_token ?? ""),
    topicChatId: String(row.topic_chat_id ?? ""),
    createdAt: String(row.created_at ?? ""),
    updatedAt: String(row.updated_at ?? "")
  };
}
function toPublicAccount(row) {
  return {
    id: row.id,
    kind: row.kind,
    label: row.label,
    enabled: row.enabled,
    groupId: row.groupId,
    topicTitle: row.topicTitle,
    topicEmoji: row.topicEmoji,
    topicChatId: row.topicChatId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    tokenHint: maskSecret(row.token),
    topicTokenHint: maskSecret(row.topicToken),
    hasToken: Boolean(row.token),
    hasTopicToken: Boolean(row.topicToken)
  };
}
function tableSql(opened, name) {
  const row = opened.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
  return row?.sql ?? "";
}
function migrateMessengerKind(opened) {
  const tables = ["accounts", "routes", "events"];
  const needs = tables.some((name) => {
    const sql = tableSql(opened, name);
    return Boolean(sql) && !sql.includes("'max'");
  });
  if (!needs) return;
  opened.pragma("foreign_keys = OFF");
  opened.exec("BEGIN");
  try {
    for (const name of tables) {
      const sql = tableSql(opened, name);
      if (!sql || sql.includes("'max'")) continue;
      const tmp = `${name}__max`;
      const next = sql.replace(`CREATE TABLE ${name}`, `CREATE TABLE ${tmp}`).replace("CHECK (kind IN ('vk', 'tg'))", "CHECK (kind IN ('vk', 'tg', 'max'))").replace(
        "CHECK (messenger IN ('vk', 'tg'))",
        "CHECK (messenger IN ('vk', 'tg', 'max'))"
      );
      opened.exec(next);
      opened.exec(`INSERT INTO ${tmp} SELECT * FROM ${name}`);
      opened.exec(`DROP TABLE ${name}`);
      opened.exec(`ALTER TABLE ${tmp} RENAME TO ${name}`);
    }
    opened.exec("COMMIT");
  } catch (e) {
    opened.exec("ROLLBACK");
    throw e;
  } finally {
    opened.pragma("foreign_keys = ON");
    opened.exec(SCHEMA_SQL);
  }
}
var db = null;
function getDb(filePath = DB_PATH) {
  if (db) return db;
  fs2.mkdirSync(path2.dirname(filePath), { recursive: true });
  const opened = new Database(filePath);
  opened.pragma("journal_mode = WAL");
  opened.pragma("foreign_keys = ON");
  opened.exec(SCHEMA_SQL);
  migrateMessengerKind(opened);
  seedSettings(opened);
  db = opened;
  return opened;
}
function seedSettings(opened) {
  const insert = opened.prepare(
    "INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)"
  );
  const seed = {
    baseUrl: DEFAULT_SETTINGS.baseUrl,
    lpat: DEFAULT_SETTINGS.lpat,
    parentChatId: DEFAULT_SETTINGS.parentChatId,
    wsUrl: DEFAULT_SETTINGS.wsUrl,
    vkApiVersion: DEFAULT_SETTINGS.vkApiVersion,
    pollEmptySec: String(DEFAULT_SETTINGS.pollEmptySec)
  };
  const tx = opened.transaction(() => {
    for (const [key, value] of Object.entries(seed)) insert.run(key, value);
  });
  tx();
}
function getSettings() {
  const rows = getDb().prepare("SELECT key, value FROM settings").all();
  const map = new Map(rows.map((r) => [r.key, r.value]));
  const poll = Number(map.get("pollEmptySec") ?? DEFAULT_SETTINGS.pollEmptySec);
  return {
    baseUrl: map.get("baseUrl") ?? DEFAULT_SETTINGS.baseUrl,
    lpat: map.get("lpat") ?? "",
    parentChatId: map.get("parentChatId") ?? "",
    wsUrl: map.get("wsUrl") ?? "",
    vkApiVersion: map.get("vkApiVersion") ?? DEFAULT_SETTINGS.vkApiVersion,
    pollEmptySec: Number.isFinite(poll) && poll > 0 ? poll : DEFAULT_SETTINGS.pollEmptySec
  };
}
function setSettings(patch) {
  const next = { ...getSettings(), ...patch };
  const upsert = getDb().prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  );
  const tx = getDb().transaction(() => {
    upsert.run("baseUrl", next.baseUrl);
    upsert.run("lpat", next.lpat);
    upsert.run("parentChatId", next.parentChatId);
    upsert.run("wsUrl", next.wsUrl);
    upsert.run("vkApiVersion", next.vkApiVersion);
    upsert.run("pollEmptySec", String(next.pollEmptySec));
  });
  tx();
  return getSettings();
}
function listAccounts() {
  const rows = getDb().prepare("SELECT * FROM accounts ORDER BY created_at ASC").all();
  return rows.map(asAccount);
}
function getAccount(id) {
  const row = getDb().prepare("SELECT * FROM accounts WHERE id = ?").get(id);
  return row ? asAccount(row) : null;
}
function insertAccount(row) {
  getDb().prepare(
    `INSERT INTO accounts (
        id, kind, label, enabled, token, group_id, topic_title, topic_emoji,
        topic_token, topic_chat_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    row.id,
    row.kind,
    row.label,
    row.enabled ? 1 : 0,
    row.token,
    row.groupId,
    row.topicTitle,
    row.topicEmoji,
    row.topicToken,
    row.topicChatId,
    row.createdAt,
    row.updatedAt
  );
  return row;
}
function updateAccount(id, patch) {
  const current = getAccount(id);
  if (!current) return null;
  const next = {
    ...current,
    ...patch,
    id,
    updatedAt: nowIso()
  };
  getDb().prepare(
    `UPDATE accounts SET
        kind = ?, label = ?, enabled = ?, token = ?, group_id = ?, topic_title = ?,
        topic_emoji = ?, topic_token = ?, topic_chat_id = ?, updated_at = ?
      WHERE id = ?`
  ).run(
    next.kind,
    next.label,
    next.enabled ? 1 : 0,
    next.token,
    next.groupId,
    next.topicTitle,
    next.topicEmoji,
    next.topicToken,
    next.topicChatId,
    next.updatedAt,
    id
  );
  return next;
}
function deleteAccount(id) {
  const info = getDb().prepare("DELETE FROM accounts WHERE id = ?").run(id);
  return info.changes > 0;
}
function upsertRoute(route) {
  getDb().prepare(
    `INSERT INTO routes (message_id, account_id, messenger, peer_id, user_id, name, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(message_id) DO UPDATE SET
         account_id = excluded.account_id,
         messenger = excluded.messenger,
         peer_id = excluded.peer_id,
         user_id = excluded.user_id,
         name = excluded.name`
  ).run(
    route.messageId,
    route.accountId,
    route.messenger,
    route.peerId,
    route.userId,
    route.name,
    route.createdAt
  );
  pruneRoutes();
}
function getRoute(messageId) {
  const row = getDb().prepare("SELECT * FROM routes WHERE message_id = ?").get(messageId);
  if (!row) return null;
  return {
    messageId: String(row.message_id),
    accountId: String(row.account_id),
    messenger: asMessengerKind(row.messenger),
    peerId: String(row.peer_id),
    userId: String(row.user_id ?? ""),
    name: String(row.name ?? ""),
    createdAt: String(row.created_at ?? "")
  };
}
function pruneRoutes() {
  getDb().prepare(
    `DELETE FROM routes WHERE message_id IN (
         SELECT message_id FROM routes ORDER BY created_at DESC LIMIT -1 OFFSET 4000
       )`
  ).run();
}
function insertLog(entry) {
  const ts = nowIso();
  const info = getDb().prepare(
    "INSERT INTO logs (ts, level, source, account_id, message) VALUES (?, ?, ?, ?, ?)"
  ).run(ts, entry.level, entry.source, entry.accountId ?? null, entry.message);
  pruneLogs();
  return {
    id: Number(info.lastInsertRowid),
    ts,
    level: entry.level,
    source: entry.source,
    accountId: entry.accountId ?? null,
    message: entry.message
  };
}
function pruneLogs() {
  getDb().prepare("DELETE FROM logs WHERE id NOT IN (SELECT id FROM logs ORDER BY id DESC LIMIT 2000)").run();
}
function listLogs(opts) {
  const limit = Math.min(Math.max(opts.limit, 1), 500);
  const clauses = [];
  const params = [];
  if (opts.source) {
    clauses.push("source = ?");
    params.push(opts.source);
  }
  if (opts.accountId) {
    clauses.push("account_id = ?");
    params.push(opts.accountId);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  params.push(limit);
  const rows = getDb().prepare(`SELECT * FROM logs ${where} ORDER BY id DESC LIMIT ?`).all(...params);
  return rows.map((row) => ({
    id: Number(row.id),
    ts: String(row.ts),
    level: row.level ?? "info",
    source: String(row.source),
    accountId: row.account_id ? String(row.account_id) : null,
    message: String(row.message)
  }));
}
function insertEvent(entry) {
  const ts = nowIso();
  const info = getDb().prepare(
    `INSERT INTO events (ts, direction, account_id, messenger, peer_id, preview, lan_message_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    ts,
    entry.direction,
    entry.accountId ?? null,
    entry.messenger,
    entry.peerId,
    entry.preview,
    entry.lanMessageId ?? null
  );
  pruneEvents();
  return {
    id: Number(info.lastInsertRowid),
    ts,
    direction: entry.direction,
    accountId: entry.accountId ?? null,
    messenger: entry.messenger,
    peerId: entry.peerId,
    preview: entry.preview,
    lanMessageId: entry.lanMessageId ?? null
  };
}
function pruneEvents() {
  getDb().prepare(
    "DELETE FROM events WHERE id NOT IN (SELECT id FROM events ORDER BY id DESC LIMIT 500)"
  ).run();
}
function listEvents(limit) {
  const n = Math.min(Math.max(limit, 1), 200);
  const rows = getDb().prepare("SELECT * FROM events ORDER BY id DESC LIMIT ?").all(n);
  return rows.map((row) => ({
    id: Number(row.id),
    ts: String(row.ts),
    direction: row.direction === "out" ? "out" : "in",
    accountId: row.account_id ? String(row.account_id) : null,
    messenger: asMessengerKind(row.messenger),
    peerId: String(row.peer_id),
    preview: String(row.preview),
    lanMessageId: row.lan_message_id ? String(row.lan_message_id) : null
  }));
}

// src/api/live.ts
var clients = /* @__PURE__ */ new Set();
function addLiveClient(reply) {
  clients.add(reply);
}
function removeLiveClient(reply) {
  clients.delete(reply);
}
function broadcastLive(payload) {
  const body = JSON.stringify(payload.data);
  const chunk = `event: ${payload.event}
data: ${redactSecrets(body)}

`;
  for (const reply of clients) {
    try {
      reply.raw.write(chunk);
      const flushed = reply.raw;
      flushed.flush?.();
    } catch {
      clients.delete(reply);
    }
  }
}

// src/bridge/dispatch.ts
import { randomInt } from "node:crypto";

// src/bridge/format.ts
var MARKER_RE = /⟦bridge:(vk|tg|max):([^⟧]+)⟧/;
function parseMarker(text) {
  const m = MARKER_RE.exec(text || "");
  if (!m || m[1] !== "vk" && m[1] !== "tg" && m[1] !== "max" || !m[2]) return null;
  return { messenger: m[1], peerId: m[2] };
}
function formatInbound(input) {
  const label = input.source || messengerLabel(input.messenger);
  const who = input.name || input.userKey || input.peerId;
  const uid = input.userKey || (input.peerId ? `id${input.peerId}` : "");
  let body = input.text.trim() || (input.nAtt ? `(\u0432\u043B\u043E\u0436\u0435\u043D\u0438\u0435 \xD7${input.nAtt})` : "(\u043F\u0443\u0441\u0442\u043E)");
  if (input.nAtt && input.text.trim()) body += `
(+\u0432\u043B\u043E\u0436\u0435\u043D\u0438\u0439: ${input.nAtt})`;
  return [
    `\u27E6bridge:${input.messenger}:${input.peerId}\u27E7`,
    label,
    who,
    uid,
    "",
    "",
    body
  ].join("\n");
}
var START_RE = /^\/start(?:@[A-Za-z0-9_]+)?(?:\s|$)/i;
function botStartInboundText(text, started = false) {
  if (started) return "\u0437\u0430\u043F\u0443\u0441\u0442\u0438\u043B \u0431\u043E\u0442\u0430";
  const raw = text.trim();
  if (START_RE.test(raw)) return "\u0437\u0430\u043F\u0443\u0441\u0442\u0438\u043B \u0431\u043E\u0442\u0430";
  return raw;
}
var telegramInboundText = botStartInboundText;
function previewText(text, max = 160) {
  const one = text.replace(/\s+/g, " ").trim();
  if (one.length <= max) return one;
  return `${one.slice(0, max - 1)}\u2026`;
}

// src/bridge/http.ts
async function httpJson(url, opts = {}) {
  const method = opts.method ?? "GET";
  const headers = new Headers(opts.headers ?? {});
  headers.set("Accept", "application/json");
  let body;
  if (opts.data !== void 0) {
    if (opts.form) {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(opts.data)) {
        if (v === void 0 || v === null) continue;
        params.set(k, String(v));
      }
      body = params.toString();
      if (!headers.has("Content-Type")) {
        headers.set("Content-Type", "application/x-www-form-urlencoded");
      }
    } else {
      body = JSON.stringify(opts.data);
      if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    }
  }
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? 6e4);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  const res = await fetch(url, { method, headers, body, signal });
  const raw = await res.text();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${method} ${url}: ${raw.slice(0, 500)}`);
  }
  if (!raw) return null;
  const ctype = (res.headers.get("content-type") || "").toLowerCase();
  if (!ctype.includes("json") && !"{[".includes(raw.trim()[0] ?? "")) {
    throw new Error(`non-JSON ${method} ${url}: ${ctype} ${raw.slice(0, 180)}`);
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`bad JSON ${method} ${url}: ${raw.slice(0, 180)}`);
  }
}

// src/bridge/lanchat.ts
function lanFromSettings(s) {
  return { base: s.baseUrl.replace(/\/+$/, ""), lpat: s.lpat };
}
function lcUser(lc, path3, method = "GET", body, signal) {
  return httpJson(`${lc.base}${path3}`, {
    method,
    data: body,
    headers: { Authorization: `Bearer ${lc.lpat}` },
    signal
  });
}
function lcTopic(base, token, path3, method = "GET", body, signal) {
  return httpJson(`${base.replace(/\/+$/, "")}${path3}`, {
    method,
    data: body,
    headers: { Authorization: `Bearer ${token}` },
    signal
  });
}

// src/bridge/logger.ts
var logBridge = {
  write(level, source, message, accountId) {
    const row = insertLog({
      level,
      source,
      accountId,
      message: redactSecrets(message)
    });
    broadcastLive({ event: "log", data: row });
    const line = `${row.ts} [${level}] ${source}${accountId ? `:${accountId.slice(0, 8)}` : ""} ${row.message}`;
    if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else console.log(line);
  },
  info(source, message, accountId) {
    this.write("info", source, message, accountId);
  },
  warn(source, message, accountId) {
    this.write("warn", source, message, accountId);
  },
  error(source, message, accountId) {
    this.write("error", source, message, accountId);
  }
};
function recordEvent(input) {
  const row = insertEvent(input);
  broadcastLive({ event: "bridge-event", data: row });
}

// src/bridge/dispatch.ts
var ownIds = /* @__PURE__ */ new Set();
var ownOrder = [];
function rememberOwn(mid) {
  if (!mid) return;
  if (ownIds.has(mid)) return;
  ownIds.add(mid);
  ownOrder.push(mid);
  while (ownOrder.length > 8e3) {
    const old = ownOrder.shift();
    if (old) ownIds.delete(old);
  }
}
function isOwn(mid) {
  return ownIds.has(mid);
}
function forgetOwn(mid) {
  ownIds.delete(mid);
}
function asRecord(v) {
  return v && typeof v === "object" ? v : {};
}
async function sendToTopic(settings, bind, route, text, signal) {
  const out = asRecord(
    await lcTopic(settings.baseUrl, bind.token, "/api/channels/send", "POST", { text }, signal)
  );
  const mid = out.messageId ? String(out.messageId) : null;
  rememberOwn(mid);
  if (mid) {
    upsertRoute({
      messageId: mid,
      accountId: route.accountId,
      messenger: route.messenger,
      peerId: route.peerId,
      userId: route.userId,
      name: route.name,
      createdAt: (/* @__PURE__ */ new Date()).toISOString()
    });
  }
  return mid;
}
async function drainTopicQueue(settings, bind, signal) {
  while (!signal?.aborted) {
    const data = asRecord(
      await lcTopic(settings.baseUrl, bind.token, "/api/channels/next", "GET", void 0, signal)
    );
    const msg = asRecord(data.message);
    if (!msg.id) return;
    const mid = String(msg.id);
    const own = isOwn(mid);
    if (own) forgetOwn(mid);
    try {
      await lcTopic(
        settings.baseUrl,
        bind.token,
        "/api/channels/read",
        "POST",
        { messageId: mid, status: true },
        signal
      );
      if (own) logBridge.info("queue", `ack own ${bind.key} ${mid}`, bind.accountId);
    } catch (e) {
      logBridge.warn("queue", `ack fail ${String(e)}`, bind.accountId);
      return;
    }
  }
}
function resolvedWsUrl(settings) {
  return settings.wsUrl.trim() || defaultWsUrl(httpBase(settings.baseUrl));
}
async function handleStaffMessage(chatId, message, sendOutbound, signal) {
  const mid = message.id ? String(message.id) : "";
  if (!mid) return;
  if (isOwn(mid)) return;
  const replyTo = message.replyToMessageId ? String(message.replyToMessageId) : "";
  if (getRoute(mid) && !replyTo) return;
  const preview = asRecord(message.replyToPreview).text;
  let route = replyTo ? getRoute(replyTo) : null;
  if (!route && typeof preview === "string") {
    const hint = parseMarker(preview);
    if (hint) {
      route = {
        messageId: replyTo,
        accountId: "",
        messenger: hint.messenger,
        peerId: hint.peerId,
        userId: "",
        name: "",
        createdAt: (/* @__PURE__ */ new Date()).toISOString()
      };
    }
  }
  if (!route) {
    if (replyTo) logBridge.warn("ws", `reply without route ${mid} \u2192 ${replyTo}`);
    else logBridge.info("ws", `ignore non-reply in topic ${chatId} ${mid}`);
    return;
  }
  const text = String(message.text ?? "");
  try {
    await sendOutbound(route, text, signal);
    upsertRoute({ ...route, messageId: mid, createdAt: (/* @__PURE__ */ new Date()).toISOString() });
    recordEvent({
      direction: "out",
      accountId: route.accountId || null,
      messenger: route.messenger,
      peerId: route.peerId,
      preview: previewText(text),
      lanMessageId: mid
    });
    logBridge.info("ws", `lan\u2192${route.messenger} ${route.peerId} ${mid}`, route.accountId || null);
  } catch (e) {
    logBridge.error("ws", `deliver fail ${String(e)}`, route.accountId || null);
  }
}
async function vkApi(token, version, method, params, signal) {
  const data = asRecord(
    await httpJson(`https://api.vk.com/method/${method}`, {
      method: "POST",
      form: true,
      data: { ...params, access_token: token, v: version },
      timeoutMs: 35e3,
      signal
    })
  );
  const err = asRecord(data.error);
  if (Object.keys(err).length) {
    throw new Error(`VK ${method}: [${err.error_code}] ${err.error_msg}`);
  }
  return data.response;
}
async function tgApi(token, method, params = {}, signal) {
  const data = asRecord(
    await httpJson(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      data: params,
      timeoutMs: 4e4,
      signal
    })
  );
  if (!data.ok) throw new Error(`TG ${method}: ${JSON.stringify(data).slice(0, 240)}`);
  return data.result;
}
async function maxApi(token, method, path3, opts = {}) {
  const url = new URL(path3, "https://platform-api2.max.ru");
  for (const [key, value] of Object.entries(opts.query ?? {})) {
    if (value === void 0 || value === "") continue;
    url.searchParams.set(key, String(value));
  }
  return httpJson(url.toString(), {
    method,
    data: opts.data,
    headers: { Authorization: token },
    timeoutMs: opts.timeoutMs ?? 4e4,
    signal: opts.signal
  });
}
async function deliverOutbound(settings, account, route, text, signal) {
  const body = text.trim() || "(\u043F\u0443\u0441\u0442\u043E)";
  if (route.messenger === "vk") {
    await vkApi(
      account.token,
      settings.vkApiVersion,
      "messages.send",
      {
        peer_id: Number(route.peerId),
        random_id: randomInt(1, 2e9),
        message: body
      },
      signal
    );
    return;
  }
  if (route.messenger === "tg") {
    await tgApi(account.token, "sendMessage", { chat_id: Number(route.peerId), text: body }, signal);
    return;
  }
  if (route.messenger === "max") {
    await maxApi(account.token, "POST", "/messages", {
      query: { chat_id: Number(route.peerId) },
      data: { text: body },
      signal
    });
    return;
  }
  throw new Error(`unknown messenger ${route.messenger}`);
}

// src/bridge/telegram.ts
function asRecord2(v) {
  return v && typeof v === "object" ? v : {};
}
async function telegramLoop(settings, account, bind, signal) {
  let offset = 0;
  logBridge.info("tg", "polling", account.id);
  while (!signal.aborted) {
    try {
      const updates = await tgApi(
        account.token,
        "getUpdates",
        { offset, timeout: 25, allowed_updates: JSON.stringify(["message"]) },
        signal
      );
      for (const raw of updates ?? []) {
        const u = asRecord2(raw);
        offset = Math.max(offset, Number(u.update_id ?? 0) + 1);
        const m = asRecord2(u.message);
        const chat = asRecord2(m.chat);
        if (!chat.id) continue;
        const chatId = String(chat.id);
        const fromU = asRecord2(m.from);
        if (fromU.is_bot) continue;
        const uid = String(fromU.id ?? "");
        const uname = fromU.username ? `@${fromU.username}` : "";
        const name = [fromU.first_name, fromU.last_name].filter(Boolean).join(" ").trim() || uname || uid;
        let nAtt = 0;
        for (const k of ["photo", "document", "video", "audio", "voice", "sticker", "animation"]) {
          if (m[k]) nAtt += 1;
        }
        const inbound = telegramInboundText(String(m.text ?? m.caption ?? ""));
        const text = formatInbound({
          messenger: "tg",
          name,
          userKey: uname || uid,
          peerId: chatId,
          text: inbound,
          nAtt,
          source: account.label || "Telegram"
        });
        const mid = await sendToTopic(
          settings,
          bind,
          { accountId: account.id, messenger: "tg", peerId: chatId, userId: uid, name },
          text,
          signal
        );
        recordEvent({
          direction: "in",
          accountId: account.id,
          messenger: "tg",
          peerId: chatId,
          preview: previewText(inbound || `(\u0432\u043B\u043E\u0436\u0435\u043D\u0438\u0435 \xD7${nAtt})`),
          lanMessageId: mid
        });
        logBridge.info("tg", `tg\u2192lan ${chatId} ${mid ?? ""}`, account.id);
      }
    } catch (e) {
      if (signal.aborted) return;
      logBridge.warn("tg", `poll ${String(e)}`, account.id);
      await sleep(2e3, signal);
    }
  }
}
function sleep(ms, signal) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true }
    );
  });
}

// src/bridge/max.ts
function asRecord3(v) {
  return v && typeof v === "object" ? v : {};
}
function displayName(user) {
  const uid = String(user.user_id ?? user.id ?? "");
  const uname = user.username ? `@${user.username}` : "";
  const name = String(user.name ?? "").trim() || [user.first_name, user.last_name].filter(Boolean).join(" ").trim() || uname || uid;
  return { uid, name, uname };
}
async function ingest(settings, account, bind, input, signal) {
  if (!input.peerId) return;
  const inbound = botStartInboundText(input.text, input.started);
  const text = formatInbound({
    messenger: "max",
    name: input.name,
    userKey: input.uname || input.uid,
    peerId: input.peerId,
    text: inbound,
    nAtt: input.nAtt,
    source: account.label || "Max"
  });
  const mid = await sendToTopic(
    settings,
    bind,
    {
      accountId: account.id,
      messenger: "max",
      peerId: input.peerId,
      userId: input.uid,
      name: input.name
    },
    text,
    signal
  );
  recordEvent({
    direction: "in",
    accountId: account.id,
    messenger: "max",
    peerId: input.peerId,
    preview: previewText(inbound || (input.nAtt ? `(\u0432\u043B\u043E\u0436\u0435\u043D\u0438\u0435 \xD7${input.nAtt})` : "")),
    lanMessageId: mid
  });
  logBridge.info("max", `max\u2192lan ${input.peerId} ${mid ?? ""}`, account.id);
}
async function handleUpdate(settings, account, bind, raw, signal) {
  const u = asRecord3(raw);
  const type = String(u.update_type ?? u.type ?? "");
  if (type === "bot_started") {
    const user2 = displayName(asRecord3(u.user));
    const peerId2 = String(u.chat_id ?? user2.uid);
    await ingest(
      settings,
      account,
      bind,
      { peerId: peerId2, ...user2, text: "", nAtt: 0, started: true },
      signal
    );
    return;
  }
  if (type !== "message_created") return;
  const message = asRecord3(u.message);
  const sender = asRecord3(message.sender ?? message.from);
  if (sender.is_bot) return;
  const user = displayName(sender);
  const recipient = asRecord3(message.recipient);
  const peerId = String(recipient.chat_id ?? message.chat_id ?? u.chat_id ?? recipient.user_id ?? "");
  const body = asRecord3(message.body);
  const attachments = Array.isArray(body.attachments) ? body.attachments : Array.isArray(message.attachments) ? message.attachments : [];
  await ingest(
    settings,
    account,
    bind,
    {
      peerId,
      ...user,
      text: String(body.text ?? message.text ?? ""),
      nAtt: attachments.length
    },
    signal
  );
}
async function maxLoop(settings, account, bind, signal) {
  let marker;
  logBridge.info("max", "polling", account.id);
  while (!signal.aborted) {
    try {
      const page = asRecord3(
        await maxApi(account.token, "GET", "/updates", {
          query: {
            limit: 100,
            timeout: 25,
            marker,
            types: "message_created,bot_started"
          },
          timeoutMs: 4e4,
          signal
        })
      );
      const updates = Array.isArray(page.updates) ? page.updates : [];
      for (const raw of updates) {
        try {
          await handleUpdate(settings, account, bind, raw, signal);
        } catch (e) {
          logBridge.warn("max", `update ${String(e)}`, account.id);
        }
      }
      if (page.marker !== void 0 && page.marker !== null) {
        const next = Number(page.marker);
        marker = Number.isFinite(next) ? next : marker;
      }
    } catch (e) {
      if (signal.aborted) return;
      logBridge.warn("max", `poll ${String(e)}`, account.id);
      await sleep2(2e3, signal);
    }
  }
}
function sleep2(ms, signal) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true }
    );
  });
}

// src/bridge/topics.ts
function asRecord4(v) {
  return v && typeof v === "object" ? v : {};
}
async function listTopics(settings, signal) {
  const lc = lanFromSettings(settings);
  const listed = await lcUser(lc, `/api/public/chats/${settings.parentChatId}/topics`, "GET", void 0, signal);
  const rec = asRecord4(listed);
  const items = Array.isArray(rec.topics) ? rec.topics : listed;
  return Array.isArray(items) ? items.map(asRecord4) : [];
}
async function topicToken(settings, topicId, signal) {
  const lc = lanFromSettings(settings);
  const tok = asRecord4(
    await lcUser(
      lc,
      `/api/public/chats/${settings.parentChatId}/topics/${topicId}/channel-token`,
      "GET",
      void 0,
      signal
    )
  );
  const token = String(tok.token ?? "");
  if (!token) throw new Error("channel-token empty");
  return token;
}
async function chatIdFromChannelToken(settings, token, signal) {
  const data = asRecord4(
    await lcTopic(settings.baseUrl, token, "/api/channels/messages?limit=1", "GET", void 0, signal)
  );
  const msgs = Array.isArray(data.messages) ? data.messages : [];
  const first = asRecord4(msgs[0]);
  const chatId = String(first.chatId ?? "");
  if (!chatId) throw new Error("channel token has no messages to infer chatId");
  return chatId;
}
async function ensureTopic(settings, account, signal) {
  const title = account.topicTitle.trim() || account.label || messengerLabel(account.kind);
  let token = trimCfg(account.topicToken);
  let chatId = trimCfg(account.topicChatId);
  if (token && chatId) {
    return { accountId: account.id, key: account.kind, title, chatId, token };
  }
  if (token && !chatId) {
    if (settings.lpat.startsWith("lpat_") && settings.parentChatId) {
      for (const t of await listTopics(settings, signal)) {
        const tid = String(t.id ?? "");
        if (!tid) continue;
        try {
          if (await topicToken(settings, tid, signal) === token) {
            persistTopic(account.id, token, tid, title);
            return { accountId: account.id, key: account.kind, title: String(t.title || title), chatId: tid, token };
          }
        } catch (e) {
          logBridge.warn("topic", `token lookup ${tid}: ${String(e)}`, account.id);
        }
      }
    }
    try {
      chatId = await chatIdFromChannelToken(settings, token, signal);
      persistTopic(account.id, token, chatId, title);
      return { accountId: account.id, key: account.kind, title, chatId, token };
    } catch (e) {
      logBridge.warn("topic", `infer chatId: ${String(e)}`, account.id);
    }
  }
  if (!settings.lpat.startsWith("lpat_") || !settings.parentChatId) {
    throw new Error(
      `\u0442\u0435\u043C\u0430 \xAB${title}\xBB: \u0443\u043A\u0430\u0436\u0438 token+chat id \u0442\u0435\u043C\u044B \u0438\u043B\u0438 LPAT + parent chat \u0434\u043B\u044F \u0430\u0432\u0442\u043E\u0441\u043E\u0437\u0434\u0430\u043D\u0438\u044F`
    );
  }
  const items = await listTopics(settings, signal);
  let found = items.find((t) => String(t.title ?? "").trim().toLowerCase() === title.toLowerCase()) ?? null;
  if (!found) {
    const created = asRecord4(
      await lcUser(
        lanFromSettings(settings),
        `/api/public/chats/${settings.parentChatId}/topics`,
        "POST",
        { title },
        signal
      )
    );
    found = created;
    logBridge.info("topic", `created \xAB${title}\xBB ${String(created.id ?? "")}`, account.id);
  }
  chatId = String(found.id ?? "");
  if (!chatId) throw new Error("topic create/list returned no id");
  if (!token) token = await topicToken(settings, chatId, signal);
  persistTopic(account.id, token, chatId, title);
  return { accountId: account.id, key: account.kind, title, chatId, token };
}
function persistTopic(accountId, token, chatId, title) {
  updateAccount(accountId, {
    topicToken: token,
    topicChatId: chatId,
    topicTitle: title,
    topicEmoji: ""
  });
}

// src/bridge/vk.ts
function asRecord5(v) {
  return v && typeof v === "object" ? v : {};
}
function vkLpUrl(server) {
  const s = server.trim();
  if (s.startsWith("http://") || s.startsWith("https://")) return s;
  return `https://${s.replace(/^\/+/, "")}`;
}
async function refreshLongPoll(account, settings, signal) {
  const gid = Number(account.groupId);
  try {
    const lp = asRecord5(
      await vkApi(account.token, settings.vkApiVersion, "groups.getLongPollServer", { group_id: gid }, signal)
    );
    return { server: String(lp.server ?? ""), key: String(lp.key ?? ""), ts: String(lp.ts ?? "") };
  } catch {
    const lp = asRecord5(
      await vkApi(
        account.token,
        settings.vkApiVersion,
        "messages.getLongPollServer",
        { group_id: gid, lp_version: 3 },
        signal
      )
    );
    return { server: String(lp.server ?? ""), key: String(lp.key ?? ""), ts: String(lp.ts ?? "") };
  }
}
async function fetchMessage(account, settings, messageId, signal) {
  try {
    const data = asRecord5(
      await vkApi(
        account.token,
        settings.vkApiVersion,
        "messages.getById",
        { message_ids: String(messageId), group_id: Number(account.groupId) },
        signal
      )
    );
    const items = Array.isArray(data.items) ? data.items : [];
    return items[0] ? asRecord5(items[0]) : null;
  } catch (e) {
    logBridge.warn("vk", `getById ${messageId} ${String(e)}`, account.id);
    return null;
  }
}
var groupTitleCache = /* @__PURE__ */ new Map();
async function groupTitle(account, settings, signal) {
  const cached = groupTitleCache.get(account.id);
  if (cached) return cached;
  try {
    const data = asRecord5(
      await vkApi(
        account.token,
        settings.vkApiVersion,
        "groups.getById",
        { group_id: Number(account.groupId) },
        signal
      )
    );
    const groups = Array.isArray(data.groups) ? data.groups : Array.isArray(data) ? data : [];
    const name = String(asRecord5(groups[0]).name ?? "").trim();
    const title = name || account.label || "VK";
    groupTitleCache.set(account.id, title);
    return title;
  } catch (e) {
    logBridge.warn("vk", `group title ${String(e)}`, account.id);
    const title = account.label || "VK";
    groupTitleCache.set(account.id, title);
    return title;
  }
}
async function displayName2(account, settings, fromId, signal) {
  if (!fromId || fromId.startsWith("-")) return fromId;
  try {
    const users = await vkApi(
      account.token,
      settings.vkApiVersion,
      "users.get",
      { user_ids: fromId },
      signal
    );
    const u = asRecord5(users?.[0]);
    const name = `${u.first_name ?? ""} ${u.last_name ?? ""}`.trim();
    return name || fromId;
  } catch {
    return fromId;
  }
}
async function ingest2(settings, account, bind, m, signal) {
  if (!m || Number(m.out) === 1) return;
  const peer = String(m.peer_id ?? "");
  const fromId = String(m.from_id ?? "");
  if (!peer) return;
  const name = fromId ? await displayName2(account, settings, fromId, signal) : peer;
  const nAtt = Array.isArray(m.attachments) ? m.attachments.length : 0;
  const source = await groupTitle(account, settings, signal);
  const text = formatInbound({
    messenger: "vk",
    name,
    userKey: fromId ? `id${fromId}` : "",
    peerId: peer,
    text: String(m.text ?? ""),
    nAtt,
    source
  });
  const mid = await sendToTopic(
    settings,
    bind,
    {
      accountId: account.id,
      messenger: "vk",
      peerId: peer,
      userId: fromId,
      name
    },
    text,
    signal
  );
  recordEvent({
    direction: "in",
    accountId: account.id,
    messenger: "vk",
    peerId: peer,
    preview: previewText(String(m.text ?? "") || `(\u0432\u043B\u043E\u0436\u0435\u043D\u0438\u0435 \xD7${nAtt})`),
    lanMessageId: mid
  });
  logBridge.info("vk", `vk\u2192lan ${peer} ${mid ?? ""}`, account.id);
}
async function handleUpdate2(settings, account, bind, u, signal) {
  if (u && typeof u === "object" && !Array.isArray(u)) {
    const rec = asRecord5(u);
    if (rec.type !== "message_new") return;
    await ingest2(settings, account, bind, asRecord5(asRecord5(rec.object).message), signal);
    return;
  }
  if (!Array.isArray(u) || u.length === 0) return;
  if (u[0] !== 4) return;
  const flags = Number(u[2] ?? 0);
  if (flags & 2) return;
  const full = typeof u[1] === "number" || typeof u[1] === "string" ? await fetchMessage(account, settings, Number(u[1]), signal) : null;
  if (full) {
    await ingest2(settings, account, bind, full, signal);
    return;
  }
  const extra = u[6] && typeof u[6] === "object" ? asRecord5(u[6]) : {};
  const peer = String(u[3] ?? "");
  const fromId = String(extra.from || peer);
  await ingest2(
    settings,
    account,
    bind,
    { peer_id: peer, from_id: fromId, text: String(u[5] ?? ""), attachments: [], out: 0 },
    signal
  );
}
async function vkLoop(settings, account, bind, signal) {
  logBridge.info("vk", `group ${await groupTitle(account, settings, signal)}`, account.id);
  let lp = await refreshLongPoll(account, settings, signal);
  logBridge.info("vk", "lp ready", account.id);
  while (!signal.aborted) {
    try {
      const q = new URLSearchParams({
        act: "a_check",
        key: lp.key,
        ts: lp.ts,
        wait: "25",
        mode: "2",
        version: "3"
      });
      const data = asRecord5(await httpJson(`${vkLpUrl(lp.server)}?${q}`, { timeoutMs: 35e3, signal }));
      if (data.failed) {
        if (Number(data.failed) === 1 && data.ts) {
          lp = { ...lp, ts: String(data.ts) };
          continue;
        }
        lp = await refreshLongPoll(account, settings, signal);
        continue;
      }
      lp = { ...lp, ts: String(data.ts ?? lp.ts) };
      const updates = Array.isArray(data.updates) ? data.updates : [];
      for (const u of updates) {
        try {
          await handleUpdate2(settings, account, bind, u, signal);
        } catch (e) {
          logBridge.warn("vk", `update ${String(e)}`, account.id);
        }
      }
    } catch (e) {
      if (signal.aborted) return;
      logBridge.warn("vk", `lp ${String(e)}`, account.id);
      await sleep3(2e3, signal);
      try {
        lp = await refreshLongPoll(account, settings, signal);
      } catch (e2) {
        logBridge.warn("vk", `refresh ${String(e2)}`, account.id);
        await sleep3(5e3, signal);
      }
    }
  }
}
function sleep3(ms, signal) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true }
    );
  });
}

// src/bridge/ws.ts
import { decode, encode } from "@msgpack/msgpack";
import WebSocket from "ws";
var LanChatSocket = class {
  constructor(settings, topicIds, onStaff, onStatus) {
    this.settings = settings;
    this.topicIds = topicIds;
    this.onStaff = onStaff;
    this.onStatus = onStatus;
  }
  ws = null;
  stop = false;
  ping = null;
  status = "idle";
  lastError = null;
  start() {
    this.stop = false;
    void this.loop();
  }
  stopNow() {
    this.stop = true;
    this.clearPing();
    this.ws?.close();
    this.ws = null;
    this.setStatus("idle");
  }
  sendJson(payload) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(encode(payload));
  }
  subscribeAll() {
    for (const chatId of this.topicIds()) {
      this.sendJson({ t: "subscribe", chatId });
    }
  }
  subscribe(chatId) {
    this.sendJson({ t: "subscribe", chatId });
  }
  setStatus(next, error = this.lastError) {
    const changed = this.status !== next || this.lastError !== error;
    this.status = next;
    this.lastError = error;
    if (changed) this.onStatus?.();
  }
  clearPing() {
    if (this.ping) clearInterval(this.ping);
    this.ping = null;
  }
  async loop() {
    while (!this.stop) {
      const settings = this.settings();
      const url = `${resolvedWsUrl(settings)}?token=${encodeURIComponent(settings.lpat)}`;
      this.setStatus("connecting", null);
      logBridge.info("ws", `connecting ${resolvedWsUrl(settings)}`);
      try {
        await this.connectOnce(url);
      } catch (e) {
        this.setStatus("error", String(e));
        logBridge.warn("ws", `loop ${String(e)}`);
      }
      if (this.stop) return;
      await sleep4(3e3);
    }
  }
  connectOnce(url) {
    return new Promise((resolve) => {
      const ws = new WebSocket(url);
      this.ws = ws;
      ws.on("open", () => {
        logBridge.info("ws", "tcp open");
        this.sendJson({ t: "auth", token: this.settings().lpat });
        this.clearPing();
        this.ping = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) this.sendJson({ t: "ping", ts: Date.now() });
        }, 25e3);
      });
      ws.on("message", (raw) => {
        void this.onMessage(raw);
      });
      ws.on("error", (err) => {
        this.setStatus("error", String(err));
        logBridge.warn("ws", `err ${String(err)}`);
      });
      ws.on("close", (code, reason) => {
        this.clearPing();
        if (!this.stop) this.setStatus("connecting");
        logBridge.info("ws", `close ${code} ${reason.toString()}`);
        resolve();
      });
    });
  }
  async onMessage(raw) {
    let msg;
    try {
      const bytes = toBytes(raw);
      if (bytes) msg = decode(bytes);
      else msg = JSON.parse(String(raw));
    } catch (e) {
      logBridge.warn("ws", `decode ${String(e)}`);
      return;
    }
    const t = msg.t;
    if (t === "authed") {
      this.setStatus("authed", null);
      const user = msg.user && typeof msg.user === "object" ? msg.user : {};
      logBridge.info("ws", `authed ${user.id ?? ""}`);
      this.subscribeAll();
      return;
    }
    if (t === "chats_available" || t === "inbox_subscribed" || t === "subscription_snapshot") {
      this.subscribeAll();
      return;
    }
    if (t === "subscribed") {
      logBridge.info("ws", `subscribed ${String(msg.chatId ?? "")}`);
      return;
    }
    if (t === "message_new") {
      const chatId = String(msg.chatId ?? "");
      if (this.topicIds().has(chatId)) {
        const message = msg.message && typeof msg.message === "object" ? msg.message : {};
        await this.onStaff(chatId, message);
      }
      return;
    }
    if (t === "error") {
      logBridge.warn("ws", `error ${JSON.stringify(msg)}`);
      return;
    }
  }
};
function toBytes(raw) {
  if (Buffer.isBuffer(raw)) return raw;
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
  if (raw instanceof Uint8Array) return raw;
  if (Array.isArray(raw)) return Buffer.concat(raw);
  return null;
}
function sleep4(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// src/bridge/manager.ts
function sleep5(ms, signal) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true }
    );
  });
}
var BridgeManager = class {
  abort = null;
  socket = null;
  startedAt = null;
  runtime = /* @__PURE__ */ new Map();
  binds = /* @__PURE__ */ new Map();
  running = false;
  getStatus() {
    const accounts = listAccounts().map((a) => {
      const rt = this.runtime.get(a.id);
      const bind = this.binds.get(a.id);
      return {
        accountId: a.id,
        state: !a.enabled ? "disabled" : rt?.state ?? "idle",
        lastError: rt?.lastError ?? null,
        lastEventAt: rt?.lastEventAt ?? null,
        topicChatId: bind?.chatId ?? (a.topicChatId || null),
        topicTitle: bind?.title ?? (a.topicTitle || null)
      };
    });
    return {
      running: this.running,
      ws: this.socket?.status ?? "idle",
      wsError: this.socket?.lastError ?? null,
      startedAt: this.startedAt,
      accounts
    };
  }
  publishStatus() {
    broadcastLive({ event: "status", data: this.getStatus() });
  }
  setRuntime(accountId, patch) {
    const prev = this.runtime.get(accountId) ?? {
      accountId,
      state: "idle",
      lastError: null,
      lastEventAt: null,
      topicChatId: null,
      topicTitle: null
    };
    this.runtime.set(accountId, { ...prev, ...patch, accountId });
    this.publishStatus();
  }
  topicIds() {
    return new Set([...this.binds.values()].map((b) => b.chatId).filter(Boolean));
  }
  accountForChat(chatId) {
    for (const bind of this.binds.values()) {
      if (bind.chatId === chatId) return getAccount(bind.accountId);
    }
    return null;
  }
  accountForRoute(route) {
    if (route.accountId) {
      const found = getAccount(route.accountId);
      if (found) return found;
    }
    const matches = listAccounts().filter((a) => a.enabled && a.kind === route.messenger);
    return matches[0] ?? null;
  }
  async start() {
    if (this.running) return;
    const settings = normalizedSettings();
    if (!settings.lpat.startsWith("lpat_")) {
      throw new Error("\u0417\u0430\u043F\u043E\u043B\u043D\u0438 LPAT \u0432 \u043D\u0430\u0441\u0442\u0440\u043E\u0439\u043A\u0430\u0445 (\u0442\u043E\u043A\u0435\u043D lpat_\u2026 \u0434\u043B\u044F WS \u0438 \u043E\u0442\u0432\u0435\u0442\u0430 \u0432 \u0442\u0435\u043C\u0435)");
    }
    const enabled = listAccounts().filter((a) => a.enabled);
    if (enabled.length === 0) {
      throw new Error("\u0412\u043A\u043B\u044E\u0447\u0438 \u0445\u043E\u0442\u044F \u0431\u044B \u043E\u0434\u0438\u043D VK \u0438\u043B\u0438 Telegram \u0430\u043A\u043A\u0430\u0443\u043D\u0442");
    }
    this.abort = new AbortController();
    const { signal } = this.abort;
    this.running = true;
    this.startedAt = (/* @__PURE__ */ new Date()).toISOString();
    this.binds.clear();
    this.runtime.clear();
    logBridge.info("sys", `start ${settings.baseUrl} vk/tg accounts=${enabled.length}`);
    try {
      for (const account of enabled) {
        const bind = await ensureTopic(settings, account, signal);
        this.binds.set(account.id, bind);
        this.setRuntime(account.id, {
          state: "running",
          lastError: null,
          topicChatId: bind.chatId,
          topicTitle: bind.title
        });
        logBridge.info("topic", `${bind.title} ${bind.chatId}`, account.id);
      }
    } catch (e) {
      this.running = false;
      this.abort.abort();
      this.abort = null;
      throw e;
    }
    this.socket = new LanChatSocket(
      () => normalizedSettings(),
      () => this.topicIds(),
      async (chatId, message) => {
        await handleStaffMessage(
          chatId,
          message,
          async (route, text, sig) => {
            const account = this.accountForRoute(route) ?? this.accountForChat(chatId);
            if (!account) throw new Error("no account for outbound route");
            await deliverOutbound(normalizedSettings(), account, route, text, sig);
          },
          signal
        );
      },
      () => this.publishStatus()
    );
    this.socket.start();
    void this.queueLoop(settings, signal);
    for (const account of enabled) {
      const bind = this.binds.get(account.id);
      if (!bind) continue;
      void this.accountLoop(account, bind, signal);
    }
    this.publishStatus();
  }
  async stop() {
    if (!this.running && !this.abort) return;
    logBridge.info("sys", "stopping\u2026");
    this.running = false;
    this.abort?.abort();
    this.abort = null;
    this.socket?.stopNow();
    this.socket = null;
    for (const [id, rt] of this.runtime) {
      if (rt.state === "running") this.runtime.set(id, { ...rt, state: "idle" });
    }
    this.publishStatus();
  }
  async restart() {
    await this.stop();
    await this.start();
  }
  async syncIfRunning() {
    if (!this.running) {
      this.publishStatus();
      return;
    }
    await this.restart();
  }
  async queueLoop(settings, signal) {
    while (!signal.aborted) {
      for (const bind of this.binds.values()) {
        if (signal.aborted) return;
        try {
          await drainTopicQueue(normalizedSettings(), bind, signal);
        } catch (e) {
          if (signal.aborted) return;
          logBridge.warn("queue", `${bind.key} ${String(e)}`, bind.accountId);
          await sleep5(2e3, signal);
        }
      }
      await sleep5(Math.round(settings.pollEmptySec * 1e3), signal);
    }
  }
  async accountLoop(account, bind, signal) {
    const settings = normalizedSettings();
    try {
      if (account.kind === "vk") await vkLoop(settings, account, bind, signal);
      else if (account.kind === "max") await maxLoop(settings, account, bind, signal);
      else await telegramLoop(settings, account, bind, signal);
    } catch (e) {
      if (signal.aborted) return;
      this.setRuntime(account.id, { state: "error", lastError: String(e) });
      logBridge.error(account.kind, String(e), account.id);
    }
  }
};
function normalizedSettings() {
  const s = getSettings();
  return {
    ...s,
    baseUrl: httpBase(s.baseUrl),
    lpat: trimCfg(s.lpat),
    parentChatId: trimCfg(s.parentChatId),
    wsUrl: trimCfg(s.wsUrl),
    vkApiVersion: trimCfg(s.vkApiVersion) || "5.199"
  };
}
var bridgeManager = new BridgeManager();

// src/api/schema.ts
import { z } from "zod";
var trimmed = z.string().trim();
var settingsPatchSchema = z.object({
  baseUrl: trimmed.url().max(500).optional(),
  lpat: trimmed.max(500).optional(),
  parentChatId: trimmed.max(80).optional(),
  wsUrl: trimmed.max(500).optional(),
  vkApiVersion: trimmed.max(20).optional(),
  pollEmptySec: z.number().min(0.2).max(30).optional()
}).strict();
var accountCreateSchema = z.object({
  kind: z.enum(["vk", "tg", "max"]),
  label: trimmed.min(1).max(80),
  token: trimmed.min(1).max(800),
  groupId: trimmed.max(32).optional().default(""),
  enabled: z.boolean().optional().default(true),
  topicTitle: trimmed.max(80).optional().default(""),
  topicEmoji: trimmed.max(8).optional().default(""),
  topicToken: trimmed.max(800).optional().default(""),
  topicChatId: trimmed.max(80).optional().default("")
}).strict().superRefine((val, ctx) => {
  if (val.kind === "vk" && !val.groupId.trim()) {
    ctx.addIssue({
      code: "custom",
      message: "\u0414\u043B\u044F VK \u0443\u043A\u0430\u0436\u0438 group id \u0441\u043E\u043E\u0431\u0449\u0435\u0441\u0442\u0432\u0430",
      path: ["groupId"]
    });
  }
});
var accountPatchSchema = z.object({
  kind: z.enum(["vk", "tg", "max"]).optional(),
  label: trimmed.min(1).max(80).optional(),
  token: trimmed.max(800).optional(),
  groupId: trimmed.max(32).optional(),
  enabled: z.boolean().optional(),
  topicTitle: trimmed.max(80).optional(),
  topicEmoji: trimmed.max(8).optional(),
  topicToken: trimmed.max(800).optional(),
  topicChatId: trimmed.max(80).optional()
}).strict();
var logsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).optional().default(120),
  source: trimmed.max(40).optional(),
  accountId: trimmed.max(80).optional()
});
var eventsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional().default(40)
});

// src/api/handlers.ts
function sendErr(reply, status, error) {
  return reply.code(status).send({ ok: false, error });
}
function publicSettings() {
  const s = getSettings();
  return {
    baseUrl: s.baseUrl,
    lpatHint: maskSecret(s.lpat),
    hasLpat: Boolean(s.lpat),
    parentChatId: s.parentChatId,
    wsUrl: s.wsUrl,
    vkApiVersion: s.vkApiVersion,
    pollEmptySec: s.pollEmptySec,
    resolvedWsUrl: s.wsUrl.trim() || defaultWsUrl(httpBase(s.baseUrl || "https://msgpublic.langame.ru"))
  };
}
async function getHealth(_req, reply) {
  return reply.send({ ok: true });
}
async function getOverview(_req, reply) {
  return reply.send({
    ok: true,
    settings: publicSettings(),
    accounts: listAccounts().map(toPublicAccount),
    status: bridgeManager.getStatus(),
    events: listEvents(200),
    logs: listLogs({ limit: 200 })
  });
}
async function getStatus(_req, reply) {
  return reply.send({ ok: true, status: bridgeManager.getStatus() });
}
async function putSettings(req, reply) {
  const parsed = settingsPatchSchema.safeParse(req.body);
  if (!parsed.success) return sendErr(reply, 400, parsed.error.issues[0]?.message ?? "\u041D\u0435\u043A\u043E\u0440\u0440\u0435\u043A\u0442\u043D\u044B\u0435 \u043D\u0430\u0441\u0442\u0440\u043E\u0439\u043A\u0438");
  const patch = { ...parsed.data };
  if (patch.baseUrl) patch.baseUrl = httpBase(patch.baseUrl);
  if (patch.lpat !== void 0) patch.lpat = trimCfg(patch.lpat);
  if (patch.lpat === "") delete patch.lpat;
  if (patch.parentChatId !== void 0) patch.parentChatId = trimCfg(patch.parentChatId);
  if (patch.wsUrl !== void 0) patch.wsUrl = trimCfg(patch.wsUrl);
  setSettings(patch);
  if (bridgeManager.running) await bridgeManager.restart();
  return reply.send({ ok: true, settings: publicSettings(), status: bridgeManager.getStatus() });
}
async function getAccounts(_req, reply) {
  return reply.send({ ok: true, accounts: listAccounts().map(toPublicAccount) });
}
async function postAccount(req, reply) {
  const parsed = accountCreateSchema.safeParse(req.body);
  if (!parsed.success) return sendErr(reply, 400, parsed.error.issues[0]?.message ?? "\u041D\u0435\u043A\u043E\u0440\u0440\u0435\u043A\u0442\u043D\u044B\u0439 \u0430\u043A\u043A\u0430\u0443\u043D\u0442");
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const v = parsed.data;
  const row = insertAccount({
    id: randomUUID(),
    kind: v.kind,
    label: v.label.trim(),
    enabled: v.enabled,
    token: trimCfg(v.token),
    groupId: trimCfg(v.groupId),
    topicTitle: trimCfg(v.topicTitle),
    topicEmoji: trimCfg(v.topicEmoji),
    topicToken: trimCfg(v.topicToken),
    topicChatId: trimCfg(v.topicChatId),
    createdAt: now,
    updatedAt: now
  });
  if (bridgeManager.running && row.enabled) await bridgeManager.syncIfRunning();
  return reply.code(201).send({ ok: true, account: toPublicAccount(row) });
}
async function patchAccount(req, reply) {
  const id = z2.string().uuid().safeParse(req.params.id);
  if (!id.success) return sendErr(reply, 400, "\u041D\u0435\u043A\u043E\u0440\u0440\u0435\u043A\u0442\u043D\u044B\u0439 id");
  const parsed = accountPatchSchema.safeParse(req.body);
  if (!parsed.success) return sendErr(reply, 400, parsed.error.issues[0]?.message ?? "\u041D\u0435\u043A\u043E\u0440\u0440\u0435\u043A\u0442\u043D\u044B\u0439 \u0430\u043A\u043A\u0430\u0443\u043D\u0442");
  const patch = { ...parsed.data };
  if (patch.token !== void 0) patch.token = trimCfg(patch.token);
  if (patch.token === "") delete patch.token;
  if (patch.topicToken !== void 0) patch.topicToken = trimCfg(patch.topicToken);
  if (patch.groupId !== void 0) patch.groupId = trimCfg(patch.groupId);
  if (patch.topicTitle !== void 0) patch.topicTitle = trimCfg(patch.topicTitle);
  if (patch.topicChatId !== void 0) patch.topicChatId = trimCfg(patch.topicChatId);
  const next = updateAccount(id.data, patch);
  if (!next) return sendErr(reply, 404, "\u0410\u043A\u043A\u0430\u0443\u043D\u0442 \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D");
  if (next.kind === "vk" && next.enabled && !next.groupId) {
    return sendErr(reply, 400, "\u0414\u043B\u044F VK \u0443\u043A\u0430\u0436\u0438 group id \u0441\u043E\u043E\u0431\u0449\u0435\u0441\u0442\u0432\u0430");
  }
  await bridgeManager.syncIfRunning();
  return reply.send({ ok: true, account: toPublicAccount(next) });
}
async function removeAccount(req, reply) {
  const id = z2.string().uuid().safeParse(req.params.id);
  if (!id.success) return sendErr(reply, 400, "\u041D\u0435\u043A\u043E\u0440\u0440\u0435\u043A\u0442\u043D\u044B\u0439 id");
  if (!deleteAccount(id.data)) return sendErr(reply, 404, "\u0410\u043A\u043A\u0430\u0443\u043D\u0442 \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D");
  await bridgeManager.syncIfRunning();
  return reply.send({ ok: true });
}
async function startBridge(_req, reply) {
  try {
    await bridgeManager.start();
    return reply.send({ ok: true, status: bridgeManager.getStatus() });
  } catch (e) {
    return sendErr(reply, 400, e instanceof Error ? e.message : String(e));
  }
}
async function stopBridge(_req, reply) {
  await bridgeManager.stop();
  return reply.send({ ok: true, status: bridgeManager.getStatus() });
}
async function restartBridge(_req, reply) {
  try {
    await bridgeManager.restart();
    return reply.send({ ok: true, status: bridgeManager.getStatus() });
  } catch (e) {
    return sendErr(reply, 400, e instanceof Error ? e.message : String(e));
  }
}
async function getLogs(req, reply) {
  const parsed = logsQuerySchema.safeParse(req.query);
  if (!parsed.success) return sendErr(reply, 400, "\u041D\u0435\u043A\u043E\u0440\u0440\u0435\u043A\u0442\u043D\u044B\u0439 \u0437\u0430\u043F\u0440\u043E\u0441 \u043B\u043E\u0433\u043E\u0432");
  return reply.send({ ok: true, logs: listLogs(parsed.data) });
}
async function getEvents(req, reply) {
  const parsed = eventsQuerySchema.safeParse(req.query);
  if (!parsed.success) return sendErr(reply, 400, "\u041D\u0435\u043A\u043E\u0440\u0440\u0435\u043A\u0442\u043D\u044B\u0439 \u0437\u0430\u043F\u0440\u043E\u0441 \u0441\u043E\u0431\u044B\u0442\u0438\u0439");
  return reply.send({ ok: true, events: listEvents(parsed.data.limit) });
}
async function streamLive(req, reply) {
  reply.hijack();
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive"
  });
  reply.raw.write(`event: status
data: ${JSON.stringify(bridgeManager.getStatus())}

`);
  addLiveClient(reply);
  req.raw.on("close", () => {
    removeLiveClient(reply);
  });
}

// src/api/routes.ts
async function registerApi(app) {
  app.get("/api/health", getHealth);
  app.get("/api/overview", getOverview);
  app.get("/api/status", getStatus);
  app.put("/api/settings", putSettings);
  app.get("/api/accounts", getAccounts);
  app.post("/api/accounts", postAccount);
  app.patch("/api/accounts/:id", patchAccount);
  app.delete("/api/accounts/:id", removeAccount);
  app.post("/api/bridge/start", startBridge);
  app.post("/api/bridge/stop", stopBridge);
  app.post("/api/bridge/restart", restartBridge);
  app.get("/api/logs", getLogs);
  app.get("/api/events", getEvents);
  app.get("/api/stream", streamLive);
}

// src/index.ts
var PUBLIC_PATHS = /* @__PURE__ */ new Set(["/api/health"]);
async function main() {
  getDb();
  const app = Fastify({ logger: false });
  app.addHook("onRequest", async (req, reply) => {
    if (!BRIDGE_UI_TOKEN) return;
    if (!req.url.startsWith("/api/") || PUBLIC_PATHS.has(req.url.split("?")[0] ?? "")) return;
    const header = req.headers.authorization ?? "";
    const queryToken = typeof req.query === "object" && req.query && "token" in req.query ? String(req.query.token ?? "") : "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : queryToken;
    if (token !== BRIDGE_UI_TOKEN) {
      return reply.code(401).send({ ok: false, error: "\u041D\u0443\u0436\u0435\u043D \u0442\u043E\u043A\u0435\u043D \u0434\u043E\u0441\u0442\u0443\u043F\u0430" });
    }
  });
  await registerApi(app);
  if (fs3.existsSync(WEB_DIST)) {
    await app.register(fastifyStatic, {
      root: WEB_DIST,
      prefix: "/"
    });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api/")) {
        return reply.code(404).send({ ok: false, error: "not found" });
      }
      return reply.sendFile("index.html");
    });
  } else {
    app.get("/", async (_req, reply) => {
      return reply.type("text/plain").send(
        "API multi-lanchat. \u0421\u043D\u0430\u0447\u0430\u043B\u0430 \u0441\u043E\u0431\u0435\u0440\u0438\u0442\u0435 UI (web/dist), \u0437\u0430\u0442\u0435\u043C npm start."
      );
    });
  }
  await app.listen({ host: HOST, port: PORT });
  logBridge.info("sys", `listening http://${HOST}:${PORT}`);
}
void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
