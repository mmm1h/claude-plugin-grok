---
description: Create a resumable Grok handoff from the current Claude Code transcript
argument-hint: "[--source <claude-jsonl>]"
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" transfer "$ARGUMENTS"`

Present stdout exactly as returned. Preserve the Grok session ID and `grok --resume <session-id>` command.
State clearly, if explaining the command, that this is a lossy transcript-to-prompt handoff rather than a native session import.
The handoff keeps at most 24,000 characters per turn and 180,000 transcript characters total (JavaScript UTF-16 code units), with explicit truncation markers and a local SHA-256/omission report.
Grok receives one synthetic prompt and produces one acknowledgement in a new session. Native tool identity/history graphs, hidden reasoning, binary attachment bodies, permissions, hooks, checkpoints, and Claude message IDs cannot be migrated.
