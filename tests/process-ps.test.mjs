import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  buildProcessListSnapshot,
  buildProcessLookupSnapshot,
  PROCESS_DECISION
} from "../plugins/grok/scripts/lib/job-control.mjs";
import {
  listJobsInStateDir,
  listStateBuckets,
  resolveStateDir,
  saveState,
  writeJobFile
} from "../plugins/grok/scripts/lib/state.mjs";
import {
  renderProcessListReport,
  renderProcessLookupReport
} from "../plugins/grok/scripts/lib/render.mjs";
import { COMPANION, initRepo, run, tempDir } from "./helpers.mjs";

function withStateHome(t) {
  const root = tempDir();
  const stateHome = path.join(root, "state");
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
  return { root, stateHome };
}

function seedWorkspace(stateHome, name, jobs) {
  const repo = path.join(stateHome, "..", "workspaces", name);
  fs.mkdirSync(repo, { recursive: true });
  initRepo(repo);
  // Force a unique companion home bucket via GROK_COMPANION_HOME already set.
  saveState(repo, {
    config: {},
    jobs: jobs.map((job) => {
      const record = {
        workspaceRoot: repo,
        cwd: repo,
        ...job
      };
      writeJobFile(repo, record.id, record);
      return record;
    })
  });
  return { repo, stateDir: resolveStateDir(repo) };
}

test("listStateBuckets enumerates every companion state directory", (t) => {
  const { stateHome } = withStateHome(t);
  const a = seedWorkspace(stateHome, "alpha", [
    {
      id: "task-a",
      kind: "task",
      status: "running",
      phase: "tool",
      pid: 1111,
      claudeSessionId: "sess-a",
      startedAt: "2026-07-30T10:00:00.000Z",
      updatedAt: "2026-07-30T10:01:00.000Z"
    }
  ]);
  const b = seedWorkspace(stateHome, "beta", [
    {
      id: "task-b",
      kind: "task",
      status: "running",
      phase: "tool",
      pid: 2222,
      claudeSessionId: "sess-b",
      startedAt: "2026-07-30T11:00:00.000Z",
      updatedAt: "2026-07-30T11:01:00.000Z"
    }
  ]);
  // Noise: non-bucket files/dirs
  fs.writeFileSync(path.join(stateHome, "readme.txt"), "x", "utf8");
  fs.mkdirSync(path.join(stateHome, "empty-dir"));

  const buckets = listStateBuckets({ stateRoot: stateHome });
  assert.equal(buckets.length, 2);
  assert.ok(buckets.some((bucket) => bucket.stateDir === a.stateDir));
  assert.ok(buckets.some((bucket) => bucket.stateDir === b.stateDir));
  assert.equal(listJobsInStateDir(a.stateDir).length, 1);
  assert.equal(listJobsInStateDir(b.stateDir).length, 1);
});

test("buildProcessListSnapshot lists active PIDs across workspaces with decisions", (t) => {
  const { stateHome } = withStateHome(t);
  seedWorkspace(stateHome, "alpha", [
    {
      id: "task-live",
      kind: "task",
      status: "running",
      phase: "tool",
      pid: 4242,
      claudeSessionId: "sess-live",
      title: "Live job",
      summary: "still working",
      startedAt: "2026-07-30T10:00:00.000Z",
      updatedAt: "2026-07-30T10:05:00.000Z"
    },
    {
      id: "task-done",
      kind: "task",
      status: "completed",
      phase: "completed",
      pid: null,
      claudeSessionId: "sess-live",
      updatedAt: "2026-07-30T09:00:00.000Z"
    }
  ]);
  seedWorkspace(stateHome, "beta", [
    {
      id: "task-orphan",
      kind: "task",
      status: "running",
      phase: "tool",
      pid: 9999,
      claudeSessionId: "sess-other",
      startedAt: "2026-07-30T08:00:00.000Z",
      updatedAt: "2026-07-30T08:30:00.000Z"
    }
  ]);

  const alive = new Set([4242]);
  const snapshot = buildProcessListSnapshot({
    stateRoot: stateHome,
    isProcessAliveImpl: (pid) => alive.has(pid)
  });

  assert.equal(snapshot.scannedBuckets, 2);
  assert.equal(snapshot.processCount, 2);
  const byId = Object.fromEntries(snapshot.processes.map((entry) => [entry.jobId, entry]));
  assert.equal(byId["task-live"].decision, PROCESS_DECISION.DO_NOT_KILL);
  assert.equal(byId["task-live"].alive, true);
  assert.equal(byId["task-live"].claudeSessionId, "sess-live");
  assert.equal(byId["task-orphan"].decision, PROCESS_DECISION.ORPHAN_RECLAIMABLE);
  assert.equal(byId["task-orphan"].alive, false);
  assert.ok(snapshot.limitations?.length >= 1);

  const rendered = renderProcessListReport(snapshot);
  assert.match(rendered, /ACTIVE — do not kill/);
  assert.match(rendered, /ORPHAN — reclaimable/);
  assert.match(rendered, /task-live/);
  assert.match(rendered, /task-orphan/);
});

test("buildProcessLookupSnapshot classifies exact, unknown, descendant, and ambiguous PIDs", (t) => {
  const { stateHome } = withStateHome(t);
  seedWorkspace(stateHome, "alpha", [
    {
      id: "task-worker",
      kind: "task",
      status: "running",
      phase: "tool",
      pid: 5000,
      claudeSessionId: "sess-a",
      startedAt: "2026-07-30T10:00:00.000Z",
      updatedAt: "2026-07-30T10:01:00.000Z"
    }
  ]);
  seedWorkspace(stateHome, "beta", [
    {
      id: "task-other",
      kind: "task",
      status: "running",
      phase: "tool",
      pid: 5000,
      claudeSessionId: "sess-b",
      startedAt: "2026-07-30T10:02:00.000Z",
      updatedAt: "2026-07-30T10:03:00.000Z"
    }
  ]);

  const alive = new Set([5000, 5001, 7777]);

  // Ambiguous: same pid recorded in two buckets (pathological but must not invent a kill OK).
  const ambiguous = buildProcessLookupSnapshot(5000, {
    stateRoot: stateHome,
    isProcessAliveImpl: (pid) => alive.has(pid)
  });
  assert.equal(ambiguous.managed, true);
  assert.equal(ambiguous.decision, PROCESS_DECISION.AMBIGUOUS);
  assert.equal(ambiguous.matches.length, 2);

  // Unknown managed status for an unrelated live PID.
  const unknown = buildProcessLookupSnapshot(7777, {
    stateRoot: stateHome,
    isProcessAliveImpl: (pid) => alive.has(pid),
    collectDescendantsImpl: () => [],
    listAncestorsImpl: (pid) => [pid]
  });
  assert.equal(unknown.managed, false);
  assert.equal(unknown.decision, PROCESS_DECISION.UNKNOWN_NOT_MANAGED);
  assert.equal(unknown.alive, true);
  assert.match(unknown.advice, /Not tracked/i);

  // Single-workspace exact match after removing beta collision via empty second bucket.
  const soloHome = path.join(stateHome, "solo-root");
  fs.mkdirSync(soloHome, { recursive: true });
  const previous = process.env.GROK_COMPANION_HOME;
  process.env.GROK_COMPANION_HOME = soloHome;
  try {
    seedWorkspace(soloHome, "solo", [
      {
        id: "task-solo",
        kind: "task",
        status: "running",
        phase: "tool",
        pid: 6000,
        claudeSessionId: "sess-solo",
        startedAt: "2026-07-30T12:00:00.000Z",
        updatedAt: "2026-07-30T12:01:00.000Z"
      }
    ]);
    const exact = buildProcessLookupSnapshot(6000, {
      stateRoot: soloHome,
      isProcessAliveImpl: (pid) => pid === 6000 || pid === 6001,
      collectDescendantsImpl: (pid) => (pid === 6000 ? [6001] : []),
      listAncestorsImpl: (pid) => (pid === 6001 ? [6001, 6000] : [pid])
    });
    assert.equal(exact.managed, true);
    assert.equal(exact.decision, PROCESS_DECISION.DO_NOT_KILL);
    assert.equal(exact.matches[0].match, "exact");

    const child = buildProcessLookupSnapshot(6001, {
      stateRoot: soloHome,
      isProcessAliveImpl: (pid) => pid === 6000 || pid === 6001,
      collectDescendantsImpl: (pid) => (pid === 6000 ? [6001] : []),
      listAncestorsImpl: (pid) => (pid === 6001 ? [6001, 6000] : [pid])
    });
    assert.equal(child.managed, true);
    assert.equal(child.decision, PROCESS_DECISION.DO_NOT_KILL);
    assert.equal(child.matches[0].match, "descendant");
    assert.match(child.advice, /Descendant of active companion job/);

    const orphan = buildProcessLookupSnapshot(6000, {
      stateRoot: soloHome,
      isProcessAliveImpl: () => false,
      collectDescendantsImpl: () => [],
      listAncestorsImpl: (pid) => [pid]
    });
    assert.equal(orphan.decision, PROCESS_DECISION.ORPHAN_RECLAIMABLE);

    const rendered = renderProcessLookupReport(exact);
    assert.match(rendered, /Managed by companion: yes/);
    assert.match(rendered, /ACTIVE — do not kill/);
  } finally {
    if (previous === undefined) {
      delete process.env.GROK_COMPANION_HOME;
    } else {
      process.env.GROK_COMPANION_HOME = previous;
    }
  }
});

test("ps CLI lists and looks up PIDs with --json", (t) => {
  const { root, stateHome } = withStateHome(t);
  seedWorkspace(stateHome, "repo", [
    {
      id: "task-cli",
      kind: "task",
      status: "running",
      phase: "tool",
      pid: 31337,
      claudeSessionId: "sess-cli",
      summary: "cli ps check",
      startedAt: "2026-07-30T13:00:00.000Z",
      updatedAt: "2026-07-30T13:01:00.000Z"
    }
  ]);

  const list = run(process.execPath, [COMPANION, "ps", "--json"], {
    env: { ...process.env, GROK_COMPANION_HOME: stateHome },
    cwd: root
  });
  assert.equal(list.status, 0, list.stderr);
  const listPayload = JSON.parse(list.stdout);
  assert.equal(listPayload.processCount, 1);
  assert.equal(listPayload.processes[0].jobId, "task-cli");
  assert.equal(listPayload.processes[0].pid, 31337);
  assert.ok(
    listPayload.processes[0].decision === PROCESS_DECISION.DO_NOT_KILL
    || listPayload.processes[0].decision === PROCESS_DECISION.ORPHAN_RECLAIMABLE
  );

  const lookup = run(process.execPath, [COMPANION, "ps", "--pid", "31337", "--json"], {
    env: { ...process.env, GROK_COMPANION_HOME: stateHome },
    cwd: root
  });
  assert.equal(lookup.status, 0, lookup.stderr);
  const lookupPayload = JSON.parse(lookup.stdout);
  assert.equal(lookupPayload.pid, 31337);
  assert.equal(lookupPayload.managed, true);
  assert.equal(lookupPayload.matches[0].jobId, "task-cli");

  const unknown = run(process.execPath, [COMPANION, "ps", "--pid", "1", "--json"], {
    env: { ...process.env, GROK_COMPANION_HOME: stateHome },
    cwd: root
  });
  assert.equal(unknown.status, 0, unknown.stderr);
  const unknownPayload = JSON.parse(unknown.stdout);
  // PID 1 may or may not be alive; it must not be treated as managed under this empty-of-pid-1 home.
  assert.equal(unknownPayload.managed, false);
  assert.equal(unknownPayload.decision, PROCESS_DECISION.UNKNOWN_NOT_MANAGED);
});

test("ps --pid rejects non-positive values", (t) => {
  const { root, stateHome } = withStateHome(t);
  const bad = run(process.execPath, [COMPANION, "ps", "--pid", "0"], {
    env: { ...process.env, GROK_COMPANION_HOME: stateHome },
    cwd: root
  });
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /positive integer/i);
});
