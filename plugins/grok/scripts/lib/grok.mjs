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
// Grok multi-turn structured runs may emit one JSON object per turn, concatenated.
// Prefer the last complete object so intermediate empty findings do not poison parse.
const KNOWN_STREAM_EVENT_TYPES =
  /^(system|init|session|tool|command|function|assistant|message|content|delta|result|final|complete|error|fail|thought|thinking|reasoning|text|end|usage)(_|$)|^(tool|command|function|assistant|message|content|delta|result|final|complete|error|fail|thought|thinking|reasoning|text|end|usage|system|init|session)/i;

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

/**
 * Split concatenated top-level JSON values (e.g. `{}{}` from multi-turn schema output).
 * Returns values in order; callers should prefer the last complete object.
 */
export function parseConcatenatedJsonValues(raw) {
  const text = String(raw ?? "");
  const values = [];
  let index = 0;
  while (index < text.length) {
    while (index < text.length && /\s/.test(text[index])) {
      index += 1;
    }
    if (index >= text.length) {
      break;
    }
    const startChar = text[index];
    if (startChar !== "{" && startChar !== "[") {
      const nextObject = text.indexOf("{", index);
      const nextArray = text.indexOf("[", index);
      const next = [nextObject, nextArray].filter((value) => value >= 0).sort((a, b) => a - b)[0];
      if (next == null) {
        break;
      }
      index = next;
      continue;
    }
    let depth = 0;
    let inString = false;
    let escape = false;
    let end = -1;
    for (let cursor = index; cursor < text.length; cursor += 1) {
      const ch = text[cursor];
      if (inString) {
        if (escape) {
          escape = false;
          continue;
        }
        if (ch === "\\") {
          escape = true;
          continue;
        }
        if (ch === "\"") {
          inString = false;
        }
        continue;
      }
      if (ch === "\"") {
        inString = true;
        continue;
      }
      if (ch === "{" || ch === "[") {
        depth += 1;
        continue;
      }
      if (ch === "}" || ch === "]") {
        depth -= 1;
        if (depth === 0) {
          end = cursor;
          break;
        }
      }
    }
    if (end < 0) {
      break;
    }
    values.push(JSON.parse(text.slice(index, end + 1)));
    index = end + 1;
  }
  return values;
}

function selectPreferredStructuredValue(values) {
  if (!values.length) {
    throw new Error("Grok structured output did not contain a complete JSON value.");
  }
  // Prefer the last object that already looks like review/stop-review payload.
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const value = values[index];
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      continue;
    }
    if (
      Object.prototype.hasOwnProperty.call(value, "verdict") ||
      Object.prototype.hasOwnProperty.call(value, "decision") ||
      Object.prototype.hasOwnProperty.call(value, "findings") ||
      STRUCTURED_OUTPUT_FIELDS.some((field) => Object.prototype.hasOwnProperty.call(value, field))
    ) {
      return value;
    }
  }
  return values[values.length - 1];
}

export function parseGrokStructuredOutput(stdout) {
  const raw = String(stdout ?? "");
  if (!raw.trim()) {
    return { ok: false, parseError: "Grok returned no structured output.", raw };
  }
  try {
    let root;
    try {
      root = JSON.parse(raw);
    } catch {
      const values = parseConcatenatedJsonValues(raw);
      root = selectPreferredStructuredValue(values);
    }
    // Also handle NDJSON (one object per line): take last non-empty line object.
    if (typeof root === "object" && root != null && !Array.isArray(root)) {
      // single object ok
    } else if (raw.includes("\n") && raw.trim().startsWith("{")) {
      const lineValues = raw
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .flatMap((line) => {
          try {
            return [JSON.parse(line)];
          } catch {
            try {
              return parseConcatenatedJsonValues(line);
            } catch {
              return [];
            }
          }
        });
      if (lineValues.length > 1) {
        root = selectPreferredStructuredValue(lineValues);
      }
    }
    // Concatenated objects that still parse as first-only is impossible with JSON.parse;
    // when raw has }{ between values, JSON.parse fails and we already split above.
    if (/\}\s*\{/.test(raw.trim())) {
      const values = parseConcatenatedJsonValues(raw);
      if (values.length > 1) {
        root = selectPreferredStructuredValue(values);
      }
    }
    const data = extractStructuredObject(root);
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
  // thought/text/end are emitted by Grok CLI 0.2.x streaming-json; never treat as unknown.
  if (/thought|thinking|reasoning/.test(normalizedType)) {
    phase = "reasoning";
  } else if (/tool|command|function/.test(normalizedType)) {
    phase = "tool";
  } else if (/assistant|message|content|delta|^text$/.test(normalizedType)) {
    phase = "assistant";
  } else if (/result|final|complete|^end$/.test(normalizedType)) {
    phase = "finalizing";
  } else if (/error|fail/.test(normalizedType)) {
    phase = "failed";
  } else if (/usage|system|init|session/.test(normalizedType)) {
    phase = "running";
  }

  let message = "";
  if (/thought|thinking|reasoning/.test(normalizedType)) {
    // Suppress token-level reasoning from progress streams (would flood Claude context).
    message = "";
  } else if (toolName) {
    message = `Grok tool: ${toolName}`;
  } else if (typeof event.message === "string") {
    message = event.message;
  } else if (typeof event.error === "string") {
    message = event.error;
  } else if (sessionId) {
    message = `Grok session confirmed: ${sessionId}`;
  } else if (/^text$/.test(normalizedType)) {
    // Accumulate text via collector; keep progress quiet.
    message = "";
  } else if (/^end$|^usage$/.test(normalizedType)) {
    message = "";
  } else {
    message = streamText(event.message ?? event.delta ?? event.content ?? event.result ?? event.output);
  }

  return {
    message: String(message).trim().replace(/\s+/g, " ").slice(0, 500),
    phase,
    sessionId,
    eventType,
    at,
    suppressProgress: /thought|thinking|reasoning|^text$|^end$|^usage$/.test(normalizedType)
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
      // Do not forward raw event bodies — they can be huge reasoning tokens.
      options.onProgress?.("Unparsed streaming event ignored.");
      return;
    }
    observedSessionId = telemetry.sessionId ?? observedSessionId;
    options.onTelemetry?.(telemetry, event);

    const type = telemetry.eventType.toLowerCase();
    const finalText = /result|final|complete|^end$/.test(type)
      ? streamText(event.result ?? event.output ?? event.message ?? event.content ?? event.text)
      : "";
    if (finalText.trim()) {
      finalTexts.push(finalText);
    } else if (/assistant|message|content|delta|^text$/.test(type)) {
      const assistantText = streamText(
        event.message ?? event.delta ?? event.content ?? event.text ?? event
      );
      if (assistantText) {
        assistantTexts.push(assistantText);
      }
    }
    // Never echo raw unknown JSON into progress (leaks thought tokens into Claude context).
    // Known thought/text/end/usage events are intentionally silent in progress.
    if (!KNOWN_STREAM_EVENT_TYPES.test(telemetry.eventType) && !telemetry.suppressProgress) {
      options.onProgress?.(`Unknown streaming event type: ${telemetry.eventType}`);
    } else if (telemetry.message && /tool|command|function|session/.test(type) && !telemetry.suppressProgress) {
      options.onProgress?.(telemetry.message);
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
      sessionConfirmed: true,
      resumable: true
    };
  }
  return null;
}
