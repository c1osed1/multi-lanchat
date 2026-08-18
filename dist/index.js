// src/index.ts
import fs5 from "node:fs";
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

// src/update/service.ts
import fs4 from "node:fs";
import path4 from "node:path";
import { spawn } from "node:child_process";

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
  parent_chat_id TEXT NOT NULL DEFAULT '',
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

CREATE TABLE IF NOT EXISTS bot_commands (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  trigger TEXT NOT NULL,
  response_text TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  account_id TEXT NOT NULL DEFAULT '',
  formatting_enabled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs (id DESC);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events (id DESC);
CREATE INDEX IF NOT EXISTS idx_routes_account ON routes (account_id);
CREATE INDEX IF NOT EXISTS idx_bot_commands_enabled ON bot_commands (enabled, created_at DESC);
`;

// src/db/repo.ts
var DEFAULT_SETTINGS = {
  baseUrl: "https://msgpublic.langame.ru",
  lpat: "",
  parentChatIds: [],
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
    parentChatId: String(row.parent_chat_id ?? ""),
    topicTitle: String(row.topic_title ?? ""),
    topicEmoji: String(row.topic_emoji ?? ""),
    topicToken: String(row.topic_token ?? ""),
    topicChatId: String(row.topic_chat_id ?? ""),
    createdAt: String(row.created_at ?? ""),
    updatedAt: String(row.updated_at ?? "")
  };
}
function asBotCommand(row) {
  return {
    id: String(row.id),
    title: String(row.title ?? ""),
    trigger: String(row.trigger ?? ""),
    responseText: String(row.response_text ?? ""),
    enabled: Number(row.enabled) === 1,
    accountId: String(row.account_id ?? ""),
    formattingEnabled: Number(row.formatting_enabled) === 1,
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
    parentChatId: row.parentChatId,
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
function ensureBotCommandsColumns(opened) {
  const cols = opened.prepare("PRAGMA table_info(bot_commands)").all();
  if (cols.length === 0) return;
  const names = new Set(cols.map((c) => String(c.name ?? "")));
  if (!names.has("account_id")) opened.exec("ALTER TABLE bot_commands ADD COLUMN account_id TEXT NOT NULL DEFAULT ''");
  if (!names.has("formatting_enabled"))
    opened.exec("ALTER TABLE bot_commands ADD COLUMN formatting_enabled INTEGER NOT NULL DEFAULT 0");
  if (names.has("account_ids_json")) {
    const rows = opened.prepare("SELECT id, account_ids_json, account_id FROM bot_commands").all();
    const update = opened.prepare("UPDATE bot_commands SET account_id = ? WHERE id = ?");
    for (const row of rows) {
      if (row.account_id) continue;
      try {
        const parsed = JSON.parse(String(row.account_ids_json ?? "[]"));
        const first = Array.isArray(parsed) ? String(parsed[0] ?? "") : "";
        if (first) update.run(first, row.id);
      } catch {
      }
    }
  }
}
function ensureAccountsParentChatColumn(opened) {
  const cols = opened.prepare("PRAGMA table_info(accounts)").all();
  const names = new Set(cols.map((c) => String(c.name ?? "")));
  if (!names.has("parent_chat_id")) {
    opened.exec("ALTER TABLE accounts ADD COLUMN parent_chat_id TEXT NOT NULL DEFAULT ''");
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
  ensureAccountsParentChatColumn(opened);
  ensureBotCommandsColumns(opened);
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
    parentChatIds: DEFAULT_SETTINGS.parentChatIds.join(","),
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
  const rawParents = String(map.get("parentChatIds") ?? map.get("parentChatId") ?? "");
  const parentChatIds = rawParents.split(/[,\s]+/g).map((s) => s.trim()).filter(Boolean).slice(0, 20);
  return {
    baseUrl: map.get("baseUrl") ?? DEFAULT_SETTINGS.baseUrl,
    lpat: map.get("lpat") ?? "",
    parentChatIds,
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
    upsert.run("parentChatIds", next.parentChatIds.join(","));
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
        id, kind, label, enabled, token, group_id, parent_chat_id, topic_title, topic_emoji,
        topic_token, topic_chat_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    row.id,
    row.kind,
    row.label,
    row.enabled ? 1 : 0,
    row.token,
    row.groupId,
    row.parentChatId,
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
        kind = ?, label = ?, enabled = ?, token = ?, group_id = ?, parent_chat_id = ?, topic_title = ?,
        topic_emoji = ?, topic_token = ?, topic_chat_id = ?, updated_at = ?
      WHERE id = ?`
  ).run(
    next.kind,
    next.label,
    next.enabled ? 1 : 0,
    next.token,
    next.groupId,
    next.parentChatId,
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
function listBotCommands() {
  const rows = getDb().prepare("SELECT * FROM bot_commands ORDER BY created_at DESC").all();
  return rows.map(asBotCommand);
}
function getBotCommand(id) {
  const row = getDb().prepare("SELECT * FROM bot_commands WHERE id = ?").get(id);
  return row ? asBotCommand(row) : null;
}
function insertBotCommand(row) {
  getDb().prepare(
    `INSERT INTO bot_commands (
        id, title, trigger, response_text, enabled, account_id, formatting_enabled, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    row.id,
    row.title,
    row.trigger,
    row.responseText,
    row.enabled ? 1 : 0,
    row.accountId,
    row.formattingEnabled ? 1 : 0,
    row.createdAt,
    row.updatedAt
  );
  return row;
}
function updateBotCommand(id, patch) {
  const current = getBotCommand(id);
  if (!current) return null;
  const next = {
    ...current,
    ...patch,
    id,
    updatedAt: nowIso()
  };
  getDb().prepare(
    `UPDATE bot_commands SET
        title = ?, trigger = ?, response_text = ?, enabled = ?, account_id = ?, formatting_enabled = ?, updated_at = ?
      WHERE id = ?`
  ).run(
    next.title,
    next.trigger,
    next.responseText,
    next.enabled ? 1 : 0,
    next.accountId,
    next.formattingEnabled ? 1 : 0,
    next.updatedAt,
    id
  );
  return next;
}
function deleteBotCommand(id) {
  const info = getDb().prepare("DELETE FROM bot_commands WHERE id = ?").run(id);
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

// src/update/git.ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
var execFileAsync = promisify(execFile);
async function run(rootDir, args) {
  const { stdout } = await execFileAsync("git", args, {
    cwd: rootDir,
    windowsHide: true
  });
  return stdout.trim();
}
async function isGitAvailable() {
  try {
    await execFileAsync("git", ["--version"], { windowsHide: true });
    return true;
  } catch {
    return false;
  }
}
async function isGitRepo(rootDir) {
  try {
    return await run(rootDir, ["rev-parse", "--is-inside-work-tree"]) === "true";
  } catch {
    return false;
  }
}
async function getHeadCommit(rootDir) {
  try {
    return await run(rootDir, ["rev-parse", "HEAD"]);
  } catch {
    return null;
  }
}
async function getUpstreamBranch(rootDir) {
  try {
    return await run(rootDir, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  } catch {
    return null;
  }
}
async function isWorktreeClean(rootDir) {
  try {
    return await run(rootDir, ["status", "--porcelain", "--untracked-files=no"]) === "";
  } catch {
    return false;
  }
}
async function getRemoteBranchHead(rootDir, branch) {
  const remoteBranch = branch.includes("/") ? branch : `origin/${branch}`;
  const shortBranch = remoteBranch.startsWith("origin/") ? remoteBranch.slice("origin/".length) : branch;
  try {
    const line = await run(rootDir, ["ls-remote", "--heads", "origin", shortBranch]);
    const sha = line.split(/\s+/)[0]?.trim();
    return sha || null;
  } catch {
    return null;
  }
}

// src/update/runtime.ts
import fs3 from "node:fs";
import path3 from "node:path";
var UPDATE_STATE_PATH = path3.join(DATA_DIR, "update-state.json");
var MANAGED_STATE_PATH = path3.join(DATA_DIR, "managed-process.json");
var MANAGED_COMMAND_PATH = path3.join(DATA_DIR, "managed-command.json");
var IDLE_PROGRESS = {
  status: "idle",
  step: "idle",
  message: "",
  startedAt: null,
  finishedAt: null,
  error: null
};
function ensureDataDir() {
  fs3.mkdirSync(DATA_DIR, { recursive: true });
}
function readJson(file) {
  try {
    if (!fs3.existsSync(file)) return null;
    return JSON.parse(fs3.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}
function writeJson(file, value) {
  ensureDataDir();
  const tmp = `${file}.tmp`;
  fs3.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}
`, "utf8");
  fs3.renameSync(tmp, file);
}
function defaultUpdateProgress() {
  return { ...IDLE_PROGRESS };
}
function readUpdateProgress() {
  return readJson(UPDATE_STATE_PATH) ?? defaultUpdateProgress();
}
function writeUpdateProgress(progress) {
  writeJson(UPDATE_STATE_PATH, progress);
}
function readManagedState() {
  return readJson(MANAGED_STATE_PATH);
}

// src/update/service.ts
function hasRemoteUpdate(currentCommit, remoteCommit) {
  return Boolean(currentCommit && remoteCommit && currentCommit !== remoteCommit);
}
function getSupportReason(input) {
  if (!input.gitAvailable) return "Git \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D \u0432 \u0441\u0438\u0441\u0442\u0435\u043C\u0435";
  if (!input.gitRepo) return "\u0423\u0441\u0442\u0430\u043D\u043E\u0432\u043A\u0430 \u043D\u0435 \u044F\u0432\u043B\u044F\u0435\u0442\u0441\u044F git-\u043A\u043B\u043E\u043D\u043E\u043C";
  if (!input.cleanWorktree) return "\u0410\u0432\u0442\u043E\u043E\u0431\u043D\u043E\u0432\u043B\u0435\u043D\u0438\u0435 \u043E\u0442\u043A\u043B\u044E\u0447\u0435\u043D\u043E: \u0435\u0441\u0442\u044C \u043B\u043E\u043A\u0430\u043B\u044C\u043D\u044B\u0435 \u0438\u0437\u043C\u0435\u043D\u0435\u043D\u0438\u044F \u0432 \u0440\u0435\u043F\u043E\u0437\u0438\u0442\u043E\u0440\u0438\u0438";
  if (!input.managedLauncher) return "\u0421\u0435\u0440\u0432\u0435\u0440 \u0437\u0430\u043F\u0443\u0449\u0435\u043D \u0431\u0435\u0437 managed launcher (`npm start`)";
  if (!input.managedStatePresent) return "Launcher state \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D, \u043F\u0435\u0440\u0435\u0437\u0430\u043F\u0443\u0441\u043A \u043F\u043E\u0441\u043B\u0435 \u043E\u0431\u043D\u043E\u0432\u043B\u0435\u043D\u0438\u044F \u043D\u0435\u0434\u043E\u0441\u0442\u0443\u043F\u0435\u043D";
  if (!input.upstreamPresent) return "\u0423 \u0442\u0435\u043A\u0443\u0449\u0435\u0439 \u0432\u0435\u0442\u043A\u0438 \u043D\u0435\u0442 upstream-\u0432\u0435\u0442\u043A\u0438 \u0434\u043B\u044F \u043E\u0431\u043D\u043E\u0432\u043B\u0435\u043D\u0438\u044F";
  return null;
}
function readPackageVersion() {
  try {
    const raw = fs4.readFileSync(path4.join(ROOT_DIR, "package.json"), "utf8");
    const pkg = JSON.parse(raw);
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}
function shortSha(value) {
  return value ? value.slice(0, 10) : null;
}
function runningProgress(progress, message) {
  return {
    ...progress,
    status: "running",
    step: "checking",
    message,
    startedAt: (/* @__PURE__ */ new Date()).toISOString(),
    finishedAt: null,
    error: null
  };
}
async function getSupportState() {
  const gitAvailable = await isGitAvailable();
  const gitRepo = gitAvailable ? await isGitRepo(ROOT_DIR) : false;
  const cleanWorktree = gitRepo ? await isWorktreeClean(ROOT_DIR) : false;
  const managedLauncher = Boolean(process.env.ML_LAUNCHER_PID) && process.env.ML_MANAGED_LAUNCHER === "1";
  const managed = readManagedState();
  const upstream = managedLauncher && gitRepo ? await getUpstreamBranch(ROOT_DIR) : null;
  const reason = getSupportReason({
    gitAvailable,
    gitRepo,
    cleanWorktree,
    managedLauncher,
    managedStatePresent: Boolean(managed?.launcherPid),
    upstreamPresent: Boolean(upstream)
  });
  return { supported: !reason, reason };
}
async function getUpdateStatus() {
  const currentVersion = readPackageVersion();
  const progress = readUpdateProgress();
  const currentCommit = shortSha(await getHeadCommit(ROOT_DIR));
  const trackedBranch = await getUpstreamBranch(ROOT_DIR);
  const remoteCommit = trackedBranch ? shortSha(await getRemoteBranchHead(ROOT_DIR, trackedBranch)) : null;
  const support = await getSupportState();
  const hasUpdate = hasRemoteUpdate(currentCommit, remoteCommit);
  return {
    currentVersion,
    currentCommit,
    trackedBranch,
    remoteCommit,
    remoteVersion: null,
    hasUpdate,
    supported: support.supported,
    supportReason: support.reason,
    progress
  };
}
async function startUpdate() {
  const status = await getUpdateStatus();
  if (!status.supported) {
    throw new Error(status.supportReason ?? "\u0410\u0432\u0442\u043E\u043E\u0431\u043D\u043E\u0432\u043B\u0435\u043D\u0438\u0435 \u043D\u0435\u0434\u043E\u0441\u0442\u0443\u043F\u043D\u043E");
  }
  if (!status.hasUpdate) {
    throw new Error("\u041D\u043E\u0432\u043E\u0439 \u0432\u0435\u0440\u0441\u0438\u0438 \u043F\u043E\u043A\u0430 \u043D\u0435\u0442");
  }
  if (status.progress.status === "running") {
    throw new Error("\u041E\u0431\u043D\u043E\u0432\u043B\u0435\u043D\u0438\u0435 \u0443\u0436\u0435 \u0432\u044B\u043F\u043E\u043B\u043D\u044F\u0435\u0442\u0441\u044F");
  }
  writeUpdateProgress(
    runningProgress(status.progress, `\u0413\u043E\u0442\u043E\u0432\u0438\u043C \u043E\u0431\u043D\u043E\u0432\u043B\u0435\u043D\u0438\u0435 ${status.currentCommit ?? ""} -> ${status.remoteCommit ?? ""}`.trim())
  );
  const child = spawn(process.execPath, [path4.join(ROOT_DIR, "scripts/self-update.mjs")], {
    cwd: ROOT_DIR,
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      ML_INSTALL_ROOT: ROOT_DIR,
      ML_DATA_DIR: process.env.ML_DATA_DIR ?? "",
      ML_LAUNCHER_PID: process.env.ML_LAUNCHER_PID ?? ""
    }
  });
  child.unref();
  logBridge.info("update", `self-update spawned pid=${child.pid ?? "?"}`);
  return {
    ...status,
    progress: readUpdateProgress()
  };
}

// src/update/handlers.ts
function sendErr(reply, status, error) {
  return reply.code(status).send({ ok: false, error });
}
async function getUpdateStatusHandler(_req, reply) {
  return reply.send({ ok: true, update: await getUpdateStatus() });
}
async function postUpdateStartHandler(_req, reply) {
  try {
    const update = await startUpdate();
    return reply.code(202).send({ ok: true, accepted: true, update });
  } catch (e) {
    return sendErr(reply, 400, e instanceof Error ? e.message : String(e));
  }
}

// src/update/routes.ts
async function registerUpdateRoutes(app) {
  app.get("/api/update/status", getUpdateStatusHandler);
  app.post("/api/update/start", postUpdateStartHandler);
}

// src/api/handlers.ts
import { randomUUID } from "node:crypto";
import { z as z2 } from "zod";

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

// src/bridge/media/types.ts
var MAX_BRIDGE_FILE_BYTES = 45 * 1024 * 1024;
var MAX_FILES_PER_MESSAGE = 8;

// src/bridge/media/httpFiles.ts
function normalizeMaxUrl(url) {
  try {
    const u = new URL(url);
    if (u.hostname === "platform-api.max.ru") u.hostname = "platform-api2.max.ru";
    return u.toString();
  } catch {
    return url.replace("platform-api.max.ru", "platform-api2.max.ru");
  }
}
async function fetchBytes(url, opts = {}) {
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? 6e4);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  const res = await fetch(normalizeMaxUrl(url), { method: "GET", headers: opts.headers, signal, redirect: "follow" });
  if (!res.ok) {
    throw new Error(`GET ${url} \u2192 HTTP ${res.status}`);
  }
  const cap = opts.maxBytes ?? MAX_BRIDGE_FILE_BYTES;
  const buf = await readCapped(res, cap);
  const mime = (res.headers.get("content-type") || "application/octet-stream").split(";")[0]?.trim() || "application/octet-stream";
  return { bytes: buf, mime };
}
async function readCapped(res, maxBytes) {
  const len = Number(res.headers.get("content-length") || 0);
  if (len > maxBytes) throw new Error("file_too_large");
  const raw = new Uint8Array(await res.arrayBuffer());
  if (raw.byteLength > maxBytes) throw new Error("file_too_large");
  return raw;
}
async function postFormJson(url, form, opts = {}) {
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? 9e4);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  const normalizedUrl = normalizeMaxUrl(url);
  const res = await fetch(url, {
    method: "POST",
    headers: opts.headers,
    body: form,
    signal
  });
  const raw = await res.text();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} POST ${normalizedUrl}: ${raw.slice(0, 400)}`);
  }
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

// src/bridge/lanchat.ts
function lanFromSettings(s) {
  return { base: s.baseUrl.replace(/\/+$/, ""), lpat: s.lpat };
}
function lcUser(lc, path5, method = "GET", body, signal) {
  return httpJson(`${lc.base}${path5}`, {
    method,
    data: body,
    headers: { Authorization: `Bearer ${lc.lpat}` },
    signal
  });
}
function lcTopic(base, token, path5, method = "GET", body, signal) {
  return httpJson(`${base.replace(/\/+$/, "")}${path5}`, {
    method,
    data: body,
    headers: { Authorization: `Bearer ${token}` },
    signal
  });
}
async function lcTopicSend(base, token, text, files, signal) {
  const url = `${base.replace(/\/+$/, "")}/api/channels/send`;
  const auth = { Authorization: `Bearer ${token}` };
  if (files.length === 0) {
    return httpJson(url, { method: "POST", data: { text }, headers: auth, signal, timeoutMs: 6e4 });
  }
  const form = new FormData();
  form.append("text", text);
  for (const file of files) {
    form.append("file", new Blob([file.bytes], { type: file.mime || "application/octet-stream" }), file.filename);
  }
  return postFormJson(url, form, { headers: auth, signal, timeoutMs: 12e4 });
}

// src/bridge/media/gate.ts
var BLOCKED_EXTENSIONS = new Set(
  [
    ".html",
    ".htm",
    ".xhtml",
    ".xml",
    ".shtml",
    ".php",
    ".php3",
    ".php4",
    ".php5",
    ".phtml",
    ".phar",
    ".asp",
    ".aspx",
    ".jsp",
    ".cgi",
    ".htaccess",
    ".bat",
    ".cmd",
    ".com",
    ".msi",
    ".sh",
    ".bash",
    ".ps1",
    ".vbs",
    ".js",
    ".mjs",
    ".cjs",
    ".svg",
    ".svgz"
  ].map((e) => e.toLowerCase())
);
var BLOCKED_RAW = new Set(
  [".dng", ".cr2", ".cr3", ".nef", ".arw", ".orf", ".rw2", ".raf", ".raw"].map((e) => e.toLowerCase())
);
var BLOCKED_MIME_PREFIXES = [
  "text/html",
  "application/xhtml",
  "application/xml",
  "text/xml",
  "application/javascript",
  "text/javascript",
  "image/svg+xml",
  "application/x-executable",
  "application/x-sh"
];
var XML_XSS = [
  /<script[\s>]/i,
  /<\/script\s*>/i,
  /\bon\w+\s*=/i,
  /javascript\s*:/i,
  /data\s*:\s*text\/html/i
];
function fileExt(filename) {
  const name = filename.toLowerCase();
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i) : "";
}
function blockedReason(filename, mime) {
  const ext = fileExt(filename);
  if (BLOCKED_EXTENSIONS.has(ext) || BLOCKED_RAW.has(ext)) return "file_type_blocked";
  const m = (mime || "").toLowerCase();
  for (const prefix of BLOCKED_MIME_PREFIXES) {
    if (m.startsWith(prefix)) return "file_type_blocked";
  }
  return null;
}
function sanitizeFilename(raw, fallback = "file.bin") {
  const base = raw.replace(/\\/g, "/").split("/").pop()?.trim() || "";
  const cleaned = base.replace(/[^\w.\- ()а-яА-ЯёЁ]+/g, "_").slice(0, 180);
  if (!cleaned || cleaned === "." || cleaned === "..") return fallback;
  return cleaned;
}
function inspectBridgeFile(file) {
  if (!file.bytes.byteLength) return "empty_file";
  if (file.bytes.byteLength > MAX_BRIDGE_FILE_BYTES) return "file_too_large";
  const name = sanitizeFilename(file.filename);
  const blocked = blockedReason(name, file.mime);
  if (blocked) return blocked;
  const head = Buffer.from(file.bytes.subarray(0, Math.min(file.bytes.byteLength, 1024 * 1024)));
  const mime = (file.mime || "").toLowerCase();
  if (mime === "application/pdf" || name.toLowerCase().endsWith(".pdf")) {
    const raw = head.toString("binary");
    if (raw.includes("/JS ") || raw.includes("/JavaScript ") || /\/S\s*\/JavaScript\b/.test(raw)) {
      return "file_type_blocked";
    }
  }
  const xmlHead = head.subarray(0, 2048).toString("utf8");
  if (/<\?xml\s/i.test(xmlHead) || /<svg\s/i.test(xmlHead)) {
    const text = head.toString("utf8");
    for (const re of XML_XSS) {
      if (re.test(text)) return "file_type_blocked";
    }
  }
  return null;
}
function acceptFiles(files) {
  const ok = [];
  const skipped = [];
  for (const file of files) {
    const safe = {
      ...file,
      filename: sanitizeFilename(file.filename)
    };
    const reason = inspectBridgeFile(safe);
    if (reason) {
      skipped.push({ name: safe.filename, reason });
      continue;
    }
    ok.push(safe);
    if (ok.length >= MAX_FILES_PER_MESSAGE) break;
  }
  return { ok, skipped };
}

// src/bridge/media/record.ts
function asRecord(v) {
  return v && typeof v === "object" ? v : {};
}

// src/bridge/media/lanchat.ts
function absUrl(base, url) {
  if (!url) return "";
  if (/^https?:\/\//i.test(url)) return url;
  return `${httpBase(base)}${url.startsWith("/") ? "" : "/"}${url}`;
}
async function filesFromLanchat(settings, message, extraToken, signal) {
  const out = [];
  const attachments = Array.isArray(message.attachments) ? message.attachments : [];
  for (const raw of attachments) {
    const att = asRecord(raw);
    const url = absUrl(settings.baseUrl, String(att.url ?? att.sourceUrl ?? ""));
    if (!url) continue;
    const file = await downloadLan(url, settings.lpat, extraToken, String(att.name ?? "file.bin"), String(att.mime ?? ""), signal);
    if (file) out.push(file);
  }
  const sticker = asRecord(message.sticker);
  const stickerUrl = absUrl(settings.baseUrl, String(sticker.sourceUrl ?? ""));
  if (stickerUrl) {
    const file = await downloadLan(stickerUrl, settings.lpat, extraToken, "sticker.webp", "image/webp", signal);
    if (file) out.push(file);
  }
  return out;
}
async function downloadLan(url, lpat, extraToken, filename, mimeHint, signal) {
  const tokens = [lpat, extraToken].filter((t) => Boolean(t));
  let last = "";
  for (const token of tokens.length ? tokens : [""]) {
    try {
      const headers = {};
      if (token) headers.Authorization = `Bearer ${token}`;
      const { bytes, mime } = await fetchBytes(url, { headers, signal, timeoutMs: 9e4 });
      return { filename, mime: mimeHint || mime, bytes };
    } catch (e) {
      last = String(e);
    }
  }
  if (last) throw new Error(last);
  return null;
}

// src/bridge/clients.ts
function asRecord2(v) {
  return v && typeof v === "object" ? v : {};
}
async function vkApi(token, version, method, params, signal) {
  const data = asRecord2(
    await httpJson(`https://api.vk.com/method/${method}`, {
      method: "POST",
      form: true,
      data: { ...params, access_token: token, v: version },
      timeoutMs: 35e3,
      signal
    })
  );
  const err = asRecord2(data.error);
  if (Object.keys(err).length) {
    throw new Error(`VK ${method}: [${err.error_code}] ${err.error_msg}`);
  }
  return data.response;
}
async function tgApi(token, method, params = {}, signal) {
  const data = asRecord2(
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
async function maxApi(token, method, path5, opts = {}) {
  const url = new URL(path5, "https://platform-api2.max.ru");
  for (const [key, value] of Object.entries(opts.query ?? {})) {
    if (value === void 0 || value === "") continue;
    url.searchParams.set(key, String(value));
  }
  const t = token.trim();
  const target = url.toString();
  async function requestWithAuth(auth) {
    return httpJson(target, {
      method,
      data: opts.data,
      headers: { Authorization: auth },
      timeoutMs: opts.timeoutMs ?? 4e4,
      signal: opts.signal
    });
  }
  const authBearer = /^bearer\s+/i.test(t) ? t : `Bearer ${t}`;
  const authRaw = t;
  try {
    return await requestWithAuth(authBearer);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const cause = e instanceof Error && "cause" in e ? (
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      String(e.cause ?? "")
    ) : "";
    if (msg.includes("verify.token") && msg.toLowerCase().includes("malformed access token")) {
      try {
        return await requestWithAuth(authRaw);
      } catch {
      }
    }
    throw new Error(`Max request failed: ${msg}${cause ? `; cause: ${cause}` : ""} (${target})`);
  }
}

// src/bridge/markup.ts
function decodeHtml(text) {
  return text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
}
function stripTags(text) {
  return decodeHtml(text.replace(/<[^>]+>/g, ""));
}
function toMaxFormattedText(text) {
  if (!text.trim()) return { text };
  return { text, textFormat: "HTML" };
}
function toVkFormattedText(text) {
  const raw = text || "";
  if (!raw.includes("<")) return { text: decodeHtml(raw) };
  const tokens = raw.split(/(<[^>]+>)/g).filter(Boolean);
  const active = [];
  const items = [];
  let out = "";
  for (const token of tokens) {
    if (!token.startsWith("<")) {
      const chunk = decodeHtml(token);
      const offset = out.length;
      out += chunk;
      const length = chunk.length;
      if (!length) continue;
      for (const mark of active) items.push({ type: mark.type, offset, length, url: mark.url });
      continue;
    }
    const close = /^<\s*\/\s*([a-z0-9-]+)\s*>$/i.exec(token);
    if (close) {
      const name2 = close[1]?.toLowerCase() ?? "";
      const mapped = name2 === "b" || name2 === "strong" ? "bold" : name2 === "i" || name2 === "em" ? "italic" : name2 === "u" || name2 === "ins" ? "underline" : name2 === "s" || name2 === "strike" || name2 === "del" ? "strikethrough" : name2 === "a" ? "url" : null;
      if (!mapped) continue;
      for (let i = active.length - 1; i >= 0; i--) {
        if (active[i]?.type === mapped) {
          active.splice(i, 1);
          break;
        }
      }
      continue;
    }
    const open = /^<\s*([a-z0-9-]+)([^>]*)>$/i.exec(token);
    if (!open) continue;
    const name = open[1]?.toLowerCase() ?? "";
    const attrs = open[2] ?? "";
    if (name === "b" || name === "strong") active.push({ type: "bold" });
    else if (name === "i" || name === "em") active.push({ type: "italic" });
    else if (name === "u" || name === "ins") active.push({ type: "underline" });
    else if (name === "s" || name === "strike" || name === "del") active.push({ type: "strikethrough" });
    else if (name === "a") {
      const href = /href\s*=\s*"([^"]+)"/i.exec(attrs)?.[1] ?? /href\s*=\s*'([^']+)'/i.exec(attrs)?.[1] ?? "";
      active.push({ type: "url", url: href });
    } else if (name === "br") out += "\n";
  }
  const merged = [];
  for (const item of items) {
    const prev = merged[merged.length - 1];
    if (prev && prev.type === item.type && prev.url === item.url && prev.offset + prev.length === item.offset) {
      prev.length += item.length;
    } else {
      merged.push({ ...item });
    }
  }
  return merged.length ? { text: stripTags(out), formatData: { version: "1", items: merged } } : { text: stripTags(out) };
}

// src/bridge/media/max.ts
function pickUrl(payload) {
  return String(
    payload.url ?? payload.photo_url ?? asRecord(payload.photo).url ?? asRecord(payload.file).url ?? ""
  );
}
async function filesFromMax(attachments, signal) {
  if (!Array.isArray(attachments)) return [];
  const out = [];
  for (const raw of attachments) {
    const att = asRecord(raw);
    const payload = asRecord(att.payload);
    const url = pickUrl(payload);
    if (!url) continue;
    const type = String(att.type ?? payload.type ?? "file");
    try {
      const { bytes, mime } = await fetchBytes(url, { signal, timeoutMs: 9e4 });
      const filename = String(payload.filename ?? payload.name ?? payload.file_name ?? "") || defaultMaxName(type, mime);
      out.push({ filename, mime: String(payload.mime ?? mime), bytes });
    } catch {
    }
  }
  return out;
}
function defaultMaxName(type, mime) {
  if (type === "image" || mime.startsWith("image/")) return "image.jpg";
  if (type === "video" || mime.startsWith("video/")) return "video.mp4";
  if (type === "audio" || mime.startsWith("audio/")) return "audio.mp3";
  return "file.bin";
}
function maxUploadType(file) {
  const mime = (file.mime || "").toLowerCase();
  if (mime.startsWith("image/") && !mime.includes("svg")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  return "file";
}
async function sendMaxFiles(token, peerId, text, files, formattingEnabled = false, signal) {
  const attachments = [];
  for (const file of files) {
    const type = maxUploadType(file);
    const prepared = asRecord(
      await maxApi(token, "POST", "/uploads", { query: { type }, signal, timeoutMs: 4e4 })
    );
    const uploadUrl = String(prepared.url ?? "");
    if (!uploadUrl) throw new Error("Max /uploads: no url");
    const form = new FormData();
    form.append("data", new Blob([file.bytes], { type: file.mime }), file.filename);
    const uploaded = asRecord(await postFormJson(uploadUrl, form, { signal, timeoutMs: 12e4 }));
    const tokenVal = String(uploaded.token ?? prepared.token ?? asRecord(uploaded.payload).token ?? "");
    if (!tokenVal) throw new Error("Max upload: no token");
    attachments.push({ type, payload: { token: tokenVal } });
  }
  const fallbackText = text.trim() || (attachments.length ? "" : "(\u043F\u0443\u0441\u0442\u043E)");
  const formatted = formattingEnabled ? toMaxFormattedText(fallbackText) : null;
  const body = { text: formatted?.text ?? fallbackText };
  if (formatted?.textFormat) {
    body.text_format = formatted.textFormat;
    body.format = formatted.textFormat;
  }
  if (attachments.length) body.attachments = attachments;
  await sendMaxWithRetry(token, peerId, body, signal);
}
async function sendMaxWithRetry(token, peerId, body, signal) {
  let delay = 800;
  for (let i = 0; i < 5; i++) {
    try {
      await maxApi(token, "POST", "/messages", {
        query: { chat_id: Number(peerId) },
        data: body,
        signal,
        timeoutMs: 4e4
      });
      return;
    } catch (e) {
      const msg = String(e);
      if (!msg.includes("attachment.not.ready") && !msg.includes("not.processed")) throw e;
      await new Promise((r) => setTimeout(r, delay));
      delay *= 2;
    }
  }
  throw new Error("Max attachment not ready");
}

// src/bridge/media/telegram.ts
var TG_MEDIA = ["photo", "document", "video", "audio", "voice", "video_note", "sticker", "animation"];
async function filesFromTelegram(token, message, signal) {
  const out = [];
  for (const key of TG_MEDIA) {
    const part = message[key];
    if (!part) continue;
    if (key === "photo" && Array.isArray(part)) {
      const last = part[part.length - 1];
      const file2 = await downloadTgFile(token, asRecord(last), "photo.jpg", "image/jpeg", signal);
      if (file2) out.push(file2);
      continue;
    }
    const rec = asRecord(part);
    const name = String(rec.file_name ?? rec.file_unique_id ?? key);
    const mime = String(rec.mime_type ?? "") || (key === "sticker" ? "image/webp" : key === "voice" ? "audio/ogg" : "application/octet-stream");
    const file = await downloadTgFile(token, rec, name, mime, signal);
    if (file) out.push(file);
  }
  return out;
}
async function downloadTgFile(token, rec, fallbackName, fallbackMime, signal) {
  const fileId = String(rec.file_id ?? "");
  if (!fileId) return null;
  const data = asRecord(
    await httpJson(`https://api.telegram.org/bot${token}/getFile`, {
      method: "POST",
      data: { file_id: fileId },
      signal,
      timeoutMs: 4e4
    })
  );
  if (!data.ok) throw new Error(`TG getFile: ${JSON.stringify(data).slice(0, 200)}`);
  const meta = asRecord(data.result);
  const path5 = String(meta.file_path ?? "");
  if (!path5) return null;
  const { bytes, mime } = await fetchBytes(`https://api.telegram.org/file/bot${token}/${path5}`, {
    signal,
    timeoutMs: 9e4
  });
  return {
    filename: String(rec.file_name ?? fallbackName),
    mime: String(rec.mime_type ?? mime ?? fallbackMime),
    bytes
  };
}
async function sendTelegramFiles(token, peerId, text, files, formattingEnabled = false, signal) {
  const caption = text.trim().slice(0, 1024);
  if (files.length === 0) {
    await httpJson(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      data: {
        chat_id: Number(peerId),
        text: text.trim() || "(\u043F\u0443\u0441\u0442\u043E)",
        parse_mode: formattingEnabled ? "HTML" : void 0
      },
      signal
    });
    return;
  }
  let first = true;
  for (const file of files) {
    const form = new FormData();
    form.append("chat_id", peerId);
    const kind = tgSendKind(file);
    form.append(kind, new Blob([file.bytes], { type: file.mime || "application/octet-stream" }), file.filename);
    if (first && caption) form.append("caption", caption);
    if (first && formattingEnabled) form.append("parse_mode", "HTML");
    first = false;
    const method = kind === "photo" ? "sendPhoto" : kind === "video" ? "sendVideo" : kind === "audio" ? "sendAudio" : "sendDocument";
    const data = asRecord(
      await postFormJson(`https://api.telegram.org/bot${token}/${method}`, form, {
        signal,
        timeoutMs: 12e4
      })
    );
    if (data.ok === false) {
      throw new Error(`TG ${method}: ${JSON.stringify(data).slice(0, 240)}`);
    }
  }
}
function tgSendKind(file) {
  const mime = (file.mime || "").toLowerCase();
  const name = file.filename.toLowerCase();
  if (mime.startsWith("image/") && !name.endsWith(".webp")) return "photo";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  return "document";
}

// src/bridge/media/vk.ts
function largestVkUrl(photo) {
  const sizes = Array.isArray(photo.sizes) ? photo.sizes : [];
  let best = "";
  let area = 0;
  for (const raw of sizes) {
    const s = asRecord(raw);
    const a = Number(s.width ?? 0) * Number(s.height ?? 0);
    const url = String(s.url ?? "");
    if (url && a >= area) {
      area = a;
      best = url;
    }
  }
  return best || String(photo.url ?? "");
}
async function filesFromVk(attachments, signal) {
  if (!Array.isArray(attachments)) return [];
  const out = [];
  for (const raw of attachments) {
    const att = asRecord(raw);
    const type = String(att.type ?? "");
    try {
      if (type === "photo") {
        const photo = asRecord(att.photo);
        const url = largestVkUrl(photo);
        if (!url) continue;
        const { bytes, mime } = await fetchBytes(url, { signal, timeoutMs: 9e4 });
        out.push({ filename: `photo_${photo.id ?? "vk"}.jpg`, mime: mime || "image/jpeg", bytes });
      } else if (type === "doc") {
        const doc = asRecord(att.doc);
        const url = String(doc.url ?? "");
        if (!url) continue;
        const { bytes, mime } = await fetchBytes(url, { signal, timeoutMs: 9e4 });
        const title = String(doc.title ?? "file");
        const ext = String(doc.ext ?? "");
        const filename = ext && !title.toLowerCase().endsWith(`.${ext.toLowerCase()}`) ? `${title}.${ext}` : title;
        out.push({ filename, mime: mime || "application/octet-stream", bytes });
      } else if (type === "audio" || type === "audio_message") {
        const audio = asRecord(att.audio ?? att.audio_message ?? att);
        const url = String(audio.link_ogg ?? audio.link_mp3 ?? audio.url ?? "");
        if (!url) continue;
        const { bytes, mime } = await fetchBytes(url, { signal, timeoutMs: 9e4 });
        out.push({ filename: type === "audio_message" ? "voice.ogg" : "audio.mp3", mime, bytes });
      } else if (type === "graffiti" || type === "sticker") {
        const obj = asRecord(att[type] ?? att);
        const url = String(obj.url ?? asRecord(obj.images).url ?? "");
        if (!url) continue;
        const { bytes, mime } = await fetchBytes(url, { signal });
        out.push({ filename: `${type}.png`, mime: mime || "image/png", bytes });
      }
    } catch {
    }
  }
  return out;
}
async function sendVkFiles(account, settings, peerId, text, files, formattingEnabled = false, signal) {
  const peer = Number(peerId);
  const attachmentIds = [];
  for (const file of files) {
    const mime = (file.mime || "").toLowerCase();
    if (mime.startsWith("image/") && !mime.includes("webp")) {
      attachmentIds.push(await uploadVkPhoto(account, settings, peer, file, signal));
    } else {
      attachmentIds.push(await uploadVkDoc(account, settings, peer, file, signal));
    }
  }
  const fallbackText = text.trim() || (attachmentIds.length ? "" : "(\u043F\u0443\u0441\u0442\u043E)");
  const formatted = formattingEnabled ? toVkFormattedText(fallbackText) : null;
  await vkApi(
    account.token,
    settings.vkApiVersion,
    "messages.send",
    {
      peer_id: peer,
      random_id: Math.floor(Math.random() * 2e9) + 1,
      message: formatted?.text ?? fallbackText,
      attachment: attachmentIds.join(",") || void 0,
      format_data: formatted?.formatData ? JSON.stringify(formatted.formatData) : void 0
    },
    signal
  );
}
async function uploadVkPhoto(account, settings, peer, file, signal) {
  const server = asRecord(
    await vkApi(
      account.token,
      settings.vkApiVersion,
      "photos.getMessagesUploadServer",
      { peer_id: peer },
      signal
    )
  );
  const uploadUrl = String(server.upload_url ?? "");
  const form = new FormData();
  form.append("photo", new Blob([file.bytes], { type: file.mime }), file.filename);
  const uploaded = asRecord(await postFormJson(uploadUrl, form, { signal, timeoutMs: 12e4 }));
  const saved = await vkApi(
    account.token,
    settings.vkApiVersion,
    "photos.saveMessagesPhoto",
    { photo: uploaded.photo, server: uploaded.server, hash: uploaded.hash },
    signal
  );
  const photo = asRecord(saved?.[0]);
  return `photo${photo.owner_id}_${photo.id}`;
}
async function uploadVkDoc(account, settings, peer, file, signal) {
  const server = asRecord(
    await vkApi(
      account.token,
      settings.vkApiVersion,
      "docs.getMessagesUploadServer",
      { peer_id: peer, type: "doc" },
      signal
    )
  );
  const uploadUrl = String(server.upload_url ?? "");
  const form = new FormData();
  form.append("file", new Blob([file.bytes], { type: file.mime }), file.filename);
  const uploaded = asRecord(await postFormJson(uploadUrl, form, { signal, timeoutMs: 12e4 }));
  const saved = asRecord(
    await vkApi(
      account.token,
      settings.vkApiVersion,
      "docs.save",
      { file: uploaded.file, title: file.filename },
      signal
    )
  );
  const doc = asRecord(saved.doc ?? saved);
  return `doc${doc.owner_id}_${doc.id}`;
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
function asRecord3(v) {
  return v && typeof v === "object" ? v : {};
}
async function sendToTopic(settings, bind, route, text, files = [], signal) {
  const gated = acceptFiles(files);
  for (const skip of gated.skipped) {
    logBridge.warn("media", `drop ${skip.name}: ${skip.reason}`, route.accountId);
  }
  const out = asRecord3(
    await lcTopicSend(settings.baseUrl, bind.token, text, gated.ok, signal)
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
function resolvedWsUrl(settings) {
  return settings.wsUrl.trim() || defaultWsUrl(httpBase(settings.baseUrl));
}
async function handleStaffMessage(settings, chatId, message, sendOutbound, signal) {
  const mid = message.id ? String(message.id) : "";
  if (!mid) return;
  if (isOwn(mid)) return;
  const replyTo = message.replyToMessageId ? String(message.replyToMessageId) : "";
  if (getRoute(mid) && !replyTo) return;
  const preview = asRecord3(message.replyToPreview).text;
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
  let files = [];
  try {
    files = await filesFromLanchat(settings, message, void 0, signal);
  } catch (e) {
    logBridge.warn("media", `lan download ${String(e)}`);
  }
  const gated = acceptFiles(files);
  for (const skip of gated.skipped) {
    logBridge.warn("media", `drop lan ${skip.name}: ${skip.reason}`, route.accountId);
  }
  try {
    await sendOutbound(route, { text, files: gated.ok }, signal);
    upsertRoute({ ...route, messageId: mid, createdAt: (/* @__PURE__ */ new Date()).toISOString() });
    recordEvent({
      direction: "out",
      accountId: route.accountId || null,
      messenger: route.messenger,
      peerId: route.peerId,
      preview: previewText(text) || (gated.ok.length ? `(\u0444\u0430\u0439\u043B \xD7${gated.ok.length})` : ""),
      lanMessageId: mid
    });
    logBridge.info("ws", `lan\u2192${route.messenger} ${route.peerId} ${mid}`, route.accountId || null);
  } catch (e) {
    logBridge.error("ws", `deliver fail ${String(e)}`, route.accountId || null);
  }
}
async function deliverOutbound(settings, account, route, text, files = [], signal) {
  const gated = acceptFiles(files);
  for (const skip of gated.skipped) {
    logBridge.warn("media", `drop out ${skip.name}: ${skip.reason}`, account.id);
  }
  if (route.messenger === "vk") {
    await sendVkFiles(account, settings, route.peerId, text, gated.ok, false, signal);
    return;
  }
  if (route.messenger === "tg") {
    await sendTelegramFiles(account.token, route.peerId, text, gated.ok, false, signal);
    return;
  }
  if (route.messenger === "max") {
    await sendMaxFiles(account.token, route.peerId, text, gated.ok, false, signal);
    return;
  }
  throw new Error(`unknown messenger ${route.messenger}`);
}

// src/bridge/autoReplies.ts
function normalizeTrigger(text) {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}
function normalizeIncomingCommand(text) {
  const norm = normalizeTrigger(text);
  if (!norm.startsWith("/")) return null;
  const first = norm.split(" ")[0] ?? "";
  return first.includes("@") ? first.split("@")[0] ?? first : first;
}
function matchBotCommand(accountId, text) {
  const needleCmd = normalizeIncomingCommand(text);
  if (!needleCmd) return null;
  for (const cmd of listBotCommands()) {
    if (!cmd.enabled) continue;
    if (cmd.accountId !== accountId) continue;
    const triggerCmd = normalizeIncomingCommand(cmd.trigger) ?? normalizeTrigger(cmd.trigger);
    if (triggerCmd === needleCmd) return cmd;
  }
  return null;
}
async function maybeSendBotCommandReply(settings, account, peerId, text, signal) {
  const cmd = matchBotCommand(account.id, text);
  if (!cmd) return false;
  logBridge.info("cmd", `match ${cmd.trigger} \u2192 auto reply`, account.id);
  if (account.kind === "vk") {
    await sendVkFiles(account, settings, peerId, cmd.responseText, [], cmd.formattingEnabled, signal);
    return true;
  }
  if (account.kind === "tg") {
    await sendTelegramFiles(account.token, peerId, cmd.responseText, [], cmd.formattingEnabled, signal);
    return true;
  }
  if (account.kind === "max") {
    await sendMaxFiles(account.token, peerId, cmd.responseText, [], cmd.formattingEnabled, signal);
    return true;
  }
  return false;
}

// src/bridge/telegram.ts
function asRecord4(v) {
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
        const u = asRecord4(raw);
        offset = Math.max(offset, Number(u.update_id ?? 0) + 1);
        const m = asRecord4(u.message);
        const chat = asRecord4(m.chat);
        if (!chat.id) continue;
        const chatId = String(chat.id);
        const fromU = asRecord4(m.from);
        if (fromU.is_bot) continue;
        const uid = String(fromU.id ?? "");
        const uname = fromU.username ? `@${fromU.username}` : "";
        const name = [fromU.first_name, fromU.last_name].filter(Boolean).join(" ").trim() || uname || uid;
        const rawIncoming = String(m.text ?? m.caption ?? "");
        const inbound = telegramInboundText(rawIncoming);
        try {
          await maybeSendBotCommandReply(settings, account, chatId, rawIncoming, signal);
        } catch (e) {
          logBridge.warn("tg", `cmd ${String(e)}`, account.id);
        }
        let files = [];
        try {
          files = await filesFromTelegram(account.token, m, signal);
        } catch (e) {
          logBridge.warn("tg", `files ${String(e)}`, account.id);
        }
        const nAtt = files.length;
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
          files,
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
function asRecord5(v) {
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
  try {
    await maybeSendBotCommandReply(
      settings,
      account,
      input.peerId,
      input.started ? "/start" : input.rawText ?? input.text,
      signal
    );
  } catch (e) {
    logBridge.warn("max", `cmd ${String(e)}`, account.id);
  }
  const files = input.files ?? [];
  const nAtt = files.length || input.nAtt;
  const text = formatInbound({
    messenger: "max",
    name: input.name,
    userKey: input.uname || input.uid,
    peerId: input.peerId,
    text: inbound,
    nAtt,
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
    files,
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
  const u = asRecord5(raw);
  const type = String(u.update_type ?? u.type ?? "");
  if (type === "bot_started") {
    const user2 = displayName(asRecord5(u.user));
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
  const message = asRecord5(u.message);
  const sender = asRecord5(message.sender ?? message.from);
  if (sender.is_bot) return;
  const user = displayName(sender);
  const recipient = asRecord5(message.recipient);
  const peerId = String(recipient.chat_id ?? message.chat_id ?? u.chat_id ?? recipient.user_id ?? "");
  const body = asRecord5(message.body);
  const attachments = Array.isArray(body.attachments) ? body.attachments : Array.isArray(message.attachments) ? message.attachments : [];
  let files = [];
  try {
    files = await filesFromMax(attachments, signal);
  } catch (e) {
    logBridge.warn("max", `files ${String(e)}`, account.id);
  }
  await ingest(
    settings,
    account,
    bind,
    {
      peerId,
      ...user,
      text: String(body.text ?? message.text ?? ""),
      rawText: String(body.text ?? message.text ?? ""),
      nAtt: files.length || attachments.length,
      files
    },
    signal
  );
}
async function maxLoop(settings, account, bind, signal) {
  let marker;
  logBridge.info("max", "polling", account.id);
  while (!signal.aborted) {
    try {
      const page = asRecord5(
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
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("verify.token") || msg.toLowerCase().includes("malformed access token") || msg.includes("HTTP 401")) {
        throw e;
      }
      logBridge.warn("max", `poll ${msg}`, account.id);
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
function asRecord6(v) {
  return v && typeof v === "object" ? v : {};
}
async function listTopics(settings, parentChatId, signal) {
  const lc = lanFromSettings(settings);
  const listed = await lcUser(lc, `/api/public/chats/${parentChatId}/topics`, "GET", void 0, signal);
  const rec = asRecord6(listed);
  const items = Array.isArray(rec.topics) ? rec.topics : listed;
  return Array.isArray(items) ? items.map(asRecord6) : [];
}
async function topicToken(settings, parentChatId, topicId, signal) {
  const lc = lanFromSettings(settings);
  const tok = asRecord6(
    await lcUser(
      lc,
      `/api/public/chats/${parentChatId}/topics/${topicId}/channel-token`,
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
  const data = asRecord6(
    await lcTopic(settings.baseUrl, token, "/api/channels/messages?limit=1", "GET", void 0, signal)
  );
  const msgs = Array.isArray(data.messages) ? data.messages : [];
  const first = asRecord6(msgs[0]);
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
  const parentChatIds = account.parentChatId.trim() ? [account.parentChatId.trim()] : settings.parentChatIds ?? [];
  if (token && !chatId) {
    if (settings.lpat.startsWith("lpat_") && parentChatIds.length > 0) {
      for (const parentChatId of parentChatIds) {
        for (const t of await listTopics(settings, parentChatId, signal)) {
          const tid = String(t.id ?? "");
          if (!tid) continue;
          try {
            if (await topicToken(settings, parentChatId, tid, signal) === token) {
              persistTopic(account.id, token, tid, title);
              return {
                accountId: account.id,
                key: account.kind,
                title: String(t.title || title),
                chatId: tid,
                token
              };
            }
          } catch (e) {
            logBridge.warn("topic", `token lookup ${tid}: ${String(e)}`, account.id);
          }
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
  if (!settings.lpat.startsWith("lpat_") || parentChatIds.length === 0) {
    throw new Error(
      `\u0442\u0435\u043C\u0430 \xAB${title}\xBB: \u0443\u043A\u0430\u0436\u0438 token+chat id \u0442\u0435\u043C\u044B \u0438\u043B\u0438 LPAT + parent chats \u0434\u043B\u044F \u0430\u0432\u0442\u043E\u0441\u043E\u0437\u0434\u0430\u043D\u0438\u044F`
    );
  }
  let found = null;
  let foundParentChatId = parentChatIds[0];
  for (const parentChatId of parentChatIds) {
    const items = await listTopics(settings, parentChatId, signal);
    const f = items.find((t) => String(t.title ?? "").trim().toLowerCase() === title.toLowerCase()) ?? null;
    if (f) {
      found = f;
      foundParentChatId = parentChatId;
      break;
    }
  }
  if (!found) {
    const parentChatId = parentChatIds[0];
    const created = asRecord6(
      await lcUser(
        lanFromSettings(settings),
        `/api/public/chats/${parentChatId}/topics`,
        "POST",
        { title },
        signal
      )
    );
    found = created;
    foundParentChatId = parentChatId;
    logBridge.info("topic", `created \xAB${title}\xBB ${String(created.id ?? "")}`, account.id);
  }
  chatId = String(found.id ?? "");
  if (!chatId) throw new Error("topic create/list returned no id");
  if (!token) token = await topicToken(settings, foundParentChatId, chatId, signal);
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
function asRecord7(v) {
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
    const lp = asRecord7(
      await vkApi(account.token, settings.vkApiVersion, "groups.getLongPollServer", { group_id: gid }, signal)
    );
    return { server: String(lp.server ?? ""), key: String(lp.key ?? ""), ts: String(lp.ts ?? "") };
  } catch {
    const lp = asRecord7(
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
    const data = asRecord7(
      await vkApi(
        account.token,
        settings.vkApiVersion,
        "messages.getById",
        { message_ids: String(messageId), group_id: Number(account.groupId) },
        signal
      )
    );
    const items = Array.isArray(data.items) ? data.items : [];
    return items[0] ? asRecord7(items[0]) : null;
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
    const data = asRecord7(
      await vkApi(
        account.token,
        settings.vkApiVersion,
        "groups.getById",
        { group_id: Number(account.groupId) },
        signal
      )
    );
    const groups = Array.isArray(data.groups) ? data.groups : Array.isArray(data) ? data : [];
    const name = String(asRecord7(groups[0]).name ?? "").trim();
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
    const u = asRecord7(users?.[0]);
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
  const nAttListed = Array.isArray(m.attachments) ? m.attachments.length : 0;
  let files = [];
  try {
    files = await filesFromVk(m.attachments, signal);
  } catch (e) {
    logBridge.warn("vk", `files ${String(e)}`, account.id);
  }
  const nAtt = files.length || nAttListed;
  const source = await groupTitle(account, settings, signal);
  try {
    await maybeSendBotCommandReply(settings, account, peer, String(m.text ?? ""), signal);
  } catch (e) {
    logBridge.warn("vk", `cmd ${String(e)}`, account.id);
  }
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
    files,
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
    const rec = asRecord7(u);
    if (rec.type !== "message_new") return;
    await ingest2(settings, account, bind, asRecord7(asRecord7(rec.object).message), signal);
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
  const extra = u[6] && typeof u[6] === "object" ? asRecord7(u[6]) : {};
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
      const data = asRecord7(await httpJson(`${vkLpUrl(lp.server)}?${q}`, { timeoutMs: 35e3, signal }));
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
          normalizedSettings(),
          chatId,
          message,
          async (route, payload, sig) => {
            const account = this.accountForRoute(route) ?? this.accountForChat(chatId);
            if (!account) throw new Error("no account for outbound route");
            await deliverOutbound(normalizedSettings(), account, route, payload.text, payload.files, sig);
          },
          signal
        );
      },
      () => this.publishStatus()
    );
    this.socket.start();
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
    parentChatIds: s.parentChatIds.map(trimCfg).filter(Boolean),
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
  parentChatIds: z.array(trimmed.max(80)).optional(),
  // backwards compatibility (single UUID)
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
  parentChatId: trimmed.max(80).optional().default(""),
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
  parentChatId: trimmed.max(80).optional(),
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
var resolveParentChatsSchema = z.object({
  ids: z.array(trimmed.max(80)).min(1).max(20)
}).strict();
var resolveTopicChatsSchema = z.object({
  ids: z.array(trimmed.max(80)).min(1).max(50)
}).strict();
var botCommandCreateSchema = z.object({
  title: trimmed.min(1).max(80),
  trigger: trimmed.min(1).max(80),
  responseText: trimmed.min(1).max(4e3),
  enabled: z.boolean().optional().default(true),
  accountId: trimmed.uuid(),
  formattingEnabled: z.boolean().optional().default(false)
}).strict();
var botCommandPatchSchema = z.object({
  title: trimmed.min(1).max(80).optional(),
  trigger: trimmed.min(1).max(80).optional(),
  responseText: trimmed.min(1).max(4e3).optional(),
  enabled: z.boolean().optional(),
  accountId: trimmed.uuid().optional(),
  formattingEnabled: z.boolean().optional()
}).strict();

// src/api/handlers.ts
function sendErr2(reply, status, error) {
  return reply.code(status).send({ ok: false, error });
}
function publicSettings() {
  const s = getSettings();
  return {
    baseUrl: s.baseUrl,
    lpatHint: maskSecret(s.lpat),
    hasLpat: Boolean(s.lpat),
    parentChatIds: s.parentChatIds,
    wsUrl: s.wsUrl,
    vkApiVersion: s.vkApiVersion,
    pollEmptySec: s.pollEmptySec,
    resolvedWsUrl: s.wsUrl.trim() || defaultWsUrl(httpBase(s.baseUrl || "https://msgpublic.langame.ru"))
  };
}
function asRecord8(v) {
  return v && typeof v === "object" ? v : {};
}
async function resolveParentChatsTitles(req, reply) {
  const parsed = resolveParentChatsSchema.safeParse(req.body);
  if (!parsed.success)
    return sendErr2(reply, 400, parsed.error.issues[0]?.message ?? "\u041D\u0435\u043A\u043E\u0440\u0440\u0435\u043A\u0442\u043D\u044B\u0439 \u0437\u0430\u043F\u0440\u043E\u0441");
  const s = getSettings();
  if (!s.lpat || !s.lpat.startsWith("lpat_")) return sendErr2(reply, 400, "\u0423\u043A\u0430\u0436\u0438 LPAT \u0432 \u043D\u0430\u0441\u0442\u0440\u043E\u0439\u043A\u0430\u0445");
  const lc = lanFromSettings({
    ...s,
    baseUrl: httpBase(s.baseUrl),
    lpat: trimCfg(s.lpat)
  });
  const titles = {};
  for (const id of parsed.data.ids) {
    try {
      const raw = await lcUser(lc, `/api/public/chats/${id}/title`, "GET", void 0);
      if (typeof raw === "string") {
        titles[id] = raw.trim();
        continue;
      }
      const rec = asRecord8(raw);
      titles[id] = String(rec.title ?? rec.tittle ?? rec.name ?? "").trim();
    } catch (e) {
      titles[id] = "";
      logBridge.warn("topic", `resolve chat ${id}: ${String(e)}`);
    }
  }
  return reply.send({ ok: true, titles });
}
async function resolveTopicChatsTitles(req, reply) {
  const parsed = resolveTopicChatsSchema.safeParse(req.body);
  if (!parsed.success)
    return sendErr2(reply, 400, parsed.error.issues[0]?.message ?? "\u041D\u0435\u043A\u043E\u0440\u0440\u0435\u043A\u0442\u043D\u044B\u0439 \u0437\u0430\u043F\u0440\u043E\u0441");
  const s = getSettings();
  if (!s.lpat || !s.lpat.startsWith("lpat_")) return sendErr2(reply, 400, "\u0423\u043A\u0430\u0436\u0438 LPAT \u0432 \u043D\u0430\u0441\u0442\u0440\u043E\u0439\u043A\u0430\u0445");
  const lc = lanFromSettings({
    ...s,
    baseUrl: httpBase(s.baseUrl),
    lpat: trimCfg(s.lpat)
  });
  const titles = {};
  const parentChatIds = s.parentChatIds ?? [];
  for (const topicId of parsed.data.ids) {
    let title = "";
    for (const parentChatId of parentChatIds) {
      try {
        const topic = asRecord8(await lcUser(lc, `/api/public/chats/${parentChatId}/topics/${topicId}`, "GET", void 0));
        title = String(topic.title ?? "");
        if (title) break;
      } catch {
      }
    }
    titles[topicId] = title;
  }
  return reply.send({ ok: true, titles });
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
  if (!parsed.success) return sendErr2(reply, 400, parsed.error.issues[0]?.message ?? "\u041D\u0435\u043A\u043E\u0440\u0440\u0435\u043A\u0442\u043D\u044B\u0435 \u043D\u0430\u0441\u0442\u0440\u043E\u0439\u043A\u0438");
  const patch = { ...parsed.data };
  if (patch.baseUrl) patch.baseUrl = httpBase(patch.baseUrl);
  if (patch.lpat !== void 0) patch.lpat = trimCfg(patch.lpat);
  if (patch.lpat === "") delete patch.lpat;
  if (patch.parentChatIds !== void 0) {
    patch.parentChatIds = patch.parentChatIds.map(trimCfg).filter(Boolean);
  }
  if (patch.parentChatId !== void 0 && patch.parentChatIds === void 0) {
    const single = trimCfg(patch.parentChatId);
    patch.parentChatIds = single ? [single] : [];
  }
  delete patch.parentChatId;
  if (patch.wsUrl !== void 0) patch.wsUrl = trimCfg(patch.wsUrl);
  setSettings(patch);
  if (bridgeManager.running) await bridgeManager.restart();
  return reply.send({ ok: true, settings: publicSettings(), status: bridgeManager.getStatus() });
}
async function getAccounts(_req, reply) {
  return reply.send({ ok: true, accounts: listAccounts().map(toPublicAccount) });
}
async function getBotCommands(_req, reply) {
  return reply.send({ ok: true, commands: listBotCommands() });
}
async function postBotCommand(req, reply) {
  const parsed = botCommandCreateSchema.safeParse(req.body);
  if (!parsed.success) return sendErr2(reply, 400, parsed.error.issues[0]?.message ?? "\u041D\u0435\u043A\u043E\u0440\u0440\u0435\u043A\u0442\u043D\u0430\u044F \u043A\u043E\u043C\u0430\u043D\u0434\u0430");
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const v = parsed.data;
  const row = insertBotCommand({
    id: randomUUID(),
    title: v.title.trim(),
    trigger: v.trigger.trim(),
    responseText: v.responseText.trim(),
    enabled: v.enabled,
    accountId: v.accountId,
    formattingEnabled: v.formattingEnabled,
    createdAt: now,
    updatedAt: now
  });
  return reply.code(201).send({ ok: true, command: row });
}
async function patchBotCommand(req, reply) {
  const id = z2.string().uuid().safeParse(req.params.id);
  if (!id.success) return sendErr2(reply, 400, "\u041D\u0435\u043A\u043E\u0440\u0440\u0435\u043A\u0442\u043D\u044B\u0439 id");
  const parsed = botCommandPatchSchema.safeParse(req.body);
  if (!parsed.success) return sendErr2(reply, 400, parsed.error.issues[0]?.message ?? "\u041D\u0435\u043A\u043E\u0440\u0440\u0435\u043A\u0442\u043D\u0430\u044F \u043A\u043E\u043C\u0430\u043D\u0434\u0430");
  const patch = { ...parsed.data };
  if (patch.title !== void 0) patch.title = patch.title.trim();
  if (patch.trigger !== void 0) patch.trigger = patch.trigger.trim();
  if (patch.responseText !== void 0) patch.responseText = patch.responseText.trim();
  const next = updateBotCommand(id.data, patch);
  if (!next) return sendErr2(reply, 404, "\u041A\u043E\u043C\u0430\u043D\u0434\u0430 \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D\u0430");
  return reply.send({ ok: true, command: next });
}
async function removeBotCommand(req, reply) {
  const id = z2.string().uuid().safeParse(req.params.id);
  if (!id.success) return sendErr2(reply, 400, "\u041D\u0435\u043A\u043E\u0440\u0440\u0435\u043A\u0442\u043D\u044B\u0439 id");
  if (!getBotCommand(id.data)) return sendErr2(reply, 404, "\u041A\u043E\u043C\u0430\u043D\u0434\u0430 \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D\u0430");
  deleteBotCommand(id.data);
  return reply.send({ ok: true });
}
async function postAccount(req, reply) {
  const parsed = accountCreateSchema.safeParse(req.body);
  if (!parsed.success) return sendErr2(reply, 400, parsed.error.issues[0]?.message ?? "\u041D\u0435\u043A\u043E\u0440\u0440\u0435\u043A\u0442\u043D\u044B\u0439 \u0430\u043A\u043A\u0430\u0443\u043D\u0442");
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const v = parsed.data;
  const row = insertAccount({
    id: randomUUID(),
    kind: v.kind,
    label: v.label.trim(),
    enabled: v.enabled,
    token: trimCfg(v.token),
    groupId: trimCfg(v.groupId),
    parentChatId: trimCfg(v.parentChatId),
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
  if (!id.success) return sendErr2(reply, 400, "\u041D\u0435\u043A\u043E\u0440\u0440\u0435\u043A\u0442\u043D\u044B\u0439 id");
  const parsed = accountPatchSchema.safeParse(req.body);
  if (!parsed.success) return sendErr2(reply, 400, parsed.error.issues[0]?.message ?? "\u041D\u0435\u043A\u043E\u0440\u0440\u0435\u043A\u0442\u043D\u044B\u0439 \u0430\u043A\u043A\u0430\u0443\u043D\u0442");
  const patch = { ...parsed.data };
  if (patch.token !== void 0) patch.token = trimCfg(patch.token);
  if (patch.token === "") delete patch.token;
  if (patch.topicToken !== void 0) patch.topicToken = trimCfg(patch.topicToken);
  if (patch.groupId !== void 0) patch.groupId = trimCfg(patch.groupId);
  if (patch.parentChatId !== void 0) patch.parentChatId = trimCfg(patch.parentChatId);
  if (patch.topicTitle !== void 0) patch.topicTitle = trimCfg(patch.topicTitle);
  if (patch.topicChatId !== void 0) patch.topicChatId = trimCfg(patch.topicChatId);
  const next = updateAccount(id.data, patch);
  if (!next) return sendErr2(reply, 404, "\u0410\u043A\u043A\u0430\u0443\u043D\u0442 \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D");
  if (next.kind === "vk" && next.enabled && !next.groupId) {
    return sendErr2(reply, 400, "\u0414\u043B\u044F VK \u0443\u043A\u0430\u0436\u0438 group id \u0441\u043E\u043E\u0431\u0449\u0435\u0441\u0442\u0432\u0430");
  }
  await bridgeManager.syncIfRunning();
  return reply.send({ ok: true, account: toPublicAccount(next) });
}
async function removeAccount(req, reply) {
  const id = z2.string().uuid().safeParse(req.params.id);
  if (!id.success) return sendErr2(reply, 400, "\u041D\u0435\u043A\u043E\u0440\u0440\u0435\u043A\u0442\u043D\u044B\u0439 id");
  if (!deleteAccount(id.data)) return sendErr2(reply, 404, "\u0410\u043A\u043A\u0430\u0443\u043D\u0442 \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D");
  await bridgeManager.syncIfRunning();
  return reply.send({ ok: true });
}
async function startBridge(_req, reply) {
  try {
    await bridgeManager.start();
    return reply.send({ ok: true, status: bridgeManager.getStatus() });
  } catch (e) {
    return sendErr2(reply, 400, e instanceof Error ? e.message : String(e));
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
    return sendErr2(reply, 400, e instanceof Error ? e.message : String(e));
  }
}
async function getLogs(req, reply) {
  const parsed = logsQuerySchema.safeParse(req.query);
  if (!parsed.success) return sendErr2(reply, 400, "\u041D\u0435\u043A\u043E\u0440\u0440\u0435\u043A\u0442\u043D\u044B\u0439 \u0437\u0430\u043F\u0440\u043E\u0441 \u043B\u043E\u0433\u043E\u0432");
  return reply.send({ ok: true, logs: listLogs(parsed.data) });
}
async function getEvents(req, reply) {
  const parsed = eventsQuerySchema.safeParse(req.query);
  if (!parsed.success) return sendErr2(reply, 400, "\u041D\u0435\u043A\u043E\u0440\u0440\u0435\u043A\u0442\u043D\u044B\u0439 \u0437\u0430\u043F\u0440\u043E\u0441 \u0441\u043E\u0431\u044B\u0442\u0438\u0439");
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
  await registerUpdateRoutes(app);
  app.put("/api/settings", putSettings);
  app.post("/api/parent-chats/titles", resolveParentChatsTitles);
  app.post("/api/topic-chats/titles", resolveTopicChatsTitles);
  app.get("/api/accounts", getAccounts);
  app.post("/api/accounts", postAccount);
  app.patch("/api/accounts/:id", patchAccount);
  app.delete("/api/accounts/:id", removeAccount);
  app.get("/api/bot-commands", getBotCommands);
  app.post("/api/bot-commands", postBotCommand);
  app.patch("/api/bot-commands/:id", patchBotCommand);
  app.delete("/api/bot-commands/:id", removeBotCommand);
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
  if (fs5.existsSync(WEB_DIST)) {
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
