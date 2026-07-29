#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";

import { cancelTrackedJob } from "./lib/job-control.mjs";
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
  if (process.env.CLAUDE_ENV_FILE && value != null && value !== "") {
    fs.appendFileSync(process.env.CLAUDE_ENV_FILE, `export ${name}=${shellEscape(value)}\n`, "utf8");
  }
}

function handleStart(input) {
  appendEnv(CLAUDE_SESSION_ID_ENV, input.session_id);
  appendEnv(TRANSCRIPT_PATH_ENV, input.transcript_path);
}

function handleEnd(input) {
  const cwd = input.cwd || process.cwd();
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const sessionId = input.session_id || process.env[CLAUDE_SESSION_ID_ENV];
  if (!sessionId) {
    return;
  }
  const active = listJobs(workspaceRoot).filter(
    (job) => job.claudeSessionId === sessionId && ["queued", "running"].includes(job.status)
  );
  for (const job of active) {
    cancelTrackedJob(workspaceRoot, job, {
      env: process.env,
      reason: "Claude session ended.",
      cancelledPhase: "session-ended"
    });
  }
}

function main() {
  const input = readInput();
  const event = process.argv[2] || input.hook_event_name;
  if (event === "SessionStart") {
    handleStart(input);
  } else if (event === "SessionEnd") {
    handleEnd(input);
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
