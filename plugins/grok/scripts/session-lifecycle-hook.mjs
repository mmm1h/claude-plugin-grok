#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";

import {
  cancelTrackedJobsParallel,
  DEFAULT_SESSION_END_CANCEL_BUDGET_MS
} from "./lib/job-control.mjs";
import { listJobs } from "./lib/state.mjs";
import { TRANSCRIPT_PATH_ENV } from "./lib/claude-session-transfer.mjs";
import { CLAUDE_SESSION_ID_ENV } from "./lib/tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

function readInput() {
  const raw = fs.readFileSync(0, "utf8").trim();
  return raw ? JSON.parse(raw) : {};
}

function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

function appendEnv(name, value) {
  // CLAUDE_ENV_FILE is sourced by Claude Code's Bash tool as bash (`export ...`).
  // Official hooks docs and Windows Git Bash tooling expect this syntax; do not
  // emit cmd/PowerShell forms here — that would break the documented contract.
  if (process.env.CLAUDE_ENV_FILE && value != null && value !== "") {
    fs.appendFileSync(process.env.CLAUDE_ENV_FILE, `export ${name}=${shellEscape(value)}\n`, "utf8");
  }
}

function handleStart(input) {
  appendEnv(CLAUDE_SESSION_ID_ENV, input.session_id);
  appendEnv(TRANSCRIPT_PATH_ENV, input.transcript_path);
}

async function handleEnd(input) {
  const cwd = input.cwd || process.cwd();
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const sessionId = input.session_id || process.env[CLAUDE_SESSION_ID_ENV];
  if (!sessionId) {
    return;
  }
  const active = listJobs(workspaceRoot).filter(
    (job) => job.claudeSessionId === sessionId && ["queued", "running"].includes(job.status)
  );
  if (active.length === 0) {
    return;
  }
  // Mark + parallel cancel under a budget so the SessionEnd hook (timeout 60s)
  // leaves cancel-requested state if termination cannot finish in time.
  await cancelTrackedJobsParallel(workspaceRoot, active, {
    env: process.env,
    reason: "Claude session ended.",
    cancelledPhase: "session-ended",
    budgetMs: DEFAULT_SESSION_END_CANCEL_BUDGET_MS
  });
}

async function main() {
  const input = readInput();
  const event = process.argv[2] || input.hook_event_name;
  if (event === "SessionStart") {
    handleStart(input);
  } else if (event === "SessionEnd") {
    await handleEnd(input);
  }
}

try {
  await main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
