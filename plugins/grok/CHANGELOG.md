# Changelog

## 0.8.0 - 2026-07-30

### Breaking changes

- **Slash command surface reduced from 13 to 9** (codex-plugin-cc parity + `ps`):
  - **Removed** `/grok:export` → use `/grok:result [job-id] --out <path>`
  - **Removed** `/grok:logs` → use `/grok:status [job-id] --logs [N]` (default tail 80)
  - **Removed** `/grok:cleanup` slash command; companion subcommand
    `grok-companion.mjs cleanup` remains for manual ops
  - **Removed** `/grok:rerun` and the companion `rerun` subcommand entirely
- **Rerun request sidecar removed** (`jobs/<id>.rerun.json` is no longer written
  or read). Re-run failed work by starting a new task with a corrected prompt.
- Bundle from `result --out` is job + log only (no rerun payload / `hasRerun`).

### Features

- `status --logs [N]` tails the job log (optional job id = newest job).
- `result --out <path>` exports a portable JSON bundle (job record + log).

## 0.7.0 - 2026-07-30

### Breaking changes

- **`cancel --all` is now session-scoped.** It cancels only active jobs for the
  current Claude session (`GROK_COMPANION_CLAUDE_SESSION_ID`), not every active
  job in the workspace. Previously `--all` cancelled across all sessions in the
  same workspace, which could kill jobs owned by other Claude sessions.
  Cross-session bulk cancel requires the new explicit flag `--all-sessions`.
  When no session id is set (hookless / direct CLI), bulk cancel still covers
  the workspace but reports `scope: "no-session-id"` so the broader effect is
  never silent. `status --all` remains a read-only cross-session view.

### Features

- `cancel --all-sessions` cancels every active job in the workspace and reports
  how many (and which) belong to other Claude sessions, including job id and
  `claudeSessionId` in human and `--json` output.

## 0.6.0 - 2026-07-30

### Features

- Added `/grok:ps` (`grok-companion.mjs ps`) for **cross-workspace** process
  attribution: lists every active companion-managed PID under the state root
  (all repo buckets), with job id, kind, status, Claude session, workspace,
  start time, liveness, and an explicit decision (`do-not-kill` /
  `orphan-reclaimable` / `unknown-not-managed` / `ambiguous`).
- `ps --pid <pid>` reverse-lookup answers whether a PID is managed and safe to
  terminate. Prefer `/grok:cancel <job-id>` over raw kill.

### Documentation

- `delegate-to-grok` description and body, plus README, now tell agents to
  **always** use this plugin and never invoke the bare `grok` CLI (stdin,
  flags, Windows spawn, and job tracking differences).

## 0.5.2 - 2026-07-30

### Fixes

- Immediate background cancel is more reliable when the worker is still starting.
  `cancelTrackedJob` retries terminate/liveness checks with a bounded backoff,
  waits briefly for PID publication, and only marks `cancelled` after signal
  delivery or a confirmed exit (process was observed alive, then gone).
  Unconfirmed cancels stay `cancel-requested` / `cancel-failed` for later
  reclaim; `status` reconcile finishes pending cancels as `cancelled` when the
  PID is dead without inventing `terminationDelivered: true`.
- `enqueue` always publishes the spawn PID when the worker has not written one
  yet, including the race where the job flips to `running` before the launcher
  records `child.pid`.

## 0.5.1 - 2026-07-30

### Fixes

- `npm test` no longer relies on shell glob expansion of `tests/*.test.mjs`.
  Windows CI on Node 18 failed because PowerShell passes the pattern through
  literally; the script now uses bare `node --test` so the runner discovers
  `*.test.mjs` on every OS and Node version in the matrix.
- CI matrix now includes `macos-latest` (ubuntu / windows / macos × Node 18.18
  and 22).
- Orphan dead-worker reconciliation no longer loses `phase: process-exited`
  when a SIGTERM'd job-worker still finalizes as `failed`. Job CAS preserves
  process-exited attribution, and POSIX termination escalates to SIGKILL when
  the tree is still alive after SIGTERM.

### Documentation

- README rewritten for agent readers: capability overview, install (including a
  paste-ready agent install prompt), command table, job lifecycle and exit-code
  conventions. Target length under 120 lines.

### Features

- Added user-facing skill `delegate-to-grok`: when to hand work to Grok, which
  command to use, handoff shape (via `grok-prompting`), result handling, and
  explicit non-use boundaries.

### Chore

- Removed tracked scratch `tmp/codex-out/impl-report.md` and the on-disk `tmp/`
  residue; `.gitignore` now ignores all of `tmp/`.

## 0.5.0 - 2026-07-30

### Stability

- Resolved the Grok binary on Windows so npm `.cmd` shims start without a
  shell; prefers `.exe`, and runs `.cmd`/`.bat` via `ComSpec /d /s /c` with
  explicit quoting while keeping `shell:false` so prompts never land on a
  command line.
- Stop-review gate timeouts now terminate the whole companion process tree
  instead of relying on `spawnSync` timeout (which only kills the direct child
  and can leave a nested Grok worker holding Windows temp-directory locks).
- Windows `taskkill` partial failures (access denied / unsupported child) no
  longer throw when the target process is already gone, so cancel and orphan
  reaping stay reliable under concurrent load.
- Stopped leaking orphaned Grok processes: foreground runs no longer detach,
  SIGINT/SIGTERM terminate the process tree, and cancel kills the whole tree
  via process group plus `pgrep` fallback.
- Guarded against PID reuse with optional name/start-time verification.
- Gave each job file its own lock and compare-and-swap writes so terminal
  states cannot be rolled back by a late progress or completion write.
- Throttled progress writes, skipped silent token-level events, and swallowed
  log I/O errors so a locked or full disk cannot abort a job.
- Lock files now carry token and pid, support renewal, and use liveness rather
  than mtime alone to detect staleness.
- Backed up and rebuilt a corrupt `state.json` instead of silently emptying it
  (which previously let prune delete live job files).

### Compatibility

- Forced git UTF-8 output (`core.quotepath=false`,
  `i18n.logOutputEncoding=utf-8`) so non-ASCII paths and diffs survive a GBK
  console.
- Estimated diff size with `numstat`, raw gitlink detection, and on-disk size
  bounds instead of materializing a full binary diff just to test a threshold.
- Fell back to a clean commit-range diff when the working tree is dirty under
  branch scope, with actionable guidance when even that exceeds budget.
- Probed `grok --version`, enforced a minimum supported version, and reported
  missing flags so a CLI upgrade fails fast.
- Auth detection accepts credential files and `config.toml` `env_key` variables
  (third-party gateway style) without ever emitting secret values.

### Features

- Added `logs`, `cleanup`, `export`, and `rerun` job lifecycle commands.
- Task and resume gained `--session-id` and `--resume-job` (including cross
  Claude session), and empty-prompt resume now injects a continue prompt.
- `review`, `adversarial-review`, and `transfer` accept `--timeout-ms`;
  `transfer` supports `--background`.
- `status` supports `--kind`, `--status`, `--limit`, `--progress-lines`,
  `--poll-interval-ms`, and `--with-result`; `result` supports `--wait`;
  wait timeouts exit `124`.
- `cancel --all [--kind]` cancels active jobs in parallel.
- `usage()` now matches the real argument surface, including `--stop-review`.
- Fixed `status --all --limit N`: `--all` only opens session scope, and
  `--limit` always caps the listing. Bare `--all` (no `--limit`) remains
  unlimited; session mode without `--limit` still defaults to 8.

### Tests

- Grew coverage from 78 to 157+ cases.
- `fake-grok` can split stdout into chunks, exit mid-stream, flood stderr, and
  exit non-zero with a valid body so streaming regressions stay reproducible.

## 0.4.2 - 2026-07-29

- Fixed structured review parsing when a Grok JSON envelope's `text` field
  contains multiple concatenated turn payloads.
- Collected Grok streaming `text` event `data` fragments into the final task
  output instead of falling back to raw streaming JSON.
- Retried atomic JSON state renames on Windows `EPERM`, `EBUSY`, and `EACCES`
  errors so concurrent status reads cannot terminate background jobs.
- Isolated hookless tasks from inherited Claude session state so missing session
  scope never produces a resume candidate, including in the test environment.

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
