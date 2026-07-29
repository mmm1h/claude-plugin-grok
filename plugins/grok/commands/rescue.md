---
description: Delegate investigation, implementation, or follow-up work to the Grok rescue subagent
argument-hint: "[--background|--wait] [--resume|--fresh] [--read-only] [--model <model>] [--effort <none|minimal|low|medium|high|xhigh>] [--timeout-ms <ms>] [--prompt-file <path>] [--session-id <id>] [--resume-job <job-id>] [what Grok should investigate, solve, or continue]"
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
- Preserve the following as runtime controls (not task prose) and forward them to companion `task` unchanged (except resume mapping below):
  - `--model`, `--effort`
  - `--timeout-ms` — Grok process timeout; omit only when the default 1-hour headless timeout is acceptable
  - `--prompt-file` — load the task body from a file (hard cap 16 MiB UTF-8); use for long prompts instead of stuffing the slash line
  - `--read-only` — force plan-mode / no-edit execution
  - `--session-id` / `--resume-job` — target a specific confirmed session or finished job
- Leave model, effort, timeout, and session targeting unset unless the user chose them.

Resume selection:
- Honor explicit `--resume` or `--fresh` without asking.
- Resume candidates are limited to confirmed, ended task sessions from the current Claude session and workspace. An active task in that scope blocks resume; without Claude session identity there is no cross-session fallback.
- Otherwise run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" task-resume-candidate --json
```

- If `available` is true, use `AskUserQuestion` exactly once:
  - `Continue current Grok session`
  - `Start a new Grok session`
- Put `Continue current Grok session (Recommended)` first for an obvious follow-up; otherwise put `Start a new Grok session (Recommended)` first.
- Add `--resume` or `--fresh` based on the answer.
- `--fresh` always allocates a new Grok session UUID before launch.
- If Grok is missing, stop and direct the user to `/grok:setup`.

Operating rules:
- The subagent is a thin forwarder. It uses exactly one Bash call to `node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" task ...`.
- The subagent tightens the request with the `grok-prompting` XML contract while
  preserving user intent. Same-session resume prompts contain only the delta.
- When `--prompt-file` is present, the file contents are the task body; still apply the prompting envelope only if the file is short user intent rather than an already-complete contract (do not rewrite large prebuilt prompts).
- Rescue/task is write-capable by default. Add `--read-only` only when the user requests diagnosis, research, planning, or no edits.
- Return companion stdout exactly as-is.
- Do not inspect files, poll status, fetch results, cancel jobs, summarize Grok, or do follow-up work inside the forwarding subagent.
- If the user supplied no task and no `--prompt-file`, ask what Grok should investigate or implement.
