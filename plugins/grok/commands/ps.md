---
description: List companion-managed processes across all workspaces, or look up a PID
argument-hint: '[--pid <pid>] [--include-terminal] [--json]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" ps "$ARGUMENTS"`

Cross-workspace process attribution for this plugin (not limited to the current repo).

List mode (default):
- Scans every state bucket under `~/.claude/grok-companion/` (or `GROK_COMPANION_HOME`)
- Shows active (`queued`/`running`) jobs that still have a recorded PID
- Each row includes pid, jobId, kind, status, claudeSessionId, workspaceRoot, started time, alive, and a **decision** label

Lookup mode:
- `--pid <pid>` answers whether that PID is managed by this plugin and whether it is safe to terminate
- Decisions:
  - `do-not-kill` / **ACTIVE — do not kill** — live companion job (use `/grok:cancel <job-id>` instead of raw kill)
  - `orphan-reclaimable` — job still active in state but PID is dead; reclaim via `/grok:status` or `/grok:cancel`
  - `unknown-not-managed` — not in companion records; do not assume it is an orphan
  - `ambiguous` — multiple jobs claim the PID; inspect before acting

Options:
- `--include-terminal` — also list terminal jobs that still have a pid field (usually empty after finalize)
- `--json` — structured payload

Limits (also printed in the report):
- Attribution is job-record based, not OS process tags
- Only the job-worker PID is stored; nested `grok` children match only via best-effort parent/descendant walk (often unavailable on Windows)
- PID reuse can map a dead job's number onto an unrelated process — prefer job id + cancel over raw kill
- Bare `grok` CLI processes started outside this plugin never appear here
