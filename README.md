# Grok plugin for Claude Code

Use the local Grok CLI from inside Claude Code for read-only code reviews, delegated tasks, transcript handoff, and tracked background jobs.

This is **Claude Code -> Grok**. It is not a Grok-to-Codex plugin and it does not use the Codex app-server runtime.

## Requirements

- Grok CLI available as `grok`
- A working Grok login or API configuration
- Node.js 18.18 or later
- Git for review commands

Run `grok login` before the first paid model call if Grok is not already authenticated.

## Install

Add the marketplace:

```text
/plugin marketplace add mmm1h/claude-plugin-grok
```

Install the plugin:

```text
/plugin install grok@claude-plugin-grok
```

Reload Claude Code plugins:

```text
/reload-plugins
```

Then check the local runtime without making a model call:

```text
/grok:setup
```

## Commands

### `/grok:review`

Runs a read-only review of the current working tree, or of a branch against a base ref.

```text
/grok:review --wait
/grok:review --background
/grok:review --base main
/grok:review --scope branch
```

The companion collects git status and diff context itself. Grok receives only the `read_file`, `grep`, and `list_dir` tools in `plan` permission mode, with shell, edit, subagent, and web tools unavailable.

### `/grok:adversarial-review`

Pressure-tests the implementation direction, assumptions, tradeoffs, and failure modes. It uses the same target selection as `/grok:review` and accepts focus text.

```text
/grok:adversarial-review --base main challenge the rollback and concurrency design
/grok:adversarial-review --background look for tenant-isolation failures
```

This command is also strictly read-only.

### `/grok:rescue`

Delegates a diagnosis, implementation, or follow-up task through the `grok:grok-rescue` subagent.

```text
/grok:rescue investigate why CI fails on Windows
/grok:rescue --background implement the smallest safe fix and run tests
/grok:rescue --resume apply the next step from the previous Grok run
/grok:rescue --fresh --model grok-code-fast-1 --effort high diagnose the regression
```

Rescue tasks are write-capable by default. Ask for read-only diagnosis or planning when no edits should be allowed. Model and effort are left to the local Grok defaults unless supplied explicitly.

### `/grok:transfer`

Reads the current Claude Code JSONL transcript, extracts user and assistant text turns, sends a bounded handoff prompt in one read-only Grok call, and prints a resumable session ID.

```text
/grok:transfer
/grok:transfer --source C:\Users\me\.claude\projects\...\session.jsonl
```

Transfer is intentionally **not** a native session import. Grok receives a lossy Markdown prompt:

- tool calls, tool results, images, and hidden reasoning are omitted;
- older turns and oversized turns can be truncated;
- one Grok model call is used to create and acknowledge the handoff;
- continue with `grok --resume <session-id>`.

### `/grok:status`

Shows active and recent jobs for the repository.

```text
/grok:status
/grok:status task-abc123
/grok:status task-abc123 --wait --timeout-ms 120000
/grok:status --all
```

### `/grok:result`

Prints the complete stored output for a finished job.

```text
/grok:result
/grok:result task-abc123
```

### `/grok:cancel`

Terminates an active background worker and its process tree.

```text
/grok:cancel
/grok:cancel task-abc123
```

### `/grok:setup`

Checks Node, `grok --version`, local authentication evidence, and review-gate configuration without sending a model prompt.

```text
/grok:setup
/grok:setup --enable-review-gate
/grok:setup --disable-review-gate
```

The optional Stop hook runs a read-only Grok check before Claude ends a turn. It can create long Claude/Grok loops and consume usage quickly, so it is disabled by default.

## Runtime Differences

This repository follows the user-facing shape of `openai/codex-plugin-cc`, but the runtime is deliberately different:

| Area | `openai/codex-plugin-cc` | `claude-plugin-grok` |
| --- | --- | --- |
| Local engine | Codex CLI plus app-server | Grok headless CLI |
| Protocol | app-server JSON-RPC and broker | direct cross-platform process spawn |
| Review | Codex app-server review | prompt-file headless call with strict read-only tools |
| Write task | Codex sandbox/config integration | `--always-approve --permission-mode bypassPermissions` |
| Read-only task | Codex read-only sandbox | `plan` plus `read_file,grep,list_dir` allowlist |
| Session ID | app-server thread ID | plugin-created UUID passed through `--session-id` |
| Transfer | native external-agent import | lossy transcript-to-handoff prompt |
| Resume-last | persistent Codex thread lookup | companion jobs, then `grok sessions list` |

No Codex app-server, broker, JSON-RPC protocol, generated app-server types, `codex.mjs`, or `@openai/codex` dependency is included.

## State and Privacy

Repository state is stored outside the repository:

```text
~/.claude/grok-companion/<repo-name>-<path-hash>/
```

Each bucket contains a bounded job index plus per-job JSON result and log files. Full prompts and transcript excerpts are present only while a job is queued or running and are removed from the stored job when it finishes. Treat this user-level directory as private. Nothing is written into the reviewed repository except changes Grok makes during an explicitly write-capable task.

## Development

```bash
npm install
npm test
npm run check-version
node plugins/grok/scripts/grok-companion.mjs setup --json
```

Tests use a fake Grok process and do not require Grok login or consume model usage.

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
