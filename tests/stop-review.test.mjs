import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { COMPANION, fakeGrokEnv, initRepo, PLUGIN_ROOT, run, tempDir } from "./helpers.mjs";
import {
  parseStopReviewDecision,
  validateStopReviewResult
} from "../plugins/grok/scripts/lib/stop-review.mjs";

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
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

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
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const response = run(process.execPath, [STOP_REVIEW_HOOK], {
    cwd: repo,
    env,
    input: JSON.stringify({ cwd: repo, session_id: "clean-session", last_assistant_message: "" })
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
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
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
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
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
