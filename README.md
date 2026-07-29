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

The companion selects the evidence mode before invoking Grok. Changes of at most 2 files and 256 KiB of tracked diff are included inline. Larger changes use `self-collect`: the prompt contains git status, changed paths, diff stat, and instructions to inspect relevant files itself. Grok still receives only the `read_file`, `grep`, and `list_dir` tools in `plan` permission mode, with shell, edit, subagent, and web tools unavailable. Self-collection is not truncation; genuinely incomplete evidence still fails closed before the model call. Branch self-collection also fails closed when a dirty working tree would make direct file reads disagree with the selected commit range.

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

Reads the current Claude Code JSONL transcript, extracts visible conversation context and bounded tool/compaction summaries, sends one read-only handoff prompt, and prints a resumable session ID plus a local source-hash and omission report.

```text
/grok:transfer
/grok:transfer --source C:\Users\me\.claude\projects\...\session.jsonl
```

Transfer is intentionally **not** a native session import. Grok receives a lossy Markdown prompt:

- user/assistant text, bounded tool parameter/result summaries, visible compaction summaries, and attachment descriptions are retained where possible;
- hidden reasoning and binary attachment bodies are excluded, while oversized turns are capped at 24,000 characters and the newest turns are selected within a 180,000-character total budget (JavaScript UTF-16 code units);
- truncation and oldest-turn removal use explicit markers; malformed JSON and other losses appear in the local omission report;
- one synthetic user prompt and one Grok acknowledgement create a new session;
- native tool identity/history graphs, Claude message IDs, permissions, hooks, checkpoints, and hidden reasoning cannot be migrated;
- continue with `grok --resume <session-id>`.

### `/grok:status`

Shows Running, Latest finished, and Recent job sections for the repository. JSON output keeps the backward-compatible flat `jobs` array and also exposes `running`, `latestFinished`, and `recent`.
`--wait` requires an explicit job ID. JSON wait responses include the resolved
`waitedJobId`, boolean `waitTimedOut`, and effective `timeoutMs`; timing out
returns the latest job snapshot so it can still be inspected or cancelled.

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

The optional Stop hook reviews only files directly edited in Claude's immediately previous turn. Turns with no file edits or no attributable diff are allowed immediately, and older working-tree findings are out of scope. The gate uses schema-constrained `{ decision, reason }` output in Grok's read-only sandbox; malformed output fails closed with guidance to run `/grok:review --wait` manually. It can create long Claude/Grok loops and consume usage quickly, so it remains disabled by default and is enabled only with `/grok:setup --enable-review-gate`.

## Runtime Differences

This repository follows the user-facing shape of `openai/codex-plugin-cc`, but the runtime is deliberately different:

| Area | `openai/codex-plugin-cc` | `claude-plugin-grok` |
| --- | --- | --- |
| Local engine | Codex CLI plus app-server | Grok headless CLI |
| Protocol | app-server JSON-RPC and broker | direct cross-platform process spawn |
| Review | Codex app-server review mode | `--json-schema` plus `--sandbox read-only`; small diffs inline, large diffs self-collect through `read_file,grep,list_dir`, and true truncation fails closed |
| Write task | Codex sandbox/config integration | `--always-approve --permission-mode bypassPermissions` |
| Read-only task | Codex read-only sandbox | `plan` plus `read_file,grep,list_dir` allowlist |
| Session ID | app-server thread ID | plugin-created UUID passed through `--session-id` |
| Transfer | native external-agent import | lossy handoff envelope with source hash and omission accounting; one synthetic turn, not native import |
| Resume | persistent Codex thread lookup | confirmed ended task sessions scoped to the current Claude session and workspace; no sessions-list fallback |
| Telemetry | app-server notifications | task `streaming-json`; status persists phase, progress, session ID, and confirmation |
| Cancel | app-server turn interrupt | process-tree termination; `cancelled` only after delivery or confirmed exit, and dead orphans become `failed` / `process-exited` |

No Codex app-server, broker, JSON-RPC protocol, generated app-server types, `codex.mjs`, or `@openai/codex` dependency is included.

### Known gaps / ceiling vs `codex-plugin-cc`

- Grok has no app-server-native review mode or turn interrupt; reviews and
  cancellation are implemented around the headless CLI process.
- Transfer cannot import Claude's native session graph. It creates a new Grok
  session from a bounded, lossy handoff envelope.
- Grok cannot run read-only git shell commands in review mode. Large-diff
  self-collection therefore uses status/stat evidence plus direct file reads;
  deleted-file claims remain limited to evidence the prompt can safely expose.

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
