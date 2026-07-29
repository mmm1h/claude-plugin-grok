import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { createTempDir } from "./fs.mjs";
import { binaryAvailable, runCommand, terminateProcessTree } from "./process.mjs";
import { listJobs } from "./state.mjs";

const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000;
const INLINE_PROMPT_MAX_BYTES = 6 * 1024;
const READ_ONLY_TOOLS = "read_file,grep,list_dir";

function grokBinary(options = {}) {
  return options.binary ?? process.env.GROK_COMPANION_GROK_BINARY ?? "grok";
}

function grokPrefixArgs(options = {}) {
  if (options.binaryPrefixArgs) {
    return options.binaryPrefixArgs;
  }
  const raw = options.env?.GROK_COMPANION_GROK_PREFIX_ARGS ?? process.env.GROK_COMPANION_GROK_PREFIX_ARGS;
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    throw new Error("GROK_COMPANION_GROK_PREFIX_ARGS must be a JSON array.");
  }
}

export function getGrokAvailability(cwd, options = {}) {
  return {
    command: grokBinary(options),
    ...binaryAvailable(grokBinary(options), ["--version"], {
      cwd,
      env: options.env
    })
  };
}

function hasNonEmptyFile(file) {
  try {
    return fs.statSync(file).isFile() && fs.statSync(file).size > 0;
  } catch {
    return false;
  }
}

export function getGrokAuthStatus(_cwd, options = {}) {
  const env = options.env ?? process.env;
  if (env.GROK_API_KEY || env.XAI_API_KEY) {
    return {
      status: "configured",
      loggedIn: true,
      source: env.GROK_API_KEY ? "GROK_API_KEY" : "XAI_API_KEY",
      detail: "An API key environment variable is present."
    };
  }

  const grokHome = options.grokHome ?? path.join(os.homedir(), ".grok");
  const credentialFiles = [
    "credentials.json",
    "auth.json",
    "oauth.json",
    "tokens.json"
  ].map((name) => path.join(grokHome, name));
  const credential = credentialFiles.find(hasNonEmptyFile);
  if (credential) {
    return {
      status: "configured",
      loggedIn: true,
      source: path.basename(credential),
      detail: "A local Grok credential file is present."
    };
  }

  const configPresent = hasNonEmptyFile(path.join(grokHome, "config.toml"));
  const localIdentityPresent = hasNonEmptyFile(path.join(grokHome, "agent_id"));
  if (configPresent || localIdentityPresent) {
    return {
      status: "unknown",
      loggedIn: null,
      source: configPresent ? "config.toml" : "agent_id",
      detail: "Grok is configured locally, but authentication was not tested to avoid a network or model call."
    };
  }

  return {
    status: "needs_login",
    loggedIn: false,
    source: null,
    detail: "No local Grok authentication evidence was found. Run `grok login`."
  };
}

export function buildGrokArgs(options = {}) {
  const args = [...grokPrefixArgs(options)];
  const sessionId = options.resumeSessionId || options.sessionId || randomUUID();
  args.push("--output-format", "plain", "--verbatim", "--no-memory");
  if (options.model) {
    args.push("--model", String(options.model));
  }
  if (options.effort) {
    args.push("--reasoning-effort", String(options.effort));
  }
  if (options.resumeSessionId) {
    args.push("--resume", String(options.resumeSessionId));
  } else {
    args.push("--session-id", sessionId);
  }

  if (options.write) {
    args.push("--always-approve", "--permission-mode", "bypassPermissions");
  } else {
    args.push(
      "--permission-mode",
      "plan",
      "--tools",
      READ_ONLY_TOOLS,
      "--no-subagents",
      "--disable-web-search"
    );
  }

  if (options.promptFile) {
    args.push("--prompt-file", options.promptFile);
  } else {
    args.push("-p", String(options.prompt ?? ""));
  }
  return { args, sessionId };
}

function progressLines(stream, onProgress) {
  if (!onProgress) {
    return;
  }
  let pending = "";
  stream.on("data", (chunk) => {
    pending += chunk.toString();
    const parts = pending.split(/\r?\n/);
    pending = parts.pop() ?? "";
    for (const line of parts) {
      if (line.trim()) {
        onProgress(line.trim());
      }
    }
  });
  stream.on("end", () => {
    if (pending.trim()) {
      onProgress(pending.trim());
    }
  });
}

function parsedSessionId(stdout, stderr, fallback) {
  const combined = `${stdout}\n${stderr}`;
  const labelled = combined.match(/(?:session(?:\s+id)?|session_id)\s*[:=]\s*([0-9a-f-]{32,36})/i);
  return labelled?.[1] ?? fallback;
}

export async function runGrokHeadless(options = {}) {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const childEnv = options.env ?? process.env;
  let tempDir = null;
  let promptFile = options.promptFile ? path.resolve(cwd, options.promptFile) : null;
  if (!promptFile && Buffer.byteLength(String(options.prompt ?? ""), "utf8") > INLINE_PROMPT_MAX_BYTES) {
    tempDir = createTempDir("grok-companion-prompt-");
    promptFile = path.join(tempDir, "prompt.md");
    fs.writeFileSync(promptFile, String(options.prompt ?? ""), "utf8");
  }

  const built = buildGrokArgs({ ...options, promptFile });
  const command = grokBinary(options);
  const startedAt = Date.now();
  try {
    const result = await new Promise((resolve, reject) => {
      const child = spawn(command, built.args, {
        cwd,
        env: childEnv,
        detached: process.platform !== "win32" && childEnv.GROK_COMPANION_BACKGROUND_WORKER !== "1",
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"]
      });
      let stdout = "";
      let stderr = "";
      let settled = false;
      let timer = null;
      let outputBytes = 0;
      const maxOutputBytes = options.maxOutputBytes ?? 32 * 1024 * 1024;

      const append = (current, chunk) => {
        outputBytes += Buffer.byteLength(chunk);
        if (outputBytes > maxOutputBytes) {
          throw new Error(`Grok output exceeded ${maxOutputBytes} bytes.`);
        }
        return current + chunk.toString();
      };
      const fail = (error, terminate = true) => {
        if (settled) {
          return;
        }
        settled = true;
        if (timer) {
          clearTimeout(timer);
        }
        if (terminate) {
          try {
            terminateProcessTree(child.pid);
          } catch {
            // Preserve the original process or output failure.
          }
        }
        reject(error);
      };

      child.stdout.on("data", (chunk) => {
        try {
          stdout = append(stdout, chunk);
        } catch (error) {
          fail(error);
        }
      });
      child.stderr.on("data", (chunk) => {
        try {
          stderr = append(stderr, chunk);
        } catch (error) {
          fail(error);
        }
      });
      progressLines(child.stderr, options.onProgress);

      timer = setTimeout(() => {
        fail(new Error(`Grok timed out after ${options.timeoutMs ?? DEFAULT_TIMEOUT_MS} ms.`));
      }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      timer.unref?.();

      child.once("error", (error) => {
        fail(error, false);
      });
      child.once("close", (code, signal) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve({ exitCode: code ?? 1, signal, stdout, stderr, pid: child.pid ?? null });
        }
      });
    });
    return {
      ...result,
      command,
      args: built.args,
      sessionId: parsedSessionId(result.stdout, result.stderr, built.sessionId),
      durationMs: Date.now() - startedAt
    };
  } finally {
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }
}

function firstSessionId(output) {
  return String(output ?? "").match(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i)?.[0] ?? null;
}

export function findLatestTaskSession(cwd, options = {}) {
  const fromJobs = [...listJobs(cwd)]
    .sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")))
    .find((job) => job.kind === "task" && job.sessionId);
  if (fromJobs) {
    return { sessionId: fromJobs.sessionId, source: "companion-job", jobId: fromJobs.id };
  }

  const availability = getGrokAvailability(cwd, options);
  if (!availability.available) {
    return null;
  }
  const result = runCommand(grokBinary(options), ["sessions", "list", "--limit", "20"], {
    cwd,
    env: options.env,
    shell: false
  });
  if (result.error || result.status !== 0) {
    return null;
  }
  const sessionId = firstSessionId(result.stdout);
  return sessionId ? { sessionId, source: "grok-sessions", jobId: null } : null;
}
