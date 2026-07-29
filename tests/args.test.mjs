import assert from "node:assert/strict";
import test from "node:test";

import { normalizeArgv, parseArgs, splitRawArgumentString } from "../plugins/grok/scripts/lib/args.mjs";

test("parseArgs handles boolean, value, aliases, inline values, and passthrough", () => {
  const result = parseArgs(
    ["--background", "--scope=branch", "-m", "grok-code", "--", "--literal", "focus"],
    {
      booleanOptions: ["background"],
      valueOptions: ["scope", "model"],
      aliasMap: { m: "model" }
    }
  );
  assert.deepEqual(result.options, {
    background: true,
    scope: "branch",
    model: "grok-code"
  });
  assert.deepEqual(result.positionals, ["--literal", "focus"]);
});

test("parseArgs preserves unknown flags as prompt text", () => {
  const result = parseArgs(["--unknown", "do", "work"], { booleanOptions: ["json"] });
  assert.deepEqual(result.options, {});
  assert.deepEqual(result.positionals, ["--unknown", "do", "work"]);
});

test("splitRawArgumentString keeps quoted values and escapes", () => {
  assert.deepEqual(
    splitRawArgumentString('--model "grok code" fix\\ this'),
    ["--model", "grok code", "fix this"]
  );
  assert.deepEqual(normalizeArgv(['--base main "focus here"']), ["--base", "main", "focus here"]);
  assert.deepEqual(
    splitRawArgumentString('--source C:\\Users\\me\\.claude\\session.jsonl'),
    ["--source", "C:\\Users\\me\\.claude\\session.jsonl"]
  );
});

test("splitRawArgumentString rejects unterminated quotes", () => {
  assert.throws(() => splitRawArgumentString('"unfinished'), /Unterminated quote/);
});
