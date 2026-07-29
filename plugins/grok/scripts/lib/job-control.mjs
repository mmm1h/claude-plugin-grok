import fs from "node:fs";

import { isProcessAlive } from "./process.mjs";
import { getConfig, listJobs, readJobFile, resolveJobFile } from "./state.mjs";
import { CLAUDE_SESSION_ID_ENV } from "./tracked-jobs.mjs";
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
  const orphaned = active && job.pid && !isProcessAlive(job.pid);
  return {
    ...job,
    phase: orphaned ? "process-exited" : (job.phase ?? job.status ?? "unknown"),
    elapsed: duration(job.startedAt ?? job.createdAt, job.completedAt),
    duration: active ? null : duration(job.startedAt ?? job.createdAt, job.completedAt ?? job.updatedAt),
    progressPreview: active || job.status === "failed" ? progressPreview(job.logPath, options.maxProgressLines) : []
  };
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
  const jobs = sortJobsNewestFirst(filterCurrentSession(listJobs(workspaceRoot), options));
  return {
    workspaceRoot,
    reviewGateEnabled: Boolean(getConfig(workspaceRoot).stopReviewGate),
    jobs: (options.all ? jobs : jobs.slice(0, options.maxJobs ?? DEFAULT_MAX_STATUS_JOBS)).map(enrichJob)
  };
}

export function buildSingleJobSnapshot(cwd, reference) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const selected = matchReference(sortJobsNewestFirst(listJobs(workspaceRoot)), reference);
  if (!selected) {
    throw new Error(`No job found for "${reference}". Run /grok:status to list known jobs.`);
  }
  return { workspaceRoot, job: enrichJob(selected) };
}

export function resolveResultJob(cwd, reference, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const jobs = sortJobsNewestFirst(filterCurrentSession(listJobs(workspaceRoot), reference ? { all: true } : options));
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
