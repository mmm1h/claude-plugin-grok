---
description: Prune old finished Grok jobs from the local companion index
argument-hint: '[--older-than <duration>] [--keep N] [--dry-run] [--json]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" cleanup "$ARGUMENTS"`

Require at least one of `--older-than` (e.g. `7d`, `24h`, `90m`) or `--keep N`. Active queued/running jobs are never removed. Prefer `--dry-run` first. Export important jobs with `/grok:export` before deleting them.
