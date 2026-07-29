---
description: Cancel an active background Grok job in this repository
argument-hint: '[job-id] [--all] [--kind <kind>] [--json]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" cancel "$ARGUMENTS"`

Cancellation targets:
- With a job ID: cancel that active (`queued`/`running`) job.
- With no job ID and a single active job in scope: cancel that job.
- With multiple active jobs and no ID: error and ask for a job ID or `--all`.
- `--all` cancels every active job in scope (cannot be combined with a job ID).
- `--kind <kind>` filters which active jobs are eligible (works with a single auto-selected job or with `--all`).
- Scope defaults to the current Claude session; companion job matching follows the same session filter as status unless broader resolution applies.

Cancellation is terminal only after a signal is delivered or the PID is confirmed exited. A failed termination is reported as `cancel-failed`; it is never presented as cancelled.
`--json` selects structured JSON (single-job or bulk `results` list).
