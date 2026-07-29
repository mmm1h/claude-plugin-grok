#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { getGrokAvailability } from "./lib/grok.mjs";
import { sortJobsNewestFirst } from "./lib/job-control.mjs";
import { interpolateTemplate, loadPromptTemplate } from "./lib/prompts.mjs";
import { getConfig, listJobs } from "./lib/state.mjs";
import { parseStopReviewDecision } from "./lib/stop-review.mjs";
import { CLAUDE_SESSION_ID_ENV } from "./lib/tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

const TIMEOUT_MS = 15 * 60 * 1000;
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(SCRIPT_DIR, "..");

function readInput() {
  const raw = fs.readFileSync(0, "utf8").trim();
  return raw ? JSON.parse(raw) : {};
}

function emitBlock(reason) {
  process.stdout.write(`${JSON.stringify({ decision: "block", reason })}\n`);
}

function currentSessionJobs(workspaceRoot, input) {
  const sessionId = input.session_id || process.env[CLAUDE_SESSION_ID_ENV];
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot));
  return sessionId ? jobs.filter((job) => job.claudeSessionId === sessionId) : jobs;
}

function parseDecision(rawOutput) {
  return parseStopReviewDecision(rawOutput?.result, rawOutput?.rawOutput);
}

function hasWorkingTreeChanges(cwd) {
  const result = spawnSync("git", ["status", "--porcelain=v1", "--untracked-files=normal"], {
    cwd,
    encoding: "utf8",
    timeout: 5_000,
    windowsHide: true
  });
  if (result.error || result.status !== 0) {
    return null;
  }
  return Boolean(String(result.stdout).trim());
}

function canSkipReview(cwd, _input) {
  // Gate only needs to block unresolved issues from direct edits still in the tree.
  // Clean trees and non-git workspaces skip the paid Grok call (ALLOW by silence).
  // A non-null dirty tree still runs the structured stop-review.
  const changes = hasWorkingTreeChanges(cwd);
  if (changes === false) {
    return true;
  }
  if (changes === null) {
    // Not a git repo / git unavailable: cannot attribute edits; fail open without a model call.
    return true;
  }
  return false;
}

function runReview(cwd, input) {
  const prompt = interpolateTemplate(loadPromptTemplate(ROOT_DIR, "stop-review-gate"), {
    CLAUDE_RESPONSE_BLOCK: String(input.last_assistant_message ?? "").trim()
  });
  const result = spawnSync(
    process.execPath,
    [
      path.join(SCRIPT_DIR, "grok-companion.mjs"),
      "task",
      "--read-only",
      "--stop-review",
      "--timeout-ms",
      String(TIMEOUT_MS - 60_000),
      "--json"
    ],
    {
      cwd,
      env: {
        ...process.env,
        ...(input.session_id ? { [CLAUDE_SESSION_ID_ENV]: input.session_id } : {})
      },
      input: prompt,
      encoding: "utf8",
      timeout: TIMEOUT_MS,
      windowsHide: true
    }
  );
  if (result.error?.code === "ETIMEDOUT") {
    return {
      allow: false,
      reason: "The Grok stop review timed out after 15 minutes. Run /grok:review --wait manually or disable the gate."
    };
  }
  let payload = null;
  try {
    payload = JSON.parse(result.stdout);
  } catch {
    // The failure path below reports malformed companion output.
  }
  if (result.error || result.status !== 0) {
    const legacy = payload ? parseDecision(payload) : null;
    if (payload?.grokExitCode === 0 && legacy?.source === "legacy") {
      return legacy;
    }
    const detail = String(result.stderr || result.stdout || result.error?.message || "").trim();
    return {
      allow: false,
      reason: `The Grok stop review failed${detail ? `: ${detail}` : "."} Run /grok:review --wait manually or disable the gate.`
    };
  }
  if (!payload) {
    return {
      allow: false,
      reason: "The Grok stop review returned invalid JSON. Run /grok:review --wait manually or disable the gate."
    };
  }
  return parseDecision(payload);
}

function main() {
  const input = readInput();
  const cwd = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const active = currentSessionJobs(workspaceRoot, input)
    .find((job) => ["queued", "running"].includes(job.status));
  const activeNote = active
    ? `Grok job ${active.id} is still ${active.status}. Check /grok:status ${active.id}.`
    : null;

  if (!getConfig(workspaceRoot).stopReviewGate) {
    if (activeNote) {
      process.stderr.write(`${activeNote}\n`);
    }
    return;
  }
  if (canSkipReview(cwd, input)) {
    if (activeNote) {
      process.stderr.write(`${activeNote}\n`);
    }
    return;
  }
  const availability = getGrokAvailability(cwd);
  if (!availability.available) {
    process.stderr.write(`Grok is unavailable for the review gate. Run /grok:setup.\n`);
    return;
  }
  const decision = runReview(cwd, input);
  if (!decision.allow) {
    emitBlock([activeNote, decision.reason].filter(Boolean).join(" "));
  } else if (activeNote) {
    process.stderr.write(`${activeNote}\n`);
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
