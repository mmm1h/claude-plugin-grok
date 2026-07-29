import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { COMPANION, fakeGrokEnv, initRepo, PLUGIN_ROOT, ROOT, run, tempDir } from "./helpers.mjs";

const commandDir = path.join(PLUGIN_ROOT, "commands");
const SESSION_HOOK = path.join(PLUGIN_ROOT, "scripts", "session-lifecycle-hook.mjs");

function runCompanion(args, options) {
  return run(process.execPath, [COMPANION, ...args], options);
}

function listFiles(dir, prefix = "") {
  const values = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const relative = path.join(prefix, entry.name);
    if (entry.isDirectory()) {
      values.push(...listFiles(path.join(dir, entry.name), relative));
    } else {
      values.push(relative);
    }
  }
  return values;
}

test("all public commands exist with basic Claude Code frontmatter", () => {
  const expected = [
    "adversarial-review.md",
    "cancel.md",
    "cleanup.md",
    "export.md",
    "logs.md",
    "rerun.md",
    "rescue.md",
    "result.md",
    "review.md",
    "setup.md",
    "status.md",
    "transfer.md"
  ];
  assert.deepEqual(fs.readdirSync(commandDir).sort(), expected);
  for (const file of expected) {
    const source = fs.readFileSync(path.join(commandDir, file), "utf8");
    assert.match(source, /^---\r?\n/);
    assert.match(source, /\ndescription:/);
    assert.match(source, /CLAUDE_PLUGIN_ROOT/);
    assert.doesNotMatch(source, /codex-companion|\/codex:/i);
  }
});

test("review commands preserve read-only and background UX contracts", () => {
  for (const file of ["review.md", "adversarial-review.md"]) {
    const source = fs.readFileSync(path.join(commandDir, file), "utf8");
    assert.match(source, /AskUserQuestion/);
    assert.match(source, /review-only/);
    assert.match(source, /verbatim/);
    assert.match(source, /run_in_background:\s*true/);
    assert.match(source, /Do not call `BashOutput`/);
    assert.match(source, /\(Recommended\)/);
  }
});

test("rescue uses the named subagent and one companion task call", () => {
  const command = fs.readFileSync(path.join(commandDir, "rescue.md"), "utf8");
  const agent = fs.readFileSync(path.join(PLUGIN_ROOT, "agents", "grok-rescue.md"), "utf8");
  assert.match(command, /subagent_type: "grok:grok-rescue"/);
  assert.match(command, /task-resume-candidate --json/);
  assert.match(command, /Continue current Grok session/);
  assert.match(agent, /Use exactly one Bash call/);
  assert.match(agent, /write-capable/);
});

test("manifests and hooks identify a valid grok plugin", () => {
  const marketplace = JSON.parse(fs.readFileSync(path.join(ROOT, ".claude-plugin", "marketplace.json"), "utf8"));
  const plugin = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, ".claude-plugin", "plugin.json"), "utf8"));
  const hooks = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, "hooks", "hooks.json"), "utf8"));
  assert.equal(marketplace.name, "claude-plugin-grok");
  assert.equal(marketplace.plugins[0].name, "grok");
  assert.equal(marketplace.plugins[0].source, "./plugins/grok");
  assert.equal(plugin.name, "grok");
  assert.ok(hooks.hooks.SessionStart);
  assert.ok(hooks.hooks.SessionEnd);
  assert.ok(hooks.hooks.Stop);
});

test("runtime contains no forbidden Codex app-server or package dependency", () => {
  const packageJson = fs.readFileSync(path.join(ROOT, "package.json"), "utf8");
  const scripts = listFiles(path.join(PLUGIN_ROOT, "scripts"))
    .filter((entry) => entry.endsWith(".mjs"));
  assert.doesNotMatch(packageJson, /@openai\/codex|app-server|generate-ts/);
  for (const relative of scripts) {
    const source = fs.readFileSync(path.join(PLUGIN_ROOT, "scripts", relative), "utf8");
    assert.doesNotMatch(source, /app-server|JSON-RPC|codex\.mjs/i);
  }
});

test("adversarial-review CLI loads the adversarial template with read-only sandbox", (t) => {
  const root = tempDir();
  const repo = path.join(root, "repo");
  const state = path.join(root, "state");
  fs.mkdirSync(repo);
  initRepo(repo);
  fs.writeFileSync(path.join(repo, "app.js"), "export const value = 42;\n", "utf8");
  const capture = path.join(root, "capture.json");
  const env = fakeGrokEnv(state, { FAKE_GROK_CAPTURE: capture });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const result = runCompanion(
    ["adversarial-review", "--wait", "--json", "--cwd", repo, "focus on race conditions"],
    { env, cwd: repo }
  );
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.exitCode, 0);
  assert.equal(payload.result.verdict, "approve");
  assert.equal(payload.parseError, null);

  const captured = JSON.parse(fs.readFileSync(capture, "utf8"));
  assert.equal(captured.sandbox, "read-only");
  assert.ok(captured.args.includes("read_file,grep,list_dir"));
  assert.ok(!captured.args.includes("--always-approve"));
  assert.match(captured.prompt, /adversarial/i);
  assert.match(captured.prompt, /race conditions/);
  assert.match(captured.prompt, /attack_surface|strongest evidence|should not ship/i);

  const status = runCompanion(["status", "--json", "--all", "--cwd", repo], { env, cwd: repo });
  assert.equal(status.status, 0, status.stderr);
  const snapshot = JSON.parse(status.stdout);
  assert.equal(snapshot.jobs[0].kind, "adversarial-review");
  assert.equal(snapshot.jobs[0].status, "completed");
});

test("review CLI fails closed when structured JSON fails schema validation", (t) => {
  const root = tempDir();
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  initRepo(repo);
  fs.writeFileSync(path.join(repo, "app.js"), "export const value = 3;\n", "utf8");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const emptySummary = {
    verdict: "approve",
    summary: "",
    findings: [],
    next_steps: []
  };
  const emptyEnv = fakeGrokEnv(path.join(root, "state-empty"), {
    FAKE_GROK_OUTPUT: JSON.stringify(emptySummary)
  });
  const emptyResponse = runCompanion(["review", "--wait", "--json", "--cwd", repo], {
    env: emptyEnv,
    cwd: repo
  });
  assert.equal(emptyResponse.status, 1, emptyResponse.stderr);
  const emptyPayload = JSON.parse(emptyResponse.stdout);
  assert.equal(emptyPayload.exitCode, 1);
  assert.match(emptyPayload.parseError, /validation/i);
  assert.match(emptyPayload.parseError, /summary/i);

  const badSeverity = {
    verdict: "needs-attention",
    summary: "found something",
    findings: [
      {
        severity: "catastrophic",
        title: "bad severity",
        body: "severity is not in the enum",
        file: "app.js",
        line_start: 1,
        line_end: 1,
        confidence: 0.9,
        recommendation: "use a valid severity"
      }
    ],
    next_steps: ["fix severity"]
  };
  const severityEnv = fakeGrokEnv(path.join(root, "state-severity"), {
    FAKE_GROK_OUTPUT: JSON.stringify(badSeverity)
  });
  const severityResponse = runCompanion(["review", "--wait", "--json", "--cwd", repo], {
    env: severityEnv,
    cwd: repo
  });
  assert.equal(severityResponse.status, 1, severityResponse.stderr);
  const severityPayload = JSON.parse(severityResponse.stdout);
  assert.equal(severityPayload.exitCode, 1);
  assert.match(severityPayload.parseError, /validation/i);
  assert.match(severityPayload.parseError, /severity/i);
});

test("SessionStart writes CLAUDE_ENV_FILE exports with correct shell escaping", (t) => {
  const root = tempDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const envFile = path.join(root, "claude-env.sh");
  fs.writeFileSync(envFile, "", "utf8");

  const sessionId = "sess-with-'quote' and 中文";
  const transcriptPath = path.join(root, "path with spaces", "transcript's.jsonl");

  const response = run(process.execPath, [SESSION_HOOK, "SessionStart"], {
    cwd: root,
    env: {
      ...process.env,
      CLAUDE_ENV_FILE: envFile
    },
    input: JSON.stringify({
      session_id: sessionId,
      transcript_path: transcriptPath,
      hook_event_name: "SessionStart"
    })
  });
  assert.equal(response.status, 0, response.stderr);
  const written = fs.readFileSync(envFile, "utf8");
  assert.match(written, /export GROK_COMPANION_CLAUDE_SESSION_ID=/);
  assert.match(written, /export GROK_COMPANION_TRANSCRIPT_PATH=/);

  // Values must be single-quoted bash strings; embedded single quotes use '"'"' form.
  assert.match(
    written,
    /export GROK_COMPANION_CLAUDE_SESSION_ID='sess-with-'"'"'quote'"'"' and 中文'/
  );
  assert.ok(written.includes("export GROK_COMPANION_TRANSCRIPT_PATH="));
  // Reconstruct expected escape for transcript path.
  const expectedTranscript = `'${transcriptPath.replace(/'/g, `'\"'\"'`)}'`;
  assert.ok(
    written.includes(`export GROK_COMPANION_TRANSCRIPT_PATH=${expectedTranscript}`),
    `expected escaped transcript export, got:\n${written}`
  );
});

test("status --json defaults to the current Claude session and --all shows every job", (t) => {
  const root = tempDir();
  const repo = path.join(root, "repo");
  const state = path.join(root, "state");
  fs.mkdirSync(repo);
  initRepo(repo);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const envA = fakeGrokEnv(state, { GROK_COMPANION_CLAUDE_SESSION_ID: "claude-status-a" });
  const envB = fakeGrokEnv(state, { GROK_COMPANION_CLAUDE_SESSION_ID: "claude-status-b" });

  const taskA = runCompanion(["task", "--json", "--cwd", repo, "status session a"], {
    env: envA,
    cwd: repo
  });
  assert.equal(taskA.status, 0, taskA.stderr);
  const jobA = JSON.parse(taskA.stdout).jobId ?? JSON.parse(taskA.stdout).id;
  // Foreground task JSON may expose sessionId/exitCode rather than jobId — re-read via status --all.
  const taskB = runCompanion(["task", "--json", "--cwd", repo, "status session b"], {
    env: envB,
    cwd: repo
  });
  assert.equal(taskB.status, 0, taskB.stderr);

  const filteredA = runCompanion(["status", "--json", "--cwd", repo], { env: envA, cwd: repo });
  assert.equal(filteredA.status, 0, filteredA.stderr);
  const snapshotA = JSON.parse(filteredA.stdout);
  assert.ok(snapshotA.jobs.length >= 1);
  assert.ok(snapshotA.jobs.every((job) => job.claudeSessionId === "claude-status-a"));
  assert.ok(snapshotA.jobs.some((job) => /status session a/.test(job.summary ?? "")));

  const filteredB = runCompanion(["status", "--json", "--cwd", repo], { env: envB, cwd: repo });
  assert.equal(filteredB.status, 0, filteredB.stderr);
  const snapshotB = JSON.parse(filteredB.stdout);
  assert.ok(snapshotB.jobs.every((job) => job.claudeSessionId === "claude-status-b"));
  assert.ok(snapshotB.jobs.some((job) => /status session b/.test(job.summary ?? "")));

  const all = runCompanion(["status", "--all", "--json", "--cwd", repo], { env: envA, cwd: repo });
  assert.equal(all.status, 0, all.stderr);
  const snapshotAll = JSON.parse(all.stdout);
  const sessionIds = new Set(snapshotAll.jobs.map((job) => job.claudeSessionId));
  assert.ok(sessionIds.has("claude-status-a"));
  assert.ok(sessionIds.has("claude-status-b"));
  assert.ok(snapshotAll.jobs.length >= 2);
  // Silence unused if jobA shape differs across payload forms.
  void jobA;
});
