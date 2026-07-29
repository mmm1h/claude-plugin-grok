import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { buildGrokArgs, getGrokAuthStatus, runGrokHeadless } from "../plugins/grok/scripts/lib/grok.mjs";
import { FAKE_GROK, tempDir } from "./helpers.mjs";

test("read-only Grok argv uses plan mode and a strict tool allowlist", () => {
  const { args, sessionId } = buildGrokArgs({
    prompt: "review",
    sessionId: "11111111-1111-4111-8111-111111111111",
    write: false
  });
  assert.equal(sessionId, "11111111-1111-4111-8111-111111111111");
  assert.deepEqual(args.slice(-2), ["-p", "review"]);
  assert.ok(args.includes("plan"));
  assert.ok(args.includes("read_file,grep,list_dir"));
  assert.ok(args.includes("--no-subagents"));
  assert.ok(args.includes("--disable-web-search"));
  assert.ok(!args.includes("--always-approve"));
  assert.ok(!args.includes("bypassPermissions"));
});

test("write-capable Grok argv enables explicit bypass flags", () => {
  const { args } = buildGrokArgs({
    prompt: "implement",
    write: true,
    model: "grok-code",
    effort: "high",
    sessionId: "22222222-2222-4222-8222-222222222222"
  });
  assert.ok(args.includes("--always-approve"));
  assert.ok(args.includes("bypassPermissions"));
  assert.ok(args.includes("grok-code"));
  assert.ok(args.includes("high"));
  assert.ok(!args.includes("--tools"));
});

test("runGrokHeadless spawns a fake binary and moves long prompts to a file", async (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const capture = path.join(dir, "capture.json");
  const progress = [];
  const prompt = "large prompt\n".repeat(1000);
  const result = await runGrokHeadless({
    cwd: dir,
    prompt,
    write: false,
    binary: process.execPath,
    binaryPrefixArgs: [FAKE_GROK],
    env: { ...process.env, FAKE_GROK_CAPTURE: capture },
    onProgress: (line) => progress.push(line),
    timeoutMs: 10_000
  });
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /FAKE_GROK_OK/);
  assert.ok(result.sessionId);
  assert.ok(progress.includes("fake grok progress"));
  const captured = JSON.parse(fs.readFileSync(capture, "utf8"));
  assert.equal(captured.prompt, prompt);
  assert.ok(captured.args.includes("--prompt-file"));
  assert.ok(!fs.existsSync(captured.promptFile), "temporary prompt file is cleaned after spawn");
});

test("getGrokAuthStatus avoids a probe and reports local evidence", (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.equal(getGrokAuthStatus(dir, { grokHome: dir, env: {} }).status, "needs_login");
  fs.writeFileSync(path.join(dir, "config.toml"), "[model]\n", "utf8");
  assert.equal(getGrokAuthStatus(dir, { grokHome: dir, env: {} }).status, "unknown");
  assert.equal(getGrokAuthStatus(dir, { grokHome: dir, env: { GROK_API_KEY: "present" } }).status, "configured");
});

test("runGrokHeadless terminates fake Grok when output exceeds the cap", async (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  await assert.rejects(
    runGrokHeadless({
      cwd: dir,
      prompt: "test output cap",
      write: false,
      binary: process.execPath,
      binaryPrefixArgs: [FAKE_GROK],
      env: { ...process.env, FAKE_GROK_OUTPUT: "x".repeat(1024) },
      maxOutputBytes: 64,
      timeoutMs: 10_000
    }),
    /output exceeded 64 bytes/
  );
});
