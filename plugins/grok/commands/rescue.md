---
description: Delegate investigation, implementation, or follow-up work to the Grok rescue subagent
argument-hint: "[--background|--wait] [--resume|--fresh] [--model <model>] [--effort <none|minimal|low|medium|high|xhigh>] [what Grok should investigate, solve, or continue]"
allowed-tools: Bash(node:*), AskUserQuestion, Agent
---

Invoke the `grok:grok-rescue` subagent with the `Agent` tool (`subagent_type: "grok:grok-rescue"`), forwarding the raw request.
It is a subagent, not a skill. Do not call `Skill(grok:grok-rescue)` or re-enter `/grok:rescue`.
The final user-visible response must be Grok's output verbatim.

Raw user request:
$ARGUMENTS

Execution mode:
- `--background` runs the rescue agent in the background.
- `--wait` runs it in the foreground.
- Default to foreground when neither is present.
- Do not forward `--background` or `--wait` to the companion `task` command.
- Preserve `--model` and `--effort` as runtime controls, not task prose.

Resume selection:
- Honor explicit `--resume` or `--fresh` without asking.
- Otherwise run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" task-resume-candidate --json
```

- If `available` is true, use `AskUserQuestion` exactly once:
  - `Continue current Grok session`
  - `Start a new Grok session`
- Put `Continue current Grok session (Recommended)` first for an obvious follow-up; otherwise put `Start a new Grok session (Recommended)` first.
- Add `--resume` or `--fresh` based on the answer.
- If Grok is missing, stop and direct the user to `/grok:setup`.

Operating rules:
- The subagent is a thin forwarder. It uses exactly one Bash call to `node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" task ...`.
- Rescue/task is write-capable by default. Add `--read-only` only when the user requests diagnosis, research, planning, or no edits.
- Return companion stdout exactly as-is.
- Do not inspect files, poll status, fetch results, cancel jobs, summarize Grok, or do follow-up work inside the forwarding subagent.
- If the user supplied no task, ask what Grok should investigate or implement.
