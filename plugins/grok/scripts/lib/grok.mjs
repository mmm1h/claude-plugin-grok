import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { createTempDir } from "./fs.mjs";
import { binaryAvailable, runCommand, terminateProcessTree } from "./process.mjs";
import { listJobs } from "./state.mjs";
import { resolveWorkspaceRoot } from "./workspace.mjs";

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

export function getGrokCapabilities(cwd, options = {}) {
  const command = grokBinary(options);
  const result = runCommand(command, [...grokPrefixArgs(options), "--help"], {
    cwd,
    env: options.env,
    shell: false
  });
  if (result.error || result.status !== 0) {
    return {
      available: false,
      jsonSchema: false,
      sandbox: false,
      detail: String(result.stderr || result.stdout || result.error?.message || `exit ${result.status}`).trim()
    };
  }
  const help = `${result.stdout}\n${result.stderr}`;
  const jsonSchema = /(?:^|\s)--json-schema(?:\s|[=<]|$)/m.test(help);
  const sandbox = /(?:^|\s)--sandbox(?:\s|[=<]|$)/m.test(help);
  return {
    available: jsonSchema && sandbox,
    jsonSchema,
    sandbox,
    detail: jsonSchema && sandbox
      ? "Supports structured review output and read-only sandboxing."
      : `Missing required review capabilities: ${[
          !jsonSchema ? "--json-schema" : null,
          !sandbox ? "--sandbox" : null
        ].filter(Boolean).join(", ")}.`
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
  if (options.jsonSchema != null) {
    const schema = typeof options.jsonSchema === "string"
      ? options.jsonSchema
      : JSON.stringify(options.jsonSchema);
    args.push("--json-schema", schema);
  } else {
    args.push("--output-format", String(options.outputFormat ?? "plain"));
  }
  args.push("--verbatim", "--no-memory");
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
    if (options.sandbox) {
      args.push("--sandbox", String(options.sandbox));
    }
    args.push("--always-approve", "--permission-mode", "bypassPermissions");
  } else {
    args.push(
      "--sandbox",
      "read-only",
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

const STRUCTURED_OUTPUT_FIELDS = ["result", "message", "content", "output", "text"];

function extractStructuredObject(value, depth = 0) {
  if (depth > 8) {
    throw new Error("Grok structured output envelope is nested too deeply.");
  }
  if (typeof value === "string") {
    const text = value.trim();
    if (!text) {
      throw new Error("Grok structured output envelope contains an empty value.");
    }
    return extractStructuredObject(JSON.parse(text), depth + 1);
  }
  if (Array.isArray(value)) {
    if (value.length !== 1) {
      throw new Error("Grok structured output envelope must contain exactly one payload.");
    }
    return extractStructuredObject(value[0], depth + 1);
  }
  if (!value || typeof value !== "object") {
    throw new Error("Grok structured output is not a JSON object.");
  }
  for (const field of STRUCTURED_OUTPUT_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(value, field) && value[field] != null) {
      return extractStructuredObject(value[field], depth + 1);
    }
  }
  return value;
}

export function parseGrokStructuredOutput(stdout) {
  const raw = String(stdout ?? "");
  if (!raw.trim()) {
    return { ok: false, parseError: "Grok returned no structured output.", raw };
  }
  try {
    const data = extractStructuredObject(JSON.parse(raw));
    return { ok: true, data, raw };
  } catch (error) {
    return {
      ok: false,
      parseError: error instanceof Error ? error.message : String(error),
      raw
    };
  }
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

function parsedSessionId(stdout, stderr) {
  const combined = `${stdout}\n${stderr}`;
  const labelled = combined.match(/(?:session(?:\s+id)?|session_id)\s*[:=]\s*([0-9a-f-]{32,36})/i);
  return labelled?.[1] ?? null;
}

function streamText(value) {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(streamText).join("");
  }
  if (!value || typeof value !== "object") {
    return "";
  }
  if (typeof value.text === "string") {
    return value.text;
  }
  if (typeof value.content === "string" || Array.isArray(value.content)) {
    return streamText(value.content);
  }
  if (value.message != null) {
    return streamText(value.message);
  }
  if (value.delta != null) {
    return streamText(value.delta);
  }
  return "";
}

function streamSessionId(event) {
  const values = [
    event?.sessionId,
    event?.session_id,
    event?.session?.id,
    event?.message?.sessionId,
    event?.message?.session_id
  ];
  return values.find((value) => typeof value === "string" && /^[0-9a-f-]{32,36}$/i.test(value)) ?? null;
}

export function normalizeGrokStreamingEvent(event, at = new Date().toISOString()) {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    return null;
  }
  const eventType = String(event.type ?? event.event ?? event.kind ?? "unknown");
  const normalizedType = eventType.toLowerCase();
  const sessionId = streamSessionId(event);
  const toolName = event.name ?? event.tool_name ?? event.tool?.name ?? event.message?.name ?? null;
  let phase = "running";
  if (/tool|command|function/.test(normalizedType)) {
    phase = "tool";
  } else if (/assistant|message|content|delta/.test(normalizedType)) {
    phase = "assistant";
  } else if (/result|final|complete/.test(normalizedType)) {
    phase = "finalizing";
  } else if (/error|fail/.test(normalizedType)) {
    phase = "failed";
  }

  let message = "";
  if (toolName) {
    message = `Grok tool: ${toolName}`;
  } else if (typeof event.message === "string") {
    message = event.message;
  } else if (typeof event.error === "string") {
    message = event.error;
  } else if (sessionId) {
    message = `Grok session confirmed: ${sessionId}`;
  } else {
    message = streamText(event.message ?? event.delta ?? event.content ?? event.result ?? event.output);
  }

  return {
    message: String(message).trim().replace(/\s+/g, " ").slice(0, 500),
    phase,
    sessionId,
    eventType,
    at
  };
}

function createStreamingCollector(options = {}) {
  let pending = "";
  let observedSessionId = null;
  const finalTexts = [];
  const assistantTexts = [];

  const acceptLine = (line) => {
    const raw = String(line).trim();
    if (!raw) {
      return;
    }
    let event;
    try {
      event = JSON.parse(raw);
    } catch {
      options.onProgress?.(`Unparsed streaming output: ${raw}`);
      return;
    }
    const telemetry = normalizeGrokStreamingEvent(event);
    if (!telemetry) {
      options.onProgress?.(`Unknown streaming event: ${raw}`);
      return;
    }
    observedSessionId = telemetry.sessionId ?? observedSessionId;
    options.onTelemetry?.(telemetry, event);

    const type = telemetry.eventType.toLowerCase();
    const finalText = /result|final|complete/.test(type)
      ? streamText(event.result ?? event.output ?? event.message ?? event.content)
      : "";
    if (finalText.trim()) {
      finalTexts.push(finalText);
    } else if (/assistant|message|content|delta/.test(type)) {
      const assistantText = streamText(event.message ?? event.delta ?? event.content);
      if (assistantText) {
        assistantTexts.push(assistantText);
      }
    }
    if (!/system|init|session|tool|command|function|assistant|message|content|delta|result|final|complete|error|fail/i.test(telemetry.eventType)) {
      options.onProgress?.(`Unknown streaming event: ${raw}`);
    }
  };

  return {
    push(chunk) {
      pending += chunk.toString();
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? "";
      for (const line of lines) {
        acceptLine(line);
      }
    },
    end() {
      acceptLine(pending);
      pending = "";
    },
    result(rawOutput) {
      const finalText = finalTexts.at(-1)?.trimEnd();
      const assistantText = assistantTexts.join("").trimEnd();
      return {
        stdout: finalText || assistantText || String(rawOutput ?? "").trimEnd(),
        observedSessionId
      };
    }
  };
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
  const streaming = options.outputFormat === "streaming-json"
    ? createStreamingCollector(options)
    : null;
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
          streaming?.push(chunk);
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
          streaming?.end();
          resolve({ exitCode: code ?? 1, signal, stdout, stderr, pid: child.pid ?? null });
        }
      });
    });
    const collected = streaming?.result(result.stdout) ?? { stdout: result.stdout, observedSessionId: null };
    const labelledSessionId = parsedSessionId(result.stdout, result.stderr);
    const observedSessionId = collected.observedSessionId ?? labelledSessionId;
    return {
      ...result,
      stdout: collected.stdout,
      rawStdout: result.stdout,
      command,
      args: built.args,
      sessionId: observedSessionId ?? built.sessionId,
      sessionConfirmed: Boolean(observedSessionId || options.sessionConfirmed),
      durationMs: Date.now() - startedAt
    };
  } finally {
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }
}

export function findLatestTaskSession(cwd, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const claudeSessionId = options.claudeSessionId
    ?? options.env?.GROK_COMPANION_CLAUDE_SESSION_ID
    ?? process.env.GROK_COMPANION_CLAUDE_SESSION_ID
    ?? null;
  if (!claudeSessionId) {
    return null;
  }
  const scoped = [...listJobs(workspaceRoot)]
    .filter((job) => job.kind === "task"
      && job.claudeSessionId === claudeSessionId
      && resolveWorkspaceRoot(job.workspaceRoot ?? job.cwd) === workspaceRoot);
  const active = scoped.find((job) => ["queued", "running"].includes(job.status));
  if (active) {
    throw new Error(`Cannot resume while Grok task ${active.id} is ${active.status} in this Claude session.`);
  }
  const fromJobs = scoped
    .sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")))
    .find((job) => ["completed", "failed", "cancelled"].includes(job.status)
      && job.sessionId
      && job.sessionConfirmed === true
      && job.resumable === true);
  if (fromJobs) {
    return {
      sessionId: fromJobs.sessionId,
      source: "companion-job",
      jobId: fromJobs.id,
      status: fromJobs.status,
      summary: fromJobs.summary,
      updatedAt: fromJobs.updatedAt,
      sessionConfirmed: true
    };
  }
  return null;
}
