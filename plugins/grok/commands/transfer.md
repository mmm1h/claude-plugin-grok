---
description: Create a resumable Grok handoff from the current Claude Code transcript
argument-hint: "[--source <claude-jsonl>]"
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" transfer "$ARGUMENTS"`

Present stdout exactly as returned. Preserve the Grok session ID and `grok --resume <session-id>` command.
State clearly, if explaining the command, that this is a lossy transcript-to-prompt handoff rather than a native session import.
