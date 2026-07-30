---
description: Cancel an active background Grok job in this repository
argument-hint: '[job-id] [--all] [--all-sessions] [--kind <kind>] [--json]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" cancel "$ARGUMENTS"`

Cancellation targets:
- With a job ID: cancel that active (`queued`/`running`) job.
- With no job ID and a single active job in the current Claude session: cancel that job.
- With multiple active jobs and no ID: error and ask for a job ID or `--all`.
- `--all` cancels every active job in the **current Claude session** only (cannot be combined with a job ID). This is a behavior change from older versions that cancelled across all sessions.
- `--all-sessions` cancels every active job in the workspace across Claude sessions. Output (and `--json`) lists how many belong to other sessions, with each job id and `claudeSessionId`.
- Without `GROK_COMPANION_CLAUDE_SESSION_ID` (hookless / direct CLI), session ownership cannot be determined: `--all` and `--all-sessions` both act on the whole workspace and the report states that explicitly.
- `--kind <kind>` filters which active jobs are eligible (works with a single auto-selected job or with `--all` / `--all-sessions`).
- Unlike `status --all` (read-only cross-session view), bulk cancel defaults to the current session for safety.

Cancellation is terminal only after a signal is delivered or the PID is confirmed exited (observed alive, then gone). Cancel retries briefly while a worker may still be starting or publishing its PID. Unconfirmed attempts remain `cancel-requested` (reclaimable by status reconcile) or `cancel-failed` if the process is still running; they are never presented as cancelled.
`--json` selects structured JSON (single-job or bulk `results` list with `scope` / other-session attribution).
