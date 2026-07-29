---
name: delegate-to-grok
description: >
  Delegate substantial coding, diagnosis, research, multi-file implementation,
  CI failures, flaky-test hunts, or post-review follow-ups to the local Grok CLI
  via this plugin. Use when a second agent is faster/safer than inline work, or
  the user asks for Grok / rescue / background Grok. Prefer /grok:review or
  /grok:adversarial-review for local-git reviews. Skip for trivial one-file
  edits, pure chat, or tasks that need Claude-only live session context.
user-invocable: true
---

# Delegate to Grok

Claude orchestrates (decide → hand off → verify). Prefer slash commands.

## When to use

- Multi-file implementation, refactors with tests, long diagnosis
- CI / platform failures, flaky tests, log-driven root cause
- Read-only research or planning
- Follow-up on an accepted `/grok:review` finding
- User asks for Grok, rescue, or a background Grok job

## When not to

| Skip when… | Instead |
| --- | --- |
| Trivial / single-file, Claude is faster | Edit inline |
| Needs Claude-only live context (UI, secrets, in-thread decisions) | Stay in Claude |
| Structured working-tree/branch review | `/grok:review` or `/grok:adversarial-review` |
| Cost/latency-sensitive micro-tasks | Inline |
| Grok missing or unauthenticated | `/grok:setup`, then `grok login` |
| User forbids external agents or writes | No write-capable rescue |

## Commands

| Goal | Command |
| --- | --- |
| Implement / diagnose / research | `/grok:rescue …` |
| Read-only | `/grok:rescue --read-only …` |
| Git review | `/grok:review --wait` (or `--background`) |
| Design pressure-test | `/grok:adversarial-review …` |
| Long job | `--background`, then status/result/logs |
| Continue / fresh | `--resume` / `--fresh` |
| Transcript handoff | `/grok:transfer` |

Rescue is subagent `grok:grok-rescue` (slash or `Agent`), not a skill. Never `Skill(grok:grok-rescue)`.

## Handoff shape

Load `grok-prompting`. Envelope: `task`, `grounding_rules`, `constraints`,
`done_when`, `output_contract`.

1. One job, observable end state, concrete paths and checks.
2. Facts vs hypotheses; do not invent repo state.
3. Rescue is write-capable unless `--read-only`.
4. Tests/lint in `done_when`; forbid unrelated refactors/commits/pushes unless asked.
5. Large briefs → `--prompt-file` (16 MiB). Default timeout 1h; set `--timeout-ms` if longer.
6. Resume prompts are deltas only.

## Results

Follow `grok-result-handling`: present companion output as-is; background via
`/grok:status <id> --wait --with-result` or `/grok:result <id> --wait`; exit
**124** = still running (keep id); logs `/grok:logs`; cancel `/grok:cancel`;
no auto-fix after review; trust `cancelled` only after delivery/exit;
auth → `/grok:setup`.

```text
/grok:rescue --background implement docs/plan.md and run npm test
/grok:status task-… --wait --with-result
```
