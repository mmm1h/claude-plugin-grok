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
- Automatic resume is limited to a confirmed, ended task from the current
  Claude session and workspace. Never discover or choose a session yourself,
  and never fall back to `grok sessions list`.
- Pass explicit model and effort values through.
- Default to write-capable task execution; use `--read-only` for explicit no-edit work.
- Do not inspect the repository or perform any independent analysis.
- Task execution uses streaming progress internally. Preserve companion stdout,
  including phase, candidate/confirmed session identity, and status commands.
- Do not poll or manage the resulting job. In particular, do not infer that a
  cancel succeeded: `cancelled` is trusted only after delivery or confirmed
  process exit, while an orphan is reconciled as `process-exited`.
- Do not perform transfer here. Transfer is a lossy handoff envelope into a new
  session, not a native import.
