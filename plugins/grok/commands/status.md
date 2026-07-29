---
description: Show active and recent Grok jobs for this repository
argument-hint: '[job-id] [--wait] [--timeout-ms <ms>] [--all]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" status "$ARGUMENTS"`

With no job ID, present the single Markdown table exactly as returned. Keep job ID, kind, status, phase, elapsed time, summary, session ID, and actions.
With a job ID, present the full output without summarizing or condensing it.
Running task jobs report live structured phase/progress and distinguish a candidate session ID from a confirmed one. If status finds an active job whose PID has exited, it persists `failed` / `process-exited` so the result is retrievable.
