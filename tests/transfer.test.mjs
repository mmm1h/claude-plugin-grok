import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  buildHandoffPrompt,
  readClaudeTranscript,
  resolveClaudeSessionPath
} from "../plugins/grok/scripts/lib/claude-session-transfer.mjs";
import { tempDir } from "./helpers.mjs";

test("Claude transcript extraction keeps user and assistant text only", (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "session.jsonl");
  const records = [
    { type: "user", message: { content: "Please fix it" } },
    { type: "assistant", message: { content: [{ type: "thinking", thinking: "hidden" }, { type: "text", text: "I found the cause" }] } },
    { type: "progress", content: "ignore" },
    "{bad json"
  ];
  fs.writeFileSync(file, records.map((value) => typeof value === "string" ? value : JSON.stringify(value)).join("\n"), "utf8");
  assert.equal(resolveClaudeSessionPath(dir, { source: file }), fs.realpathSync(file));
  const transcript = readClaudeTranscript(file);
  assert.equal(transcript.totalTurns, 2);
  assert.deepEqual(transcript.turns.map((turn) => turn.role), ["user", "assistant"]);
  const prompt = buildHandoffPrompt({ cwd: dir, sourcePath: file, transcript });
  assert.match(prompt, /lossy handoff/);
  assert.match(prompt, /Please fix it/);
  assert.doesNotMatch(prompt, /hidden/);
});
