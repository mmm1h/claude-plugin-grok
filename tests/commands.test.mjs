import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { PLUGIN_ROOT, ROOT } from "./helpers.mjs";

const commandDir = path.join(PLUGIN_ROOT, "commands");

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
