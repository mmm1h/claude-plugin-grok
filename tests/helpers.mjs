import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const PLUGIN_ROOT = path.join(ROOT, "plugins", "grok");
export const COMPANION = path.join(PLUGIN_ROOT, "scripts", "grok-companion.mjs");
export const FAKE_GROK = path.join(ROOT, "tests", "fake-grok-fixture.mjs");

export function tempDir(prefix = "grok-plugin-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd ?? ROOT,
    env: options.env ?? process.env,
    encoding: "utf8",
    input: options.input,
    timeout: options.timeout ?? 20_000,
    windowsHide: true,
    shell: false
  });
}

export function git(cwd, args) {
  const result = run("git", args, { cwd });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout);
  }
  return result.stdout.trim();
}

export function initRepo(dir) {
  git(dir, ["init", "-b", "main"]);
  git(dir, ["config", "user.email", "tests@example.com"]);
  git(dir, ["config", "user.name", "Plugin Tests"]);
  fs.writeFileSync(path.join(dir, "app.js"), "export const value = 1;\n", "utf8");
  git(dir, ["add", "app.js"]);
  git(dir, ["commit", "-m", "initial"]);
}

export function fakeGrokEnv(stateHome, overrides = {}) {
  const env = {
    ...process.env,
    GROK_COMPANION_HOME: stateHome,
    GROK_COMPANION_GROK_BINARY: process.execPath,
    GROK_COMPANION_GROK_PREFIX_ARGS: JSON.stringify([FAKE_GROK]),
    ...overrides
  };
  if (!Object.hasOwn(overrides, "GROK_COMPANION_CLAUDE_SESSION_ID")) {
    delete env.GROK_COMPANION_CLAUDE_SESSION_ID;
  }
  return env;
}
