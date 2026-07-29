import { spawnSync } from "node:child_process";
import process from "node:process";

export function runCommand(command, args = [], options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: "utf8",
    input: options.input,
    maxBuffer: options.maxBuffer ?? 16 * 1024 * 1024,
    stdio: options.stdio ?? "pipe",
    shell: options.shell ?? false,
    windowsHide: true
  });
  return {
    command,
    args,
    status: result.status ?? (result.error ? 1 : 0),
    signal: result.signal ?? null,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error ?? null
  };
}

export function formatCommandFailure(result) {
  const command = [result.command, ...result.args].join(" ");
  const detail = String(result.stderr || result.stdout || result.error?.message || "").trim();
  return `${command}: ${result.signal ? `signal ${result.signal}` : `exit ${result.status}`}${detail ? `: ${detail}` : ""}`;
}

export function runCommandChecked(command, args = [], options = {}) {
  const result = runCommand(command, args, options);
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(formatCommandFailure(result));
  }
  return result;
}

export function binaryAvailable(command, versionArgs = ["--version"], options = {}) {
  const result = runCommand(command, versionArgs, options);
  if (result.error?.code === "ENOENT") {
    return { available: false, detail: "not found" };
  }
  if (result.error || result.status !== 0) {
    return {
      available: false,
      detail: result.error?.message ?? String(result.stderr || result.stdout || `exit ${result.status}`).trim()
    };
  }
  return { available: true, detail: String(result.stdout || result.stderr || "ok").trim() };
}

function missingProcess(text) {
  return /not found|no running instance|cannot find|does not exist|no such process/i.test(text);
}

export function isProcessAlive(pid, options = {}) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    (options.killImpl ?? process.kill.bind(process))(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

export function terminateProcessTree(pid, options = {}) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return { attempted: false, delivered: false, method: null };
  }
  const platform = options.platform ?? process.platform;
  const run = options.runCommandImpl ?? runCommand;
  const kill = options.killImpl ?? process.kill.bind(process);

  if (platform === "win32") {
    const result = run("taskkill", ["/PID", String(pid), "/T", "/F"], {
      cwd: options.cwd,
      env: options.env
    });
    if (!result.error && result.status === 0) {
      return { attempted: true, delivered: true, method: "taskkill", result };
    }
    if (!result.error && missingProcess(`${result.stdout}\n${result.stderr}`)) {
      return { attempted: true, delivered: false, method: "taskkill", result };
    }
    if (result.error?.code !== "ENOENT") {
      throw result.error ?? new Error(formatCommandFailure(result));
    }
  }

  try {
    if (platform !== "win32") {
      kill(-pid, "SIGTERM");
      return { attempted: true, delivered: true, method: "process-group" };
    }
    kill(pid, "SIGTERM");
    return { attempted: true, delivered: true, method: "process" };
  } catch (error) {
    if (platform !== "win32" && error?.code === "ESRCH") {
      try {
        kill(pid, "SIGTERM");
        return { attempted: true, delivered: true, method: "process" };
      } catch (innerError) {
        if (innerError?.code === "ESRCH") {
          return { attempted: true, delivered: false, method: "process" };
        }
        throw innerError;
      }
    }
    if (error?.code === "ESRCH") {
      return { attempted: true, delivered: false, method: "process" };
    }
    throw error;
  }
}
