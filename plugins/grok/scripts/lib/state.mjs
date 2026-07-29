import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { writeJsonFileAtomic } from "./fs.mjs";
import { resolveWorkspaceRoot } from "./workspace.mjs";

const STATE_VERSION = 1;
const MAX_JOBS = 50;
const STATE_FILE_NAME = "state.json";
const JOBS_DIR_NAME = "jobs";
const STATE_LOCK_NAME = ".state.lock";
const LOCK_TIMEOUT_MS = 5_000;
const STALE_LOCK_MS = 30_000;
const lockWaiter = new Int32Array(new SharedArrayBuffer(4));

function nowIso() {
  return new Date().toISOString();
}

function defaultState() {
  return {
    version: STATE_VERSION,
    config: {
      stopReviewGate: false
    },
    jobs: []
  };
}

export function resolveStateRoot() {
  return process.env.GROK_COMPANION_HOME || path.join(os.homedir(), ".claude", "grok-companion");
}

export function resolveStateDir(cwd) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  let canonical = workspaceRoot;
  try {
    canonical = fs.realpathSync.native(workspaceRoot);
  } catch {
    // Hash the resolved input when a real path is unavailable.
  }
  const slug = (path.basename(workspaceRoot) || "workspace")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "workspace";
  const normalized = process.platform === "win32" ? canonical.toLowerCase() : canonical;
  const hash = createHash("sha256").update(normalized).digest("hex").slice(0, 16);
  return path.join(resolveStateRoot(), `${slug}-${hash}`);
}

export function resolveStateFile(cwd) {
  return path.join(resolveStateDir(cwd), STATE_FILE_NAME);
}

export function resolveJobsDir(cwd) {
  return path.join(resolveStateDir(cwd), JOBS_DIR_NAME);
}

export function ensureStateDir(cwd) {
  fs.mkdirSync(resolveJobsDir(cwd), { recursive: true });
}

export function loadState(cwd) {
  const file = resolveStateFile(cwd);
  if (!fs.existsSync(file)) {
    return defaultState();
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return {
      ...defaultState(),
      ...parsed,
      config: { ...defaultState().config, ...(parsed.config ?? {}) },
      jobs: Array.isArray(parsed.jobs) ? parsed.jobs : []
    };
  } catch {
    return defaultState();
  }
}

function pruneJobs(jobs) {
  return [...jobs]
    .sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")))
    .slice(0, MAX_JOBS);
}

function sleepSync(milliseconds) {
  Atomics.wait(lockWaiter, 0, 0, milliseconds);
}

function withStateLock(cwd, operation) {
  ensureStateDir(cwd);
  const lockFile = path.join(resolveStateDir(cwd), STATE_LOCK_NAME);
  const lockToken = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const started = Date.now();
  let descriptor = null;
  while (descriptor === null) {
    try {
      descriptor = fs.openSync(lockFile, "wx");
      fs.writeFileSync(descriptor, `${lockToken}\n`, "utf8");
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
      try {
        if (Date.now() - fs.statSync(lockFile).mtimeMs > STALE_LOCK_MS) {
          fs.unlinkSync(lockFile);
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() - started >= LOCK_TIMEOUT_MS) {
        throw new Error(`Timed out waiting for Grok companion state lock: ${lockFile}`);
      }
      sleepSync(20);
    }
  }

  try {
    return operation();
  } finally {
    fs.closeSync(descriptor);
    try {
      if (fs.readFileSync(lockFile, "utf8").trim() === lockToken) {
        fs.unlinkSync(lockFile);
      }
    } catch {
      // Another process can recover a stale lock if cleanup is interrupted.
    }
  }
}

function saveStateUnlocked(cwd, state) {
  const previousJobs = loadState(cwd).jobs;
  ensureStateDir(cwd);
  const value = {
    version: STATE_VERSION,
    config: { ...defaultState().config, ...(state.config ?? {}) },
    jobs: pruneJobs(state.jobs ?? [])
  };
  writeJsonFileAtomic(resolveStateFile(cwd), value);
  const retained = new Set(value.jobs.map((job) => job.id));
  for (const job of previousJobs) {
    if (retained.has(job.id)) {
      continue;
    }
    for (const file of [
      path.join(resolveJobsDir(cwd), `${job.id}.json`),
      job.logPath || path.join(resolveJobsDir(cwd), `${job.id}.log`)
    ]) {
      try {
        if (fs.existsSync(file)) {
          fs.unlinkSync(file);
        }
      } catch {
        // Pruning the index must not make an otherwise valid state update fail.
      }
    }
  }
  return value;
}

export function saveState(cwd, state) {
  return withStateLock(cwd, () => saveStateUnlocked(cwd, state));
}

export function updateState(cwd, mutator) {
  return withStateLock(cwd, () => {
    const state = loadState(cwd);
    mutator(state);
    return saveStateUnlocked(cwd, state);
  });
}

export function generateJobId(prefix = "job") {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function upsertJob(cwd, patch) {
  return updateState(cwd, (state) => {
    const timestamp = nowIso();
    const index = state.jobs.findIndex((job) => job.id === patch.id);
    if (index === -1) {
      state.jobs.unshift({ createdAt: timestamp, updatedAt: timestamp, ...patch });
    } else {
      state.jobs[index] = { ...state.jobs[index], ...patch, updatedAt: timestamp };
    }
  });
}

export function listJobs(cwd) {
  return loadState(cwd).jobs;
}

export function setConfig(cwd, key, value) {
  return updateState(cwd, (state) => {
    state.config = { ...state.config, [key]: value };
  });
}

export function getConfig(cwd) {
  return loadState(cwd).config;
}

export function resolveJobFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.json`);
}

export function resolveJobLogFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.log`);
}

export function writeJobFile(cwd, jobId, payload) {
  const file = resolveJobFile(cwd, jobId);
  writeJsonFileAtomic(file, payload);
  return file;
}

export function readJobFile(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}
