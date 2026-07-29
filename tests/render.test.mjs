import assert from "node:assert/strict";
import test from "node:test";

import {
  renderSetupReport,
  renderStatusReport,
  renderStoredJobResult,
  renderTaskResult
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
    rawOutput: "implementation complete",
    stderr: ""
  };
  assert.match(renderTaskResult(payload), /grok --resume 44444444/);
  const stored = renderStoredJobResult({
    id: "task-123",
    kind: "task",
    status: "completed",
    sessionId: payload.sessionId,
    rendered: "implementation complete\n"
  });
  assert.match(stored, /Job ID: task-123/);
  assert.match(stored, /implementation complete/);
});
