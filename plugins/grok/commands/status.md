---
description: Show active and recent Grok jobs for this repository
argument-hint: '[job-id] [--wait] [--timeout-ms <ms>] [--all]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" status "$ARGUMENTS"`

With no job ID, present the grouped Running, Latest finished, and Recent Markdown tables exactly as returned. Keep job ID, kind, status, phase, elapsed or duration, progress, summary, session evidence, and actions.
With a job ID, present the full output without summarizing or condensing it.
`--wait` requires a job ID. In JSON mode, a waited response includes `waitedJobId`, `waitTimedOut`, and `timeoutMs`; a timeout returns the latest job snapshot instead of failing or discarding current state.
Running task jobs report live structured phase/progress and distinguish a candidate session ID from a confirmed one. If status finds an active job whose PID has exited, it persists `failed` / `process-exited` so the result is retrievable.
