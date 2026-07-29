import fs from "node:fs";

import { isProcessAlive, terminateProcessTree } from "./process.mjs";
import { getConfig, listJobs, readJobFile, resolveJobFile, upsertJob, writeJobFile } from "./state.mjs";
import {
  appendLogLine,
  CLAUDE_SESSION_ID_ENV,
  indexJobRecord,
  nowIso
} from "./tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./workspace.mjs";

export const DEFAULT_MAX_STATUS_JOBS = 8;

export function sortJobsNewestFirst(jobs) {
  return [...jobs].sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")));
}

function currentClaudeSession(options = {}) {
  return options.env?.[CLAUDE_SESSION_ID_ENV] ?? process.env[CLAUDE_SESSION_ID_ENV] ?? null;
}

function filterCurrentSession(jobs, options = {}) {
  const sessionId = currentClaudeSession(options);
  return sessionId && !options.all ? jobs.filter((job) => job.claudeSessionId === sessionId) : jobs;
}

function duration(startValue, endValue = null) {
  const start = Date.parse(startValue ?? "");
  const end = endValue ? Date.parse(endValue) : Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    return null;
  }
  const seconds = Math.max(0, Math.round((end - start) / 1000));
  if (seconds >= 3600) {
    return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  }
  if (seconds >= 60) {
    return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  }
  return `${seconds}s`;
}

function progressPreview(logPath, maxLines = 4) {
  if (!logPath || !fs.existsSync(logPath)) {
    return [];
  }
  return fs.readFileSync(logPath, "utf8")
    .split(/\r?\n/)
    .filter((line) => /^\[[^\]]+\]/.test(line))
    .map((line) => line.replace(/^\[[^\]]+\]\s*/, "").trim())
    .filter(Boolean)
    .slice(-maxLines);
}

export function enrichJob(job, options = {}) {
  const active = job.status === "queued" || job.status === "running";
  return {
    ...job,
    phase: job.phase ?? job.status ?? "unknown",
    elapsed: duration(job.startedAt ?? job.createdAt, job.completedAt),
    duration: active ? null : duration(job.startedAt ?? job.createdAt, job.completedAt ?? job.updatedAt),
    progressPreview: active || job.status === "failed" ? progressPreview(job.logPath, options.maxProgressLines) : []
  };
}

function persistJob(workspaceRoot, job) {
  writeJobFile(workspaceRoot, job.id, job);
  upsertJob(workspaceRoot, indexJobRecord(job));
  return job;
}

export function reconcileOrphanedJob(workspaceRoot, job, options = {}) {
  if (!["queued", "running"].includes(job.status) || !job.pid) {
    return job;
  }
  const alive = options.isProcessAliveImpl ?? isProcessAlive;
  if (alive(job.pid)) {
    return job;
  }
  const stored = readStoredJob(workspaceRoot, job.id) ?? job;
  if (!["queued", "running"].includes(stored.status) || (stored.pid && alive(stored.pid))) {
    return stored;
  }
  const message = `Tracked Grok process ${job.pid} exited before the job reached a terminal state.`;
  const { request: _request, ...base } = stored;
  const failed = persistJob(workspaceRoot, {
    ...base,
    status: "failed",
    phase: "process-exited",
    pid: null,
    completedAt: nowIso(),
    resumable: stored.kind === "task" && Boolean(stored.sessionConfirmed),
    errorMessage: message
  });
  appendLogLine(failed.logPath, `Failed: ${message}`);
  return failed;
}

function reconciledJobs(workspaceRoot, options = {}) {
  return listJobs(workspaceRoot).map((job) => reconcileOrphanedJob(workspaceRoot, job, options));
}

export function cancelTrackedJob(workspaceRoot, job, options = {}) {
  const stored = readStoredJob(workspaceRoot, job.id) ?? job;
  const cancelRequestedAt = nowIso();
  const requested = persistJob(workspaceRoot, {
    ...stored,
    phase: "cancel-requested",
    cancelRequestedAt,
    terminationDelivered: null,
    terminationMethod: null,
    errorMessage: null
  });
  appendLogLine(requested.logPath, `Cancellation requested${options.reason ? `: ${options.reason}` : "."}`);

  let termination = { attempted: false, delivered: false, method: null };
  let terminationError = null;
  try {
    termination = (options.terminateImpl ?? terminateProcessTree)(requested.pid, {
      cwd: requested.cwd,
      env: options.env
    });
  } catch (error) {
    terminationError = error instanceof Error ? error.message : String(error);
  }
  const alive = options.isProcessAliveImpl ?? isProcessAlive;
  const exited = !alive(requested.pid);
  const cancelled = Boolean(termination.delivered || exited);
  const method = termination.method ?? (exited ? "already-exited" : null);

  if (cancelled) {
    const cancelledAt = nowIso();
    const { request: _request, ...base } = requested;
    const final = persistJob(workspaceRoot, {
      ...base,
      status: "cancelled",
      phase: options.cancelledPhase ?? "cancelled",
      pid: null,
      completedAt: cancelledAt,
      cancelledAt,
      terminationMethod: method,
      terminationDelivered: Boolean(termination.delivered),
      resumable: requested.kind === "task" && Boolean(requested.sessionConfirmed),
      errorMessage: null
    });
    appendLogLine(final.logPath, `Cancelled via ${method ?? "confirmed process exit"}; signal delivered: ${Boolean(termination.delivered)}.`);
    return { job: final, previousStatus: stored.status, status: "cancelled", delivered: Boolean(termination.delivered), method, errorMessage: null };
  }

  const errorMessage = terminationError || `Could not terminate process ${requested.pid}; it is still running.`;
  const failed = persistJob(workspaceRoot, {
    ...requested,
    phase: "cancel-failed",
    terminationMethod: termination.method ?? null,
    terminationDelivered: false,
    errorMessage
  });
  appendLogLine(failed.logPath, `Cancellation failed: ${errorMessage}`);
  return { job: failed, previousStatus: stored.status, status: "cancel-failed", delivered: false, method: termination.method ?? null, errorMessage };
}

function matchReference(jobs, reference, predicate = () => true) {
  const candidates = jobs.filter(predicate);
  if (!reference) {
    return candidates[0] ?? null;
  }
  const exact = candidates.find((job) => job.id === reference);
  if (exact) {
    return exact;
  }
  const prefix = candidates.filter((job) => job.id.startsWith(reference));
  if (prefix.length === 1) {
    return prefix[0];
  }
  if (prefix.length > 1) {
    throw new Error(`Job reference "${reference}" is ambiguous. Use a longer job id.`);
  }
  return null;
}

export function readStoredJob(workspaceRoot, jobId) {
  const file = resolveJobFile(workspaceRoot, jobId);
  return fs.existsSync(file) ? readJobFile(file) : null;
}

export function buildStatusSnapshot(cwd, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const jobs = sortJobsNewestFirst(filterCurrentSession(reconciledJobs(workspaceRoot, options), options));
  return {
    workspaceRoot,
    reviewGateEnabled: Boolean(getConfig(workspaceRoot).stopReviewGate),
    jobs: (options.all ? jobs : jobs.slice(0, options.maxJobs ?? DEFAULT_MAX_STATUS_JOBS)).map(enrichJob)
  };
}

export function buildSingleJobSnapshot(cwd, reference) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const selected = matchReference(sortJobsNewestFirst(reconciledJobs(workspaceRoot)), reference);
  if (!selected) {
    throw new Error(`No job found for "${reference}". Run /grok:status to list known jobs.`);
  }
  return { workspaceRoot, job: enrichJob(selected) };
}

export function resolveResultJob(cwd, reference, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const jobs = sortJobsNewestFirst(filterCurrentSession(reconciledJobs(workspaceRoot), reference ? { all: true } : options));
  const finished = matchReference(jobs, reference, (job) => ["completed", "failed", "cancelled"].includes(job.status));
  if (finished) {
    return { workspaceRoot, job: finished };
  }
  const active = matchReference(jobs, reference, (job) => ["queued", "running"].includes(job.status));
  if (active) {
    throw new Error(`Job ${active.id} is still ${active.status}. Check /grok:status ${active.id}.`);
  }
  throw new Error(reference
    ? `No finished job found for "${reference}".`
    : "No finished Grok jobs found for this repository yet.");
}

export function resolveCancelableJob(cwd, reference, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const active = sortJobsNewestFirst(listJobs(workspaceRoot))
    .filter((job) => ["queued", "running"].includes(job.status));
  if (reference) {
    const selected = matchReference(active, reference);
    if (!selected) {
      throw new Error(`No active job found for "${reference}".`);
    }
    return { workspaceRoot, job: selected };
  }
  const scoped = filterCurrentSession(active, options);
  if (scoped.length === 1) {
    return { workspaceRoot, job: scoped[0] };
  }
  if (scoped.length > 1) {
    throw new Error("Multiple Grok jobs are active. Pass a job id to /grok:cancel.");
  }
  throw new Error("No active Grok jobs to cancel.");
}
