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

export function renderReviewResult(payload) {
  const output = String(payload.rawOutput ?? "").trimEnd();
  if (output) {
    return `${output}\n`;
  }
  const detail = String(payload.stderr ?? "").trim();
  return `${detail || "Grok returned no review output."}\n`;
}

export function renderTaskResult(payload, options = {}) {
  const lines = [
    `${options.title ?? "Grok Task"} ${payload.exitCode === 0 ? "completed" : "failed"}.`,
    payload.sessionId ? `Grok session ID: ${payload.sessionId}` : null,
    payload.sessionId ? `Resume in Grok: grok --resume ${payload.sessionId}` : null,
    "",
    String(payload.rawOutput || payload.stderr || "Grok returned no output.").trimEnd()
  ].filter((value) => value !== null);
  return `${lines.join("\n")}\n`;
}

export function renderQueuedLaunch(payload) {
  return `${payload.title} started in the background as ${payload.jobId}. Check /grok:status ${payload.jobId} for progress.\n`;
}

export function renderTransferResult(payload) {
  return [
    "Created a Grok handoff session from the Claude transcript.",
    "This is a lossy prompt handoff, not a native Claude-to-Grok session import.",
    `Included transcript turns: ${payload.includedTurns} of ${payload.totalTurns}.`,
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
  const lines = [
    `Job ID: ${storedJob.id}`,
    `Kind: ${storedJob.kind}`,
    `Status: ${storedJob.status}`,
    storedJob.sessionId ? `Grok session ID: ${storedJob.sessionId}` : null,
    storedJob.sessionId ? `Resume in Grok: grok --resume ${storedJob.sessionId}` : null,
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
  return [
    `Cancelled Grok job ${payload.jobId}.`,
    `Previous status: ${payload.previousStatus}.`,
    `Process termination delivered: ${yesNo(payload.delivered)}.`,
    ""
  ].join("\n");
}
