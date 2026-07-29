import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { COMPANION, fakeGrokEnv, initRepo, run, tempDir } from "./helpers.mjs";

function runCompanion(args, options) {
  return run(process.execPath, [COMPANION, ...args], options);
}

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
  assert.match(payload.rawOutput, /FAKE_GROK_OK/);
  const captured = JSON.parse(fs.readFileSync(capture, "utf8"));
  assert.ok(captured.args.includes("plan"));
  assert.ok(captured.args.includes("read_file,grep,list_dir"));

  const status = runCompanion(["status", "--json", "--all", "--cwd", repo], { env, cwd: repo });
  const snapshot = JSON.parse(status.stdout);
  assert.equal(snapshot.jobs[0].kind, "review");
  assert.equal(snapshot.jobs[0].status, "completed");
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
  const job = JSON.parse(waited.stdout).job;
  assert.equal(job.status, "completed");
  const result = runCompanion(["result", jobId, "--json", "--cwd", repo], { env, cwd: repo });
  assert.equal(result.status, 0, result.stderr);
  const stored = JSON.parse(result.stdout);
  assert.equal(stored.result.write, true);
  assert.match(stored.result.rawOutput, /FAKE_GROK_OK/);
  assert.ok(stored.sessionId);
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
  assert.equal(JSON.parse(status.stdout).job.status, "cancelled");
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
  assert.ok(payload.sessionId);
  const captured = JSON.parse(fs.readFileSync(capture, "utf8"));
  assert.match(captured.prompt, /lossy handoff/);
  assert.match(captured.prompt, /Investigate the regression/);
  assert.ok(captured.args.includes("read_file,grep,list_dir"));
});
