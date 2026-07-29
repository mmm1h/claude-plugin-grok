import fs from "node:fs";
import path from "node:path";

import { isProbablyText } from "./fs.mjs";
import { formatCommandFailure, runCommand, runCommandChecked } from "./process.mjs";

const DEFAULT_INLINE_DIFF_MAX_FILES = 2;
const DEFAULT_INLINE_DIFF_MAX_BYTES = 256 * 1024;
const DEFAULT_SELF_COLLECT_MAX_BYTES = 512 * 1024;
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

function normalizeLimit(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
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

function measureGitOutputBytes(cwd, args, maxBytes) {
  const result = git(cwd, args, { maxBuffer: maxBytes + 1 });
  if (result.error?.code === "ENOBUFS") {
    return maxBytes + 1;
  }
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(formatCommandFailure(result));
  }
  return Buffer.byteLength(result.stdout, "utf8");
}

function measureCombinedGitOutputBytes(cwd, argSets, maxBytes) {
  let total = 0;
  for (const args of argSets) {
    const remaining = maxBytes - total;
    if (remaining < 0) {
      return maxBytes + 1;
    }
    total += measureGitOutputBytes(cwd, args, remaining);
    if (total > maxBytes) {
      return total;
    }
  }
  return total;
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

function selfCollectionGuidance() {
  return [
    "The complete diff is intentionally not inline because this review exceeds the inline evidence threshold.",
    "Treat the changed-files list as the review scope and use only the available read-only tools (read_file, grep, and list_dir) to inspect every relevant changed file and its surrounding code before deciding.",
    "Do not infer the contents of unread files or treat this summary as a complete patch. Deleted paths cannot be read, so make claims only when the status/stat and readable repository evidence support them."
  ].join(" ");
}

function inlineCollectionGuidance() {
  return "The complete tracked diff is inline below. Use it as primary evidence and use the available read-only tools for surrounding repository context when needed.";
}

function collectWorkingTreeContext(repoRoot, state, options = {}) {
  const includeDiff = options.includeDiff !== false;
  const maxDiffBytes = options.maxDiffBytes;
  const changedFiles = uniqueFiles(state.staged, state.unstaged, state.untracked);
  const status = gitChecked(repoRoot, ["status", "--short", "--untracked-files=all"]).stdout;

  if (!includeDiff) {
    return {
      mode: "working-tree",
      summary: `Reviewing ${state.staged.length} staged, ${state.unstaged.length} unstaged, and ${state.untracked.length} untracked file(s).`,
      changedFiles,
      truncated: false,
      collectionGuidance: selfCollectionGuidance(),
      content: [
        formatSection("Collection Guidance", selfCollectionGuidance()),
        formatSection("Git Status", status),
        formatSection("Changed Files", changedFiles.join("\n")),
        formatSection("Staged Diff Stat", gitChecked(repoRoot, ["diff", "--stat", "--cached"]).stdout),
        formatSection("Unstaged Diff Stat", gitChecked(repoRoot, ["diff", "--stat"]).stdout)
      ].join("\n")
    };
  }

  const staged = readDiff(
    repoRoot,
    ["diff", "--cached", "--binary", "--no-ext-diff", "--submodule=diff"],
    maxDiffBytes
  );
  const remaining = Math.max(0, maxDiffBytes - Buffer.byteLength(staged.text, "utf8"));
  const unstaged = readDiff(
    repoRoot,
    ["diff", "--binary", "--no-ext-diff", "--submodule=diff"],
    remaining
  );
  const untrackedBody = state.untracked.map((file) => formatUntrackedFile(repoRoot, file)).join("\n\n");
  const truncated = staged.truncated || unstaged.truncated;
  const guidance = truncated
    ? "The requested inline diff was truly truncated while collecting evidence. Do not approve this review."
    : inlineCollectionGuidance();

  return {
    mode: "working-tree",
    summary: `Reviewing ${state.staged.length} staged, ${state.unstaged.length} unstaged, and ${state.untracked.length} untracked file(s).`,
    changedFiles,
    truncated,
    collectionGuidance: guidance,
    content: [
      formatSection("Collection Guidance", guidance),
      formatSection("Git Status", status),
      formatSection("Changed Files", changedFiles.join("\n")),
      formatSection("Staged Diff", staged.text),
      formatSection("Unstaged Diff", unstaged.text),
      formatSection("Untracked Files", untrackedBody)
    ].join("\n")
  };
}

function collectBranchContext(repoRoot, baseRef, comparison, options = {}) {
  const includeDiff = options.includeDiff !== false;
  const changedFiles = lines(gitChecked(repoRoot, ["diff", "--name-only", comparison.commitRange]).stdout);
  const commitLog = gitChecked(repoRoot, ["log", "--oneline", "--decorate", comparison.commitRange]).stdout;
  const diffStat = gitChecked(repoRoot, ["diff", "--stat", comparison.commitRange]).stdout;

  if (!includeDiff) {
    return {
      mode: "branch",
      summary: `Reviewing branch ${getCurrentBranch(repoRoot)} against ${baseRef} from merge-base ${comparison.mergeBase}.`,
      changedFiles,
      comparison,
      truncated: false,
      collectionGuidance: selfCollectionGuidance(),
      content: [
        formatSection("Collection Guidance", selfCollectionGuidance()),
        formatSection("Commit Log", commitLog),
        formatSection("Diff Stat", diffStat),
        formatSection("Changed Files", changedFiles.join("\n"))
      ].join("\n")
    };
  }

  const diff = readDiff(
    repoRoot,
    ["diff", "--binary", "--no-ext-diff", "--submodule=diff", comparison.commitRange],
    options.maxDiffBytes
  );
  const guidance = diff.truncated
    ? "The requested inline diff was truly truncated while collecting evidence. Do not approve this review."
    : inlineCollectionGuidance();
  return {
    mode: "branch",
    summary: `Reviewing branch ${getCurrentBranch(repoRoot)} against ${baseRef} from merge-base ${comparison.mergeBase}.`,
    changedFiles,
    comparison,
    truncated: diff.truncated,
    collectionGuidance: guidance,
    content: [
      formatSection("Collection Guidance", guidance),
      formatSection("Commit Log", commitLog),
      formatSection("Diff Stat", diffStat),
      formatSection("Changed Files", changedFiles.join("\n")),
      formatSection("Branch Diff", diff.text)
    ].join("\n")
  };
}

export function collectReviewContext(cwd, target, options = {}) {
  const repoRoot = getRepoRoot(cwd);
  const maxInlineFiles = normalizeLimit(options.maxInlineFiles, DEFAULT_INLINE_DIFF_MAX_FILES);
  const maxInlineDiffBytes = normalizeLimit(options.maxInlineDiffBytes, DEFAULT_INLINE_DIFF_MAX_BYTES);
  const maxDiffBytes = normalizeLimit(options.maxDiffBytes, maxInlineDiffBytes);
  const maxSelfCollectBytes = normalizeLimit(options.maxSelfCollectBytes, DEFAULT_SELF_COLLECT_MAX_BYTES);
  let details;
  let diffBytes;
  let includeDiff;

  if (target.mode === "working-tree") {
    const state = getWorkingTreeState(repoRoot);
    const changedFiles = uniqueFiles(state.staged, state.unstaged, state.untracked);
    diffBytes = measureCombinedGitOutputBytes(
      repoRoot,
      [
        ["diff", "--cached", "--binary", "--no-ext-diff", "--submodule=diff"],
        ["diff", "--binary", "--no-ext-diff", "--submodule=diff"]
      ],
      maxInlineDiffBytes
    );
    includeDiff = options.includeDiff ?? (
      changedFiles.length <= maxInlineFiles && diffBytes <= maxInlineDiffBytes
    );
    details = collectWorkingTreeContext(repoRoot, state, { includeDiff, maxDiffBytes });
  } else {
    const comparison = buildBranchComparison(repoRoot, target.baseRef);
    const changedFiles = lines(gitChecked(repoRoot, ["diff", "--name-only", comparison.commitRange]).stdout);
    diffBytes = measureGitOutputBytes(
      repoRoot,
      ["diff", "--binary", "--no-ext-diff", "--submodule=diff", comparison.commitRange],
      maxInlineDiffBytes
    );
    includeDiff = options.includeDiff ?? (
      changedFiles.length <= maxInlineFiles && diffBytes <= maxInlineDiffBytes
    );
    details = collectBranchContext(repoRoot, target.baseRef, comparison, { includeDiff, maxDiffBytes });
    if (!includeDiff && getWorkingTreeState(repoRoot).isDirty) {
      const failure = "Branch self-collection cannot verify the selected commit range while the working tree is dirty because read-only file tools would observe uncommitted content.";
      details = {
        ...details,
        truncated: true,
        collectionGuidance: `${failure} Do not approve this review.`,
        content: formatSection("Collection Failure", failure)
      };
    }
  }

  if (!includeDiff && Buffer.byteLength(details.content, "utf8") > maxSelfCollectBytes) {
    const failure = `Self-collection summary exceeded the ${maxSelfCollectBytes} byte evidence limit. Refusing to provide a partial file list or diff stat.`;
    details = {
      ...details,
      truncated: true,
      collectionGuidance: `${failure} Do not approve this review.`,
      content: formatSection("Collection Failure", failure)
    };
  }

  return {
    cwd: repoRoot,
    repoRoot,
    branch: getCurrentBranch(repoRoot),
    target,
    fileCount: details.changedFiles.length,
    diffBytes,
    inputMode: details.truncated ? "truncated-diff" : (includeDiff ? "inline-diff" : "self-collect"),
    ...details
  };
}
