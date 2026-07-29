---
description: Cancel an active background Grok job in this repository
argument-hint: '[job-id]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" cancel "$ARGUMENTS"`

Cancellation is terminal only after a signal is delivered or the PID is confirmed exited. A failed termination is reported as `cancel-failed`; it is never presented as cancelled.
