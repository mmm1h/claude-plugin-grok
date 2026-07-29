---
description: Show the stored final output for a finished Grok job in this repository
argument-hint: '[job-id] [--wait] [--timeout-ms <ms>] [--poll-interval-ms <ms>] [--json]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" result "$ARGUMENTS"`

Present the full output exactly as returned. Preserve job status, the complete Grok output, errors, Grok session ID, file references, and resume guidance. Do not summarize it.
Preserve duration, exit code, last progress, session confirmation, resumability, and cancellation evidence when present.

Without `--wait`:
- Resolve a finished job (`completed` / `failed` / `cancelled`). Omit the job ID to use the latest finished job for this Claude session/workspace.
- Active `queued`/`running` jobs error with a pointer to `/grok:status`.

With `--wait` (requires a job ID):
- Poll until the job finishes or the wait budget expires.
- Default wait budget is **240000 ms** (4 minutes); override with `--timeout-ms <ms>` (non-negative).
- `--poll-interval-ms <ms>` sets the poll interval (default **1000**).
- On success, print the full stored result.
- On timeout, print the latest **status** snapshot (not a fake result) and exit code **124**.

`--json` selects structured JSON.

Resume guidance is emitted only for a confirmed, resumable task record; automatic candidate selection remains scoped to the originating Claude session and workspace. Failed orphan and cancellation results remain readable and include their terminal metadata.
