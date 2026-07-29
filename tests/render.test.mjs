import assert from "node:assert/strict";
import test from "node:test";

import {
  renderJobStatusReport,
  renderSetupReport,
  renderStatusReport,
  renderStoredJobResult,
  renderTaskResult,
  renderReviewResult,
  renderTransferResult
} from "../plugins/grok/scripts/lib/render.mjs";

test("setup renderer includes readiness, auth, gate, and next steps", () => {
  const rendered = renderSetupReport({
    ready: true,
    node: { available: true, detail: "v22.0.0" },
    grok: { available: true, detail: "grok 1.0" },
    auth: { status: "unknown", detail: "not probed" },
    reviewGateEnabled: false,
    stateDir: "C:\\state\\repo-hash",
    actionsTaken: [],
    nextSteps: ["Run `grok login` if needed."]
  });
  assert.match(rendered, /Grok Companion setup/);
  assert.match(rendered, /Authentication: unknown/);
  assert.match(rendered, /Review gate: disabled/);
  assert.match(rendered, /Run `grok login`/);
});

test("status renderer groups running, latest finished, and recent jobs", () => {
  const running = {
    id: "task-123",
    kind: "task",
    status: "running",
    phase: "running",
    elapsed: "3s",
    lastProgressAt: "2026-07-29T08:00:00.000Z",
    sessionId: "44444444-4444-4444-8444-444444444444",
    sessionConfirmed: true,
    resumable: false,
    summary: "Fix | verify"
  };
  const rendered = renderStatusReport({
    reviewGateEnabled: false,
    running: [running],
    latestFinished: {
      ...running,
      id: "review-456",
      kind: "review",
      status: "completed",
      phase: "completed",
      elapsed: null,
      duration: "5s",
      summary: "Latest review"
    },
    recent: [{
      ...running,
      id: "task-789",
      status: "failed",
      phase: "failed",
      elapsed: null,
      duration: "8s",
      summary: "Older task"
    }]
  });
  assert.match(rendered, /^# Grok Status/);
  assert.match(rendered, /## Running/);
  assert.match(rendered, /## Latest finished/);
  assert.match(rendered, /## Recent/);
  assert.match(rendered, /Fix \\?\| verify/);
  assert.match(rendered, /elapsed 3s/);
  assert.match(rendered, /duration 5s/);
  assert.match(rendered, /Older task/);
  assert.match(rendered, /2026-07-29T08:00:00.000Z/);
  assert.match(rendered, /\| yes \| no \|/);
  assert.match(rendered, /\/grok:cancel task-123/);
});

test("single-job status renderer includes lifecycle and cancellation evidence", () => {
  const rendered = renderJobStatusReport({
    id: "task-123",
    kind: "task",
    status: "cancelled",
    phase: "cancelled",
    summary: "Stopped task",
    duration: "4s",
    pid: null,
    sessionId: "44444444-4444-4444-8444-444444444444",
    sessionConfirmed: true,
    resumable: true,
    lastProgressAt: "2026-07-29T08:00:00.000Z",
    exitCode: 130,
    terminationMethod: "taskkill",
    terminationDelivered: true,
    cancelRequestedAt: "2026-07-29T08:00:01.000Z",
    cancelledAt: "2026-07-29T08:00:02.000Z",
    logPath: "C:\\state\\task-123.log"
  });
  assert.match(rendered, /Duration: 4s/);
  assert.match(rendered, /Last progress: 2026-07-29T08:00:00.000Z/);
  assert.match(rendered, /Session confirmed: yes/);
  assert.match(rendered, /Resumable: yes/);
  assert.match(rendered, /Exit code: 130/);
  assert.match(rendered, /Termination delivered: yes/);
  assert.match(rendered, /Cancellation requested:/);
  assert.match(rendered, /Cancelled:/);
});

test("task and stored-result renderers preserve session and raw output", () => {
  const payload = {
    exitCode: 0,
    sessionId: "44444444-4444-4444-8444-444444444444",
    sessionConfirmed: true,
    rawOutput: "implementation complete",
    stderr: ""
  };
  assert.match(renderTaskResult(payload), /grok --resume 44444444/);
  const stored = renderStoredJobResult({
    id: "task-123",
    kind: "task",
    status: "completed",
    sessionId: payload.sessionId,
    sessionConfirmed: true,
    resumable: true,
    lastProgressAt: "2026-07-29T08:00:00.000Z",
    durationMs: 1234,
    exitCode: 0,
    rendered: "implementation complete\n"
  });
  assert.match(stored, /Job ID: task-123/);
  assert.match(stored, /Duration: 1s/);
  assert.match(stored, /Last progress: 2026-07-29T08:00:00.000Z/);
  assert.match(stored, /Session confirmed: yes/);
  assert.match(stored, /Resumable: yes/);
  assert.match(stored, /Exit code: 0/);
  assert.match(stored, /implementation complete/);
});

test("transfer renderer shows the local fidelity bill and shortened source hash", () => {
  const rendered = renderTransferResult({
    includedTurns: 3,
    totalTurns: 5,
    omittedTurns: 2,
    selectedEventCount: 3,
    rawEventCount: 7,
    selectedChars: 120,
    rawChars: 500,
    sourceSha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    omissions: { bad_json: 1, omitted_oldest: 2 },
    sessionId: "44444444-4444-4444-8444-444444444444",
    sessionConfirmed: true
  });
  assert.match(rendered, /lossy prompt handoff/);
  assert.match(rendered, /Included transcript turns: 3 of 5/);
  assert.match(rendered, /Source SHA-256: 0123456789ab/);
  assert.match(rendered, /bad_json=1/);
  assert.match(rendered, /omitted_oldest=2/);
  assert.match(rendered, /grok --resume 44444444/);
});

test("transfer renderer withholds resume when session is unconfirmed", () => {
  const unconfirmed = renderTransferResult({
    includedTurns: 1,
    totalTurns: 1,
    omittedTurns: 0,
    selectedEventCount: 1,
    rawEventCount: 1,
    selectedChars: 10,
    rawChars: 10,
    sourceSha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    omissions: {},
    sessionId: "55555555-5555-4555-8555-555555555555",
    sessionConfirmed: false
  });
  assert.match(unconfirmed, /preallocated \/ unconfirmed/);
  assert.match(unconfirmed, /Resume command withheld/);
  assert.doesNotMatch(unconfirmed, /grok --resume/);

  const confirmed = renderTransferResult({
    includedTurns: 1,
    totalTurns: 1,
    omittedTurns: 0,
    selectedEventCount: 1,
    rawEventCount: 1,
    selectedChars: 10,
    rawChars: 10,
    sourceSha256: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    omissions: {},
    sessionId: "55555555-5555-4555-8555-555555555555",
    sessionConfirmed: true
  });
  assert.match(confirmed, /grok --resume 55555555/);
  assert.doesNotMatch(confirmed, /preallocated/);
});

test("review renderer validates, sorts, and renders structured findings", () => {
  const rendered = renderReviewResult({
    result: {
      verdict: "needs-attention",
      summary: "Two defects need attention.",
      findings: [
        {
          severity: "low",
          title: "Low issue",
          body: "Low impact.",
          file: "low.mjs",
          line_start: 8,
          line_end: 8,
          confidence: 0.7,
          recommendation: "Tighten the check."
        },
        {
          severity: "critical",
          title: "Critical issue",
          body: "Data can be lost.",
          file: "critical.mjs",
          line_start: 10,
          line_end: 12,
          confidence: 0.99,
          recommendation: "Abort before writing."
        }
      ],
      next_steps: ["Fix the critical issue first."]
    },
    parseError: null,
    rawOutput: "{}",
    target: { label: "working tree diff" },
    context: { inputMode: "self-collect" }
  });
  assert.match(rendered, /Verdict: needs-attention/);
  assert.match(rendered, /Evidence mode: self-collect/);
  assert.ok(rendered.indexOf("Critical issue") < rendered.indexOf("Low issue"));
  assert.match(rendered, /critical\.mjs:10-12/);
  assert.match(rendered, /Confidence: 0\.99/);
  assert.match(rendered, /Recommendation: Abort before writing/);
});

test("review renderer reports parse and shape failures with raw output", () => {
  const invalidJson = renderReviewResult({
    result: null,
    parseError: "Unexpected token",
    rawOutput: "not-json"
  });
  assert.match(invalidJson, /did not return valid structured review output/);
  assert.match(invalidJson, /Unexpected token/);
  assert.match(invalidJson, /not-json/);

  const invalidShape = renderReviewResult({
    result: { verdict: "approve", summary: "ok", findings: [{}], next_steps: [] },
    parseError: null,
    rawOutput: "{bad shape}"
  });
  assert.match(invalidShape, /missing required field/);
  assert.doesNotMatch(invalidShape, /No material findings/);
});
