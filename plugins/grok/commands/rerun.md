---
description: Re-queue a finished Grok job from its saved request sidecar
argument-hint: '<job-id> [--background] [--json]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" rerun "$ARGUMENTS"`

Rerun creates a new job from the original prompt and parameters saved when the source job was launched. It does not resume the prior Grok session unless the stored request already targeted one. Prefer `--background` for long work, then `/grok:status` / `/grok:result`.
