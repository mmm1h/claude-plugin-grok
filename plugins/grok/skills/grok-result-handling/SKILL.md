---
name: grok-result-handling
description: Internal guidance for presenting Grok companion output
user-invocable: false
---

# Grok Result Handling

## Preserve companion output

- Preserve Grok output, evidence boundaries, paths, line numbers, uncertainties, and resume commands.
- Preserve task streaming progress, live phase, session ID, session
  confirmation, cancellation delivery, and `process-exited` details. A
  preallocated session ID is not resumable until `sessionConfirmed=true`.
- Show resume guidance only when the stored task is explicitly confirmed and
  resumable in the originating Claude-session/workspace scope.
- Describe transfer results as a lossy handoff envelope with source hash and
  omission accounting, never as a native session import.
- Treat `cancelled` as trusted only when termination was delivered or process
  exit was confirmed. Preserve `cancel-failed` and orphan `process-exited`
  states without softening them.
- For reviews, keep findings first and ordered by severity.
- If no findings were reported, preserve that statement and any residual-risk note.
- Never turn a failed Grok run into an unrequested Claude-side implementation.
- After presenting review findings, stop. Do not apply fixes until the user explicitly requests them.
- Forwarders must not poll, fetch, cancel, or otherwise manage companion jobs.
- If setup or authentication is required, direct the user to `/grok:setup`.

## Status: three-section list and wait modes

- `/grok:status` without a job ID renders **Running**, **Latest finished**, and
  **Recent** sections. Present those tables as returned. JSON also keeps a flat
  `jobs` array plus `running`, `latestFinished`, and `recent`.
- Filters (`--kind`, `--status`, `--limit`, `--all`, `--progress-lines`) change
  which rows appear; do not re-filter or re-sort in prose.
- `/grok:status <job-id> --wait` polls until terminal or timeout. Default wait
  budget is 240s; timeout returns the latest snapshot with exit code **124** and
  JSON fields `waitedJobId`, `waitTimedOut`, and `timeoutMs`.
- `--with-result` requires `--wait` and a job ID. When the job finishes in time,
  present the full stored result (same content as `/grok:result`), not a
  condensed status line.

## Result and logs

- `/grok:result` shows the full stored output for a finished job.
- `/grok:result --wait` (job ID required) waits for completion, then prints the
  result; on timeout it prints a **status** snapshot (not a fabricated result)
  and exits **124**.
- Prefer `/grok:logs <job-id>` for live or historical progress lines (default
  tail 80). Do not invent progress from memory when the log command is available.

## Lifecycle helpers

- `/grok:export` writes a portable JSON bundle (job + log + rerun sidecar).
  Present the path and `hasLog` / `hasRerun` facts.
- `/grok:cleanup` deletes finished job artifacts only when `--older-than` and/or
  `--keep` select them. Prefer reporting a prior `--dry-run` selection before
  destructive cleanup. Active jobs are never removed.
- `/grok:rerun` launches a **new** job from the saved request; it is not a
  session resume unless the stored request already resumed one. Point the user
  at the new job id for status/result/logs.

## Wait / timeout presentation

- When a wait times out, say the job is still active (or report the snapshot
  status) and preserve the job id for `/grok:status`, `/grok:logs`,
  `/grok:cancel`, or a longer `--timeout-ms` retry.
- Do not claim success on exit code 124 or on `waitTimedOut: true`.
