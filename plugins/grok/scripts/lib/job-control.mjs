import { spawn } from "node:child_process";
import fs from "node:fs";
import process from "node:process";

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
/** Leave headroom under the SessionEnd hook timeout (60s). */
export const DEFAULT_SESSION_END_CANCEL_BUDGET_MS = 55_000;

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

function formatDuration(milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) {
    return null;
  }
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  if (seconds >= 3600) {
    return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  }
  if (seconds >= 60) {
    return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  }
  return `${seconds}s`;
}

function duration(startValue, endValue = null) {
  const start = Date.parse(startValue ?? "");
  const end = endValue ? Date.parse(endValue) : Date.now();
  return Number.isFinite(start) && Number.isFinite(end) && end >= start
    ? formatDuration(end - start)
    : null;
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
    elapsed: active ? duration(job.startedAt ?? job.createdAt) : null,
    duration: active
      ? null
      : (formatDuration(job.durationMs) ?? duration(job.startedAt ?? job.createdAt, job.completedAt ?? job.updatedAt)),
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

/**
 * Reconcile every indexed job (orphan PID → failed). Used by status/result paths.
 */
export function reconcileJobs(workspaceRoot, options = {}) {
  return listJobs(workspaceRoot).map((job) => reconcileOrphanedJob(workspaceRoot, job, options));
}

/**
 * Reconcile jobs for the current Claude session (or all when options.all / no session).
 *
 * Wire this at companion entry points that must not see stale "running" orphans:
 * - task (before findLatestTaskSession / enqueue)
 * - task-resume-candidate
 * - any other path that calls findLatestTaskSession
 *
 * status/result already reconcile via buildStatusSnapshot / resolveResultJob.
 */
export function reconcileSessionJobs(workspaceRoot, options = {}) {
  const sessionId = currentClaudeSession(options);
  const jobs = listJobs(workspaceRoot);
  const scoped = sessionId && !options.all
    ? jobs.filter((job) => job.claudeSessionId === sessionId)
    : jobs;
  return scoped.map((job) => reconcileOrphanedJob(workspaceRoot, job, options));
}

function reconciledJobs(workspaceRoot, options = {}) {
  return reconcileJobs(workspaceRoot, options);
}

/**
 * Persist cancel-requested without waiting for process termination.
 * Used when SessionEnd is about to time out so later status can reclaim the job.
 */
export function markJobCancelRequested(workspaceRoot, job, options = {}) {
  const stored = readStoredJob(workspaceRoot, job.id) ?? job;
  if (!["queued", "running"].includes(stored.status) && stored.phase !== "cancel-requested") {
    return stored;
  }
  if (stored.phase === "cancel-requested" && stored.cancelRequestedAt) {
    return stored;
  }
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
  return requested;
}

export function cancelTrackedJob(workspaceRoot, job, options = {}) {
  const stored = readStoredJob(workspaceRoot, job.id) ?? job;
  const requested = options.alreadyMarked
    ? (readStoredJob(workspaceRoot, job.id) ?? stored)
    : markJobCancelRequested(workspaceRoot, job, options);
  if (!["queued", "running"].includes(requested.status) && requested.phase !== "cancel-requested" && requested.phase !== "cancel-failed") {
    return {
      job: requested,
      previousStatus: stored.status,
      status: requested.status,
      delivered: false,
      method: null,
      errorMessage: null
    };
  }

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

function budgetExhaustedResult(workspaceRoot, job, message) {
  return {
    job: readStoredJob(workspaceRoot, job.id) ?? job,
    previousStatus: job.status,
    status: "cancel-requested",
    delivered: false,
    method: null,
    errorMessage: message
  };
}

/**
 * Cancel many jobs: mark cancel-requested immediately, then terminate in parallel child processes.
 * Jobs still unfinished when the budget elapses remain cancel-requested for later status/result reclaim.
 */
export async function cancelTrackedJobsParallel(workspaceRoot, jobs, options = {}) {
  const list = Array.isArray(jobs) ? jobs : [];
  if (list.length === 0) {
    return [];
  }
  const budgetMs = options.budgetMs ?? DEFAULT_SESSION_END_CANCEL_BUDGET_MS;
  const deadline = Date.now() + Math.max(0, budgetMs);
  const marked = list.map((job) => markJobCancelRequested(workspaceRoot, job, options));

  if (typeof options.cancelImpl === "function") {
    return Promise.all(marked.map(async (job) => {
      if (Date.now() >= deadline) {
        return budgetExhaustedResult(workspaceRoot, job, "SessionEnd cancel budget exhausted; left cancel-requested.");
      }
      return options.cancelImpl(job);
    }));
  }

  // Child processes so Windows taskkill work does not serialize on one event loop.
  return Promise.all(marked.map((job) => cancelJobInSubprocess(workspaceRoot, job, {
    ...options,
    timeoutMs: Math.max(1_000, deadline - Date.now())
  })));
}

function cancelJobInSubprocess(workspaceRoot, job, options = {}) {
  return new Promise((resolve) => {
    const moduleUrl = new URL("./job-control.mjs", import.meta.url).href;
    const inline = `
import { cancelTrackedJob } from ${JSON.stringify(moduleUrl)};
const input = JSON.parse(process.argv[1]);
const result = cancelTrackedJob(input.workspaceRoot, input.job, {
  reason: input.reason,
  cancelledPhase: input.cancelledPhase,
  alreadyMarked: true,
  env: process.env
});
process.stdout.write(JSON.stringify(result));
`;
    const payload = JSON.stringify({
      workspaceRoot,
      job,
      reason: options.reason ?? null,
      cancelledPhase: options.cancelledPhase ?? "cancelled"
    });
    const child = spawn(process.execPath, ["--input-type=module", "-e", inline, payload], {
      env: options.env ?? process.env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeoutMs = options.timeoutMs ?? DEFAULT_SESSION_END_CANCEL_BUDGET_MS;
    const finish = (value) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // ignore
      }
      finish(budgetExhaustedResult(workspaceRoot, job, "Cancel subprocess timed out; left cancel-requested."));
    }, Math.max(500, timeoutMs));

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      finish(budgetExhaustedResult(workspaceRoot, job, error.message));
    });
    child.on("close", (code) => {
      try {
        if (code === 0 && stdout.trim()) {
          finish(JSON.parse(stdout));
          return;
        }
      } catch {
        // fall through
      }
      finish(budgetExhaustedResult(
        workspaceRoot,
        job,
        stderr.trim() || `Cancel subprocess exited ${code}`
      ));
    });
  });
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
  const selected = options.all ? jobs : jobs.slice(0, options.maxJobs ?? DEFAULT_MAX_STATUS_JOBS);
  const running = jobs
    .filter((job) => ["queued", "running"].includes(job.status))
    .map(enrichJob);
  const latestFinishedRaw = jobs.find((job) => !["queued", "running"].includes(job.status)) ?? null;
  const latestFinished = latestFinishedRaw ? enrichJob(latestFinishedRaw) : null;
  const recent = selected
    .filter((job) => !["queued", "running"].includes(job.status) && job.id !== latestFinished?.id)
    .map(enrichJob);
  return {
    workspaceRoot,
    reviewGateEnabled: Boolean(getConfig(workspaceRoot).stopReviewGate),
    jobs: selected.map(enrichJob),
    running,
    latestFinished,
    recent
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
