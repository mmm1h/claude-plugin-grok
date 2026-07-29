# Grok plugin for Claude Code

Use the local Grok CLI from inside Claude Code for read-only code reviews, delegated tasks, transcript handoff, and tracked background jobs.

This is **Claude Code → Grok**. It is not a Grok-to-Codex plugin and it does not use the Codex app-server runtime.

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

Slash commands map to `plugins/grok/scripts/grok-companion.mjs`. Full CLI help:

```bash
node plugins/grok/scripts/grok-companion.mjs --help
```

### `/grok:review`

Runs a read-only review of the current working tree, or of a branch against a base ref.

```text
/grok:review --wait
/grok:review --background
/grok:review --base main
/grok:review --scope branch
/grok:review --model <id> --timeout-ms 1800000 --json
```

Options: `--wait` | `--background`, `--base <ref>`, `--scope auto|working-tree|branch`, `--model <id>`, `--timeout-ms <ms>`, `--json`.

The companion selects the evidence mode before invoking Grok. Changes of at most 2 files and 256 KiB of tracked diff are included inline. Larger changes use `self-collect`: the prompt contains git status, changed paths, diff stat, and instructions to inspect relevant files itself. Grok still receives only the `read_file`, `grep`, and `list_dir` tools in `plan` permission mode, with shell, edit, subagent, and web tools unavailable. Self-collection is not truncation; genuinely incomplete evidence still fails closed before the model call.

**Dirty working tree on branch review:** when branch self-collection would rely on file reads while the tree is dirty, the companion first embeds the **clean commit-range** diff and warns that working-tree reads are not authoritative. Only if that clean range still exceeds the evidence budget does the review fail closed, with recovery options such as `--scope working-tree`, stashing/committing, or narrowing the range.

### `/grok:adversarial-review`

Pressure-tests the implementation direction, assumptions, tradeoffs, and failure modes. Same target selection and options as `/grok:review`, plus free-form focus text.

```text
/grok:adversarial-review --base main challenge the rollback and concurrency design
/grok:adversarial-review --background look for tenant-isolation failures
```

This command is also strictly read-only.

### `/grok:rescue`

Delegates a diagnosis, implementation, or follow-up task through the `grok:grok-rescue` subagent (thin forwarder to companion `task`).

```text
/grok:rescue investigate why CI fails on Windows
/grok:rescue --background implement the smallest safe fix and run tests
/grok:rescue --resume apply the next step from the previous Grok run
/grok:rescue --fresh --model grok-code-fast-1 --effort high diagnose the regression
/grok:rescue --read-only --timeout-ms 7200000 map the auth flow without editing
/grok:rescue --prompt-file ./long-brief.md implement the plan
```

Claude-side: `--background` | `--wait`. Forwarded to companion: `--resume` (→ `--resume-last`), `--fresh`, `--read-only`, `--model`, `--effort`, `--timeout-ms`, `--prompt-file`, `--session-id`, `--resume-job`.

Rescue tasks are write-capable by default. Ask for read-only diagnosis or planning when no edits should be allowed. Model, effort, and timeout are left to local Grok / companion defaults unless supplied. Default Grok process timeout is **1 hour** when `--timeout-ms` is omitted. Prompt bodies (argv, stdin, or `--prompt-file`) are capped at **16 MiB** UTF-8.

### `/grok:transfer`

Reads the current Claude Code JSONL transcript, extracts visible conversation context and bounded tool/compaction summaries, sends one read-only handoff prompt, and prints a resumable session ID plus a local source-hash and omission report.

```text
/grok:transfer
/grok:transfer --source C:\Users\me\.claude\projects\...\session.jsonl
/grok:transfer --background --timeout-ms 600000
```

Options: `--background`, `--source <claude-jsonl>`, `--timeout-ms <ms>`, `--json`.

Transfer is intentionally **not** a native session import. Grok receives a lossy Markdown prompt:

- user/assistant text, bounded tool parameter/result summaries, visible compaction summaries, and attachment descriptions are retained where possible;
- hidden reasoning and binary attachment bodies are excluded, while oversized turns are capped at 24,000 characters and the newest turns are selected within a 180,000-character total budget (JavaScript UTF-16 code units);
- truncation and oldest-turn removal use explicit markers; malformed JSON and other losses appear in the local omission report;
- one synthetic user prompt and one Grok acknowledgement create a new session;
- native tool identity/history graphs, Claude message IDs, permissions, hooks, checkpoints, and hidden reasoning cannot be migrated;
- continue with `grok --resume <session-id>`.

### `/grok:status`

Shows **Running**, **Latest finished**, and **Recent** job sections for the repository. JSON keeps a flat `jobs` array and also exposes `running`, `latestFinished`, and `recent`.

```text
/grok:status
/grok:status task-abc123
/grok:status task-abc123 --wait --timeout-ms 120000
/grok:status task-abc123 --wait --with-result
/grok:status --all --kind task --status failed --limit 20
/grok:status --progress-lines 12
```

Options: optional `[job-id]`, `--all`, `--kind <kind>`, `--status <status>`, `--limit N`, `--progress-lines N`, `--wait`, `--with-result` (requires `--wait` + job id), `--timeout-ms <ms>` (default wait budget **240000**), `--poll-interval-ms <ms>` (default **1000**), `--json`.

`--wait` requires a job ID. Wait timeout returns the latest snapshot with exit code **124** and JSON fields `waitedJobId`, `waitTimedOut`, `timeoutMs`. Running task jobs report live phase/progress and distinguish candidate vs confirmed session IDs. Dead-PID active jobs are reconciled to `failed` / `process-exited`.

### `/grok:result`

Prints the complete stored output for a finished job.

```text
/grok:result
/grok:result task-abc123
/grok:result task-abc123 --wait --timeout-ms 300000
```

Options: optional `[job-id]`, `--wait` (job id required), `--timeout-ms`, `--poll-interval-ms`, `--json`. Without `--wait`, active jobs error. With `--wait`, timeout yields a status snapshot and exit code **124**.

### `/grok:cancel`

Terminates an active background worker and its process tree.

```text
/grok:cancel
/grok:cancel task-abc123
/grok:cancel --all
/grok:cancel --all --kind review
```

Options: optional `[job-id]`, `--all` (not with a job id), `--kind <kind>`, `--json`. Multiple active jobs without an id require a job id or `--all`. Cancellation is terminal only after a signal is delivered or the PID is confirmed exited; failed termination is `cancel-failed`, never soft-reported as cancelled.

### `/grok:logs`

Tails the on-disk log for a job (default last **80** lines).

```text
/grok:logs task-abc123
/grok:logs task-abc123 --tail 200
```

Options: optional `[job-id]` (defaults to newest job), `--tail N`, `--json`.

### `/grok:cleanup`

Prunes finished jobs from the local companion index and deletes their result, log, and rerun files. Active jobs are never removed.

```text
/grok:cleanup --dry-run --older-than 7d
/grok:cleanup --keep 20
/grok:cleanup --older-than 24h --keep 5
```

Require at least one of `--older-than <duration>` (e.g. `7d`, `24h`, `90m`) or `--keep N`. When both are set, a job is removed only if it is old enough **and** outside the newest-N set. Prefer `--dry-run` first; export important jobs with `/grok:export` before deleting.

### `/grok:export`

Exports a portable JSON bundle (job record + log text + rerun sidecar when present).

```text
/grok:export task-abc123
/grok:export task-abc123 --out ./backup/task-abc123.export.json
```

Default path: `<job-id>.export.json` under the workspace root.

### `/grok:rerun`

Launches a **new** job from the request saved when the source job was queued (rerun sidecar). Does not resume the prior Grok session unless the stored request already did.

```text
/grok:rerun task-abc123 --background
/grok:rerun task-abc123
```

Source must not still be `queued`/`running`. Jobs without a sidecar or residual request cannot be rerun.

### `/grok:setup`

Checks Node, `grok --version` / capabilities, **offline** authentication evidence, and review-gate configuration without sending a model prompt.

```text
/grok:setup
/grok:setup --enable-review-gate
/grok:setup --disable-review-gate
/grok:setup --json
```

Authentication is local evidence only by default:

- **Configured:** `GROK_API_KEY` / `XAI_API_KEY`, a non-empty credential file under `~/.grok/`, `config.toml` `env_key` with that env var set, or a non-empty inline `api_key` in `config.toml`.
- **Needs login:** missing credentials, or only a bare `config.toml` / `agent_id` without a key or credential file (not treated as ready).
- Setup does not probe the network or run a paid model call; run `grok login` if the first real task reports an auth error.

The optional Stop hook reviews only files directly edited in Claude's immediately previous turn. Turns with no file edits or no attributable diff are allowed immediately, and older working-tree findings are out of scope. The gate uses schema-constrained `{ decision, reason }` output in Grok's read-only sandbox; malformed output fails closed with guidance to run `/grok:review --wait` manually. It can create long Claude/Grok loops and consume usage quickly, so it remains disabled by default and is enabled only with `/grok:setup --enable-review-gate`.

## Typical workflows

**Foreground review of a small change**

```text
/grok:review --wait
```

**Background review, then poll**

```text
/grok:review --background --base main
/grok:status review-... --wait --with-result
```

**Long delegated implementation**

```text
/grok:rescue --background --timeout-ms 7200000 implement the plan in docs/plan.md and run tests
/grok:logs task-... --tail 100
/grok:result task-... --wait
```

**Handoff Claude context into a Grok session**

```text
/grok:transfer --background
/grok:result transfer-... --wait
```

**Housekeeping**

```text
/grok:export task-... --out ./archives/task-....export.json
/grok:cleanup --dry-run --older-than 7d
/grok:cleanup --older-than 7d --keep 10
/grok:rerun task-... --background
```

## Runtime Differences

This repository follows the user-facing shape of `openai/codex-plugin-cc`, but the runtime is deliberately different:

| Area | `openai/codex-plugin-cc` | `claude-plugin-grok` |
| --- | --- | --- |
| Local engine | Codex CLI plus app-server | Grok headless CLI |
| Protocol | app-server JSON-RPC and broker | direct cross-platform process spawn |
| Review | Codex app-server review mode | `--json-schema` plus `--sandbox read-only`; small diffs inline, large diffs self-collect through `read_file,grep,list_dir`; dirty branch self-collect prefers clean commit-range evidence; true truncation fails closed |
| Write task | Codex sandbox/config integration | `--always-approve --permission-mode bypassPermissions` |
| Read-only task | Codex read-only sandbox | `plan` plus `read_file,grep,list_dir` allowlist |
| Session ID | app-server thread ID | plugin-created UUID passed through `--session-id` |
| Transfer | native external-agent import | lossy handoff envelope with source hash and omission accounting; one synthetic turn, not native import |
| Resume | persistent Codex thread lookup | confirmed ended task sessions scoped to the current Claude session and workspace; no sessions-list fallback |
| Telemetry | app-server notifications | task `streaming-json`; status persists phase, progress, session ID, and confirmation |
| Job ops | app-server turn lifecycle | tracked jobs with `status` / `result` / `logs` / `cancel` / `export` / `cleanup` / `rerun` |
| Cancel | app-server turn interrupt | process-tree termination; `cancelled` only after delivery or confirmed exit, and dead orphans become `failed` / `process-exited` |

No Codex app-server, broker, JSON-RPC protocol, generated app-server types, `codex.mjs`, or `@openai/codex` dependency is included.

### Known gaps / ceiling vs `codex-plugin-cc`

- Grok has no app-server-native review mode or turn interrupt; reviews and
  cancellation are implemented around the headless CLI process.
- Transfer cannot import Claude's native session graph. It creates a new Grok
  session from a bounded, lossy handoff envelope.
- Grok cannot run read-only git shell commands in review mode. Large-diff
  self-collection therefore uses status/stat evidence plus direct file reads;
  dirty branch reviews prefer an embedded clean commit-range diff over
  uncommitted file content.

## State and Privacy

Repository state is stored outside the repository:

```text
~/.claude/grok-companion/<repo-name>-<path-hash>/
```

Each bucket contains a bounded job index plus per-job JSON result, log, and rerun-sidecar files. Full prompts and transcript excerpts are present only while a job is queued or running and are removed from the stored job when it finishes (rerun sidecars retain the request needed for `/grok:rerun`). Treat this user-level directory as private. Nothing is written into the reviewed repository except changes Grok makes during an explicitly write-capable task.

## Development

```bash
npm install
npm test
npm run check-version
node plugins/grok/scripts/grok-companion.mjs setup --json
node plugins/grok/scripts/grok-companion.mjs --help
```

Tests use a fake Grok process and do not require Grok login or consume model usage.

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
