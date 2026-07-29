---
name: grok-cli-runtime
description: Internal contract for forwarding one request to the Grok companion runtime
user-invocable: false
---

# Grok Runtime

Use only inside `grok:grok-rescue`.

Primary helper:
`node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" task "<raw arguments>"`

- Invoke `task` exactly once and return stdout unchanged.
- Do not call setup, review, adversarial-review, transfer, status, result, or cancel.
- Strip Claude execution flags `--background` and `--wait`.
- Map `--resume` to `--resume-last`; strip `--fresh`.
- Pass explicit model and effort values through.
- Default to write-capable task execution; use `--read-only` for explicit no-edit work.
- Do not inspect the repository or perform any independent analysis.
- Do not poll or manage the resulting job.
