import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { resolveUserPath } from "./fs.mjs";

export const TRANSCRIPT_PATH_ENV = "GROK_COMPANION_TRANSCRIPT_PATH";
const DEFAULT_MAX_CHARS = 180_000;
const MAX_TURN_CHARS = 24_000;

function textFromContent(content) {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

function transcriptTurn(record) {
  const role = record?.type === "user" || record?.type === "assistant"
    ? record.type
    : record?.message?.role;
  if (role !== "user" && role !== "assistant") {
    return null;
  }
  const text = textFromContent(record?.message?.content ?? record?.content).trim();
  if (!text) {
    return null;
  }
  return {
    role,
    text: text.length > MAX_TURN_CHARS ? `${text.slice(0, MAX_TURN_CHARS)}\n[turn truncated]` : text
  };
}

export function resolveClaudeSessionPath(cwd, options = {}) {
  const requested = options.source || process.env[TRANSCRIPT_PATH_ENV];
  if (!requested) {
    throw new Error("Could not identify the current Claude transcript. Retry with --source <path-to-claude-jsonl>.");
  }
  const file = resolveUserPath(cwd, requested);
  if (path.extname(file).toLowerCase() !== ".jsonl") {
    throw new Error(`Claude session source must be a JSONL file: ${file}`);
  }
  try {
    const real = fs.realpathSync(file);
    if (!fs.statSync(real).isFile()) {
      throw new Error("not a file");
    }
    return real;
  } catch {
    throw new Error(`Claude session file not found: ${file}`);
  }
}

export function readClaudeTranscript(file, options = {}) {
  const turns = [];
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    try {
      const turn = transcriptTurn(JSON.parse(line));
      if (turn) {
        turns.push(turn);
      }
    } catch {
      // Ignore malformed or non-message records and preserve the usable conversation.
    }
  }
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const selected = [];
  let total = 0;
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    const size = turn.text.length + turn.role.length + 12;
    if (selected.length > 0 && total + size > maxChars) {
      break;
    }
    selected.unshift(turn);
    total += size;
  }
  return {
    turns: selected,
    totalTurns: turns.length,
    omittedTurns: Math.max(0, turns.length - selected.length),
    truncated: selected.length < turns.length
  };
}

export function buildHandoffPrompt({ cwd, sourcePath, transcript }) {
  const turns = transcript.turns
    .map((turn) => `## ${turn.role === "user" ? "User" : "Assistant"}\n\n${turn.text}`)
    .join("\n\n");
  const lines = [
    "# Claude Code to Grok handoff",
    "",
    "This is a lossy handoff, not a native session import. Treat the transcript as context, verify repository state directly, and do not make changes in this initial read-only handoff turn.",
    "",
    `Repository: ${cwd}`,
    `Source transcript: ${sourcePath}`,
    `Included turns: ${transcript.turns.length} of ${transcript.totalTurns}`,
    ...(transcript.omittedTurns ? [`Omitted oldest turns: ${transcript.omittedTurns}`] : []),
    "",
    "Acknowledge the handoff briefly, summarize the current objective and unresolved work, and state what you would inspect first after the user resumes this Grok session.",
    "",
    "# Transcript",
    "",
    turns || "(No user or assistant text turns could be extracted.)"
  ];
  return lines.join("\n");
}
