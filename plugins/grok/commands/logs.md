---
description: Show the log file for a Grok job (tail by default)
argument-hint: '[job-id] [--tail N] [--json]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" logs "$ARGUMENTS"`

Present the log output exactly as returned. Preserve timestamps and progress lines.

- Job ID is optional; when omitted, the newest known job for the workspace is used.
- Default tail is the last **80** lines.
- `--tail N` shows the last N lines (`0` yields an empty window; larger N for more history).
- `--json` returns the structured payload (`lines`, `totalLines`, `tail`, `logPath`, …).
