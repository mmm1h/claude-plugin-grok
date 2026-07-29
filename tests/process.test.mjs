import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { cancelTrackedJob } from "../plugins/grok/scripts/lib/job-control.mjs";
import { terminateProcessTree } from "../plugins/grok/scripts/lib/process.mjs";
import { readJobFile, resolveJobFile, upsertJob, writeJobFile } from "../plugins/grok/scripts/lib/state.mjs";
import { initRepo, tempDir } from "./helpers.mjs";

test("POSIX termination falls back from a missing process group to the process", () => {
  const calls = [];
  const result = terminateProcessTree(1234, {
    platform: "linux",
    killImpl(pid, signal) {
      calls.push([pid, signal]);
      if (pid < 0) {
        const error = new Error("no process group");
        error.code = "ESRCH";
        throw error;
      }
    }
  });
  assert.deepEqual(calls, [[-1234, "SIGTERM"], [1234, "SIGTERM"]]);
  assert.equal(result.delivered, true);
  assert.equal(result.method, "process");
});

test("termination reports an already exited process without throwing", () => {
  const result = terminateProcessTree(1234, {
    platform: "linux",
    killImpl() {
      const error = new Error("gone");
      error.code = "ESRCH";
      throw error;
    }
  });
  assert.equal(result.attempted, true);
  assert.equal(result.delivered, false);
});

test("cancel helper does not report cancelled when termination is not delivered", (t) => {
  const root = tempDir();
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  initRepo(repo);
  const previousHome = process.env.GROK_COMPANION_HOME;
  process.env.GROK_COMPANION_HOME = path.join(root, "state");
  t.after(() => {
    if (previousHome == null) {
      delete process.env.GROK_COMPANION_HOME;
    } else {
      process.env.GROK_COMPANION_HOME = previousHome;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  const job = {
    id: "task-cancel-failed",
    kind: "task",
    title: "Task",
    status: "running",
    phase: "running",
    pid: 1234,
    cwd: repo,
    workspaceRoot: repo,
    summary: "test",
    createdAt: new Date().toISOString()
  };
  writeJobFile(repo, job.id, job);
  upsertJob(repo, job);

  const result = cancelTrackedJob(repo, job, {
    terminateImpl: () => ({ attempted: true, delivered: false, method: "test-signal" }),
    isProcessAliveImpl: () => true
  });
  const stored = readJobFile(resolveJobFile(repo, job.id));
  assert.equal(result.status, "cancel-failed");
  assert.equal(stored.status, "running");
  assert.equal(stored.phase, "cancel-failed");
  assert.equal(stored.terminationDelivered, false);
  assert.equal(stored.terminationMethod, "test-signal");
  assert.ok(stored.cancelRequestedAt);
  assert.match(stored.errorMessage, /still running/);

  const goneJob = { ...job, id: "task-already-exited", pid: 5678 };
  writeJobFile(repo, goneJob.id, goneJob);
  upsertJob(repo, goneJob);
  const gone = cancelTrackedJob(repo, goneJob, {
    terminateImpl: () => ({ attempted: true, delivered: false, method: null }),
    isProcessAliveImpl: () => false
  });
  const goneStored = readJobFile(resolveJobFile(repo, goneJob.id));
  assert.equal(gone.status, "cancelled");
  assert.equal(gone.delivered, false);
  assert.equal(goneStored.terminationMethod, "already-exited");
  assert.ok(goneStored.cancelledAt);
});
