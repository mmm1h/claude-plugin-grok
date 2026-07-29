# Changelog

## 0.2.0 - 2026-07-29

- Added schema-constrained normal and adversarial reviews with strict shape
  validation, read-only sandboxing, severity-ordered rendering, and fail-closed
  handling for truncated diff context.
- Added a bounded lossy handoff envelope with SHA-256 source identity, stable
  omission accounting, explicit truncation markers, and privacy-preserving
  transcript summaries. Transfer remains a new-session handoff, not native
  import.
- Isolated automatic resume to confirmed, ended task sessions from the current
  Claude session and workspace, removing the unscoped sessions-list fallback.
- Added task `streaming-json` progress with persisted phase, session identity,
  confirmation, and readable final/raw output.
- Hardened cancellation and orphan reconciliation so terminal states require
  process evidence; failed delivery remains `cancel-failed` and dead workers
  become `process-exited`.
- Expanded Grok-specific prompting guidance for coding, diagnosis, research,
  and structured-review follow-up, including compact XML blocks and recipes.

## 0.1.0 - 2026-07-29

- Initial Claude Code marketplace plugin.
- Added read-only review and adversarial review commands.
- Added write-capable rescue tasks with Grok session resume support.
- Added detached background jobs with status, result, wait, and cancellation.
- Added lossy Claude transcript handoff and optional stop-time review gate.
