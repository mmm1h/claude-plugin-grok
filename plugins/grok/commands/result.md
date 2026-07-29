---
description: Show the stored final output for a finished Grok job in this repository
argument-hint: '[job-id]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" result "$ARGUMENTS"`

Present the full output exactly as returned. Preserve job status, the complete Grok output, errors, Grok session ID, file references, and resume guidance. Do not summarize it.
Resume guidance is emitted only for a confirmed, resumable task record; automatic candidate selection remains scoped to the originating Claude session and workspace. Failed orphan and cancellation results remain readable and include their terminal metadata.
