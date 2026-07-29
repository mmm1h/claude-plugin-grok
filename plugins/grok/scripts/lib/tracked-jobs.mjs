import fs from "node:fs";
import process from "node:process";

import {
  readJobFile,
  resolveJobFile,
  resolveJobLogFile,
  upsertJob,
  writeJobFile
} from "./state.mjs";

export const CLAUDE_SESSION_ID_ENV = "GROK_COMPANION_CLAUDE_SESSION_ID";

export function nowIso() {
  return new Date().toISOString();
}

export function appendLogLine(logPath, message) {
  const value = String(message ?? "").trim();
  if (logPath && value) {
    fs.appendFileSync(logPath, `[${nowIso()}] ${value}\n`, "utf8");
  }
}

export function appendLogBlock(logPath, title, body) {
  const value = String(body ?? "").trimEnd();
  if (logPath && value) {
    fs.appendFileSync(logPath, `\n[${nowIso()}] ${title}\n${value}\n`, "utf8");
  }
}

export function createJobLogFile(workspaceRoot, jobId, title) {
  const logPath = resolveJobLogFile(workspaceRoot, jobId);
  fs.writeFileSync(logPath, "", "utf8");
  appendLogLine(logPath, `Starting ${title}.`);
  return logPath;
}

export function createJobRecord(base, options = {}) {
  const env = options.env ?? process.env;
  const claudeSessionId = env[CLAUDE_SESSION_ID_ENV];
  return {
    ...base,
    createdAt: nowIso(),
    ...(claudeSessionId ? { claudeSessionId } : {})
  };
}

export function createProgressReporter({ stderr = false, logPath = null } = {}) {
  if (!stderr && !logPath) {
    return null;
  }
  return (message) => {
    const value = String(message ?? "").trim();
    if (!value) {
      return;
    }
    if (stderr) {
      process.stderr.write(`[grok] ${value}\n`);
    }
    appendLogLine(logPath, value);
  };
}

function storedJob(workspaceRoot, jobId) {
  const file = resolveJobFile(workspaceRoot, jobId);
  return fs.existsSync(file) ? readJobFile(file) : null;
}

function writeIndex(workspaceRoot, record) {
  upsertJob(workspaceRoot, {
    id: record.id,
    kind: record.kind,
    title: record.title,
    status: record.status,
    phase: record.phase,
    pid: record.pid ?? null,
    cwd: record.cwd,
    workspaceRoot,
    summary: record.summary,
    promptSummary: record.promptSummary ?? record.summary,
    sessionId: record.sessionId ?? null,
    claudeSessionId: record.claudeSessionId ?? null,
    resultPath: record.resultPath ?? null,
    logPath: record.logPath ?? null,
    createdAt: record.createdAt,
    startedAt: record.startedAt ?? null,
    completedAt: record.completedAt ?? null,
    errorMessage: record.errorMessage ?? null
  });
}

export async function runTrackedJob(job, runner, options = {}) {
  const running = {
    ...job,
    status: "running",
    phase: "running",
    startedAt: job.startedAt ?? nowIso(),
    pid: process.pid,
    logPath: options.logPath ?? job.logPath ?? null,
    resultPath: resolveJobFile(job.workspaceRoot, job.id)
  };
  writeJobFile(job.workspaceRoot, job.id, running);
  writeIndex(job.workspaceRoot, running);

  try {
    const execution = await runner();
    const latest = storedJob(job.workspaceRoot, job.id);
    if (latest?.status === "cancelled") {
      return { ...execution, exitCode: 130, cancelled: true };
    }
    const status = execution.exitCode === 0 ? "completed" : "failed";
    const { request: _request, ...completedBase } = running;
    const final = {
      ...completedBase,
      status,
      phase: status === "completed" ? "done" : "failed",
      pid: null,
      completedAt: nowIso(),
      sessionId: execution.sessionId ?? null,
      result: execution.payload,
      rendered: execution.rendered,
      errorMessage: execution.errorMessage ?? null
    };
    writeJobFile(job.workspaceRoot, job.id, final);
    writeIndex(job.workspaceRoot, final);
    appendLogBlock(final.logPath, "Final output", execution.rendered || execution.payload?.rawOutput);
    return execution;
  } catch (error) {
    const latest = storedJob(job.workspaceRoot, job.id);
    if (latest?.status === "cancelled") {
      return { exitCode: 130, cancelled: true, payload: null, rendered: "" };
    }
    const message = error instanceof Error ? error.message : String(error);
    const { request: _request, ...failedBase } = running;
    const final = {
      ...failedBase,
      status: "failed",
      phase: "failed",
      pid: null,
      completedAt: nowIso(),
      errorMessage: message
    };
    writeJobFile(job.workspaceRoot, job.id, final);
    writeIndex(job.workspaceRoot, final);
    appendLogLine(final.logPath, `Failed: ${message}`);
    throw error;
  }
}
