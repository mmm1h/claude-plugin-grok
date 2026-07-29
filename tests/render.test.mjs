import assert from "node:assert/strict";
import test from "node:test";

import {
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

test("status renderer is a compact actionable Markdown table", () => {
  const rendered = renderStatusReport({
    jobs: [{
      id: "task-123",
      kind: "task",
      status: "running",
      phase: "running",
      elapsed: "3s",
      sessionId: null,
      summary: "Fix | verify"
    }]
  });
  assert.match(rendered, /^\| Job \| Kind \|/);
  assert.match(rendered, /Fix \\?\| verify/);
  assert.match(rendered, /\/grok:cancel task-123/);
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
    rendered: "implementation complete\n"
  });
  assert.match(stored, /Job ID: task-123/);
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
    sessionId: "44444444-4444-4444-8444-444444444444"
  });
  assert.match(rendered, /lossy prompt handoff/);
  assert.match(rendered, /Included transcript turns: 3 of 5/);
  assert.match(rendered, /Source SHA-256: 0123456789ab/);
  assert.match(rendered, /bad_json=1/);
  assert.match(rendered, /omitted_oldest=2/);
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
    target: { label: "working tree diff" }
  });
  assert.match(rendered, /Verdict: needs-attention/);
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
