#!/usr/bin/env node

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { normalizeArgv, parseArgs } from "./lib/args.mjs";
import {
  buildHandoffEnvelope,
  readClaudeTranscript,
  resolveClaudeSessionPath
} from "./lib/claude-session-transfer.mjs";
import { readStdinIfPiped } from "./lib/fs.mjs";
import { collectReviewContext, resolveReviewTarget } from "./lib/git.mjs";
import {
  findLatestTaskSession,
  getGrokAuthStatus,
  getGrokAvailability,
  getGrokCapabilities,
  parseGrokStructuredOutput,
  runGrokHeadless
} from "./lib/grok.mjs";
import {
  buildSingleJobSnapshot,
  buildStatusSnapshot,
  cancelTrackedJob,
  readStoredJob,
  resolveCancelableJob,
  resolveResultJob
} from "./lib/job-control.mjs";
import { interpolateTemplate, loadPromptTemplate } from "./lib/prompts.mjs";
import {
  renderCancelReport,
  renderJobStatusReport,
  renderQueuedLaunch,
  renderReviewResult,
  renderSetupReport,
  renderStatusReport,
  renderStoredJobResult,
  renderTaskResult,
  renderTransferResult,
  validateReviewResult
} from "./lib/render.mjs";
import {
  generateJobId,
  getConfig,
  resolveJobFile,
  resolveStateDir,
  setConfig,
  upsertJob,
  writeJobFile
} from "./lib/state.mjs";
import {
  appendLogLine,
  createJobLogFile,
  createJobProgressUpdater,
  createJobRecord,
  createProgressReporter,
  indexJobRecord,
  runTrackedJob
} from "./lib/tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(SCRIPT_DIR, "..");
const REVIEW_SCHEMA = JSON.parse(
  fs.readFileSync(path.resolve(SCRIPT_DIR, "../schemas/review-output.schema.json"), "utf8")
);
const VALID_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh"]);
const DEFAULT_STATUS_WAIT_TIMEOUT_MS = 240_000;
const STATUS_POLL_INTERVAL_MS = 1_000;

function usage() {
  return [
    "Usage:",
    "  grok-companion.mjs setup [--enable-review-gate|--disable-review-gate] [--json]",
    "  grok-companion.mjs review [--wait|--background] [--base <ref>] [--scope auto|working-tree|branch]",
    "  grok-companion.mjs adversarial-review [--wait|--background] [--base <ref>] [--scope auto|working-tree|branch] [focus...]",
    "  grok-companion.mjs task [--background] [--write|--read-only] [--resume-last|--fresh] [--model <id>] [--effort <level>] [prompt]",
    "  grok-companion.mjs task-resume-candidate [--json]",
    "  grok-companion.mjs transfer [--source <claude-jsonl>] [--json]",
    "  grok-companion.mjs status [job-id] [--all] [--json] [--wait] [--timeout-ms <ms>]",
    "  grok-companion.mjs result [job-id] [--json]",
    "  grok-companion.mjs cancel [job-id] [--json]"
  ].join("\n");
}

function commandInput(argv, config = {}) {
  return parseArgs(normalizeArgv(argv), {
    ...config,
    aliasMap: { C: "cwd", ...(config.aliasMap ?? {}) }
  });
}

function commandCwd(options) {
  return options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
}

function output(payload, rendered, json) {
  if (json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    process.stdout.write(rendered);
  }
}

function shorten(value, limit = 120) {
  const text = String(value ?? "").trim().replace(/\s+/g, " ");
  return text.length <= limit ? text : `${text.slice(0, limit - 3)}...`;
}

function normalizeEffort(value) {
  if (value == null || String(value).trim() === "") {
    return null;
  }
  const effort = String(value).toLowerCase();
  if (!VALID_EFFORTS.has(effort)) {
    throw new Error(`Unsupported reasoning effort "${value}". Use: ${[...VALID_EFFORTS].join(", ")}.`);
  }
  return effort;
}

function requireAvailable(cwd) {
  const availability = getGrokAvailability(cwd);
  if (!availability.available) {
    throw new Error(`Grok CLI is unavailable (${availability.detail}). Run /grok:setup.`);
  }
}

function makeJob({ cwd, kind, title, summary, write, request, sessionId = null, sessionConfirmed = false }) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const job = createJobRecord({
    id: generateJobId(kind === "adversarial-review" ? "review" : kind),
    kind,
    title,
    status: "created",
    phase: "created",
    pid: null,
    cwd,
    workspaceRoot,
    summary,
    promptSummary: summary,
    write: Boolean(write),
    sessionId,
    sessionConfirmed,
    resumable: false,
    request
  });
  return job;
}

function readPrompt(cwd, options, positionals) {
  if (options["prompt-file"]) {
    return fs.readFileSync(path.resolve(cwd, options["prompt-file"]), "utf8");
  }
  return positionals.join(" ").trim() || readStdinIfPiped().trim();
}

async function buildSetup(cwd, actionsTaken = []) {
  const grok = getGrokAvailability(cwd);
  const capabilities = grok.available
    ? getGrokCapabilities(cwd)
    : { available: false, jsonSchema: false, sandbox: false, detail: "Grok CLI is unavailable." };
  const auth = getGrokAuthStatus(cwd);
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const config = getConfig(workspaceRoot);
  const nextSteps = [];
  if (!grok.available) {
    nextSteps.push("Install the Grok CLI and ensure `grok` is on PATH.");
  } else if (!capabilities.available) {
    nextSteps.push("Upgrade the Grok CLI to a version that supports `--json-schema` and `--sandbox`.");
  } else if (auth.status === "needs_login") {
    nextSteps.push("Run `grok login`.");
  } else if (auth.status === "unknown") {
    nextSteps.push("Authentication was not probed to avoid a network/model call; run `grok login` if the first task reports an auth error.");
  }
  if (!config.stopReviewGate) {
    nextSteps.push("Optional: run `/grok:setup --enable-review-gate` to enable stop-time review.");
  }
  return {
    ready: grok.available && capabilities.available && auth.status !== "needs_login",
    node: { available: true, detail: process.version },
    grok,
    capabilities,
    auth,
    reviewGateEnabled: Boolean(config.stopReviewGate),
    stateDir: resolveStateDir(workspaceRoot),
    actionsTaken,
    nextSteps
  };
}

async function handleSetup(argv) {
  const { options } = commandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json", "enable-review-gate", "disable-review-gate"]
  });
  if (options["enable-review-gate"] && options["disable-review-gate"]) {
    throw new Error("Choose either --enable-review-gate or --disable-review-gate.");
  }
  const cwd = commandCwd(options);
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const actions = [];
  if (options["enable-review-gate"]) {
    setConfig(workspaceRoot, "stopReviewGate", true);
    actions.push("Enabled the stop-time Grok review gate.");
  } else if (options["disable-review-gate"]) {
    setConfig(workspaceRoot, "stopReviewGate", false);
    actions.push("Disabled the stop-time Grok review gate.");
  }
  const report = await buildSetup(cwd, actions);
  output(report, renderSetupReport(report), options.json);
}

function buildReviewRequest(cwd, options, focus, adversarial) {
  const target = resolveReviewTarget(cwd, { base: options.base, scope: options.scope });
  const context = collectReviewContext(cwd, target);
  if (context.fileCount === 0) {
    throw new Error(`Nothing to review for ${target.label}.`);
  }
  if (!adversarial && focus) {
    throw new Error("The review command does not accept focus text. Use adversarial-review.");
  }
  const prompt = interpolateTemplate(
    loadPromptTemplate(ROOT_DIR, adversarial ? "adversarial-review" : "review"),
    {
      TARGET_LABEL: target.label,
      USER_FOCUS: focus || "(none)",
      CHANGE_SUMMARY: context.summary,
      REPOSITORY_CONTEXT: context.content
    }
  );
  return {
    type: "review",
    cwd: context.repoRoot,
    prompt,
    adversarial,
    target,
    context: {
      summary: context.summary,
      fileCount: context.fileCount,
      diffBytes: context.diffBytes,
      truncated: context.truncated,
      inputMode: context.inputMode
    },
    model: options.model ?? null
  };
}

async function executeReview(request, onProgress) {
  if (request.context.truncated) {
    const parseError = "Review context was truncated; refusing to invoke Grok on an incomplete diff. Narrow the review with --base or --scope.";
    const payload = {
      exitCode: 1,
      sessionId: null,
      result: null,
      rawOutput: "",
      parseError,
      stderr: "",
      target: request.target,
      context: request.context
    };
    return {
      exitCode: 1,
      sessionId: null,
      payload,
      rendered: renderReviewResult(payload),
      errorMessage: parseError
    };
  }
  const result = await runGrokHeadless({
    cwd: request.cwd,
    prompt: request.prompt,
    model: request.model,
    write: false,
    sandbox: "read-only",
    jsonSchema: REVIEW_SCHEMA,
    onProgress
  });
  const parsed = parseGrokStructuredOutput(result.stdout);
  const validationError = parsed.ok ? validateReviewResult(parsed.data) : null;
  const parseError = parsed.ok
    ? (validationError ? `Structured review validation failed: ${validationError}` : null)
    : parsed.parseError;
  const exitCode = result.exitCode === 0 && parseError ? 1 : result.exitCode;
  const payload = {
    exitCode,
    sessionId: result.sessionId,
    result: parsed.ok ? parsed.data : null,
    rawOutput: result.stdout.trimEnd(),
    parseError,
    stderr: result.stderr.trimEnd(),
    target: request.target,
    context: request.context
  };
  return {
    exitCode,
    sessionId: result.sessionId,
    payload,
    rendered: renderReviewResult(payload),
    errorMessage: exitCode === 0
      ? null
      : (parseError || result.stderr.trim() || `Grok exited with ${result.exitCode}.`)
  };
}

async function executeTask(request, onProgress, onTelemetry) {
  const result = await runGrokHeadless({
    cwd: request.cwd,
    prompt: request.prompt,
    model: request.model,
    effort: request.effort,
    write: request.write,
    sessionId: request.sessionId,
    sessionConfirmed: request.sessionConfirmed,
    resumeSessionId: request.resumeSessionId,
    outputFormat: "streaming-json",
    onProgress,
    onTelemetry,
    timeoutMs: request.timeoutMs
  });
  const payload = {
    exitCode: result.exitCode,
    sessionId: result.sessionId,
    sessionConfirmed: result.sessionConfirmed,
    rawOutput: result.stdout.trimEnd(),
    rawStreamingOutput: result.rawStdout.trimEnd(),
    stderr: result.stderr.trimEnd(),
    signal: result.signal,
    durationMs: result.durationMs,
    write: request.write,
    resumed: Boolean(request.resumeSessionId)
  };
  return {
    exitCode: result.exitCode,
    sessionId: result.sessionId,
    sessionConfirmed: result.sessionConfirmed,
    payload,
    rendered: renderTaskResult(payload, { title: request.title }),
    errorMessage: result.exitCode === 0 ? null : (result.stderr.trim() || `Grok exited with ${result.exitCode}.`)
  };
}

async function executeTransfer(request, onProgress) {
  const result = await runGrokHeadless({
    cwd: request.cwd,
    prompt: request.prompt,
    write: false,
    onProgress
  });
  const payload = {
    exitCode: result.exitCode,
    sessionId: result.sessionId,
    rawOutput: result.stdout.trimEnd(),
    stderr: result.stderr.trimEnd(),
    sourcePath: request.sourcePath,
    ...request.handoffMetadata
  };
  return {
    exitCode: result.exitCode,
    sessionId: result.sessionId,
    payload,
    rendered: result.exitCode === 0 ? renderTransferResult(payload) : renderTaskResult(payload, { title: "Grok Transfer" }),
    errorMessage: result.exitCode === 0 ? null : (result.stderr.trim() || `Grok exited with ${result.exitCode}.`)
  };
}

function executeRequest(request, onProgress, onTelemetry) {
  if (request.type === "review") {
    return executeReview(request, onProgress);
  }
  if (request.type === "task") {
    return executeTask(request, onProgress, onTelemetry);
  }
  if (request.type === "transfer") {
    return executeTransfer(request, onProgress);
  }
  throw new Error(`Unknown stored job request type: ${request.type}`);
}

async function runForeground(job, json) {
  const logPath = createJobLogFile(job.workspaceRoot, job.id, job.title);
  const progress = createProgressReporter({ stderr: !json, logPath });
  const telemetry = createJobProgressUpdater({ workspaceRoot: job.workspaceRoot, jobId: job.id, logPath });
  const execution = await runTrackedJob(
    { ...job, logPath, resultPath: resolveJobFile(job.workspaceRoot, job.id) },
    () => executeRequest(job.request, progress, telemetry),
    { logPath }
  );
  output(execution.payload, execution.rendered, json);
  if (execution.exitCode !== 0) {
    process.exitCode = execution.exitCode;
  }
}

function spawnWorker(cwd, jobId) {
  const child = spawn(process.execPath, [path.join(SCRIPT_DIR, "grok-companion.mjs"), "job-worker", "--cwd", cwd, "--job-id", jobId], {
    cwd,
    env: {
      ...process.env,
      GROK_COMPANION_BACKGROUND_WORKER: "1"
    },
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    shell: false
  });
  child.unref();
  return child;
}

function enqueue(job) {
  const logPath = createJobLogFile(job.workspaceRoot, job.id, job.title);
  const queued = {
    ...job,
    status: "queued",
    phase: "queued",
    logPath,
    resultPath: resolveJobFile(job.workspaceRoot, job.id)
  };
  writeJobFile(job.workspaceRoot, job.id, queued);
  upsertJob(job.workspaceRoot, indexJobRecord(queued));
  appendLogLine(logPath, "Queued for background execution.");
  const child = spawnWorker(job.cwd, job.id);
  const latest = readStoredJob(job.workspaceRoot, job.id);
  if (latest?.status === "queued") {
    const withPid = { ...latest, pid: child.pid ?? null };
    writeJobFile(job.workspaceRoot, job.id, withPid);
    upsertJob(job.workspaceRoot, indexJobRecord(withPid));
  }
  return {
    jobId: job.id,
    status: "queued",
    title: job.title,
    summary: job.summary,
    logPath
  };
}

async function handleReview(argv, adversarial) {
  const { options, positionals } = commandInput(argv, {
    valueOptions: ["base", "scope", "model", "cwd"],
    booleanOptions: ["json", "background", "wait"]
  });
  if (options.background && options.wait) {
    throw new Error("Choose either --background or --wait.");
  }
  const cwd = commandCwd(options);
  requireAvailable(cwd);
  const request = buildReviewRequest(cwd, options, positionals.join(" ").trim(), adversarial);
  const kind = adversarial ? "adversarial-review" : "review";
  const title = adversarial ? "Grok Adversarial Review" : "Grok Review";
  const job = makeJob({
    cwd: request.cwd,
    kind,
    title,
    summary: `${title} for ${request.target.label}`,
    write: false,
    request
  });
  if (options.background) {
    const payload = enqueue(job);
    output(payload, renderQueuedLaunch(payload), options.json);
  } else {
    await runForeground(job, options.json);
  }
}

async function handleTask(argv) {
  const { options, positionals } = commandInput(argv, {
    valueOptions: ["cwd", "prompt-file", "model", "effort", "timeout-ms"],
    booleanOptions: [
      "json",
      "background",
      "write",
      "read-only",
      "resume-last",
      "resume",
      "fresh",
      "stop-review"
    ]
  });
  if (options.write && options["read-only"]) {
    throw new Error("Choose either --write or --read-only.");
  }
  if ((options["resume-last"] || options.resume) && options.fresh) {
    throw new Error("Choose either --resume-last/--resume or --fresh.");
  }
  const cwd = commandCwd(options);
  requireAvailable(cwd);
  const prompt = readPrompt(cwd, options, positionals);
  if (!prompt) {
    throw new Error("Provide a task prompt, --prompt-file, or piped stdin.");
  }
  const resume = options["resume-last"] || options.resume ? findLatestTaskSession(cwd) : null;
  if ((options["resume-last"] || options.resume) && !resume) {
    throw new Error("No resumable Grok task session was found for the current Claude session and workspace.");
  }
  const write = options["read-only"] ? false : true;
  const timeoutMs = options["timeout-ms"] == null ? null : Number(options["timeout-ms"]);
  if (timeoutMs !== null && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
    throw new Error("--timeout-ms must be a positive number.");
  }
  const kind = options["stop-review"] ? "stop-review" : "task";
  const title = options["stop-review"] ? "Grok Stop Review" : (resume ? "Grok Resumed Task" : "Grok Task");
  const sessionId = resume?.sessionId ?? randomUUID();
  const request = {
    type: "task",
    cwd: resolveWorkspaceRoot(cwd),
    prompt,
    write,
    model: options.model ?? null,
    effort: normalizeEffort(options.effort),
    sessionId,
    sessionConfirmed: Boolean(resume?.sessionConfirmed),
    resumeSessionId: resume?.sessionId ?? null,
    timeoutMs,
    title
  };
  const job = makeJob({
    cwd: request.cwd,
    kind,
    title,
    summary: shorten(prompt),
    write,
    request,
    sessionId,
    sessionConfirmed: Boolean(resume?.sessionConfirmed)
  });
  if (options.background) {
    const payload = enqueue(job);
    output(payload, renderQueuedLaunch(payload), options.json);
  } else {
    await runForeground(job, options.json);
  }
}

function handleTaskResumeCandidate(argv) {
  const { options } = commandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });
  const cwd = commandCwd(options);
  const availability = getGrokAvailability(cwd);
  const candidate = availability.available ? findLatestTaskSession(cwd) : null;
  const payload = {
    available: Boolean(candidate),
    grokAvailable: availability.available,
    sessionId: candidate?.sessionId ?? null,
    source: candidate?.source ?? null,
    jobId: candidate?.jobId ?? null,
    status: candidate?.status ?? null,
    summary: candidate?.summary ?? null,
    updatedAt: candidate?.updatedAt ?? null,
    sessionConfirmed: Boolean(candidate?.sessionConfirmed)
  };
  output(payload, payload.available
    ? `Resumable Grok session: ${payload.sessionId}\n`
    : "No resumable Grok task session found.\n", options.json);
}

async function handleTransfer(argv) {
  const { options } = commandInput(argv, {
    valueOptions: ["cwd", "source"],
    booleanOptions: ["json"]
  });
  const cwd = commandCwd(options);
  requireAvailable(cwd);
  const sourcePath = resolveClaudeSessionPath(cwd, { source: options.source });
  const transcript = readClaudeTranscript(sourcePath);
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const handoff = buildHandoffEnvelope({ cwd: workspaceRoot, sourcePath, transcript });
  const request = {
    type: "transfer",
    cwd: workspaceRoot,
    sourcePath,
    prompt: handoff.prompt,
    handoffMetadata: handoff.metadata
  };
  const job = makeJob({
    cwd: workspaceRoot,
    kind: "transfer",
    title: "Grok Transfer",
    summary: `Claude transcript handoff (${transcript.turns.length}/${transcript.totalTurns} turns)`,
    write: false,
    request
  });
  await runForeground(job, options.json);
}

async function waitForJob(cwd, reference, timeoutMs) {
  const started = Date.now();
  for (;;) {
    const snapshot = buildSingleJobSnapshot(cwd, reference);
    if (!["queued", "running"].includes(snapshot.job.status)) {
      return snapshot;
    }
    if (Date.now() - started >= timeoutMs) {
      return snapshot;
    }
    await new Promise((resolve) => setTimeout(resolve, STATUS_POLL_INTERVAL_MS));
  }
}

async function handleStatus(argv) {
  const { options, positionals } = commandInput(argv, {
    valueOptions: ["cwd", "timeout-ms"],
    booleanOptions: ["json", "all", "wait"]
  });
  const cwd = commandCwd(options);
  const reference = positionals[0] ?? "";
  const timeoutMs = options["timeout-ms"] == null ? DEFAULT_STATUS_WAIT_TIMEOUT_MS : Number(options["timeout-ms"]);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new Error("--timeout-ms must be a non-negative number.");
  }
  if (reference) {
    const snapshot = options.wait
      ? await waitForJob(cwd, reference, timeoutMs)
      : buildSingleJobSnapshot(cwd, reference);
    output(snapshot, renderJobStatusReport(snapshot.job), options.json);
    return;
  }
  if (options.wait) {
    const active = buildStatusSnapshot(cwd, { all: options.all }).jobs.find((job) => ["queued", "running"].includes(job.status));
    if (active) {
      await waitForJob(cwd, active.id, timeoutMs);
    }
  }
  const snapshot = buildStatusSnapshot(cwd, { all: options.all });
  output(snapshot, renderStatusReport(snapshot), options.json);
}

function handleResult(argv) {
  const { options, positionals } = commandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });
  const cwd = commandCwd(options);
  const { workspaceRoot, job } = resolveResultJob(cwd, positionals[0] ?? "", { env: process.env });
  const stored = readStoredJob(workspaceRoot, job.id) ?? job;
  output(stored, renderStoredJobResult(stored), options.json);
}

function handleCancel(argv) {
  const { options, positionals } = commandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });
  const cwd = commandCwd(options);
  const { workspaceRoot, job } = resolveCancelableJob(cwd, positionals[0] ?? "", { env: process.env });
  const cancellation = cancelTrackedJob(workspaceRoot, job, { env: process.env });
  const payload = {
    jobId: job.id,
    previousStatus: cancellation.previousStatus,
    status: cancellation.status,
    delivered: cancellation.delivered,
    method: cancellation.method,
    errorMessage: cancellation.errorMessage
  };
  output(payload, renderCancelReport(payload), options.json);
  if (cancellation.status !== "cancelled") {
    process.exitCode = 1;
  }
}

async function handleWorker(argv) {
  const { options } = commandInput(argv, {
    valueOptions: ["cwd", "job-id"]
  });
  if (!options["job-id"]) {
    throw new Error("job-worker requires --job-id.");
  }
  const cwd = commandCwd(options);
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const job = readStoredJob(workspaceRoot, options["job-id"]);
  if (!job?.request) {
    throw new Error(`Stored job ${options["job-id"]} has no request payload.`);
  }
  const progress = createProgressReporter({ logPath: job.logPath });
  const telemetry = createJobProgressUpdater({ workspaceRoot, jobId: job.id, logPath: job.logPath });
  await runTrackedJob(
    { ...job, workspaceRoot },
    () => executeRequest(job.request, progress, telemetry),
    { logPath: job.logPath }
  );
}

async function main() {
  const [command, ...argv] = process.argv.slice(2);
  switch (command) {
    case "setup":
      await handleSetup(argv);
      break;
    case "review":
      await handleReview(argv, false);
      break;
    case "adversarial-review":
      await handleReview(argv, true);
      break;
    case "task":
      await handleTask(argv);
      break;
    case "task-resume-candidate":
      handleTaskResumeCandidate(argv);
      break;
    case "transfer":
      await handleTransfer(argv);
      break;
    case "status":
      await handleStatus(argv);
      break;
    case "result":
      handleResult(argv);
      break;
    case "cancel":
      handleCancel(argv);
      break;
    case "job-worker":
      await handleWorker(argv);
      break;
    case "help":
    case "--help":
    case "-h":
    case undefined:
      process.stdout.write(`${usage()}\n`);
      break;
    default:
      throw new Error(`Unknown command: ${command}\n\n${usage()}`);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
