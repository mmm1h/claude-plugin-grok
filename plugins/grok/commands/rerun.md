---
description: Re-queue a finished Grok job from its saved request sidecar
argument-hint: '<job-id> [--background] [--json]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" rerun "$ARGUMENTS"`

Rerun creates a **new** job from the original prompt and parameters saved when the source job was launched (rerun sidecar preferred; falls back to a stored request on the job record when present).

- Job ID is required.
- Source job must not still be `queued` or `running` — cancel or wait first.
- Does **not** resume the prior Grok session unless the stored request already targeted one.
- Prefer `--background` for long work, then `/grok:status` / `/grok:result` / `/grok:logs`.
- Without `--background`, runs in the foreground and prints the new run's output.
- Jobs finished before the companion saved rerun sidecars, or pruned without a sidecar and without a residual request, cannot be rerun.
- `--json` selects structured JSON (includes `sourceJobId` for background launches).
