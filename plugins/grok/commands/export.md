---
description: Export a Grok job record, log, and rerun payload to a JSON bundle
argument-hint: '<job-id> [--out <path>] [--json]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" export "$ARGUMENTS"`

Present the export path and whether the bundle includes the log and rerun sidecar.

- Job ID is required.
- Default output path is `<job-id>.export.json` under the workspace root unless `--out` is set.
- Bundle fields: job record, full log text when present, rerun sidecar when present, `exportedAt`, and workspace root.
- `--json` selects structured JSON metadata about the export (`outPath`, `hasLog`, `hasRerun`, `bytes`, …).
