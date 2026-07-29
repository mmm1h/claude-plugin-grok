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
  assert.equal(context.inputMode, "inline-diff");
  assert.equal(context.truncated, false);
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

test("branch self-collection fails closed when uncommitted files would contaminate evidence", (t) => {
  const repo = tempDir();
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  initRepo(repo);
  git(repo, ["checkout", "-b", "feature"]);
  for (const file of ["one.js", "two.js", "three.js"]) {
    fs.writeFileSync(path.join(repo, file), `export const name = "${file}";\n`, "utf8");
  }
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "three files"]);
  fs.writeFileSync(path.join(repo, "one.js"), "export const dirty = true;\n", "utf8");

  const context = collectReviewContext(repo, resolveReviewTarget(repo, { base: "main" }));
  assert.equal(context.truncated, true);
  assert.equal(context.inputMode, "truncated-diff");
  assert.match(context.content, /working tree is dirty/);
  assert.doesNotMatch(context.content, /export const dirty/);
});

test("review context switches to self-collect above the file threshold without partial diff", (t) => {
  const repo = tempDir();
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  initRepo(repo);
  fs.writeFileSync(path.join(repo, "app.js"), "export const value = 2;\n", "utf8");
  fs.writeFileSync(path.join(repo, "second.js"), "export const second = 2;\n", "utf8");
  fs.writeFileSync(path.join(repo, "third.js"), "export const third = 3;\n", "utf8");

  const context = collectReviewContext(repo, resolveReviewTarget(repo, { scope: "working-tree" }));
  assert.equal(context.inputMode, "self-collect");
  assert.equal(context.truncated, false);
  assert.equal(context.fileCount, 3);
  assert.match(context.content, /Collection Guidance/);
  assert.match(context.content, /Changed Files/);
  assert.match(context.content, /Unstaged Diff Stat/);
  assert.doesNotMatch(context.content, /export const value = 2/);
  assert.match(context.collectionGuidance, /read_file, grep, and list_dir/);
});

test("oversized diff uses self-collect while forced inline truncation remains explicit", (t) => {
  const repo = tempDir();
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  initRepo(repo);
  fs.writeFileSync(
    path.join(repo, "app.js"),
    Array.from({ length: 40_000 }, (_, index) => `export const value${index} = ${index};`).join("\n"),
    "utf8"
  );
  const target = resolveReviewTarget(repo, { scope: "working-tree" });

  const selfCollected = collectReviewContext(repo, target);
  assert.equal(selfCollected.inputMode, "self-collect");
  assert.equal(selfCollected.truncated, false);
  assert.ok(selfCollected.diffBytes > 256 * 1024);
  assert.doesNotMatch(selfCollected.content, /diff truncated by grok companion/);

  const forcedInline = collectReviewContext(repo, target, { includeDiff: true, maxDiffBytes: 1024 });
  assert.equal(forcedInline.inputMode, "truncated-diff");
  assert.equal(forcedInline.truncated, true);
  assert.match(forcedInline.content, /diff truncated by grok companion/);

  const oversizedSummary = collectReviewContext(repo, target, {
    includeDiff: false,
    maxSelfCollectBytes: 128
  });
  assert.equal(oversizedSummary.truncated, true);
  assert.equal(oversizedSummary.inputMode, "truncated-diff");
  assert.match(oversizedSummary.content, /Collection Failure/);
  assert.doesNotMatch(oversizedSummary.content, /export const value39999/);
});

test("invalid review scope is rejected", (t) => {
  const repo = tempDir();
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  initRepo(repo);
  assert.throws(() => resolveReviewTarget(repo, { scope: "staged" }), /Unsupported review scope/);
});
