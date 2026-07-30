---
description: Show active and recent Grok jobs for this repository
argument-hint: '[job-id] [--all] [--kind <kind>] [--status <status>] [--limit N] [--progress-lines N] [--logs [N]] [--wait] [--with-result] [--timeout-ms <ms>] [--poll-interval-ms <ms>] [--json]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" status "$ARGUMENTS"`

With no job ID, present the **three-section** Markdown report exactly as returned:
1. **Running** — queued/running jobs
2. **Latest finished** — most recent terminal job
3. **Recent** — other recent finished jobs (excluding the latest)

Keep job ID, kind, status, phase, elapsed or duration, progress, summary, session evidence, and actions. JSON still exposes a flat `jobs` array plus `running`, `latestFinished`, and `recent`.

With a job ID, present the full single-job status without summarizing.

Filters and options (list mode, no job ID unless noted):
- `--all` — include jobs outside the current Claude session scope and ignore the default list cap
- `--kind <kind>` — filter by job kind (`task`, `review`, `adversarial-review`, `transfer`, `stop-review`, …)
- `--status <status>` — filter by status (`queued`, `running`, `completed`, `failed`, `cancelled`, …)
- `--limit N` — cap listed jobs (default 8 when `--all` is not set)
- `--progress-lines N` — how many recent progress lines to attach per job (non-negative)
- `--logs [N]` — print the job log tail instead of the status report (default **80** lines; job ID optional = newest job). Not combinable with `--wait` / `--with-result`
- `--json` — structured JSON instead of Markdown tables

Wait mode (requires a job ID):
- `--wait` polls until the job leaves `queued`/`running` or the wait budget expires
- Default wait budget is **240000 ms** (4 minutes); override with `--timeout-ms <ms>` (non-negative; `0` means do not wait beyond the first snapshot)
- `--poll-interval-ms <ms>` sets the poll interval (default **1000**)
- `--with-result` requires `--wait` and a job ID; when the job finishes before timeout, print the full stored result (same shape as `/grok:result`) instead of only status
- On wait timeout, return the latest status snapshot and exit code **124**; do not discard current state

Running task jobs report live structured phase/progress and distinguish a candidate session ID from a confirmed one. If status finds an active job whose PID has exited, it persists `failed` / `process-exited` so the result is retrievable.
