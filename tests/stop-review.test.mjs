import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { COMPANION, fakeGrokEnv, initRepo, PLUGIN_ROOT, removeTempDir, run, tempDir } from "./helpers.mjs";
import {
  parseStopReviewDecision,
  validateStopReviewResult
} from "../plugins/grok/scripts/lib/stop-review.mjs";
import { saveState, writeJobFile } from "../plugins/grok/scripts/lib/state.mjs";

const STOP_REVIEW_HOOK = path.join(PLUGIN_ROOT, "scripts", "stop-review-gate-hook.mjs");
const STOP_REVIEW_SCHEMA = JSON.parse(
  fs.readFileSync(path.join(PLUGIN_ROOT, "schemas", "stop-review-output.schema.json"), "utf8")
);

function runCompanion(args, options) {
  return run(process.execPath, [COMPANION, ...args], options);
}

function enableGate(repo, env) {
  const result = runCompanion(["setup", "--enable-review-gate", "--json", "--cwd", repo], {
    cwd: repo,
    env
  });
  assert.equal(result.status, 0, result.stderr);
}

test("stop-review schema and validator enforce the compact decision shape", () => {
  assert.deepEqual(STOP_REVIEW_SCHEMA.required, ["decision", "reason"]);
  assert.deepEqual(STOP_REVIEW_SCHEMA.properties.decision.enum, ["allow", "block"]);
  assert.equal(STOP_REVIEW_SCHEMA.properties.reason.minLength, 1);
  assert.equal(STOP_REVIEW_SCHEMA.additionalProperties, false);
  assert.equal(validateStopReviewResult({ decision: "allow", reason: "Clean." }), null);
  assert.match(validateStopReviewResult({ decision: "allow", reason: "", extra: true }), /Unexpected/);
});

test("stop-review parser prioritizes structured allow and block decisions", () => {
  assert.deepEqual(
    parseStopReviewDecision({ decision: "allow", reason: "No issue." }, "BLOCK: ignored"),
    { allow: true, reason: "No issue.", source: "structured" }
  );
  assert.deepEqual(
    parseStopReviewDecision({ decision: "block", reason: "Fix the regression." }, "ALLOW: ignored"),
    { allow: false, reason: "Fix the regression.", source: "structured" }
  );
});

test("stop-review parser remains compatible with legacy first-line decisions", () => {
  assert.equal(parseStopReviewDecision(null, "ALLOW: no edits\nextra").allow, true);
  const blocked = parseStopReviewDecision(null, "BLOCK: add the missing test\nextra");
  assert.equal(blocked.allow, false);
  assert.equal(blocked.reason, "add the missing test");
});

test("task --stop-review uses the stop schema and read-only sandbox", (t) => {
  const root = tempDir();
  const repo = path.join(root, "repo");
  const capture = path.join(root, "capture.json");
  fs.mkdirSync(repo);
  initRepo(repo);
  const env = fakeGrokEnv(path.join(root, "state"), { FAKE_GROK_CAPTURE: capture });
  t.after(() => removeTempDir(root));

  const response = runCompanion(
    ["task", "--stop-review", "--json", "--cwd", repo, "review the previous edit"],
    { cwd: repo, env }
  );
  assert.equal(response.status, 0, response.stderr);
  const payload = JSON.parse(response.stdout);
  assert.deepEqual(payload.result, {
    decision: "allow",
    reason: "No blocking issue was introduced in the previous turn."
  });
  assert.equal(payload.parseError, null);
  assert.equal(payload.write, false);
  const captured = JSON.parse(fs.readFileSync(capture, "utf8"));
  assert.equal(captured.sandbox, "read-only");
  assert.equal(captured.outputFormat, null);
  assert.deepEqual(JSON.parse(captured.jsonSchema), STOP_REVIEW_SCHEMA);
  assert.ok(captured.args.includes("read_file,grep,list_dir"));
  assert.ok(!captured.args.includes("--always-approve"));
});

test("enabled hook short-circuits an empty message in a clean working tree", (t) => {
  const root = tempDir();
  const repo = path.join(root, "repo");
  const capture = path.join(root, "capture.json");
  fs.mkdirSync(repo);
  initRepo(repo);
  const env = fakeGrokEnv(path.join(root, "state"), { FAKE_GROK_CAPTURE: capture });
  enableGate(repo, env);
  t.after(() => removeTempDir(root));

  const response = run(process.execPath, [STOP_REVIEW_HOOK], {
    cwd: repo,
    env,
    input: JSON.stringify({ cwd: repo, session_id: "clean-session", last_assistant_message: "" })
  });
  assert.equal(response.status, 0, response.stderr);
  assert.equal(response.stdout, "");
  assert.equal(fs.existsSync(capture), false);
});

test("enabled hook short-circuits status turns when the working tree is clean", (t) => {
  const root = tempDir();
  const repo = path.join(root, "repo");
  const capture = path.join(root, "capture.json");
  fs.mkdirSync(repo);
  initRepo(repo);
  const env = fakeGrokEnv(path.join(root, "state"), { FAKE_GROK_CAPTURE: capture });
  enableGate(repo, env);
  t.after(() => removeTempDir(root));

  const response = run(process.execPath, [STOP_REVIEW_HOOK], {
    cwd: repo,
    env,
    input: JSON.stringify({
      cwd: repo,
      session_id: "status-session",
      last_assistant_message: "Setup looks good. No file edits were made."
    })
  });
  assert.equal(response.status, 0, response.stderr);
  assert.equal(response.stdout, "");
  assert.equal(fs.existsSync(capture), false);
});

test("enabled hook short-circuits outside a git repository", (t) => {
  const root = tempDir();
  const capture = path.join(root, "capture.json");
  const env = fakeGrokEnv(path.join(root, "state"), { FAKE_GROK_CAPTURE: capture });
  // Enable gate against a fake workspace path under state root by writing config via companion on a git repo first.
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  initRepo(repo);
  enableGate(repo, env);
  t.after(() => removeTempDir(root));

  const nonGit = path.join(root, "plain");
  fs.mkdirSync(nonGit);
  // Copy gate config into the non-git workspace state bucket by enabling there after forcing a state dir write:
  // The hook reads config for resolveWorkspaceRoot(nonGit). Enable by writing companion state for that path.
  enableGate(nonGit, env);

  const response = run(process.execPath, [STOP_REVIEW_HOOK], {
    cwd: nonGit,
    env,
    input: JSON.stringify({
      cwd: nonGit,
      session_id: "nongit-session",
      last_assistant_message: "Just chatting."
    })
  });
  assert.equal(response.status, 0, response.stderr);
  assert.equal(response.stdout, "");
  assert.equal(fs.existsSync(capture), false);
});

test("enabled hook emits structured blocks and fails closed on invalid output", (t) => {
  const root = tempDir();
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  initRepo(repo);
  fs.writeFileSync(path.join(repo, "app.js"), "export const value = 2;\n", "utf8");
  const state = path.join(root, "state");
  const baseEnv = fakeGrokEnv(state);
  enableGate(repo, baseEnv);
  t.after(() => removeTempDir(root));
  const input = JSON.stringify({
    cwd: repo,
    session_id: "edit-session",
    last_assistant_message: "Updated app.js and ran its focused test."
  });

  const blocked = run(process.execPath, [STOP_REVIEW_HOOK], {
    cwd: repo,
    env: {
      ...baseEnv,
      FAKE_GROK_OUTPUT: JSON.stringify({ decision: "block", reason: "The edit breaks value consumers." })
    },
    input
  });
  assert.equal(blocked.status, 0, blocked.stderr);
  assert.deepEqual(JSON.parse(blocked.stdout), {
    decision: "block",
    reason: "The edit breaks value consumers."
  });

  const invalid = run(process.execPath, [STOP_REVIEW_HOOK], {
    cwd: repo,
    env: { ...baseEnv, FAKE_GROK_OUTPUT: "not-json" },
    input
  });
  assert.equal(invalid.status, 0, invalid.stderr);
  const invalidDecision = JSON.parse(invalid.stdout);
  assert.equal(invalidDecision.decision, "block");
  assert.match(invalidDecision.reason, /\/grok:review --wait manually/);
});

test("enabled hook accepts legacy allow and block output after schema parsing fails", (t) => {
  const root = tempDir();
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  initRepo(repo);
  fs.writeFileSync(path.join(repo, "app.js"), "export const value = 3;\n", "utf8");
  const baseEnv = fakeGrokEnv(path.join(root, "state"));
  enableGate(repo, baseEnv);
  t.after(() => removeTempDir(root));
  const input = JSON.stringify({
    cwd: repo,
    session_id: "legacy-session",
    last_assistant_message: "Updated app.js."
  });

  const allowed = run(process.execPath, [STOP_REVIEW_HOOK], {
    cwd: repo,
    env: { ...baseEnv, FAKE_GROK_OUTPUT: "ALLOW: legacy reviewer approved" },
    input
  });
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.equal(allowed.stdout, "");

  const blocked = run(process.execPath, [STOP_REVIEW_HOOK], {
    cwd: repo,
    env: { ...baseEnv, FAKE_GROK_OUTPUT: "BLOCK: legacy reviewer found a regression" },
    input
  });
  assert.equal(blocked.status, 0, blocked.stderr);
  assert.deepEqual(JSON.parse(blocked.stdout), {
    decision: "block",
    reason: "legacy reviewer found a regression"
  });
});

test("enabled hook fails closed when Grok is unavailable", (t) => {
  const root = tempDir();
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  initRepo(repo);
  fs.writeFileSync(path.join(repo, "app.js"), "export const value = 4;\n", "utf8");
  const baseEnv = fakeGrokEnv(path.join(root, "state"), {
    GROK_COMPANION_GROK_BINARY: path.join(root, "missing-grok-binary")
  });
  // enableGate needs a working binary; use real fake first, then point at missing.
  enableGate(repo, fakeGrokEnv(path.join(root, "state")));
  t.after(() => removeTempDir(root));

  const response = run(process.execPath, [STOP_REVIEW_HOOK], {
    cwd: repo,
    env: baseEnv,
    input: JSON.stringify({
      cwd: repo,
      session_id: "unavailable-session",
      last_assistant_message: "Edited app.js."
    })
  });
  assert.equal(response.status, 0, response.stderr);
  const decision = JSON.parse(response.stdout);
  assert.equal(decision.decision, "block");
  assert.match(decision.reason, /skipped: unavailable/);
  assert.match(decision.reason, /\/grok:setup/);
});

test("enabled hook can fail open on unavailable Grok when explicitly opted in", (t) => {
  const root = tempDir();
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  initRepo(repo);
  fs.writeFileSync(path.join(repo, "app.js"), "export const value = 5;\n", "utf8");
  enableGate(repo, fakeGrokEnv(path.join(root, "state")));
  t.after(() => removeTempDir(root));

  const response = run(process.execPath, [STOP_REVIEW_HOOK], {
    cwd: repo,
    env: fakeGrokEnv(path.join(root, "state"), {
      GROK_COMPANION_GROK_BINARY: path.join(root, "missing-grok-binary"),
      GROK_COMPANION_STOP_REVIEW_FAIL_OPEN: "1"
    }),
    input: JSON.stringify({
      cwd: repo,
      session_id: "fail-open-session",
      last_assistant_message: "Edited app.js."
    })
  });
  assert.equal(response.status, 0, response.stderr);
  assert.equal(response.stdout, "");
  assert.match(response.stderr, /skipped: unavailable/);
});

test("enabled hook fails closed on ETIMEDOUT from the review subprocess", (t) => {
  const root = tempDir();
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  initRepo(repo);
  fs.writeFileSync(path.join(repo, "app.js"), "export const value = 6;\n", "utf8");
  const baseEnv = fakeGrokEnv(path.join(root, "state"));
  enableGate(repo, baseEnv);
  t.after(() => removeTempDir(root));

  // Short gate timeout + slow fake Grok → spawnSync ETIMEDOUT → fail-closed block.
  const response = run(process.execPath, [STOP_REVIEW_HOOK], {
    cwd: repo,
    env: {
      ...baseEnv,
      GROK_COMPANION_STOP_REVIEW_TIMEOUT_MS: "800",
      FAKE_GROK_DELAY_MS: "10000"
    },
    input: JSON.stringify({
      cwd: repo,
      session_id: "timeout-session",
      last_assistant_message: "Edited app.js."
    }),
    timeout: 15_000
  });
  assert.equal(response.status, 0, response.stderr);
  const decision = JSON.parse(response.stdout);
  assert.equal(decision.decision, "block");
  assert.match(decision.reason, /timed out/);
  assert.match(decision.reason, /\/grok:review --wait manually/);
});

test("enabled hook prepends active job note when blocking a dirty tree", (t) => {
  const root = tempDir();
  const repo = path.join(root, "repo");
  const stateHome = path.join(root, "state");
  fs.mkdirSync(repo);
  initRepo(repo);
  fs.writeFileSync(path.join(repo, "app.js"), "export const value = 7;\n", "utf8");
  const baseEnv = fakeGrokEnv(stateHome);
  enableGate(repo, baseEnv);
  const previousHome = process.env.GROK_COMPANION_HOME;
  process.env.GROK_COMPANION_HOME = stateHome;
  t.after(() => {
    if (previousHome === undefined) {
      delete process.env.GROK_COMPANION_HOME;
    } else {
      process.env.GROK_COMPANION_HOME = previousHome;
    }
    removeTempDir(root);
  });

  const job = {
    id: "task-active-note",
    kind: "task",
    status: "running",
    phase: "tool",
    claudeSessionId: "active-note-session",
    cwd: repo,
    workspaceRoot: repo,
    updatedAt: "2026-07-29T12:00:00.000Z"
  };
  writeJobFile(repo, job.id, job);
  saveState(repo, { config: { stopReviewGate: true }, jobs: [job] });

  const blocked = run(process.execPath, [STOP_REVIEW_HOOK], {
    cwd: repo,
    env: {
      ...baseEnv,
      FAKE_GROK_OUTPUT: JSON.stringify({ decision: "block", reason: "Missing regression test." })
    },
    input: JSON.stringify({
      cwd: repo,
      session_id: "active-note-session",
      last_assistant_message: "Updated app.js."
    })
  });
  assert.equal(blocked.status, 0, blocked.stderr);
  const decision = JSON.parse(blocked.stdout);
  assert.equal(decision.decision, "block");
  assert.match(decision.reason, /Grok job task-active-note is still running/);
  assert.match(decision.reason, /Missing regression test/);
});
