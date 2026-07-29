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
  assert.equal(waited.status, 0, waited.stderr);
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

  const hooklessEnv = fakeGrokEnv(state);
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
