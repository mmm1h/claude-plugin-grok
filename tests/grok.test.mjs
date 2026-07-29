import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  buildGrokArgs,
  findLatestTaskSession,
  getGrokAuthStatus,
  getGrokCapabilities,
  normalizeGrokStreamingEvent,
  parseGrokStructuredOutput,
  runGrokHeadless
} from "../plugins/grok/scripts/lib/grok.mjs";
import { renderTaskResult } from "../plugins/grok/scripts/lib/render.mjs";
import { FAKE_GROK, tempDir } from "./helpers.mjs";

test("findLatestTaskSession returns no candidate without Claude session scope", () => {
  const previous = process.env.GROK_COMPANION_CLAUDE_SESSION_ID;
  process.env.GROK_COMPANION_CLAUDE_SESSION_ID = "ambient-parent-session";
  try {
    assert.equal(findLatestTaskSession(process.cwd(), { env: {} }), null);
  } finally {
    if (previous === undefined) {
      delete process.env.GROK_COMPANION_CLAUDE_SESSION_ID;
    } else {
      process.env.GROK_COMPANION_CLAUDE_SESSION_ID = previous;
    }
  }
});

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
  assert.deepEqual(args.slice(args.indexOf("--sandbox"), args.indexOf("--sandbox") + 2), ["--sandbox", "read-only"]);
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
  assert.ok(!args.includes("--sandbox"));
});

test("structured Grok argv passes the schema without forcing plain output", () => {
  const schema = { type: "object" };
  const { args } = buildGrokArgs({ prompt: "review", write: false, jsonSchema: schema });
  assert.equal(args[args.indexOf("--json-schema") + 1], JSON.stringify(schema));
  assert.ok(!args.includes("--output-format"));
  assert.equal(args[args.indexOf("--sandbox") + 1], "read-only");
});

test("parseGrokStructuredOutput accepts direct payloads and common CLI envelopes", () => {
  const payload = { verdict: "approve", summary: "ok", findings: [], next_steps: [] };
  assert.deepEqual(parseGrokStructuredOutput(JSON.stringify(payload)).data, payload);
  assert.deepEqual(
    parseGrokStructuredOutput(JSON.stringify({ result: JSON.stringify(payload) })).data,
    payload
  );
  const invalid = parseGrokStructuredOutput("not json");
  assert.equal(invalid.ok, false);
  assert.equal(invalid.raw, "not json");
  assert.match(invalid.parseError, /JSON|complete JSON/i);
});

test("parseGrokStructuredOutput prefers the last object when multi-turn outputs are concatenated", () => {
  const intermediate = {
    verdict: "approve",
    summary: "partial",
    findings: [],
    next_steps: []
  };
  const finalPayload = {
    verdict: "needs-attention",
    summary: "found bugs",
    findings: [
      {
        severity: "high",
        title: "assignment in condition",
        body: "if (x = 1)",
        file: "a.js",
        line_start: 1,
        line_end: 1,
        confidence: 0.98,
        recommendation: "use ==="
      }
    ],
    next_steps: ["fix comparisons"]
  };
  const concatenated = `${JSON.stringify(intermediate)}${JSON.stringify(finalPayload)}`;
  const parsed = parseGrokStructuredOutput(concatenated);
  assert.equal(parsed.ok, true, parsed.parseError);
  assert.equal(parsed.data.verdict, "needs-attention");
  assert.equal(parsed.data.findings.length, 1);
  assert.equal(parsed.data.findings[0].title, "assignment in condition");

  const spaced = `${JSON.stringify(intermediate)}\n${JSON.stringify(finalPayload)}\n`;
  assert.equal(parseGrokStructuredOutput(spaced).data.verdict, "needs-attention");

  const enveloped = parseGrokStructuredOutput(JSON.stringify({
    text: concatenated,
    stopReason: "EndTurn"
  }));
  assert.equal(enveloped.ok, true, enveloped.parseError);
  assert.deepEqual(enveloped.data, finalPayload);
});

test("getGrokCapabilities detects structured output and sandbox flags", () => {
  const capabilities = getGrokCapabilities(process.cwd(), {
    binary: process.execPath,
    binaryPrefixArgs: [FAKE_GROK]
  });
  assert.equal(capabilities.available, true);
  assert.equal(capabilities.jsonSchema, true);
  assert.equal(capabilities.sandbox, true);
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

test("streaming-json telemetry confirms the session and preserves readable final output", async (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const telemetry = [];
  const progress = [];
  const sessionId = "55555555-5555-4555-8555-555555555555";
  const result = await runGrokHeadless({
    cwd: dir,
    prompt: "stream this task",
    write: true,
    sessionId,
    outputFormat: "streaming-json",
    binary: process.execPath,
    binaryPrefixArgs: [FAKE_GROK],
    env: {
      ...process.env,
      FAKE_GROK_MALFORMED_EVENT: "1",
      FAKE_GROK_UNKNOWN_EVENT: "1"
    },
    onTelemetry: (event) => telemetry.push(event),
    onProgress: (line) => progress.push(line),
    timeoutMs: 10_000
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "FAKE_GROK_OK");
  assert.match(result.rawStdout, /\"type\":\"result\"/);
  assert.equal(result.sessionId, sessionId);
  assert.equal(result.sessionConfirmed, true);
  assert.ok(telemetry.some((event) => event.phase === "tool"));
  assert.ok(progress.some((line) => /Unparsed streaming output/.test(line)));
  assert.ok(progress.some((line) => /Unknown streaming event type:/.test(line)));
  assert.ok(!progress.some((line) => line.includes("\"type\"")));
});

test("streaming thought/text/end events do not leak raw tokens into progress", async (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const progress = [];
  const telemetry = [];
  const sessionId = "77777777-7777-4777-8777-777777777777";
  const stream = [
    JSON.stringify({ type: "thought", text: "I am thinking token by token about secrets" }),
    JSON.stringify({ type: "thought", text: "more reasoning" }),
    JSON.stringify({ type: "text", text: "PING" }),
    JSON.stringify({ type: "end" }),
    JSON.stringify({ type: "result", result: "PING" })
  ].join("\n");
  const result = await runGrokHeadless({
    cwd: dir,
    prompt: "ping",
    write: true,
    sessionId,
    outputFormat: "streaming-json",
    binary: process.execPath,
    binaryPrefixArgs: [FAKE_GROK],
    env: {
      ...process.env,
      FAKE_GROK_STREAM: stream
    },
    onTelemetry: (event) => telemetry.push(event),
    onProgress: (line) => progress.push(line),
    timeoutMs: 10_000
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "PING");
  assert.ok(telemetry.some((event) => event.phase === "reasoning"));
  assert.ok(telemetry.some((event) => event.eventType === "text"));
  assert.ok(!progress.some((line) => /thinking token|more reasoning|secrets/i.test(line)));
  assert.ok(!progress.some((line) => /Unknown streaming event/.test(line) && line.includes("thought")));
});

test("streaming text data fragments become final output without raw JSON fallback", async (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sessionId = "88888888-8888-4888-8888-888888888888";
  const stream = [
    JSON.stringify({ type: "thought", data: "private reasoning" }),
    JSON.stringify({ type: "text", data: "Hello, " }),
    JSON.stringify({ type: "text", data: "world!" }),
    JSON.stringify({ type: "end", data: { sessionId, usage: { outputTokens: 2 } } })
  ].join("\n");
  const result = await runGrokHeadless({
    cwd: dir,
    prompt: "stream text fragments",
    write: true,
    outputFormat: "streaming-json",
    binary: process.execPath,
    binaryPrefixArgs: [FAKE_GROK],
    env: { ...process.env, FAKE_GROK_STREAM: stream },
    timeoutMs: 10_000
  });

  assert.equal(result.stdout, "Hello, world!");
  assert.equal(result.sessionId, sessionId);
  assert.equal(result.sessionConfirmed, true);
  assert.match(result.rawStdout, /\"type\":\"thought\"/);
  assert.doesNotMatch(result.stdout, /\"type\":/);
  const rendered = renderTaskResult({
    exitCode: result.exitCode,
    sessionId: result.sessionId,
    sessionConfirmed: result.sessionConfirmed,
    rawOutput: result.stdout,
    stderr: result.stderr
  });
  assert.match(rendered, /Hello, world!/);
  assert.doesNotMatch(rendered, /\"type\":/);
});

test("streaming event normalization tolerates future event shapes", () => {
  const toolEvent = normalizeGrokStreamingEvent(
    { type: "tool_start", tool: { name: "grep" }, session_id: "66666666-6666-4666-8666-666666666666" },
    "2026-01-01T00:00:00.000Z"
  );
  assert.equal(toolEvent.message, "Grok tool: grep");
  assert.equal(toolEvent.phase, "tool");
  assert.equal(toolEvent.sessionId, "66666666-6666-4666-8666-666666666666");
  assert.equal(toolEvent.eventType, "tool_start");

  const thought = normalizeGrokStreamingEvent({ type: "thought", text: "secret chain" }, "2026-01-01T00:00:00.000Z");
  assert.equal(thought.phase, "reasoning");
  assert.equal(thought.suppressProgress, true);
  assert.equal(thought.message, "");

  const textEvent = normalizeGrokStreamingEvent({ type: "text", text: "hello" }, "2026-01-01T00:00:00.000Z");
  assert.equal(textEvent.phase, "assistant");
  assert.equal(textEvent.suppressProgress, true);
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
