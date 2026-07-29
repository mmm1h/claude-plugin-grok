import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  collectReviewContext,
  getWorkingTreeState,
  resolveReviewTarget
} from "../plugins/grok/scripts/lib/git.mjs";
import { git, initRepo, tempDir } from "./helpers.mjs";

test("working-tree review includes staged, unstaged, and untracked context", (t) => {
  const repo = tempDir();
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  initRepo(repo);
  fs.writeFileSync(path.join(repo, "app.js"), "export const value = 2;\n", "utf8");
  fs.writeFileSync(path.join(repo, "new.txt"), "new content\n", "utf8");

  const state = getWorkingTreeState(repo);
  assert.equal(state.isDirty, true);
  assert.deepEqual(state.untracked, ["new.txt"]);

  const target = resolveReviewTarget(repo, { scope: "auto" });
  assert.equal(target.mode, "working-tree");
  const context = collectReviewContext(repo, target);
  assert.equal(context.fileCount, 2);
  assert.match(context.content, /app\.js/);
  assert.match(context.content, /new content/);
  assert.match(context.content, /Unstaged Diff/);
});

test("branch review resolves an explicit base and reports committed changes", (t) => {
  const repo = tempDir();
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  initRepo(repo);
  const base = "main";
  git(repo, ["checkout", "-b", "feature"]);
  fs.writeFileSync(path.join(repo, "app.js"), "export const value = 3;\n", "utf8");
  git(repo, ["add", "app.js"]);
  git(repo, ["commit", "-m", "feature"]);
  const target = resolveReviewTarget(repo, { base });
  const context = collectReviewContext(repo, target);
  assert.equal(context.mode, "branch");
  assert.equal(context.fileCount, 1);
  assert.match(context.content, /feature/);
  assert.match(context.content, /value = 3/);
});

test("invalid review scope is rejected", (t) => {
  const repo = tempDir();
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  initRepo(repo);
  assert.throws(() => resolveReviewTarget(repo, { scope: "staged" }), /Unsupported review scope/);
});
