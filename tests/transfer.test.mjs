import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  buildHandoffEnvelope,
  buildHandoffPrompt,
  readClaudeTranscript,
  resolveClaudeSessionPath
} from "../plugins/grok/scripts/lib/claude-session-transfer.mjs";
import { tempDir } from "./helpers.mjs";

function writeJsonl(file, records) {
  const source = records
    .map((value) => typeof value === "string" ? value : JSON.stringify(value))
    .join("\n");
  fs.writeFileSync(file, source, "utf8");
  return source;
}

test("Claude transcript handoff retains bounded visible context and accounts for losses", (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "session.jsonl");
  const source = writeJsonl(file, [
    { type: "user", message: { content: "Please fix it" } },
    {
      type: "assistant",
      message: {
        content: [
          { type: "thinking", thinking: "hidden chain of thought" },
          { type: "text", text: "I found the cause" },
          { type: "tool_use", name: "read_file", input: { path: "src/app.js", detail: "brief" } }
        ]
      }
    },
    {
      type: "user",
      message: {
        content: [
          { type: "tool_result", content: "const cause = true;" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "SECRET_BINARY" }, filename: "error.png" }
        ]
      }
    },
    { type: "summary", summary: "Compacted context: inspect the failing branch." },
    { type: "progress", content: "ignore" },
    "{bad json"
  ]);

  assert.equal(resolveClaudeSessionPath(dir, { source: file }), fs.realpathSync(file));
  const transcript = readClaudeTranscript(file);
  assert.equal(transcript.schemaVersion, 1);
  assert.equal(transcript.rawEventCount, 6);
  assert.equal(transcript.selectedEventCount, 4);
  assert.equal(transcript.totalTurns, 4);
  assert.equal(transcript.omissions.bad_json, 1);
  assert.equal(transcript.omissions.non_message, 1);
  assert.equal(transcript.omissions.thinking, 1);
  assert.equal(transcript.omissions.tool_use, 1);
  assert.equal(transcript.omissions.tool_result, 1);
  assert.equal(transcript.omissions["image/attachment"], 1);
  assert.equal(transcript.omissions["system/summary"], 1);
  assert.equal(transcript.rawChars, source.length);

  const prompt = buildHandoffPrompt({ cwd: dir, sourcePath: file, transcript });
  assert.match(prompt, /lossy handoff/);
  assert.match(prompt, /Please fix it/);
  assert.match(prompt, /\[Tool use: read_file\]/);
  assert.match(prompt, /src\/app\.js/);
  assert.match(prompt, /\[Tool result summary\]/);
  assert.match(prompt, /const cause = true/);
  assert.match(prompt, /Compacted context/);
  assert.match(prompt, /Image\/attachment omitted: error\.png/);
  assert.doesNotMatch(prompt, /hidden chain of thought/);
  assert.doesNotMatch(prompt, /SECRET_BINARY/);
});

test("bad JSON is counted without aborting transcript extraction", (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "bad-lines.jsonl");
  writeJsonl(file, [
    "{ definitely not json",
    { type: "user", message: { content: "usable context" } }
  ]);

  const transcript = readClaudeTranscript(file);
  assert.equal(transcript.omissions.bad_json, 1);
  assert.equal(transcript.rawEventCount, 2);
  assert.equal(transcript.totalTurns, 1);
  assert.equal(transcript.turns[0].text, "usable context");
});

test("a turn over its budget has an explicit truncation sentinel", (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "large-turn.jsonl");
  writeJsonl(file, [{ type: "user", message: { content: "x".repeat(500) } }]);

  const transcript = readClaudeTranscript(file, { maxTurnChars: 100 });
  assert.equal(transcript.turns[0].text.length, 100);
  assert.match(transcript.turns[0].text, /\[turn truncated;/);
  assert.equal(transcript.omissions.truncated_turn, 1);
  assert.equal(transcript.truncated, true);
});

test("the total handoff budget omits oldest turns with an explicit sentinel", (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "many-turns.jsonl");
  writeJsonl(file, [
    { type: "user", message: { content: `oldest-${"a".repeat(50)}` } },
    { type: "assistant", message: { content: `older-${"b".repeat(50)}` } },
    { type: "user", message: { content: `newer-${"c".repeat(50)}` } },
    { type: "assistant", message: { content: `newest-${"d".repeat(50)}` } }
  ]);

  const transcript = readClaudeTranscript(file, { maxChars: 150 });
  assert.equal(transcript.totalTurns, 4);
  assert.equal(transcript.turns.length, 2);
  assert.equal(transcript.omittedTurns, 2);
  assert.equal(transcript.omissions.omitted_oldest, 2);
  assert.match(transcript.turns[0].text, /^newer-/);
  const prompt = buildHandoffPrompt({ cwd: dir, sourcePath: file, transcript });
  assert.match(prompt, /\[oldest turns omitted by total handoff budget: 2\]/);
  assert.doesNotMatch(prompt, /oldest-a/);
});

test("source hash is stable and the absolute source path stays out of the model prompt", (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "hash-source.jsonl");
  const source = writeJsonl(file, [{ type: "user", message: { content: "hash me" } }]);

  const first = readClaudeTranscript(file);
  const second = readClaudeTranscript(file);
  const expected = crypto.createHash("sha256").update(Buffer.from(source)).digest("hex");
  assert.equal(first.sourceSha256, expected);
  assert.equal(second.sourceSha256, expected);

  const envelope = buildHandoffEnvelope({ cwd: dir, sourcePath: file, transcript: first });
  assert.equal(envelope.metadata.sourcePath, file);
  assert.equal(envelope.metadata.sourceSha256, expected);
  assert.match(envelope.prompt, /path redacted/);
  assert.equal(envelope.prompt.includes(file), false);
});
