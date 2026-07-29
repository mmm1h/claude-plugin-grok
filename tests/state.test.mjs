import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { writeJsonFileAtomic } from "../plugins/grok/scripts/lib/fs.mjs";
import {
  getConfig,
  listJobs,
  loadState,
  resolveJobFile,
  resolveStateDir,
  saveState,
  setConfig,
  upsertJob
} from "../plugins/grok/scripts/lib/state.mjs";
import {
  createJobLogFile,
  createJobRecord,
  runTrackedJob
} from "../plugins/grok/scripts/lib/tracked-jobs.mjs";
import {
  buildSingleJobSnapshot,
  buildStatusSnapshot
} from "../plugins/grok/scripts/lib/job-control.mjs";
import { tempDir } from "./helpers.mjs";

test("atomic JSON writes retry transient Windows rename locks", (t) => {
  const root = tempDir();
  const target = path.join(root, "state.json");
  const delays = [];
  let attempts = 0;
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  writeJsonFileAtomic(target, { ready: true }, {
    renameSync(tempFile, filePath) {
      attempts += 1;
      if (attempts < 3) {
        const error = new Error("target is temporarily locked");
        error.code = attempts === 1 ? "EPERM" : "EBUSY";
        throw error;
      }
      fs.renameSync(tempFile, filePath);
    },
    sleepSync(milliseconds) {
      delays.push(milliseconds);
    }
  });

  assert.equal(attempts, 3);
  assert.deepEqual(delays, [10, 20]);
  assert.deepEqual(JSON.parse(fs.readFileSync(target, "utf8")), { ready: true });
  assert.deepEqual(fs.readdirSync(root).filter((name) => name.endsWith(".tmp")), []);
});

test("atomic JSON writes rethrow after bounded retries and remove the temp file", (t) => {
  const root = tempDir();
  const target = path.join(root, "state.json");
  let attempts = 0;
  let lastError = null;
  let thrown = null;
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  try {
    writeJsonFileAtomic(target, { ready: false }, {
      renameSync() {
        attempts += 1;
        lastError = new Error(`locked ${attempts}`);
        lastError.code = "EACCES";
        throw lastError;
      },
      sleepSync() {}
    });
  } catch (error) {
    thrown = error;
  }

  assert.equal(attempts, 6);
  assert.equal(thrown, lastError);
  assert.equal(fs.existsSync(target), false);
  assert.deepEqual(fs.readdirSync(root), []);
});

test("state uses a user-level override and hashes workspace paths", (t) => {
  const root = tempDir();
  const workspace = path.join(root, "workspace");
  const stateHome = path.join(root, "state");
  fs.mkdirSync(workspace);
  const previous = process.env.GROK_COMPANION_HOME;
  process.env.GROK_COMPANION_HOME = stateHome;
  t.after(() => {
    if (previous === undefined) {
      delete process.env.GROK_COMPANION_HOME;
    } else {
      process.env.GROK_COMPANION_HOME = previous;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  const dir = resolveStateDir(workspace);
  assert.ok(dir.startsWith(stateHome));
  assert.match(path.basename(dir), /^workspace-[0-9a-f]{16}$/);
  assert.deepEqual(loadState(workspace).jobs, []);
  setConfig(workspace, "stopReviewGate", true);
  assert.equal(getConfig(workspace).stopReviewGate, true);
});

test("upsertJob creates and updates an indexed record", (t) => {
  const root = tempDir();
  const stateHome = path.join(root, "state");
  const previous = process.env.GROK_COMPANION_HOME;
  process.env.GROK_COMPANION_HOME = stateHome;
  t.after(() => {
    previous === undefined ? delete process.env.GROK_COMPANION_HOME : process.env.GROK_COMPANION_HOME = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  upsertJob(root, { id: "task-one", status: "queued" });
  upsertJob(root, { id: "task-one", status: "running", pid: 123 });
  assert.equal(listJobs(root).length, 1);
  assert.equal(listJobs(root)[0].status, "running");
  assert.equal(listJobs(root)[0].pid, 123);
});

test("runTrackedJob stores a completed result and index metadata", async (t) => {
  const root = tempDir();
  const stateHome = path.join(root, "state");
  const previous = process.env.GROK_COMPANION_HOME;
  process.env.GROK_COMPANION_HOME = stateHome;
  t.after(() => {
    previous === undefined ? delete process.env.GROK_COMPANION_HOME : process.env.GROK_COMPANION_HOME = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const job = createJobRecord({
    id: "task-complete",
    kind: "task",
    title: "Task",
    cwd: root,
    workspaceRoot: root,
    summary: "test"
  }, { env: {} });
  const logPath = createJobLogFile(root, job.id, job.title);
  const execution = await runTrackedJob(job, async () => ({
    exitCode: 0,
    durationMs: 1234,
    sessionId: "33333333-3333-4333-8333-333333333333",
    payload: { rawOutput: "done" },
    rendered: "done\n"
  }), { logPath });
  assert.equal(execution.exitCode, 0);
  const stored = JSON.parse(fs.readFileSync(resolveJobFile(root, job.id), "utf8"));
  assert.equal(stored.status, "completed");
  assert.equal(stored.result.rawOutput, "done");
  assert.equal(stored.exitCode, 0);
  assert.equal(stored.durationMs, 1234);
  assert.equal(stored.request, undefined);
  const indexed = listJobs(root)[0];
  assert.equal(indexed.sessionId, "33333333-3333-4333-8333-333333333333");
  assert.equal(indexed.exitCode, 0);
  assert.equal(indexed.durationMs, 1234);
});

test("state pruning keeps the newest 50 jobs", (t) => {
  const root = tempDir();
  const stateHome = path.join(root, "state");
  const previous = process.env.GROK_COMPANION_HOME;
  process.env.GROK_COMPANION_HOME = stateHome;
  t.after(() => {
    previous === undefined ? delete process.env.GROK_COMPANION_HOME : process.env.GROK_COMPANION_HOME = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  saveState(root, {
    config: {},
    jobs: Array.from({ length: 55 }, (_value, index) => ({
      id: `task-${String(index).padStart(2, "0")}`,
      status: "completed",
      updatedAt: new Date(2026, 0, 1, 0, 0, index).toISOString()
    }))
  });
  const jobs = listJobs(root);
  assert.equal(jobs.length, 50);
  assert.equal(jobs.some((job) => job.id === "task-00"), false);
  assert.equal(jobs.some((job) => job.id === "task-54"), true);
});

test("status snapshot exposes partitions and job references accept unique prefixes", (t) => {
  const root = tempDir();
  const stateHome = path.join(root, "state");
  const previous = process.env.GROK_COMPANION_HOME;
  process.env.GROK_COMPANION_HOME = stateHome;
  t.after(() => {
    previous === undefined ? delete process.env.GROK_COMPANION_HOME : process.env.GROK_COMPANION_HOME = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  saveState(root, {
    config: { stopReviewGate: true },
    jobs: [
      { id: "task-alpha-one", kind: "task", status: "running", phase: "tool", updatedAt: "2026-07-29T08:03:00.000Z" },
      { id: "task-alpha-two", kind: "task", status: "completed", phase: "completed", updatedAt: "2026-07-29T08:02:00.000Z" },
      { id: "review-beta-one", kind: "review", status: "failed", phase: "failed", updatedAt: "2026-07-29T08:01:00.000Z" }
    ]
  });

  const snapshot = buildStatusSnapshot(root, { all: true });
  assert.equal(snapshot.reviewGateEnabled, true);
  assert.deepEqual(snapshot.running.map((job) => job.id), ["task-alpha-one"]);
  assert.equal(snapshot.latestFinished.id, "task-alpha-two");
  assert.deepEqual(snapshot.recent.map((job) => job.id), ["review-beta-one"]);
  assert.equal(snapshot.jobs.length, 3);

  assert.equal(buildSingleJobSnapshot(root, "review-b").job.id, "review-beta-one");
  assert.throws(() => buildSingleJobSnapshot(root, "task-alpha"), /ambiguous/);
});

test("concurrent state writers retain every job", async (t) => {
  const root = tempDir();
  const stateHome = path.join(root, "state");
  const previous = process.env.GROK_COMPANION_HOME;
  process.env.GROK_COMPANION_HOME = stateHome;
  t.after(() => {
    previous === undefined ? delete process.env.GROK_COMPANION_HOME : process.env.GROK_COMPANION_HOME = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const fixture = fileURLToPath(new URL("./state-writer-fixture.mjs", import.meta.url));
  await Promise.all(
    Array.from({ length: 8 }, (_value, index) => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [fixture, root, `parallel-${index}`], {
        env: { ...process.env, GROK_COMPANION_HOME: stateHome },
        windowsHide: true,
        stdio: "ignore"
      });
      child.once("error", reject);
      child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`state writer exited ${code}`)));
    }))
  );
  const ids = new Set(listJobs(root).map((job) => job.id));
  assert.equal(ids.size, 8);
  for (let index = 0; index < 8; index += 1) {
    assert.ok(ids.has(`parallel-${index}`));
  }
});
