import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
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
    windowsHide: true,
    windowsVerbatimArguments: options.windowsVerbatimArguments
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

/**
 * Quote a single argument for cmd.exe /c so user-controlled values (prompts)
 * never become unquoted shell metacharacters.
 */
export function quoteWindowsCmdArg(value) {
  const string = String(value);
  // Always quote: safe for spaces, &, |, >, <, ^, and empty strings.
  return `"${string.replace(/"/g, "\"\"")}"`;
}

/**
 * Resolve a command to a concrete executable path on Windows.
 * Prefers .exe over .cmd/.bat so spawn({ shell: false }) can start without a shell.
 * Returns the original command on non-Windows or when resolution fails.
 */
export function resolveExecutable(command, options = {}) {
  const platform = options.platform ?? process.platform;
  const raw = String(command ?? "").trim();
  if (!raw || platform !== "win32") {
    return raw;
  }
  if (path.isAbsolute(raw) && fs.existsSync(raw)) {
    return raw;
  }

  const run = options.runCommandImpl ?? runCommand;
  const env = options.env ?? process.env;
  const where = run("where.exe", [raw], {
    cwd: options.cwd,
    env,
    shell: false
  });
  if (!where.error && where.status === 0) {
    const candidates = String(where.stdout)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const preferred =
      candidates.find((line) => /\.exe$/i.test(line))
      ?? candidates.find((line) => /\.cmd$/i.test(line))
      ?? candidates.find((line) => /\.bat$/i.test(line))
      ?? candidates[0];
    if (preferred) {
      return preferred;
    }
  }

  // Manual PATH + PATHEXT probe when where.exe is unavailable.
  const pathExt = String(env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM")
    .split(";")
    .map((ext) => ext.trim())
    .filter(Boolean);
  const extensions = pathExt.length > 0 ? pathExt : [".EXE", ".CMD", ".BAT", ".COM"];
  const hasExt = /\.[^./\\]+$/.test(raw);
  const names = hasExt ? [raw] : [raw, ...extensions.map((ext) => `${raw}${ext}`)];
  // Prefer .exe when we synthesize names without an extension.
  names.sort((left, right) => Number(/\.exe$/i.test(right)) - Number(/\.exe$/i.test(left)));
  const pathEntries = String(env.PATH ?? env.Path ?? "")
    .split(path.delimiter)
    .filter(Boolean);
  for (const entry of pathEntries) {
    for (const name of names) {
      const candidate = path.join(entry, name);
      try {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
          return candidate;
        }
      } catch {
        // Ignore unreadable path entries.
      }
    }
  }
  return raw;
}

/**
 * Build a spawn-safe command/args pair for Windows npm .cmd shims and normal binaries.
 * Always keeps shell:false. User args (including prompts) are never passed via shell:true.
 *
 * - .exe / non-Windows: spawn(resolved, args, { shell: false })
 * - .cmd/.bat: spawn(ComSpec, ['/d','/s','/c', quotedLine], { shell: false, windowsVerbatimArguments: true })
 */
export function resolveSpawnInvocation(command, args = [], options = {}) {
  const platform = options.platform ?? process.platform;
  const resolved = resolveExecutable(command, options);
  if (platform === "win32" && /\.(cmd|bat)$/i.test(resolved)) {
    const env = options.env ?? process.env;
    const comspec = env.ComSpec || env.COMSPEC || process.env.ComSpec || process.env.COMSPEC || "cmd.exe";
    const line = [resolved, ...args].map(quoteWindowsCmdArg).join(" ");
    return {
      command: comspec,
      args: ["/d", "/s", "/c", line],
      shell: false,
      windowsVerbatimArguments: true,
      resolved
    };
  }
  return {
    command: resolved,
    args: [...args],
    shell: false,
    windowsVerbatimArguments: false,
    resolved
  };
}

/** @deprecated Prefer resolveSpawnInvocation; kept for call sites that only need the path. */
export function spawnCommandOptions(command, options = {}) {
  const invocation = resolveSpawnInvocation(command, [], options);
  return {
    command: invocation.resolved,
    shell: false,
    resolved: invocation.resolved
  };
}

export function binaryAvailable(command, versionArgs = ["--version"], options = {}) {
  const invocation = resolveSpawnInvocation(command, versionArgs, options);
  const run = options.runCommandImpl ?? runCommand;
  const result = run(invocation.command, invocation.args, {
    cwd: options.cwd,
    env: options.env,
    shell: false,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments
  });
  if (result.error?.code === "ENOENT") {
    return { available: false, detail: "not found", command: invocation.resolved };
  }
  if (result.error || result.status !== 0) {
    return {
      available: false,
      detail: result.error?.message ?? String(result.stderr || result.stdout || `exit ${result.status}`).trim(),
      command: invocation.resolved
    };
  }
  return { available: true, detail: String(result.stdout || result.stderr || "ok").trim(), command: invocation.resolved };
}

function missingProcess(text) {
  return /not found|no running instance|cannot find|does not exist|no such process/i.test(text);
}

function parseWindowsDate(value) {
  const raw = String(value ?? "").trim();
  if (!raw) {
    return null;
  }
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Best-effort process identity for PID-reuse guards.
 * Returns null when the process is gone or identity cannot be read.
 */
export function getProcessIdentity(pid, options = {}) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return null;
  }
  const platform = options.platform ?? process.platform;
  const run = options.runCommandImpl ?? runCommand;

  if (platform === "win32") {
    const ps = run(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        `Get-Process -Id ${pid} -ErrorAction SilentlyContinue | Select-Object -First 1 -Property ProcessName,StartTime | ConvertTo-Json -Compress`
      ],
      { cwd: options.cwd, env: options.env, shell: false }
    );
    if (!ps.error && ps.status === 0 && ps.stdout.trim()) {
      try {
        const data = JSON.parse(ps.stdout);
        const name = data?.ProcessName ? String(data.ProcessName) : null;
        const startedAtMs = parseWindowsDate(data?.StartTime);
        if (name || startedAtMs != null) {
          return { pid, name, startedAtMs };
        }
      } catch {
        // Fall through to wmic.
      }
    }
    const wmic = run(
      "wmic",
      ["process", "where", `ProcessId=${pid}`, "get", "Name,CreationDate", "/format:csv"],
      { cwd: options.cwd, env: options.env, shell: false }
    );
    if (!wmic.error && wmic.status === 0) {
      const lines = String(wmic.stdout)
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      // CSV: Node,CreationDate,Name
      for (const line of lines.slice(1)) {
        const parts = line.split(",");
        if (parts.length < 3) {
          continue;
        }
        const creation = parts[parts.length - 2] ?? "";
        const name = (parts[parts.length - 1] ?? "").replace(/\.exe$/i, "");
        // WMIC CreationDate like 20260729123045.123456+480
        const match = creation.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/);
        let startedAtMs = null;
        if (match) {
          startedAtMs = Date.UTC(
            Number(match[1]),
            Number(match[2]) - 1,
            Number(match[3]),
            Number(match[4]),
            Number(match[5]),
            Number(match[6])
          );
        }
        if (name || startedAtMs != null) {
          return { pid, name: name || null, startedAtMs };
        }
      }
    }
    return null;
  }

  // POSIX: prefer /proc, fall back to ps.
  try {
    const comm = fs.readFileSync(`/proc/${pid}/comm`, "utf8").trim();
    let startedAtMs = null;
    try {
      const procStat = fs.statSync(`/proc/${pid}`);
      startedAtMs = procStat.birthtimeMs || procStat.ctimeMs || null;
    } catch {
      // ignore
    }
    if (comm) {
      return { pid, name: comm, startedAtMs };
    }
  } catch {
    // /proc unavailable (macOS etc.)
  }

  const ps = run("ps", ["-o", "lstart=,comm=", "-p", String(pid)], {
    cwd: options.cwd,
    env: options.env,
    shell: false
  });
  if (!ps.error && ps.status === 0 && ps.stdout.trim()) {
    const line = ps.stdout.trim();
    // lstart is like "Mon Jul 29 12:30:45 2026" then comm
    const match = line.match(/^([A-Z][a-z]{2}\s+\S+\s+\d+\s+\d+:\d+:\d+\s+\d+)\s+(.+)$/);
    if (match) {
      return {
        pid,
        name: match[2].trim().split(/[\\/]/).pop() ?? match[2].trim(),
        startedAtMs: Date.parse(match[1])
      };
    }
    return { pid, name: line.split(/\s+/).pop() ?? null, startedAtMs: null };
  }
  return null;
}

function normalizeProcessName(name) {
  return String(name ?? "")
    .trim()
    .replace(/\.exe$/i, "")
    .split(/[\\/]/)
    .pop()
    .toLowerCase();
}

/**
 * Optional identity match for PID-reuse safety.
 * When no expected* fields are provided, always matches (backward compatible).
 */
export function processIdentityMatches(identity, options = {}) {
  if (!options.expectedName && options.expectedStartedAt == null && options.expectedStartedAtMs == null) {
    return true;
  }
  if (!identity) {
    return false;
  }
  if (options.expectedName) {
    const expected = normalizeProcessName(options.expectedName);
    const actual = normalizeProcessName(identity.name);
    if (!actual || actual !== expected) {
      return false;
    }
  }
  const expectedMs = options.expectedStartedAtMs
    ?? (options.expectedStartedAt != null ? Date.parse(String(options.expectedStartedAt)) : null);
  if (expectedMs != null && Number.isFinite(expectedMs)) {
    if (identity.startedAtMs == null || !Number.isFinite(identity.startedAtMs)) {
      // Name matched (or not required) but start time unavailable.
      // If we only have a name expectation that already matched, accept;
      // pure start-time checks without a readable clock are a mismatch.
      return Boolean(options.expectedName);
    }
    // Allow skew between job bookkeeping and OS process start.
    const skewMs = options.startTimeSkewMs ?? 120_000;
    if (Math.abs(identity.startedAtMs - expectedMs) > skewMs) {
      return false;
    }
  }
  return true;
}

function signalAlive(pid, kill) {
  try {
    kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

export function isProcessAlive(pid, options = {}) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  const kill = options.killImpl ?? process.kill.bind(process);
  if (!signalAlive(pid, kill)) {
    return false;
  }
  // Backward compatible: no identity expectations → alive if kill(pid,0) succeeds.
  if (!options.expectedName && options.expectedStartedAt == null && options.expectedStartedAtMs == null) {
    return true;
  }
  const identity = typeof options.getIdentityImpl === "function"
    ? options.getIdentityImpl(pid, options)
    : getProcessIdentity(pid, options);
  return processIdentityMatches(identity, options);
}

function collectDescendantPids(pid, options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    return [];
  }
  const run = options.runCommandImpl ?? runCommand;
  const seen = new Set();
  const queue = [pid];
  const descendants = [];
  while (queue.length > 0) {
    const current = queue.shift();
    const result = run("pgrep", ["-P", String(current)], {
      cwd: options.cwd,
      env: options.env,
      shell: false
    });
    if (result.error || result.status !== 0) {
      continue;
    }
    for (const line of String(result.stdout).split(/\r?\n/)) {
      const child = Number(line.trim());
      if (!Number.isInteger(child) || child <= 0 || seen.has(child) || child === pid) {
        continue;
      }
      seen.add(child);
      descendants.push(child);
      queue.push(child);
    }
  }
  return descendants;
}

function tryKill(kill, pid, signal) {
  try {
    kill(pid, signal);
    return { ok: true, code: null };
  } catch (error) {
    return { ok: false, code: error?.code ?? null, error };
  }
}

export function terminateProcessTree(pid, options = {}) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return { attempted: false, delivered: false, method: null };
  }
  const platform = options.platform ?? process.platform;
  const run = options.runCommandImpl ?? runCommand;
  const kill = options.killImpl ?? process.kill.bind(process);

  // PID-reuse guard: refuse to signal a process that no longer matches expectations.
  if (options.expectedName || options.expectedStartedAt != null || options.expectedStartedAtMs != null) {
    const identity = typeof options.getIdentityImpl === "function"
      ? options.getIdentityImpl(pid, options)
      : getProcessIdentity(pid, options);
    if (!processIdentityMatches(identity, options)) {
      return { attempted: true, delivered: false, method: "identity-mismatch", identity };
    }
  }

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

  // Explicit child PIDs (e.g. recorded Grok worker children) are always targeted.
  const extraChildren = Array.isArray(options.childPids)
    ? options.childPids.filter((value) => Number.isInteger(value) && value > 0 && value !== pid)
    : [];
  const descendants = platform === "win32"
    ? []
    : collectDescendantPids(pid, { ...options, runCommandImpl: run });
  const tree = [...new Set([...extraChildren, ...descendants])];

  if (platform !== "win32") {
    // Prefer process-group signal so a detached/session-leader worker and its Grok child die together.
    const group = tryKill(kill, -pid, "SIGTERM");
    if (group.ok) {
      let method = "process-group";
      for (const child of tree) {
        const childKill = tryKill(kill, child, "SIGTERM");
        if (childKill.ok) {
          method = "process-group+tree";
        } else if (childKill.code && childKill.code !== "ESRCH") {
          throw childKill.error;
        }
      }
      return { attempted: true, delivered: true, method };
    }
    if (group.code && group.code !== "ESRCH" && group.code !== "EPERM") {
      // Unexpected group-kill failure: still try direct targets below.
    }
  }

  // Direct PID + descendant fallback (group missing, Windows without taskkill, etc.).
  let delivered = false;
  let method = null;
  const targets = platform === "win32" ? [pid] : [pid, ...tree];
  for (const target of targets) {
    const result = tryKill(kill, target, "SIGTERM");
    if (result.ok) {
      delivered = true;
      if (!method) {
        method = target === pid ? "process" : "process-tree";
      } else if (method === "process" && target !== pid) {
        method = "process+tree";
      }
      continue;
    }
    if (result.code === "ESRCH") {
      continue;
    }
    if (result.code === "EPERM") {
      delivered = true;
      method = method ?? (target === pid ? "process" : "process-tree");
      continue;
    }
    throw result.error;
  }

  return { attempted: true, delivered, method: method ?? "process" };
}
