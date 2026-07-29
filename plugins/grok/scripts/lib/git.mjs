import fs from "node:fs";
import path from "node:path";

import { isProbablyText } from "./fs.mjs";
import { formatCommandFailure, runCommand, runCommandChecked } from "./process.mjs";

const DEFAULT_MAX_DIFF_BYTES = 512 * 1024;
const MAX_UNTRACKED_FILE_BYTES = 32 * 1024;

function git(cwd, args, options = {}) {
  return runCommand("git", args, { cwd, ...options, shell: false });
}

function gitChecked(cwd, args, options = {}) {
  return runCommandChecked("git", args, { cwd, ...options, shell: false });
}

function lines(value) {
  return String(value ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function uniqueFiles(...groups) {
  return [...new Set(groups.flat().filter(Boolean))].sort();
}

function formatSection(title, body) {
  return [`## ${title}`, "", String(body ?? "").trim() || "(none)", ""].join("\n");
}

function truncateUtf8(value, maxBytes) {
  const source = String(value ?? "");
  if (Buffer.byteLength(source, "utf8") <= maxBytes) {
    return { text: source, truncated: false };
  }
  const buffer = Buffer.from(source, "utf8").subarray(0, Math.max(0, maxBytes));
  return {
    text: `${buffer.toString("utf8").replace(/\uFFFD$/u, "")}\n\n[diff truncated by grok companion]`,
    truncated: true
  };
}

function readDiff(cwd, args, maxBytes) {
  const result = git(cwd, args, { maxBuffer: maxBytes + 1 });
  if (result.error?.code === "ENOBUFS") {
    const partial = truncateUtf8(result.stdout, maxBytes);
    return {
      text: partial.text,
      truncated: true,
      measuredBytes: maxBytes + 1
    };
  }
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(formatCommandFailure(result));
  }
  return {
    ...truncateUtf8(result.stdout, maxBytes),
    measuredBytes: Buffer.byteLength(result.stdout, "utf8")
  };
}

export function ensureGitRepository(cwd) {
  const result = git(cwd, ["rev-parse", "--show-toplevel"]);
  if (result.error?.code === "ENOENT") {
    throw new Error("git is not installed. Install Git and retry.");
  }
  if (result.status !== 0) {
    throw new Error("This command must run inside a Git repository.");
  }
  return result.stdout.trim();
}

export function getRepoRoot(cwd) {
  return gitChecked(cwd, ["rev-parse", "--show-toplevel"]).stdout.trim();
}

export function getCurrentBranch(cwd) {
  return gitChecked(cwd, ["branch", "--show-current"]).stdout.trim() || "HEAD";
}

export function detectDefaultBranch(cwd) {
  const symbolic = git(cwd, ["symbolic-ref", "refs/remotes/origin/HEAD"]);
  if (symbolic.status === 0) {
    const value = symbolic.stdout.trim();
    if (value.startsWith("refs/remotes/origin/")) {
      return value.slice("refs/remotes/origin/".length);
    }
  }

  for (const candidate of ["main", "master", "trunk"]) {
    if (git(cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${candidate}`]).status === 0) {
      return candidate;
    }
    if (git(cwd, ["show-ref", "--verify", "--quiet", `refs/remotes/origin/${candidate}`]).status === 0) {
      return `origin/${candidate}`;
    }
  }
  throw new Error("Unable to detect the default branch. Pass --base <ref> or use --scope working-tree.");
}

export function getWorkingTreeState(cwd) {
  const staged = lines(gitChecked(cwd, ["diff", "--cached", "--name-only"]).stdout);
  const unstaged = lines(gitChecked(cwd, ["diff", "--name-only"]).stdout);
  const untracked = lines(gitChecked(cwd, ["ls-files", "--others", "--exclude-standard"]).stdout);
  return {
    staged,
    unstaged,
    untracked,
    isDirty: staged.length + unstaged.length + untracked.length > 0
  };
}

export function resolveReviewTarget(cwd, options = {}) {
  ensureGitRepository(cwd);
  const scope = options.scope ?? "auto";
  if (!["auto", "working-tree", "branch"].includes(scope)) {
    throw new Error(`Unsupported review scope "${scope}". Use auto, working-tree, or branch.`);
  }
  if (options.base) {
    return { mode: "branch", label: `branch diff against ${options.base}`, baseRef: options.base, explicit: true };
  }
  if (scope === "working-tree") {
    return { mode: "working-tree", label: "working tree diff", baseRef: null, explicit: true };
  }
  if (scope === "branch") {
    const baseRef = detectDefaultBranch(cwd);
    return { mode: "branch", label: `branch diff against ${baseRef}`, baseRef, explicit: true };
  }
  if (getWorkingTreeState(cwd).isDirty) {
    return { mode: "working-tree", label: "working tree diff", baseRef: null, explicit: false };
  }
  const baseRef = detectDefaultBranch(cwd);
  return { mode: "branch", label: `branch diff against ${baseRef}`, baseRef, explicit: false };
}

function formatUntrackedFile(repoRoot, relativePath) {
  const absolutePath = path.resolve(repoRoot, relativePath);
  const relative = path.relative(repoRoot, absolutePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return `### ${relativePath}\n(skipped: path escapes repository)`;
  }
  try {
    const stat = fs.statSync(absolutePath);
    if (!stat.isFile()) {
      return `### ${relativePath}\n(skipped: not a regular file)`;
    }
    if (stat.size > MAX_UNTRACKED_FILE_BYTES) {
      return `### ${relativePath}\n(skipped: ${stat.size} bytes exceeds ${MAX_UNTRACKED_FILE_BYTES} byte limit)`;
    }
    const content = fs.readFileSync(absolutePath);
    if (!isProbablyText(content)) {
      return `### ${relativePath}\n(skipped: binary file)`;
    }
    return [`### ${relativePath}`, "```text", content.toString("utf8").trimEnd(), "```"].join("\n");
  } catch {
    return `### ${relativePath}\n(skipped: unreadable file)`;
  }
}

function buildBranchComparison(cwd, baseRef) {
  const mergeBase = gitChecked(cwd, ["merge-base", "HEAD", baseRef]).stdout.trim();
  return {
    mergeBase,
    commitRange: `${mergeBase}..HEAD`,
    reviewRange: `${baseRef}...HEAD`
  };
}

function collectWorkingTreeContext(repoRoot, maxDiffBytes) {
  const state = getWorkingTreeState(repoRoot);
  const changedFiles = uniqueFiles(state.staged, state.unstaged, state.untracked);
  const staged = readDiff(
    repoRoot,
    ["diff", "--cached", "--binary", "--no-ext-diff", "--submodule=diff"],
    Math.floor(maxDiffBytes / 2)
  );
  const remaining = Math.max(4096, maxDiffBytes - Buffer.byteLength(staged.text, "utf8"));
  const unstaged = readDiff(
    repoRoot,
    ["diff", "--binary", "--no-ext-diff", "--submodule=diff"],
    remaining
  );
  const untrackedBudget = Math.max(
    4096,
    maxDiffBytes - Buffer.byteLength(staged.text, "utf8") - Buffer.byteLength(unstaged.text, "utf8")
  );
  const untracked = truncateUtf8(
    state.untracked.map((file) => formatUntrackedFile(repoRoot, file)).join("\n\n"),
    untrackedBudget
  );
  const changedFileList = truncateUtf8(changedFiles.join("\n"), 64 * 1024);
  const truncated = staged.truncated || unstaged.truncated || untracked.truncated || changedFileList.truncated;
  const limitation = truncated
    ? "The inline diff exceeded the companion limit. Review the included patch and read current changed files; deleted or omitted hunks may require a follow-up review with a narrower scope."
    : "The complete tracked diff is included below.";

  return {
    mode: "working-tree",
    summary: `Reviewing ${state.staged.length} staged, ${state.unstaged.length} unstaged, and ${state.untracked.length} untracked file(s).`,
    changedFiles,
    truncated,
    diffBytes: staged.measuredBytes + unstaged.measuredBytes,
    content: [
      formatSection("Collection Note", limitation),
      formatSection("Git Status", gitChecked(repoRoot, ["status", "--short", "--untracked-files=all"]).stdout),
      formatSection("Changed Files", changedFileList.text),
      formatSection("Staged Diff", staged.text),
      formatSection("Unstaged Diff", unstaged.text),
      formatSection("Untracked Files", untracked.text)
    ].join("\n")
  };
}

function collectBranchContext(repoRoot, baseRef, maxDiffBytes) {
  const comparison = buildBranchComparison(repoRoot, baseRef);
  const changedFiles = lines(gitChecked(repoRoot, ["diff", "--name-only", comparison.commitRange]).stdout);
  const diff = readDiff(
    repoRoot,
    ["diff", "--binary", "--no-ext-diff", "--submodule=diff", comparison.commitRange],
    maxDiffBytes
  );
  const changedFileList = truncateUtf8(changedFiles.join("\n"), 64 * 1024);
  const commitLog = truncateUtf8(
    gitChecked(repoRoot, ["log", "--oneline", "--decorate", comparison.commitRange]).stdout,
    64 * 1024
  );
  const truncated = diff.truncated || changedFileList.truncated || commitLog.truncated;
  const limitation = truncated
    ? "The inline branch context exceeded the companion limit. Review the included patch and read current changed files; deleted or omitted hunks may require a narrower follow-up review."
    : "The complete branch diff is included below.";
  return {
    mode: "branch",
    summary: `Reviewing branch ${getCurrentBranch(repoRoot)} against ${baseRef} from merge-base ${comparison.mergeBase}.`,
    changedFiles,
    comparison,
    truncated,
    diffBytes: diff.measuredBytes,
    content: [
      formatSection("Collection Note", limitation),
      formatSection("Commit Log", commitLog.text),
      formatSection("Diff Stat", gitChecked(repoRoot, ["diff", "--stat", comparison.commitRange]).stdout),
      formatSection("Changed Files", changedFileList.text),
      formatSection("Branch Diff", diff.text)
    ].join("\n")
  };
}

export function collectReviewContext(cwd, target, options = {}) {
  const repoRoot = getRepoRoot(cwd);
  const maxDiffBytes = Number.isFinite(Number(options.maxDiffBytes))
    ? Math.max(8192, Number(options.maxDiffBytes))
    : DEFAULT_MAX_DIFF_BYTES;
  const details = target.mode === "working-tree"
    ? collectWorkingTreeContext(repoRoot, maxDiffBytes)
    : collectBranchContext(repoRoot, target.baseRef, maxDiffBytes);
  return {
    cwd: repoRoot,
    repoRoot,
    branch: getCurrentBranch(repoRoot),
    target,
    fileCount: details.changedFiles.length,
    inputMode: details.truncated ? "truncated-diff" : "inline-diff",
    ...details
  };
}
