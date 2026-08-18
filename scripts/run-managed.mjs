import { spawn } from "node:child_process";
import {
  MANAGED_COMMAND_PATH,
  MANAGED_STATE_PATH,
  ROOT_DIR,
  readJson,
  writeJson,
} from "./runtime-paths.mjs";

let child = null;
let desiredState = "running";
let shuttingDown = false;
let lastCommandId = null;
let lastExitCode = null;
let lastExitSignal = null;
const bootedAt = new Date().toISOString();

function persistState() {
  writeJson(MANAGED_STATE_PATH, {
    launcherPid: process.pid,
    childPid: child?.pid ?? null,
    childRunning: Boolean(child && !child.killed),
    desiredState,
    bootedAt,
    updatedAt: new Date().toISOString(),
    lastCommandId,
    lastExitCode,
    lastExitSignal,
  });
}

function spawnChild() {
  if (child || desiredState !== "running" || shuttingDown) return;
  child = spawn(process.execPath, ["dist/index.js"], {
    cwd: ROOT_DIR,
    stdio: "inherit",
    env: {
      ...process.env,
      ML_MANAGED_LAUNCHER: "1",
      ML_LAUNCHER_PID: String(process.pid),
      ML_INSTALL_ROOT: ROOT_DIR,
      ML_DATA_DIR: process.env.DATA_DIR ?? "",
    },
  });
  persistState();
  child.on("exit", (code, signal) => {
    lastExitCode = typeof code === "number" ? code : null;
    lastExitSignal = signal ?? null;
    child = null;
    persistState();
    if (shuttingDown) {
      process.exit(lastExitCode ?? 0);
      return;
    }
    if (desiredState === "running") {
      setTimeout(() => spawnChild(), 150);
    }
  });
}

function stopChild() {
  if (!child) {
    persistState();
    return;
  }
  try {
    child.kill("SIGTERM");
  } catch {
    /* ignore */
  }
}

function applyCommand(command) {
  if (!command || command.id === lastCommandId) return;
  lastCommandId = command.id;
  if (command.action === "stop-child") {
    desiredState = "stopped";
    stopChild();
  } else if (command.action === "start-child") {
    desiredState = "running";
    if (!child) spawnChild();
  } else if (command.action === "restart-child") {
    desiredState = "running";
    if (child) stopChild();
    else spawnChild();
  }
  persistState();
}

setInterval(() => {
  applyCommand(readJson(MANAGED_COMMAND_PATH));
}, 700);

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    shuttingDown = true;
    desiredState = "stopped";
    if (!child) {
      process.exit(0);
      return;
    }
    stopChild();
  });
}

spawnChild();
