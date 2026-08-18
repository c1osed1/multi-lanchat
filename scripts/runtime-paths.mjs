import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = path.resolve(here, "..");

function loadDotenv() {
  const file = path.join(ROOT_DIR, ".env");
  if (!fs.existsSync(file)) return;
  const raw = fs.readFileSync(file, "utf8");
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function readEnv(name, fallback = "") {
  const raw = process.env[name];
  return typeof raw === "string" ? raw.trim() : fallback;
}

loadDotenv();

export const DATA_DIR = path.resolve(ROOT_DIR, readEnv("DATA_DIR", "./data"));
export const UPDATE_STATE_PATH = path.join(DATA_DIR, "update-state.json");
export const MANAGED_STATE_PATH = path.join(DATA_DIR, "managed-process.json");
export const MANAGED_COMMAND_PATH = path.join(DATA_DIR, "managed-command.json");

export function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

export function readJson(file) {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

export function writeJson(file, value) {
  ensureDataDir();
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, file);
}
