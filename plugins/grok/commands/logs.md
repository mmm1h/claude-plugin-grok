---
description: Show the log file for a Grok job (tail by default)
argument-hint: '<job-id> [--tail N] [--json]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" logs "$ARGUMENTS"`

Present the log output exactly as returned. Preserve timestamps and progress lines. Default tail is the last 80 lines; pass `--tail 0` only when intentionally requesting an empty window, or a larger N for more history.
