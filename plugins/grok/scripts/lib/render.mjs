function line(value) {
  return String(value ?? "").replace(/\r?\n/g, " ").trim();
}

function markdownCell(value) {
  return line(value).replace(/\|/g, "\\|");
}

function yesNo(value) {
  if (value === null || value === undefined) {
    return "unknown";
  }
  return value ? "yes" : "no";
}

export function renderSetupReport(report) {
  const lines = [
    "Grok Companion setup",
    "",
    `Node available: ${yesNo(report.node.available)}${report.node.detail ? ` (${line(report.node.detail)})` : ""}`,
    `Grok available: ${yesNo(report.grok.available)}${report.grok.detail ? ` (${line(report.grok.detail)})` : ""}`,
    `Authentication: ${report.auth.status}${report.auth.detail ? ` (${line(report.auth.detail)})` : ""}`,
    `Review gate: ${report.reviewGateEnabled ? "enabled" : "disabled"}`,
    `State directory: ${report.stateDir}`,
    `Ready: ${yesNo(report.ready)}`
  ];
  if (report.actionsTaken?.length) {
    lines.push("", "Actions:", ...report.actionsTaken.map((value) => `- ${value}`));
  }
  if (report.nextSteps?.length) {
    lines.push("", "Next steps:", ...report.nextSteps.map((value) => `- ${value}`));
  }
  return `${lines.join("\n")}\n`;
}

const REVIEW_SEVERITIES = ["critical", "high", "medium", "low"];
const REVIEW_RESULT_KEYS = ["verdict", "summary", "findings", "next_steps"];
const REVIEW_FINDING_KEYS = [
  "severity",
  "title",
  "body",
  "file",
  "line_start",
  "line_end",
  "confidence",
  "recommendation"
];

function unexpectedKeys(value, allowed) {
  return Object.keys(value).filter((key) => !allowed.includes(key));
}

export function validateReviewResult(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return "Expected a top-level JSON object.";
  }
  const topLevelExtras = unexpectedKeys(data, REVIEW_RESULT_KEYS);
  if (topLevelExtras.length) {
    return `Unexpected top-level field: ${topLevelExtras[0]}.`;
  }
  if (!new Set(["approve", "needs-attention"]).has(data.verdict)) {
    return "Field `verdict` must be `approve` or `needs-attention`.";
  }
  if (typeof data.summary !== "string" || !data.summary.trim()) {
    return "Field `summary` must be a non-empty string.";
  }
  if (!Array.isArray(data.findings)) {
    return "Field `findings` must be an array.";
  }
  for (const [index, finding] of data.findings.entries()) {
    const prefix = `Finding ${index + 1}`;
    if (!finding || typeof finding !== "object" || Array.isArray(finding)) {
      return `${prefix} must be an object.`;
    }
    const extras = unexpectedKeys(finding, REVIEW_FINDING_KEYS);
    if (extras.length) {
      return `${prefix} has unexpected field: ${extras[0]}.`;
    }
    for (const field of REVIEW_FINDING_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(finding, field)) {
        return `${prefix} is missing required field \`${field}\`.`;
      }
    }
    if (!REVIEW_SEVERITIES.includes(finding.severity)) {
      return `${prefix} has an invalid severity.`;
    }
    for (const field of ["title", "body", "file"]) {
      if (typeof finding[field] !== "string" || !finding[field].trim()) {
        return `${prefix} field \`${field}\` must be a non-empty string.`;
      }
    }
    if (!Number.isInteger(finding.line_start) || finding.line_start < 1) {
      return `${prefix} field \`line_start\` must be a positive integer.`;
    }
    if (!Number.isInteger(finding.line_end) || finding.line_end < finding.line_start) {
      return `${prefix} field \`line_end\` must be an integer at or after \`line_start\`.`;
    }
    if (typeof finding.confidence !== "number" || !Number.isFinite(finding.confidence) || finding.confidence < 0 || finding.confidence > 1) {
      return `${prefix} field \`confidence\` must be a number from 0 to 1.`;
    }
    if (typeof finding.recommendation !== "string") {
      return `${prefix} field \`recommendation\` must be a string.`;
    }
  }
  if (!Array.isArray(data.next_steps)) {
    return "Field `next_steps` must be an array.";
  }
  if (data.next_steps.some((step) => typeof step !== "string" || !step.trim())) {
    return "Every `next_steps` item must be a non-empty string.";
  }
  return null;
}

function reviewTitle(payload) {
  return payload.target?.label ? `Grok Review - ${payload.target.label}` : "Grok Review";
}

function rawOutputExcerpt(value, limit = 4000) {
  const raw = String(value ?? "").trim();
  return raw.length <= limit ? raw : `${raw.slice(0, limit)}\n[raw output truncated]`;
}

export function renderReviewResult(payload) {
  const hasStructuredFields = Object.prototype.hasOwnProperty.call(payload, "result") ||
    Object.prototype.hasOwnProperty.call(payload, "parseError");
  if (!hasStructuredFields) {
    const output = String(payload.rawOutput ?? "").trimEnd();
    if (output) {
      return `${output}\n`;
    }
    const detail = String(payload.stderr ?? "").trim();
    return `${detail || "Grok returned no review output."}\n`;
  }

  const validationError = payload.result == null ? null : validateReviewResult(payload.result);
  const executionError = payload.exitCode != null && payload.exitCode !== 0
    ? (String(payload.stderr ?? "").trim() || `Grok exited with ${payload.exitCode}.`)
    : null;
  const error = payload.parseError || validationError || executionError;
  if (error) {
    const lines = [
      `# ${reviewTitle(payload)}`,
      "",
      "Grok did not return valid structured review output.",
      "",
      `Error: ${line(error)}`
    ];
    const raw = rawOutputExcerpt(payload.rawOutput);
    if (raw) {
      lines.push("", "Raw output:", "", "```text", raw, "```");
    }
    return `${lines.join("\n")}\n`;
  }
  if (!payload.result) {
    return `# ${reviewTitle(payload)}\n\nGrok returned no structured review result.\n`;
  }

  const findings = [...payload.result.findings].sort(
    (left, right) => REVIEW_SEVERITIES.indexOf(left.severity) - REVIEW_SEVERITIES.indexOf(right.severity)
  );
  const lines = [
    `# ${reviewTitle(payload)}`,
    "",
    `Verdict: ${payload.result.verdict}`,
    "",
    "Summary:",
    payload.result.summary.trim(),
    "",
    "Findings:"
  ];
  if (!findings.length) {
    lines.push("No material findings.");
  } else {
    for (const finding of findings) {
      const range = finding.line_start === finding.line_end
        ? String(finding.line_start)
        : `${finding.line_start}-${finding.line_end}`;
      lines.push(`- [${finding.severity}] ${finding.title} (${finding.file}:${range})`);
      lines.push(`  ${finding.body}`);
      lines.push(`  Confidence: ${finding.confidence}`);
      lines.push(`  Recommendation: ${finding.recommendation}`);
    }
  }
  lines.push("", "Next steps:");
  if (payload.result.next_steps.length) {
    lines.push(...payload.result.next_steps.map((step) => `- ${step.trim()}`));
  } else {
    lines.push("None.");
  }
  return `${lines.join("\n")}\n`;
}

export function renderTaskResult(payload, options = {}) {
  const canResume = Boolean(payload.sessionId && payload.sessionConfirmed);
  const lines = [
    `${options.title ?? "Grok Task"} ${payload.exitCode === 0 ? "completed" : "failed"}.`,
    payload.sessionId ? `Grok session ID: ${payload.sessionId}` : null,
    canResume ? `Resume in Grok: grok --resume ${payload.sessionId}` : null,
    "",
    String(payload.rawOutput || payload.stderr || "Grok returned no output.").trimEnd()
  ].filter((value) => value !== null);
  return `${lines.join("\n")}\n`;
}

export function renderQueuedLaunch(payload) {
  return `${payload.title} started in the background as ${payload.jobId}. Check /grok:status ${payload.jobId} for progress.\n`;
}

export function renderTransferResult(payload) {
  const omissionSummary = Object.entries(payload.omissions ?? {})
    .filter(([, count]) => count > 0)
    .map(([kind, count]) => `${kind}=${count}`)
    .join(", ") || "none";
  const sourceHash = payload.sourceSha256 ? payload.sourceSha256.slice(0, 12) : "(unavailable)";
  return [
    "Created a Grok handoff session from the Claude transcript.",
    "This is a lossy prompt handoff, not a native Claude-to-Grok session import.",
    `Included transcript turns: ${payload.includedTurns} of ${payload.totalTurns}.`,
    `Omitted oldest turns: ${payload.omittedTurns}.`,
    `Selected events: ${payload.selectedEventCount} of ${payload.rawEventCount}.`,
    `Selected transcript chars: ${payload.selectedChars} of ${payload.rawChars} (UTF-16 code units).`,
    `Source SHA-256: ${sourceHash}.`,
    `Loss/omission counts: ${omissionSummary}.`,
    `Grok session ID: ${payload.sessionId}`,
    `Resume in Grok: grok --resume ${payload.sessionId}`,
    ""
  ].join("\n");
}

function actionCell(job) {
  const actions = [`/grok:status ${job.id}`];
  if (["queued", "running"].includes(job.status)) {
    actions.push(`/grok:cancel ${job.id}`);
  } else {
    actions.push(`/grok:result ${job.id}`);
  }
  return actions.map((value) => `\`${value}\``).join("<br>");
}

export function renderStatusReport(snapshot) {
  const lines = [
    "| Job | Kind | Status | Phase | Elapsed | Grok Session ID | Summary | Actions |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |"
  ];
  for (const job of snapshot.jobs) {
    lines.push(
      `| ${markdownCell(job.id)} | ${markdownCell(job.kind)} | ${markdownCell(job.status)} | ${markdownCell(job.phase)} | ${markdownCell(job.elapsed)} | ${markdownCell(job.sessionId)} | ${markdownCell(job.summary)} | ${actionCell(job)} |`
    );
  }
  if (snapshot.jobs.length === 0) {
    lines.push("| (none) |  |  |  |  |  | No Grok jobs for this session. |  |");
  }
  return `${lines.join("\n")}\n`;
}

export function renderJobStatusReport(job) {
  const lines = [
    `Job ID: ${job.id}`,
    `Kind: ${job.kind}`,
    `Status: ${job.status}`,
    `Phase: ${job.phase}`,
    `Summary: ${job.summary ?? ""}`,
    `Elapsed: ${job.elapsed ?? ""}`,
    `PID: ${job.pid ?? ""}`,
    `Grok session ID: ${job.sessionId ?? ""}`,
    `Session confirmed: ${yesNo(job.sessionConfirmed)}.`,
    `Resumable: ${yesNo(job.resumable)}.`,
    `Last progress: ${job.lastProgressAt ?? ""}`,
    `Log: ${job.logPath ?? ""}`
  ];
  if (job.progressPreview?.length) {
    lines.push("", "Recent progress:", ...job.progressPreview.map((value) => `- ${value}`));
  }
  if (["queued", "running"].includes(job.status)) {
    lines.push("", `Cancel: /grok:cancel ${job.id}`);
  } else {
    lines.push("", `Result: /grok:result ${job.id}`);
  }
  return `${lines.join("\n")}\n`;
}

export function renderStoredJobResult(storedJob) {
  const canResume = Boolean(storedJob.sessionId && storedJob.sessionConfirmed && storedJob.resumable);
  const lines = [
    `Job ID: ${storedJob.id}`,
    `Kind: ${storedJob.kind}`,
    `Status: ${storedJob.status}`,
    storedJob.sessionId ? `Grok session ID: ${storedJob.sessionId}` : null,
    canResume ? `Resume in Grok: grok --resume ${storedJob.sessionId}` : null,
    storedJob.terminationMethod ? `Termination method: ${storedJob.terminationMethod}` : null,
    storedJob.cancelRequestedAt ? `Cancellation requested: ${storedJob.cancelRequestedAt}` : null,
    storedJob.cancelledAt ? `Cancelled: ${storedJob.cancelledAt}` : null,
    ""
  ].filter((value) => value !== null);
  if (storedJob.rendered) {
    lines.push(String(storedJob.rendered).trimEnd());
  } else if (storedJob.result?.rawOutput || storedJob.result?.stderr) {
    lines.push(String(storedJob.result.rawOutput || storedJob.result.stderr).trimEnd());
  } else if (storedJob.errorMessage) {
    lines.push(`Error: ${storedJob.errorMessage}`);
  } else {
    lines.push("No stored result output.");
  }
  return `${lines.join("\n")}\n`;
}

export function renderCancelReport(payload) {
  if (payload.status !== "cancelled") {
    return [
      `Could not cancel Grok job ${payload.jobId}.`,
      `Previous status: ${payload.previousStatus}.`,
      `Process termination delivered: ${yesNo(payload.delivered)}.`,
      `Error: ${payload.errorMessage ?? "The process is still running."}`,
      ""
    ].join("\n");
  }
  return [
    `Cancelled Grok job ${payload.jobId}.`,
    `Previous status: ${payload.previousStatus}.`,
    `Process termination delivered: ${yesNo(payload.delivered)}.`,
    ""
  ].join("\n");
}
