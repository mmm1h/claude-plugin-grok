#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";

import { terminateProcessTree } from "./lib/process.mjs";
import { listJobs, upsertJob, writeJobFile } from "./lib/state.mjs";
import { readStoredJob } from "./lib/job-control.mjs";
import { TRANSCRIPT_PATH_ENV } from "./lib/claude-session-transfer.mjs";
import { CLAUDE_SESSION_ID_ENV, nowIso } from "./lib/tracked-jobs.mjs";
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
    try {
      terminateProcessTree(job.pid, { cwd });
    } catch {
      // Session teardown should continue even if a process has already exited.
    }
    const stored = readStoredJob(workspaceRoot, job.id) ?? job;
    const { request: _request, ...cancelledBase } = stored;
    const cancelled = {
      ...cancelledBase,
      status: "cancelled",
      phase: "session-ended",
      pid: null,
      completedAt: nowIso()
    };
    writeJobFile(workspaceRoot, job.id, cancelled);
    upsertJob(workspaceRoot, {
      id: cancelled.id,
      kind: cancelled.kind,
      title: cancelled.title,
      status: cancelled.status,
      phase: cancelled.phase,
      pid: null,
      cwd: cancelled.cwd,
      workspaceRoot,
      summary: cancelled.summary,
      promptSummary: cancelled.promptSummary,
      write: Boolean(cancelled.write),
      sessionId: cancelled.sessionId ?? null,
      claudeSessionId: cancelled.claudeSessionId ?? null,
      resultPath: cancelled.resultPath ?? null,
      logPath: cancelled.logPath ?? null,
      createdAt: cancelled.createdAt,
      startedAt: cancelled.startedAt ?? null,
      completedAt: cancelled.completedAt
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
