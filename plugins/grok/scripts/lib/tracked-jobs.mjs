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

export function indexJobRecord(record) {
  return {
    id: record.id,
    kind: record.kind,
    title: record.title,
    status: record.status,
    phase: record.phase,
    pid: record.pid ?? null,
    cwd: record.cwd,
    workspaceRoot: record.workspaceRoot,
    summary: record.summary,
    promptSummary: record.promptSummary ?? record.summary,
    sessionId: record.sessionId ?? null,
    sessionConfirmed: Boolean(record.sessionConfirmed),
    resumable: Boolean(record.resumable),
    claudeSessionId: record.claudeSessionId ?? null,
    resultPath: record.resultPath ?? null,
    logPath: record.logPath ?? null,
    createdAt: record.createdAt,
    startedAt: record.startedAt ?? null,
    completedAt: record.completedAt ?? null,
    lastProgressAt: record.lastProgressAt ?? null,
    progress: record.progress ?? null,
    cancelRequestedAt: record.cancelRequestedAt ?? null,
    cancelledAt: record.cancelledAt ?? null,
    terminationMethod: record.terminationMethod ?? null,
    terminationDelivered: record.terminationDelivered ?? null,
    errorMessage: record.errorMessage ?? null
  };
}

function writeIndex(workspaceRoot, record) {
  upsertJob(workspaceRoot, indexJobRecord(record));
}

export function createJobProgressUpdater({ workspaceRoot, jobId, logPath = null } = {}) {
  return (telemetry) => {
    if (!telemetry || typeof telemetry !== "object") {
      return;
    }
    const latest = storedJob(workspaceRoot, jobId);
    if (!latest || !["queued", "running"].includes(latest.status)) {
      return;
    }
    const confirmedSessionId = telemetry.sessionId ?? null;
    const progress = {
      message: telemetry.message || telemetry.eventType || "Grok progress",
      eventType: telemetry.eventType ?? "unknown",
      at: telemetry.at ?? nowIso()
    };
    const patched = {
      ...latest,
      phase: telemetry.phase ?? latest.phase ?? "running",
      sessionId: confirmedSessionId ?? latest.sessionId ?? null,
      sessionConfirmed: confirmedSessionId ? true : Boolean(latest.sessionConfirmed),
      resumable: false,
      lastProgressAt: progress.at,
      progress
    };
    writeJobFile(workspaceRoot, jobId, patched);
    writeIndex(workspaceRoot, patched);
    if (progress.message) {
      appendLogLine(logPath ?? patched.logPath, progress.message);
    }
  };
}

export async function runTrackedJob(job, runner, options = {}) {
  const running = {
    ...job,
    status: "running",
    phase: "starting",
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
    const { request: _request, ...completedBase } = latest ?? running;
    const sessionConfirmed = Boolean(execution.sessionConfirmed || completedBase.sessionConfirmed);
    const final = {
      ...completedBase,
      status,
      phase: status,
      pid: null,
      completedAt: nowIso(),
      sessionId: execution.sessionId ?? completedBase.sessionId ?? null,
      sessionConfirmed,
      resumable: completedBase.kind === "task" && sessionConfirmed,
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
    const { request: _request, ...failedBase } = latest ?? running;
    const final = {
      ...failedBase,
      status: "failed",
      phase: "failed",
      pid: null,
      completedAt: nowIso(),
      resumable: failedBase.kind === "task" && Boolean(failedBase.sessionConfirmed),
      errorMessage: message
    };
    writeJobFile(job.workspaceRoot, job.id, final);
    writeIndex(job.workspaceRoot, final);
    appendLogLine(final.logPath, `Failed: ${message}`);
    throw error;
  }
}
