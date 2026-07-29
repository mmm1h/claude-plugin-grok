# Changelog

## 0.4.1 - 2026-07-29

- Fixed multi-turn structured review parse failures when Grok emits concatenated
  JSON objects (`{}{}`); the companion now keeps the last complete payload.
- Recognized Grok CLI `thought` / `text` / `end` streaming events so reasoning
  tokens no longer leak as "unknown" progress into Claude context.
- Stop-review gate now short-circuits clean working trees and non-git workspaces
  without a paid Grok call (ALLOW by silence), matching the no-edit intent.

## 0.4.0 - 2026-07-29

- Added a strict `{ decision, reason }` schema for stop-time reviews and routed
  `task --stop-review` through Grok's schema-constrained read-only sandbox.
- Made the Stop hook prefer validated structured decisions while retaining
  compatibility with legacy `ALLOW:` and `BLOCK:` first-line responses.
- Scoped the gate to files directly edited in the immediately previous Claude
  turn, allowed no-edit turns immediately, and excluded old working-tree and
  style-only findings from blocking decisions.
- Added a clean-tree empty-message short circuit and explicit fail-closed
  guidance to run `/grok:review --wait` manually when output cannot be parsed.

## 0.3.0 - 2026-07-29

- Added threshold-based review evidence collection: changes of at most 2 files
  and 256 KiB stay inline, while larger reviews receive status, changed paths,
  diff stat, and explicit self-collection guidance.
- Kept self-collection inside Grok's existing read-only sandbox and
  `read_file,grep,list_dir` allowlist; general shell access remains disabled.
- Reserved `truncated` for genuine incomplete-evidence failures, which still
  fail closed before Grok can approve, while self-collected reviews run normally.
- Bounded self-collection summaries and fail closed without emitting a partial
  file list or stat when even the lightweight evidence exceeds its budget.
- Exposed the review evidence mode in rendered results and fail closed when a
  dirty working tree would contaminate branch self-collection evidence.
- Split status output into Running, Latest finished, and Recent sections while
  preserving the flat `jobs` JSON field for compatibility.
- Added unique job-ID prefix matching and strengthened stored duration, exit
  code, session confirmation, resumability, progress, and cancellation evidence.

## 0.2.1 - 2026-07-29

- Made `status --wait` require an explicit job ID and return the resolved job
  ID, timeout outcome, effective timeout, and latest snapshot.
- Expanded status, result, and resume-candidate metadata with progress timing,
  elapsed or total duration, session confirmation, resumability, exit code,
  and existing cancellation evidence.
- Persisted execution duration and exit code in stored jobs and the job index,
  with runtime coverage for completed and timed-out waits.

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
