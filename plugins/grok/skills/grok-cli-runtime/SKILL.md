---
name: grok-cli-runtime
description: Internal contract for forwarding one request to the Grok companion runtime
user-invocable: false
---

# Grok Runtime

Use only inside `grok:grok-rescue`.

Primary helper:
`node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" task "<raw arguments>"`

## Companion command surface (reference)

The companion CLI supports these commands. The rescue forwarder may call **only** `task` (and the parent rescue command may call `task-resume-candidate` for resume UI). Do not call the others from this skill.

| Command | Role |
| --- | --- |
| `setup` | Offline readiness + optional stop-review gate toggle |
| `review` / `adversarial-review` | Read-only structured reviews |
| `task` | Write-capable or read-only delegated work (this skill) |
| `task-resume-candidate` | Resume candidate probe (parent command only) |
| `transfer` | Lossy Claude→Grok transcript handoff |
| `status` | Job list / single-job status; optional `--wait` / `--with-result` |
| `result` | Stored finished output; optional `--wait` |
| `cancel` | Cancel active job(s); optional `--all` / `--kind` |
| `logs` | Tail job log file |
| `cleanup` | Prune finished jobs (`--older-than` / `--keep` / `--dry-run`) |
| `export` | Bundle job + log + rerun sidecar |
| `rerun` | New job from saved request sidecar |
| `job-worker` | Internal background worker (never call manually) |

## `task` flags the forwarder must honor

```text
task [--background] [--write|--read-only] [--resume-last|--resume|--fresh]
     [--session-id <id>] [--resume-job <job-id>] [--model <id>] [--effort <level>]
     [--timeout-ms <ms>] [--prompt-file <path>] [--stop-review] [--json] [prompt]
```

Forwarder rules:

- Invoke `task` exactly once and return stdout unchanged.
- Do not call setup, review, adversarial-review, transfer, status, result, cancel, logs, cleanup, export, or rerun.
- Strip Claude execution flags `--background` and `--wait` (Claude-side only).
- Map `--resume` to `--resume-last`; strip `--fresh`.
- Pass through when present: `--model`, `--effort`, `--timeout-ms`, `--prompt-file`, `--read-only`, `--session-id`, `--resume-job`, `--json`.
- Do not invent `--timeout-ms` or `--prompt-file`. Default headless timeout is 1 hour when timeout is omitted; long jobs should receive an explicit `--timeout-ms` from the user/command layer.
- Prefer `--prompt-file` for large prompts (hard cap 16 MiB UTF-8) instead of stuffing the argv line.
- Automatic resume is limited to a confirmed, ended task from the current Claude session and workspace. Never discover or choose a session yourself, and never fall back to `grok sessions list`.
- Default to write-capable task execution; use `--read-only` for explicit no-edit work.
- Do not inspect the repository or perform any independent analysis.
- Task execution uses streaming progress internally. Preserve companion stdout, including phase, candidate/confirmed session identity, and any follow-up commands the companion prints.
- Do not poll or manage the resulting job. In particular, do not infer that a cancel succeeded: `cancelled` is trusted only after delivery or confirmed process exit, while an orphan is reconciled as `process-exited`.
- Do not perform transfer here. Transfer is a lossy handoff envelope into a new session, not a native import.
