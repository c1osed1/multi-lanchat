import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import {
  MANAGED_COMMAND_PATH,
  MANAGED_STATE_PATH,
  ROOT_DIR,
  UPDATE_STATE_PATH,
  readJson,
  writeJson,
} from "./runtime-paths.mjs";

const execFileAsync = promisify(execFile);

function now() {
  return new Date().toISOString();
}

function setProgress(patch) {
  const prev = readJson(UPDATE_STATE_PATH) ?? {
    status: "idle",
    step: "idle",
    message: "",
    startedAt: null,
    finishedAt: null,
    error: null,
  };
  writeJson(UPDATE_STATE_PATH, {
    ...prev,
    ...patch,
  });
}

async function run(cmd, args, cwd = ROOT_DIR) {
  const { stdout } = await execFileAsync(cmd, args, {
    cwd,
    windowsHide: true,
  });
  return stdout.trim();
}

async function waitFor(predicate, timeoutMs, step, message) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    setProgress({
      status: "running",
      step,
      message,
      startedAt: readJson(UPDATE_STATE_PATH)?.startedAt ?? now(),
      finishedAt: null,
      error: null,
    });
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(message);
}

function sendCommand(action, reason) {
  writeJson(MANAGED_COMMAND_PATH, {
    id: randomUUID(),
    action,
    reason,
    requestedAt: now(),
  });
}

async function main() {
  const startedAt = now();
  setProgress({
    status: "running",
    step: "checking",
    message: "Проверяем рабочее дерево перед обновлением",
    startedAt,
    finishedAt: null,
    error: null,
  });

  const porcelain = await run("git", ["status", "--porcelain", "--untracked-files=no"]);
  if (porcelain) {
    throw new Error("Автообновление остановлено: в репозитории есть локальные изменения");
  }

  const branch = await run("git", ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  const managed = readJson(MANAGED_STATE_PATH);
  if (!managed?.launcherPid) {
    throw new Error("Managed launcher не найден");
  }

  setProgress({
    status: "running",
    step: "stopping",
    message: "Останавливаем сервер перед заменой файлов",
    startedAt,
    finishedAt: null,
    error: null,
  });
  sendCommand("stop-child", "self-update");
  await waitFor(
    () => {
      const state = readJson(MANAGED_STATE_PATH);
      return !state?.childRunning;
    },
    30_000,
    "stopping",
    "Сервер долго останавливается перед обновлением",
  );

  setProgress({
    status: "running",
    step: "pulling",
    message: `Подтягиваем ${branch}`,
    startedAt,
    finishedAt: null,
    error: null,
  });
  await run("git", ["pull", "--ff-only"]);

  setProgress({
    status: "running",
    step: "installing",
    message: "Обновляем production-зависимости",
    startedAt,
    finishedAt: null,
    error: null,
  });
  await run("npm", ["install", "--omit=dev"]);

  setProgress({
    status: "running",
    step: "starting",
    message: "Поднимаем обновлённый сервер",
    startedAt,
    finishedAt: null,
    error: null,
  });
  sendCommand("start-child", "self-update");
  await waitFor(
    () => {
      const state = readJson(MANAGED_STATE_PATH);
      return Boolean(state?.childRunning);
    },
    45_000,
    "starting",
    "Новый сервер не поднялся после обновления",
  );

  setProgress({
    status: "done",
    step: "done",
    message: "Обновление завершено, сервер перезапущен",
    startedAt,
    finishedAt: now(),
    error: null,
  });
}

main().catch((error) => {
  sendCommand("start-child", "recover-after-update-failure");
  setProgress({
    status: "failed",
    step: "failed",
    message: "Обновление завершилось с ошибкой",
    startedAt: readJson(UPDATE_STATE_PATH)?.startedAt ?? now(),
    finishedAt: now(),
    error: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});
