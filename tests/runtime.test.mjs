import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { COMPANION, fakeGrokEnv, initRepo, run, tempDir } from "./helpers.mjs";
import { terminateProcessTree } from "../plugins/grok/scripts/lib/process.mjs";
import { resolveJobFile, upsertJob, writeJobFile } from "../plugins/grok/scripts/lib/state.mjs";
import { indexJobRecord } from "../plugins/grok/scripts/lib/tracked-jobs.mjs";

const SESSION_HOOK = path.join(path.dirname(COMPANION), "session-lifecycle-hook.mjs");

function runCompanion(args, options) {
  return run(process.execPath, [COMPANION, ...args], options);
}

async function waitForJob(repo, env, jobId, predicate, timeoutMs = 10_000) {
  const started = Date.now();
  for (;;) {
    const response = runCompanion(["status", jobId, "--json", "--cwd", repo], { env, cwd: repo });
    assert.equal(response.status, 0, response.stderr);
    const job = JSON.parse(response.stdout).job;
    if (predicate(job)) {
      return job;
    }
    if (Date.now() - started >= timeoutMs) {
      assert.fail(`Timed out waiting for job ${jobId}; last state: ${JSON.stringify(job)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

test("setup is not ready when Grok lacks structured review capabilities", (t) => {
  const root = tempDir();
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  initRepo(repo);
  const env = fakeGrokEnv(path.join(root, "state"), { FAKE_GROK_HELP: "Usage: old-grok\n" });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const response = runCompanion(["setup", "--json", "--cwd", repo], { env, cwd: repo });
  assert.equal(response.status, 0, response.stderr);
  const report = JSON.parse(response.stdout);
  assert.equal(report.ready, false);
  assert.equal(report.capabilities.jsonSchema, false);
  assert.equal(report.capabilities.sandbox, false);
  assert.ok(report.nextSteps.some((step) => /Upgrade the Grok CLI/.test(step)));
});

test("review CLI spawns fake Grok and stores a foreground job", (t) => {
  const root = tempDir();
  const repo = path.join(root, "repo");
  const state = path.join(root, "state");
  fs.mkdirSync(repo);
  initRepo(repo);
  fs.writeFileSync(path.join(repo, "app.js"), "export const value = 9;\n", "utf8");
  const capture = path.join(root, "capture.json");
  const env = fakeGrokEnv(state, { FAKE_GROK_CAPTURE: capture });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const result = runCompanion(["review", "--wait", "--json", "--cwd", repo], { env, cwd: repo });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.exitCode, 0);
  assert.equal(payload.result.verdict, "approve");
  assert.equal(payload.parseError, null);
  const captured = JSON.parse(fs.readFileSync(capture, "utf8"));
  assert.ok(captured.args.includes("plan"));
  assert.ok(captured.args.includes("read_file,grep,list_dir"));
  assert.equal(captured.sandbox, "read-only");
  assert.equal(captured.outputFormat, null);
  assert.equal(JSON.parse(captured.jsonSchema).properties.findings.items.additionalProperties, false);

  const status = runCompanion(["status", "--json", "--all", "--cwd", repo], { env, cwd: repo });
  const snapshot = JSON.parse(status.stdout);
  assert.equal(snapshot.jobs[0].kind, "review");
  assert.equal(snapshot.jobs[0].status, "completed");
  assert.equal(snapshot.jobs[0].sessionConfirmed, false);
  assert.equal(snapshot.jobs[0].resumable, false);
  assert.equal(snapshot.jobs[0].exitCode, 0);
  assert.ok(Number.isFinite(snapshot.jobs[0].durationMs));
});

test("review CLI fails closed when Grok returns invalid structured output", (t) => {
  const root = tempDir();
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  initRepo(repo);
  fs.writeFileSync(path.join(repo, "app.js"), "export const value = 10;\n", "utf8");
  const env = fakeGrokEnv(path.join(root, "state"), { FAKE_GROK_OUTPUT: "not-json" });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const response = runCompanion(["review", "--wait", "--json", "--cwd", repo], { env, cwd: repo });
  assert.equal(response.status, 1, response.stderr);
  const payload = JSON.parse(response.stdout);
  assert.equal(payload.exitCode, 1);
  assert.equal(payload.result, null);
  assert.match(payload.parseError, /JSON/);
  assert.equal(payload.rawOutput, "not-json");
});

test("large review uses self-collect and invokes fake Grok with the read-only evidence surface", (t) => {
  const root = tempDir();
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  initRepo(repo);
  fs.writeFileSync(
    path.join(repo, "app.js"),
    Array.from({ length: 40_000 }, (_, index) => `export const value${index} = ${index};`).join("\n"),
    "utf8"
  );
  const capture = path.join(root, "capture.json");
  const env = fakeGrokEnv(path.join(root, "state"), { FAKE_GROK_CAPTURE: capture });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const response = runCompanion(
    ["review", "--wait", "--json", "--scope", "working-tree", "--cwd", repo],
    { env, cwd: repo, timeout: 30_000 }
  );
  assert.equal(response.status, 0, response.stderr);
  const payload = JSON.parse(response.stdout);
  assert.equal(payload.context.inputMode, "self-collect");
  assert.equal(payload.context.truncated, false);
  assert.equal(payload.result.verdict, "approve");
  assert.equal(fs.existsSync(capture), true);
  const captured = JSON.parse(fs.readFileSync(capture, "utf8"));
  assert.equal(captured.sandbox, "read-only");
  assert.ok(captured.args.includes("read_file,grep,list_dir"));
  assert.match(captured.prompt, /complete diff is intentionally not inline/i);
  assert.match(captured.prompt, /## Unstaged Diff Stat/);
  assert.doesNotMatch(captured.prompt, /## Unstaged Diff\n/);
  assert.match(captured.prompt, /app\.js/);
  assert.doesNotMatch(captured.prompt, /export const value39999/);
});

test("truly truncated stored review fails closed before invoking Grok", (t) => {
  const root = tempDir();
  const repo = path.join(root, "repo");
  const state = path.join(root, "state");
  fs.mkdirSync(repo);
  initRepo(repo);
  const capture = path.join(root, "capture.json");
  const env = fakeGrokEnv(state, { FAKE_GROK_CAPTURE: capture });
  const previousStateHome = process.env.GROK_COMPANION_HOME;
  process.env.GROK_COMPANION_HOME = state;
  t.after(() => {
    previousStateHome === undefined
      ? delete process.env.GROK_COMPANION_HOME
      : process.env.GROK_COMPANION_HOME = previousStateHome;
    fs.rmSync(root, { recursive: true, force: true });
  });

  const id = "review-truncated-proof";
  const job = {
    id,
    kind: "review",
    title: "Grok Review",
    status: "queued",
    phase: "queued",
    pid: null,
    cwd: repo,
    workspaceRoot: repo,
    summary: "forced truncated evidence",
    write: false,
    createdAt: new Date().toISOString(),
    resultPath: resolveJobFile(repo, id),
    request: {
      type: "review",
      cwd: repo,
      prompt: "This prompt must never reach Grok.",
      adversarial: false,
      target: { mode: "working-tree", label: "working tree diff" },
      context: { truncated: true, inputMode: "truncated-diff" },
      model: null
    }
  };
  writeJobFile(repo, id, job);
  upsertJob(repo, indexJobRecord(job));

  const worker = runCompanion(["job-worker", "--cwd", repo, "--job-id", id], { env, cwd: repo });
  assert.equal(worker.status, 0, worker.stderr);
  assert.equal(fs.existsSync(capture), false);
  const stored = JSON.parse(fs.readFileSync(resolveJobFile(repo, id), "utf8"));
  assert.equal(stored.status, "failed");
  assert.equal(stored.result.result, null);
  assert.match(stored.result.parseError, /refusing to invoke Grok on an incomplete diff/);
});

test("background task detaches, completes, and can be read with result", async (t) => {
  const root = tempDir();
  const repo = path.join(root, "repo");
  const state = path.join(root, "state");
  fs.mkdirSync(repo);
  initRepo(repo);
  const env = fakeGrokEnv(state);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const launched = runCompanion(
    ["task", "--background", "--json", "--cwd", repo, "implement", "the", "change"],
    { env, cwd: repo }
  );
  assert.equal(launched.status, 0, launched.stderr);
  const jobId = JSON.parse(launched.stdout).jobId;
  const waited = runCompanion(
    ["status", jobId, "--wait", "--timeout-ms", "20000", "--json", "--cwd", repo],
    { env, cwd: repo, timeout: 25_000 }
  );
  assert.equal(waited.status, 0, waited.stderr);
  const waitPayload = JSON.parse(waited.stdout);
  assert.equal(waitPayload.waitedJobId, jobId);
  assert.equal(waitPayload.waitTimedOut, false);
  assert.equal(waitPayload.timeoutMs, 20_000);
  const job = waitPayload.job;
  assert.equal(job.status, "completed");
  const result = runCompanion(["result", jobId, "--json", "--cwd", repo], { env, cwd: repo });
  assert.equal(result.status, 0, result.stderr);
  const stored = JSON.parse(result.stdout);
  assert.equal(stored.result.write, true);
  assert.match(stored.result.rawOutput, /FAKE_GROK_OK/);
  assert.ok(stored.sessionId);
  assert.equal(stored.sessionConfirmed, true);
  assert.equal(stored.resumable, true);
  assert.equal(stored.exitCode, 0);
  assert.ok(Number.isFinite(stored.durationMs));
});

test("status --wait requires a job id", (t) => {
  const root = tempDir();
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  initRepo(repo);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const response = runCompanion(["status", "--wait", "--json", "--cwd", repo], {
    env: fakeGrokEnv(path.join(root, "state")),
    cwd: repo
  });
  assert.equal(response.status, 1);
  assert.match(response.stderr, /status --wait.*requires a job id/i);
  assert.equal(response.stdout, "");
});

test("status --wait timeout returns the active snapshot and remains cancellable", async (t) => {
  const root = tempDir();
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  initRepo(repo);
  const env = fakeGrokEnv(path.join(root, "state"), { FAKE_GROK_DELAY_MS: "10000" });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const launched = runCompanion(["task", "--background", "--json", "--cwd", repo, "long wait"], { env, cwd: repo });
  assert.equal(launched.status, 0, launched.stderr);
  const jobId = JSON.parse(launched.stdout).jobId;
  await waitForJob(repo, env, jobId, (job) => job.status === "running");

  const waited = runCompanion(
    ["status", jobId, "--wait", "--timeout-ms", "1", "--json", "--cwd", repo],
    { env, cwd: repo }
  );
  assert.equal(waited.status, 124, waited.stderr);
  const payload = JSON.parse(waited.stdout);
  assert.equal(payload.waitedJobId, jobId);
  assert.equal(payload.waitTimedOut, true);
  assert.equal(payload.timeoutMs, 1);
  assert.ok(["queued", "running"].includes(payload.job.status));

  const cancelled = runCompanion(["cancel", jobId, "--json", "--cwd", repo], { env, cwd: repo });
  assert.equal(cancelled.status, 0, cancelled.stderr);
  assert.equal(JSON.parse(cancelled.stdout).status, "cancelled");
});

test("running task exposes confirmed session telemetry before completion", async (t) => {
  const root = tempDir();
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  initRepo(repo);
  const env = fakeGrokEnv(path.join(root, "state"), {
    GROK_COMPANION_CLAUDE_SESSION_ID: "claude-live",
    FAKE_GROK_DELAY_MS: "5000"
  });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const launched = runCompanion(["task", "--background", "--json", "--cwd", repo, "observe live progress"], { env, cwd: repo });
  assert.equal(launched.status, 0, launched.stderr);
  const jobId = JSON.parse(launched.stdout).jobId;
  const running = await waitForJob(
    repo,
    env,
    jobId,
    (job) => job.status === "running" && job.sessionConfirmed === true && job.phase === "tool"
  );
  assert.ok(running.sessionId);
  assert.equal(running.phase, "tool");
  assert.ok(running.lastProgressAt);
  assert.equal(running.progress.eventType, "tool_use");
  const cancelled = runCompanion(["cancel", jobId, "--json", "--cwd", repo], { env, cwd: repo });
  assert.equal(cancelled.status, 0, cancelled.stderr);
});

test("task read-only flag reaches the fake Grok process", (t) => {
  const root = tempDir();
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  initRepo(repo);
  const capture = path.join(root, "capture.json");
  const env = fakeGrokEnv(path.join(root, "state"), { FAKE_GROK_CAPTURE: capture });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const result = runCompanion(["task", "--read-only", "--json", "--cwd", repo, "diagnose"], { env, cwd: repo });
  assert.equal(result.status, 0, result.stderr);
  const captured = JSON.parse(fs.readFileSync(capture, "utf8"));
  assert.ok(captured.args.includes("plan"));
  assert.equal(captured.sandbox, "read-only");
  assert.ok(!captured.args.includes("--always-approve"));
});

test("background task can be cancelled and remains cancelled", async (t) => {
  const root = tempDir();
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  initRepo(repo);
  const env = fakeGrokEnv(path.join(root, "state"), { FAKE_GROK_DELAY_MS: "10000" });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const launched = runCompanion(["task", "--background", "--json", "--cwd", repo, "long task"], { env, cwd: repo });
  assert.equal(launched.status, 0, launched.stderr);
  const jobId = JSON.parse(launched.stdout).jobId;

  const cancelled = runCompanion(["cancel", jobId, "--json", "--cwd", repo], { env, cwd: repo });
  assert.equal(cancelled.status, 0, cancelled.stderr);
  assert.equal(JSON.parse(cancelled.stdout).status, "cancelled");
  await new Promise((resolve) => setTimeout(resolve, 200));
  const status = runCompanion(["status", jobId, "--json", "--cwd", repo], { env, cwd: repo });
  const job = JSON.parse(status.stdout).job;
  assert.equal(job.status, "cancelled");
  assert.ok(job.cancelRequestedAt);
  assert.ok(job.cancelledAt);
  assert.equal(job.terminationDelivered, true);
  assert.ok(job.terminationMethod);
});

test("resume candidates are isolated by Claude session and active tasks block resume", async (t) => {
  const root = tempDir();
  const repo = path.join(root, "repo");
  const state = path.join(root, "state");
  fs.mkdirSync(repo);
  initRepo(repo);
  const envA = fakeGrokEnv(state, { GROK_COMPANION_CLAUDE_SESSION_ID: "claude-a" });
  const envB = fakeGrokEnv(state, { GROK_COMPANION_CLAUDE_SESSION_ID: "claude-b" });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const first = runCompanion(["task", "--json", "--cwd", repo, "first session task"], { env: envA, cwd: repo });
  assert.equal(first.status, 0, first.stderr);
  const firstSessionId = JSON.parse(first.stdout).sessionId;
  const candidateA = runCompanion(["task-resume-candidate", "--json", "--cwd", repo], { env: envA, cwd: repo });
  const candidatePayload = JSON.parse(candidateA.stdout);
  assert.equal(candidatePayload.sessionId, firstSessionId);
  assert.equal(candidatePayload.status, "completed");
  assert.equal(candidatePayload.summary, "first session task");
  assert.ok(candidatePayload.updatedAt);
  assert.equal(candidatePayload.sessionConfirmed, true);
  assert.equal(candidatePayload.resumable, true);
  const candidateB = runCompanion(["task-resume-candidate", "--json", "--cwd", repo], { env: envB, cwd: repo });
  assert.equal(JSON.parse(candidateB.stdout).available, false);

  const resumeCapture = path.join(root, "resume-capture.json");
  const resumed = runCompanion(["task", "--resume", "--json", "--cwd", repo, "continue scoped session"], {
    env: { ...envA, FAKE_GROK_CAPTURE: resumeCapture },
    cwd: repo
  });
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.equal(JSON.parse(fs.readFileSync(resumeCapture, "utf8")).resumeSessionId, firstSessionId);

  const delayedEnvA = { ...envA, FAKE_GROK_DELAY_MS: "10000" };
  const active = runCompanion(["task", "--background", "--json", "--fresh", "--cwd", repo, "active task"], { env: delayedEnvA, cwd: repo });
  const activeId = JSON.parse(active.stdout).jobId;
  await waitForJob(repo, delayedEnvA, activeId, (job) => job.status === "running");
  const blocked = runCompanion(["task-resume-candidate", "--json", "--cwd", repo], { env: delayedEnvA, cwd: repo });
  assert.equal(blocked.status, 1);
  assert.match(blocked.stderr, /Cannot resume while Grok task/);
  runCompanion(["cancel", activeId, "--json", "--cwd", repo], { env: delayedEnvA, cwd: repo });

  const capture = path.join(root, "fresh-capture.json");
  const fresh = runCompanion(["task", "--fresh", "--json", "--cwd", repo, "explicitly fresh"], {
    env: { ...envA, FAKE_GROK_CAPTURE: capture },
    cwd: repo
  });
  assert.equal(fresh.status, 0, fresh.stderr);
  const captured = JSON.parse(fs.readFileSync(capture, "utf8"));
  assert.notEqual(captured.sessionId, firstSessionId);
  assert.equal(captured.resumeSessionId, null);
});

test("failed-before-session and hookless jobs are never resume candidates", (t) => {
  const root = tempDir();
  const repo = path.join(root, "repo");
  const state = path.join(root, "state");
  fs.mkdirSync(repo);
  initRepo(repo);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const failedEnv = fakeGrokEnv(state, {
    GROK_COMPANION_CLAUDE_SESSION_ID: "claude-failed",
    FAKE_GROK_FAIL_BEFORE_SESSION: "1"
  });
  const failed = runCompanion(["task", "--json", "--cwd", repo, "fail early"], { env: failedEnv, cwd: repo });
  assert.equal(failed.status, 1);
  const failedStatus = runCompanion(["status", "--all", "--json", "--cwd", repo], { env: failedEnv, cwd: repo });
  const failedJob = JSON.parse(failedStatus.stdout).jobs[0];
  assert.ok(failedJob.sessionId, "the preallocated candidate UUID remains observable");
  assert.equal(failedJob.sessionConfirmed, false);
  assert.equal(failedJob.resumable, false);
  const failedCandidate = runCompanion(["task-resume-candidate", "--json", "--cwd", repo], { env: failedEnv, cwd: repo });
  assert.equal(JSON.parse(failedCandidate.stdout).available, false);

  const inheritedSessionId = process.env.GROK_COMPANION_CLAUDE_SESSION_ID;
  process.env.GROK_COMPANION_CLAUDE_SESSION_ID = "ambient-parent-session";
  const hooklessEnv = fakeGrokEnv(state);
  if (inheritedSessionId === undefined) {
    delete process.env.GROK_COMPANION_CLAUDE_SESSION_ID;
  } else {
    process.env.GROK_COMPANION_CLAUDE_SESSION_ID = inheritedSessionId;
  }
  assert.equal(Object.hasOwn(hooklessEnv, "GROK_COMPANION_CLAUDE_SESSION_ID"), false);
  const hookless = runCompanion(["task", "--fresh", "--json", "--cwd", repo, "no Claude hook"], { env: hooklessEnv, cwd: repo });
  assert.equal(hookless.status, 0, hookless.stderr);
  const hooklessCandidate = runCompanion(["task-resume-candidate", "--json", "--cwd", repo], { env: hooklessEnv, cwd: repo });
  assert.equal(JSON.parse(hooklessCandidate.stdout).available, false);
  const resume = runCompanion(["task", "--resume", "--json", "--cwd", repo, "must not cross sessions"], { env: hooklessEnv, cwd: repo });
  assert.equal(resume.status, 1);
  assert.match(resume.stderr, /No resumable Grok task session/);
});

test("status persists a dead worker as failed process-exited and result becomes readable", async (t) => {
  const root = tempDir();
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  initRepo(repo);
  const env = fakeGrokEnv(path.join(root, "state"), { FAKE_GROK_DELAY_MS: "10000" });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const launched = runCompanion(["task", "--background", "--json", "--cwd", repo, "orphan me"], { env, cwd: repo });
  const jobId = JSON.parse(launched.stdout).jobId;
  const running = await waitForJob(repo, env, jobId, (job) => job.status === "running" && job.pid);
  const termination = terminateProcessTree(running.pid, { cwd: repo, env });
  assert.equal(termination.delivered, true);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const status = runCompanion(["status", jobId, "--json", "--cwd", repo], { env, cwd: repo });
  const failed = JSON.parse(status.stdout).job;
  assert.equal(failed.status, "failed");
  assert.equal(failed.phase, "process-exited");
  assert.match(failed.errorMessage, /exited before the job reached a terminal state/);
  const result = runCompanion(["result", jobId, "--json", "--cwd", repo], { env, cwd: repo });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).status, "failed");
});

test("SessionEnd uses trusted cancellation metadata", async (t) => {
  const root = tempDir();
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  initRepo(repo);
  const env = fakeGrokEnv(path.join(root, "state"), {
    GROK_COMPANION_CLAUDE_SESSION_ID: "claude-ending",
    FAKE_GROK_DELAY_MS: "10000"
  });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const launched = runCompanion(["task", "--background", "--json", "--cwd", repo, "end with session"], { env, cwd: repo });
  const jobId = JSON.parse(launched.stdout).jobId;
  await waitForJob(repo, env, jobId, (job) => job.status === "running");
  const hook = run(process.execPath, [SESSION_HOOK, "SessionEnd"], {
    cwd: repo,
    env,
    input: JSON.stringify({ session_id: "claude-ending", cwd: repo })
  });
  assert.equal(hook.status, 0, hook.stderr);
  const status = runCompanion(["status", jobId, "--json", "--cwd", repo], { env, cwd: repo });
  const cancelled = JSON.parse(status.stdout).job;
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.phase, "session-ended");
  assert.ok(cancelled.cancelRequestedAt);
  assert.ok(cancelled.cancelledAt);
  assert.equal(cancelled.terminationDelivered, true);
});

test("transfer CLI creates a read-only resumable handoff with fake Grok", (t) => {
  const root = tempDir();
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  initRepo(repo);
  const transcript = path.join(root, "session.jsonl");
  fs.writeFileSync(
    transcript,
    [
      JSON.stringify({ type: "user", message: { content: "Investigate the regression" } }),
      JSON.stringify({ type: "assistant", message: { content: "The next step is to inspect app.js" } })
    ].join("\n"),
    "utf8"
  );
  const capture = path.join(root, "capture.json");
  const env = fakeGrokEnv(path.join(root, "state"), { FAKE_GROK_CAPTURE: capture });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const result = runCompanion(["transfer", "--json", "--cwd", repo, "--source", transcript], { env, cwd: repo });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.includedTurns, 2);
  assert.equal(payload.totalTurns, 2);
  assert.equal(payload.omittedTurns, 0);
  assert.match(payload.sourceSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(payload.omissions.bad_json, 0);
  assert.ok(payload.sessionId);
  assert.equal(payload.sessionConfirmed, false);
  const captured = JSON.parse(fs.readFileSync(capture, "utf8"));
  assert.match(captured.prompt, /lossy handoff/);
  assert.match(captured.prompt, /Investigate the regression/);
  assert.equal(captured.prompt.includes(transcript), false);
  assert.ok(captured.args.includes("read_file,grep,list_dir"));
});

test("task and task-resume-candidate reclaim dead-PID orphans before findLatestTaskSession", async (t) => {
  const root = tempDir();
  const repo = path.join(root, "repo");
  const state = path.join(root, "state");
  fs.mkdirSync(repo);
  initRepo(repo);
  const env = fakeGrokEnv(state, {
    GROK_COMPANION_CLAUDE_SESSION_ID: "claude-orphan-reclaim",
    FAKE_GROK_DELAY_MS: "10000"
  });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const launched = runCompanion(["task", "--background", "--json", "--cwd", repo, "orphan then resume"], {
    env,
    cwd: repo
  });
  assert.equal(launched.status, 0, launched.stderr);
  const jobId = JSON.parse(launched.stdout).jobId;
  const running = await waitForJob(repo, env, jobId, (job) => job.status === "running" && job.pid);
  const termination = terminateProcessTree(running.pid, { cwd: repo, env });
  assert.equal(termination.delivered, true);
  await new Promise((resolve) => setTimeout(resolve, 300));

  // Without status/result the index would still say running; resume paths must reconcile first
  // so they do not permanently throw "Cannot resume while ... is running".
  const candidate = runCompanion(["task-resume-candidate", "--json", "--cwd", repo], { env, cwd: repo });
  assert.equal(candidate.status, 0, candidate.stderr);
  assert.doesNotMatch(candidate.stderr, /Cannot resume while Grok task/);
  const candidatePayload = JSON.parse(candidate.stdout);
  // Reconcile flips the orphan to failed. Whether it is resumable depends on whether
  // sessionConfirmed landed before the kill (race with FAKE_GROK_DELAY_MS).
  if (candidatePayload.available) {
    assert.equal(candidatePayload.jobId, jobId);
    assert.equal(candidatePayload.status, "failed");
  }

  const status = runCompanion(["status", jobId, "--json", "--cwd", repo], { env, cwd: repo });
  const failedJob = JSON.parse(status.stdout).job;
  assert.equal(failedJob.status, "failed");
  assert.equal(failedJob.phase, "process-exited");

  // task --resume must reconcile too (not block on the stale running index entry).
  const resumeCapture = path.join(root, "resume-after-orphan.json");
  const resume = runCompanion(["task", "--resume", "--json", "--cwd", repo, "after orphan reclaim"], {
    env: { ...env, FAKE_GROK_CAPTURE: resumeCapture, FAKE_GROK_DELAY_MS: "0" },
    cwd: repo
  });
  assert.doesNotMatch(resume.stderr, /Cannot resume while Grok task/);
  if (candidatePayload.available) {
    assert.equal(resume.status, 0, resume.stderr);
    assert.equal(JSON.parse(fs.readFileSync(resumeCapture, "utf8")).resumeSessionId, failedJob.sessionId);
  } else {
    assert.equal(resume.status, 1, resume.stderr);
    assert.match(resume.stderr, /No resumable Grok task session/);
  }
});

test("job-worker refuses to re-run completed or cancelled jobs", (t) => {
  const root = tempDir();
  const repo = path.join(root, "repo");
  const state = path.join(root, "state");
  fs.mkdirSync(repo);
  initRepo(repo);
  const capture = path.join(root, "capture.json");
  const env = fakeGrokEnv(state, { FAKE_GROK_CAPTURE: capture });
  const previousStateHome = process.env.GROK_COMPANION_HOME;
  process.env.GROK_COMPANION_HOME = state;
  t.after(() => {
    previousStateHome === undefined
      ? delete process.env.GROK_COMPANION_HOME
      : process.env.GROK_COMPANION_HOME = previousStateHome;
    fs.rmSync(root, { recursive: true, force: true });
  });

  const id = "task-already-done";
  const logPath = path.join(repo, `${id}.log`);
  fs.writeFileSync(logPath, "", "utf8");
  const originalResult = { rawOutput: "ORIGINAL_RESULT", exitCode: 0 };
  const job = {
    id,
    kind: "task",
    title: "Grok Task",
    status: "completed",
    phase: "completed",
    pid: null,
    cwd: repo,
    workspaceRoot: repo,
    summary: "already finished",
    write: true,
    createdAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    logPath,
    resultPath: resolveJobFile(repo, id),
    result: originalResult,
    request: {
      type: "task",
      cwd: repo,
      prompt: "must not run again",
      write: true,
      model: null,
      effort: null,
      sessionId: null,
      sessionConfirmed: false,
      resumeSessionId: null,
      timeoutMs: null,
      title: "Grok Task"
    }
  };
  writeJobFile(repo, id, job);
  upsertJob(repo, indexJobRecord(job));

  const worker = runCompanion(["job-worker", "--cwd", repo, "--job-id", id], { env, cwd: repo });
  assert.notEqual(worker.status, 0);
  assert.match(worker.stderr, /refused to run job|status is "completed"/i);
  assert.equal(fs.existsSync(capture), false);
  const stored = JSON.parse(fs.readFileSync(resolveJobFile(repo, id), "utf8"));
  assert.equal(stored.status, "completed");
  assert.deepEqual(stored.result, originalResult);
});

test("task rejects oversized --prompt-file before invoking Grok", (t) => {
  const root = tempDir();
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  initRepo(repo);
  const capture = path.join(root, "capture.json");
  const env = fakeGrokEnv(path.join(root, "state"), { FAKE_GROK_CAPTURE: capture });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const promptFile = path.join(root, "huge-prompt.txt");
  const maxPromptBytes = 16 * 1024 * 1024;
  // One byte over the companion limit; write without holding the full string in V8 heap longer than needed.
  const fd = fs.openSync(promptFile, "w");
  try {
    fs.writeSync(fd, Buffer.alloc(maxPromptBytes, 0x61));
    fs.writeSync(fd, Buffer.from("!"));
  } finally {
    fs.closeSync(fd);
  }
  assert.equal(fs.statSync(promptFile).size, maxPromptBytes + 1);

  const response = runCompanion(
    ["task", "--json", "--cwd", repo, "--prompt-file", promptFile],
    { env, cwd: repo, timeout: 30_000 }
  );
  assert.equal(response.status, 1);
  assert.match(response.stderr, /prompt-file/i);
  assert.match(response.stderr, /exceeds the maximum/i);
  assert.match(response.stderr, /16/);
  assert.equal(fs.existsSync(capture), false);
});

test("task --resume without prompt injects the default continue prompt", (t) => {
  const root = tempDir();
  const repo = path.join(root, "repo");
  const state = path.join(root, "state");
  fs.mkdirSync(repo);
  initRepo(repo);
  const env = fakeGrokEnv(state, { GROK_COMPANION_CLAUDE_SESSION_ID: "claude-continue" });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const first = runCompanion(["task", "--json", "--cwd", repo, "seed session"], { env, cwd: repo });
  assert.equal(first.status, 0, first.stderr);
  const sessionId = JSON.parse(first.stdout).sessionId;
  const capture = path.join(root, "continue-capture.json");
  const resumed = runCompanion(["task", "--resume", "--json", "--cwd", repo], {
    env: { ...env, FAKE_GROK_CAPTURE: capture },
    cwd: repo
  });
  assert.equal(resumed.status, 0, resumed.stderr);
  const captured = JSON.parse(fs.readFileSync(capture, "utf8"));
  assert.equal(captured.resumeSessionId, sessionId);
  assert.match(captured.prompt, /Continue from where you left off/i);
});

test("task --session-id and --resume-job resume a confirmed session outside auto-candidate scope", (t) => {
  const root = tempDir();
  const repo = path.join(root, "repo");
  const state = path.join(root, "state");
  fs.mkdirSync(repo);
  initRepo(repo);
  const envA = fakeGrokEnv(state, { GROK_COMPANION_CLAUDE_SESSION_ID: "claude-owner" });
  const envB = fakeGrokEnv(state, { GROK_COMPANION_CLAUDE_SESSION_ID: "claude-other" });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const first = runCompanion(["task", "--json", "--cwd", repo, "owned task"], { env: envA, cwd: repo });
  assert.equal(first.status, 0, first.stderr);
  const sessionId = JSON.parse(first.stdout).sessionId;
  const status = runCompanion(["status", "--all", "--json", "--cwd", repo], { env: envA, cwd: repo });
  const jobId = JSON.parse(status.stdout).jobs[0].id;

  // Other Claude session has no auto-candidate, but explicit flags still work.
  const candidateB = runCompanion(["task-resume-candidate", "--json", "--cwd", repo], { env: envB, cwd: repo });
  assert.equal(JSON.parse(candidateB.stdout).available, false);

  const bySession = path.join(root, "by-session.json");
  const resumedBySession = runCompanion(
    ["task", "--session-id", sessionId, "--json", "--cwd", repo, "continue via session id"],
    { env: { ...envB, FAKE_GROK_CAPTURE: bySession }, cwd: repo }
  );
  assert.equal(resumedBySession.status, 0, resumedBySession.stderr);
  assert.equal(JSON.parse(fs.readFileSync(bySession, "utf8")).resumeSessionId, sessionId);

  const byJob = path.join(root, "by-job.json");
  const resumedByJob = runCompanion(
    ["task", "--resume-job", jobId, "--json", "--cwd", repo, "continue via job id"],
    { env: { ...envB, FAKE_GROK_CAPTURE: byJob }, cwd: repo }
  );
  assert.equal(resumedByJob.status, 0, resumedByJob.stderr);
  assert.equal(JSON.parse(fs.readFileSync(byJob, "utf8")).resumeSessionId, sessionId);

  const missing = runCompanion(
    ["task", "--session-id", "00000000-0000-4000-8000-000000000099", "--json", "--cwd", repo, "nope"],
    { env: envB, cwd: repo }
  );
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /No confirmed Grok task session/);
});

test("review and transfer accept --timeout-ms", (t) => {
  const root = tempDir();
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  initRepo(repo);
  fs.writeFileSync(path.join(repo, "app.js"), "export const value = 11;\n", "utf8");
  const transcript = path.join(root, "session.jsonl");
  fs.writeFileSync(
    transcript,
    [
      JSON.stringify({ type: "user", message: { content: "timeout handoff" } }),
      JSON.stringify({ type: "assistant", message: { content: "ack" } })
    ].join("\n"),
    "utf8"
  );
  const env = fakeGrokEnv(path.join(root, "state"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const review = runCompanion(
    ["review", "--wait", "--json", "--timeout-ms", "60000", "--cwd", repo],
    { env, cwd: repo }
  );
  assert.equal(review.status, 0, review.stderr);

  const transfer = runCompanion(
    ["transfer", "--json", "--timeout-ms", "60000", "--source", transcript, "--cwd", repo],
    { env, cwd: repo }
  );
  assert.equal(transfer.status, 0, transfer.stderr);
  assert.equal(JSON.parse(transfer.stdout).includedTurns, 2);

  const invalid = runCompanion(
    ["review", "--wait", "--json", "--timeout-ms", "0", "--cwd", repo],
    { env, cwd: repo }
  );
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /timeout-ms must be a positive number/i);
});

test("rerun requeues a finished job from the request sidecar", (t) => {
  const root = tempDir();
  const repo = path.join(root, "repo");
  const state = path.join(root, "state");
  fs.mkdirSync(repo);
  initRepo(repo);
  const env = fakeGrokEnv(state);
  const previousStateHome = process.env.GROK_COMPANION_HOME;
  process.env.GROK_COMPANION_HOME = state;
  t.after(() => {
    previousStateHome === undefined
      ? delete process.env.GROK_COMPANION_HOME
      : process.env.GROK_COMPANION_HOME = previousStateHome;
    fs.rmSync(root, { recursive: true, force: true });
  });

  const first = runCompanion(["task", "--json", "--cwd", repo, "original prompt for rerun"], { env, cwd: repo });
  assert.equal(first.status, 0, first.stderr);
  const status = runCompanion(["status", "--all", "--json", "--cwd", repo], { env, cwd: repo });
  const sourceId = JSON.parse(status.stdout).jobs[0].id;
  const stored = JSON.parse(fs.readFileSync(resolveJobFile(repo, sourceId), "utf8"));
  assert.equal(stored.request, undefined);

  const capture = path.join(root, "rerun-capture.json");
  const rerun = runCompanion(["rerun", sourceId, "--json", "--cwd", repo], {
    env: { ...env, FAKE_GROK_CAPTURE: capture },
    cwd: repo
  });
  assert.equal(rerun.status, 0, rerun.stderr);
  const captured = JSON.parse(fs.readFileSync(capture, "utf8"));
  assert.match(captured.prompt, /original prompt for rerun/);
});

test("logs and status --progress-lines expose job log content", async (t) => {
  const root = tempDir();
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  initRepo(repo);
  const env = fakeGrokEnv(path.join(root, "state"), { FAKE_GROK_DELAY_MS: "4000" });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const launched = runCompanion(
    ["task", "--background", "--json", "--cwd", repo, "log progress task"],
    { env, cwd: repo }
  );
  assert.equal(launched.status, 0, launched.stderr);
  const jobId = JSON.parse(launched.stdout).jobId;
  await waitForJob(repo, env, jobId, (job) => job.status === "running" && job.sessionConfirmed === true);

  const logs = runCompanion(["logs", jobId, "--tail", "20", "--json", "--cwd", repo], { env, cwd: repo });
  assert.equal(logs.status, 0, logs.stderr);
  const logPayload = JSON.parse(logs.stdout);
  assert.equal(logPayload.jobId, jobId);
  assert.equal(logPayload.exists, true);
  assert.ok(logPayload.lines.length > 0);

  const status = runCompanion(
    ["status", jobId, "--progress-lines", "10", "--json", "--cwd", repo],
    { env, cwd: repo }
  );
  assert.equal(status.status, 0, status.stderr);
  const job = JSON.parse(status.stdout).job;
  assert.ok(Array.isArray(job.progressPreview));

  runCompanion(["cancel", jobId, "--json", "--cwd", repo], { env, cwd: repo });
});

test("cleanup dry-run and export preserve job evidence", (t) => {
  const root = tempDir();
  const repo = path.join(root, "repo");
  const state = path.join(root, "state");
  fs.mkdirSync(repo);
  initRepo(repo);
  const env = fakeGrokEnv(state);
  const previousStateHome = process.env.GROK_COMPANION_HOME;
  process.env.GROK_COMPANION_HOME = state;
  t.after(() => {
    previousStateHome === undefined
      ? delete process.env.GROK_COMPANION_HOME
      : process.env.GROK_COMPANION_HOME = previousStateHome;
    fs.rmSync(root, { recursive: true, force: true });
  });

  const first = runCompanion(["task", "--json", "--cwd", repo, "cleanup target"], { env, cwd: repo });
  assert.equal(first.status, 0, first.stderr);
  const status = runCompanion(["status", "--all", "--json", "--cwd", repo], { env, cwd: repo });
  const jobId = JSON.parse(status.stdout).jobs[0].id;

  const outPath = path.join(root, "bundle.json");
  const exported = runCompanion(["export", jobId, "--out", outPath, "--json", "--cwd", repo], { env, cwd: repo });
  assert.equal(exported.status, 0, exported.stderr);
  const exportPayload = JSON.parse(exported.stdout);
  assert.equal(exportPayload.jobId, jobId);
  assert.equal(exportPayload.hasRerun, true);
  assert.equal(fs.existsSync(outPath), true);
  const bundle = JSON.parse(fs.readFileSync(outPath, "utf8"));
  assert.equal(bundle.job.id, jobId);
  assert.ok(bundle.rerun?.request?.prompt);

  const dry = runCompanion(["cleanup", "--keep", "0", "--dry-run", "--json", "--cwd", repo], { env, cwd: repo });
  assert.equal(dry.status, 0, dry.stderr);
  const dryPayload = JSON.parse(dry.stdout);
  assert.equal(dryPayload.dryRun, true);
  assert.ok(dryPayload.removedCount >= 1);
  assert.equal(fs.existsSync(resolveJobFile(repo, jobId)), true);

  const cleaned = runCompanion(["cleanup", "--keep", "0", "--json", "--cwd", repo], { env, cwd: repo });
  assert.equal(cleaned.status, 0, cleaned.stderr);
  assert.equal(fs.existsSync(resolveJobFile(repo, jobId)), false);
});

test("status filters by kind/status/limit and cancel --all cancels active jobs", async (t) => {
  const root = tempDir();
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  initRepo(repo);
  const env = fakeGrokEnv(path.join(root, "state"), { FAKE_GROK_DELAY_MS: "10000" });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const a = runCompanion(["task", "--background", "--json", "--cwd", repo, "cancel all a"], { env, cwd: repo });
  const b = runCompanion(["task", "--background", "--json", "--cwd", repo, "cancel all b"], { env, cwd: repo });
  assert.equal(a.status, 0, a.stderr);
  assert.equal(b.status, 0, b.stderr);
  const idA = JSON.parse(a.stdout).jobId;
  const idB = JSON.parse(b.stdout).jobId;
  await waitForJob(repo, env, idA, (job) => job.status === "running");
  await waitForJob(repo, env, idB, (job) => job.status === "running");

  const filtered = runCompanion(
    ["status", "--kind", "task", "--status", "running", "--limit", "1", "--json", "--cwd", repo],
    { env, cwd: repo }
  );
  assert.equal(filtered.status, 0, filtered.stderr);
  const snapshot = JSON.parse(filtered.stdout);
  assert.ok(snapshot.jobs.every((job) => job.kind === "task" && job.status === "running"));
  assert.ok(snapshot.jobs.length <= 1);

  // No session id: --all scopes to the whole workspace and reports no-session-id.
  const cancelled = runCompanion(["cancel", "--all", "--kind", "task", "--json", "--cwd", repo], {
    env,
    cwd: repo,
    timeout: 30_000
  });
  assert.equal(cancelled.status, 0, cancelled.stderr);
  const cancelPayload = JSON.parse(cancelled.stdout);
  assert.ok(cancelPayload.requestedCount >= 2);
  assert.equal(cancelPayload.cancelledCount, cancelPayload.requestedCount);
  assert.equal(cancelPayload.scope, "no-session-id");
});

test("cancel --all is session-scoped; --all-sessions crosses sessions", async (t) => {
  const root = tempDir();
  const repo = path.join(root, "repo");
  const state = path.join(root, "state");
  fs.mkdirSync(repo);
  initRepo(repo);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const envA = fakeGrokEnv(state, {
    FAKE_GROK_DELAY_MS: "10000",
    GROK_COMPANION_CLAUDE_SESSION_ID: "claude-cancel-a"
  });
  const envB = fakeGrokEnv(state, {
    FAKE_GROK_DELAY_MS: "10000",
    GROK_COMPANION_CLAUDE_SESSION_ID: "claude-cancel-b"
  });

  const launchedA = runCompanion(
    ["task", "--background", "--json", "--cwd", repo, "session a cancel scope"],
    { env: envA, cwd: repo }
  );
  const launchedB = runCompanion(
    ["task", "--background", "--json", "--cwd", repo, "session b cancel scope"],
    { env: envB, cwd: repo }
  );
  assert.equal(launchedA.status, 0, launchedA.stderr);
  assert.equal(launchedB.status, 0, launchedB.stderr);
  const idA = JSON.parse(launchedA.stdout).jobId;
  const idB = JSON.parse(launchedB.stdout).jobId;
  await waitForJob(repo, envA, idA, (job) => job.status === "running");
  await waitForJob(repo, envB, idB, (job) => job.status === "running");

  const cancelA = runCompanion(["cancel", "--all", "--json", "--cwd", repo], {
    env: envA,
    cwd: repo,
    timeout: 30_000
  });
  assert.equal(cancelA.status, 0, cancelA.stderr);
  const payloadA = JSON.parse(cancelA.stdout);
  assert.equal(payloadA.scope, "current-session");
  assert.equal(payloadA.claudeSessionId, "claude-cancel-a");
  assert.equal(payloadA.otherSessionCount, 0);
  assert.equal(payloadA.requestedCount, 1);
  assert.equal(payloadA.cancelledCount, 1);
  assert.equal(payloadA.results[0].jobId, idA);
  assert.equal(payloadA.results[0].claudeSessionId, "claude-cancel-a");
  assert.equal(payloadA.results[0].otherSession, false);

  const stillB = runCompanion(["status", idB, "--json", "--cwd", repo], { env: envB, cwd: repo });
  assert.equal(stillB.status, 0, stillB.stderr);
  const jobB = JSON.parse(stillB.stdout).job;
  assert.ok(["queued", "running"].includes(jobB.status), `expected B still active, got ${jobB.status}`);

  const cancelAllSessions = runCompanion(["cancel", "--all-sessions", "--json", "--cwd", repo], {
    env: envA,
    cwd: repo,
    timeout: 30_000
  });
  assert.equal(cancelAllSessions.status, 0, cancelAllSessions.stderr);
  const payloadAll = JSON.parse(cancelAllSessions.stdout);
  assert.equal(payloadAll.scope, "all-sessions");
  assert.equal(payloadAll.claudeSessionId, "claude-cancel-a");
  assert.equal(payloadAll.requestedCount, 1);
  assert.equal(payloadAll.cancelledCount, 1);
  assert.equal(payloadAll.otherSessionCount, 1);
  assert.equal(payloadAll.otherSessionJobs.length, 1);
  assert.equal(payloadAll.otherSessionJobs[0].jobId, idB);
  assert.equal(payloadAll.otherSessionJobs[0].claudeSessionId, "claude-cancel-b");
  assert.equal(payloadAll.results[0].jobId, idB);
  assert.equal(payloadAll.results[0].claudeSessionId, "claude-cancel-b");
  assert.equal(payloadAll.results[0].otherSession, true);

  const doneB = runCompanion(["status", idB, "--json", "--cwd", repo], { env: envB, cwd: repo });
  assert.equal(doneB.status, 0, doneB.stderr);
  assert.equal(JSON.parse(doneB.stdout).job.status, "cancelled");
});

test("cancel --all without session id reports no-session-id workspace scope", async (t) => {
  const root = tempDir();
  const repo = path.join(root, "repo");
  const state = path.join(root, "state");
  fs.mkdirSync(repo);
  initRepo(repo);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  // Seed two session-tagged jobs via env, then cancel with no session id.
  const envA = fakeGrokEnv(state, {
    FAKE_GROK_DELAY_MS: "10000",
    GROK_COMPANION_CLAUDE_SESSION_ID: "claude-ns-a"
  });
  const envB = fakeGrokEnv(state, {
    FAKE_GROK_DELAY_MS: "10000",
    GROK_COMPANION_CLAUDE_SESSION_ID: "claude-ns-b"
  });
  const envNoSession = fakeGrokEnv(state);

  const launchedA = runCompanion(
    ["task", "--background", "--json", "--cwd", repo, "no-session cancel a"],
    { env: envA, cwd: repo }
  );
  const launchedB = runCompanion(
    ["task", "--background", "--json", "--cwd", repo, "no-session cancel b"],
    { env: envB, cwd: repo }
  );
  assert.equal(launchedA.status, 0, launchedA.stderr);
  assert.equal(launchedB.status, 0, launchedB.stderr);
  const idA = JSON.parse(launchedA.stdout).jobId;
  const idB = JSON.parse(launchedB.stdout).jobId;
  await waitForJob(repo, envA, idA, (job) => job.status === "running");
  await waitForJob(repo, envB, idB, (job) => job.status === "running");

  const cancelled = runCompanion(["cancel", "--all", "--json", "--cwd", repo], {
    env: envNoSession,
    cwd: repo,
    timeout: 30_000
  });
  assert.equal(cancelled.status, 0, cancelled.stderr);
  const payload = JSON.parse(cancelled.stdout);
  assert.equal(payload.scope, "no-session-id");
  assert.equal(payload.claudeSessionId, null);
  assert.equal(payload.requestedCount, 2);
  assert.equal(payload.cancelledCount, 2);
  const cancelledIds = new Set(payload.results.map((entry) => entry.jobId));
  assert.ok(cancelledIds.has(idA));
  assert.ok(cancelledIds.has(idB));
});

test("status --wait --with-result returns the finished job result", async (t) => {
  const root = tempDir();
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  initRepo(repo);
  const env = fakeGrokEnv(path.join(root, "state"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const launched = runCompanion(
    ["task", "--background", "--json", "--cwd", repo, "wait with result"],
    { env, cwd: repo }
  );
  assert.equal(launched.status, 0, launched.stderr);
  const jobId = JSON.parse(launched.stdout).jobId;
  const waited = runCompanion(
    ["status", jobId, "--wait", "--with-result", "--timeout-ms", "20000", "--json", "--cwd", repo],
    { env, cwd: repo, timeout: 25_000 }
  );
  assert.equal(waited.status, 0, waited.stderr);
  const payload = JSON.parse(waited.stdout);
  assert.equal(payload.waitTimedOut, false);
  assert.equal(payload.result.status, "completed");
  assert.match(payload.result.result.rawOutput, /FAKE_GROK_OK/);
});

test("transfer --background enqueues and completes via status/result", async (t) => {
  const root = tempDir();
  const repo = path.join(root, "repo");
  const state = path.join(root, "state");
  fs.mkdirSync(repo);
  initRepo(repo);
  // Minimal Claude transcript JSONL for transfer source.
  const transcriptPath = path.join(root, "session.jsonl");
  fs.writeFileSync(
    transcriptPath,
    [
      JSON.stringify({ type: "user", message: { content: "hello transfer" } }),
      JSON.stringify({ type: "assistant", message: { content: "ack" } })
    ].join("\n"),
    "utf8"
  );
  const env = fakeGrokEnv(state);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const launched = runCompanion(
    ["transfer", "--background", "--source", transcriptPath, "--json", "--cwd", repo],
    { env, cwd: repo }
  );
  assert.equal(launched.status, 0, launched.stderr);
  const jobId = JSON.parse(launched.stdout).jobId;
  const waited = runCompanion(
    ["status", jobId, "--wait", "--timeout-ms", "20000", "--json", "--cwd", repo],
    { env, cwd: repo, timeout: 25_000 }
  );
  assert.equal(waited.status, 0, waited.stderr);
  assert.equal(JSON.parse(waited.stdout).job.status, "completed");
  const result = runCompanion(["result", jobId, "--json", "--cwd", repo], { env, cwd: repo });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).kind, "transfer");
});

test("usage lists new commands and task resume flags", (t) => {
  const response = runCompanion(["help"], { env: fakeGrokEnv(tempDir()), cwd: process.cwd() });
  assert.equal(response.status, 0, response.stderr);
  assert.match(response.stdout, /--session-id/);
  assert.match(response.stdout, /--resume-job/);
  assert.match(response.stdout, /--stop-review/);
  assert.match(response.stdout, /--timeout-ms/);
  assert.match(response.stdout, /\blogs\b/);
  assert.match(response.stdout, /\bps\b/);
  assert.match(response.stdout, /--pid/);
  assert.match(response.stdout, /\bcleanup\b/);
  assert.match(response.stdout, /\bexport\b/);
  assert.match(response.stdout, /\brerun\b/);
  assert.match(response.stdout, /--with-result/);
  assert.match(response.stdout, /cancel .*--all/);
  assert.match(response.stdout, /--all-sessions/);
});
