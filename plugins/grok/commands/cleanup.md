---
description: Prune old finished Grok jobs from the local companion index
argument-hint: '[--older-than <duration>] [--keep N] [--dry-run] [--json]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" cleanup "$ARGUMENTS"`

Selection (require at least one selector):
- `--older-than <duration>` — keep jobs younger than this age; delete older terminal jobs. Accepts `7d`, `24h`, `90m`, `30s`, bare milliseconds, etc.
- `--keep N` — among terminal jobs, keep the newest N and delete the rest.
- When both are set, a job is removed only if it is old enough **and** outside the newest-N protected set.
- Active `queued`/`running` jobs are **never** removed.

Safety:
- Prefer `--dry-run` first: lists the jobs and paths that would be deleted without unlinking anything.
- Without `--dry-run`, deletes each selected job's result JSON, log file, and rerun sidecar, then updates the job index.
- Export important jobs with `/grok:export` before deleting them.
- `--json` selects structured JSON (`dryRun`, `removedCount`, `removed`).
