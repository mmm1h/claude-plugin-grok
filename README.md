# Grok plugin for Claude Code

Claude Code → local Grok CLI for read-only reviews, delegated tasks, transcript handoff, and tracked background jobs. Not Grok→Codex; no Codex app-server.

## Requirements

- `grok` on `PATH`, authenticated (`grok login` if needed)
- Node.js ≥ 18.18 · Git (reviews)

## Install

```text
/plugin marketplace add mmm1h/claude-plugin-grok
/plugin install grok@claude-plugin-grok
/reload-plugins
/grok:setup
```

### Agent install prompt

Paste into Claude Code:

```text
Install the Grok plugin for Claude Code from marketplace repo mmm1h/claude-plugin-grok.

1. /plugin marketplace add mmm1h/claude-plugin-grok
2. /plugin install grok@claude-plugin-grok
3. /reload-plugins
4. /grok:setup — report whether Grok CLI and auth look ready
5. Confirm /grok: commands exist (e.g. /grok:review, /grok:rescue)

Use only the marketplace and plugin names above. After reload, stop and summarize status.
```

## Capabilities

| Area | Role |
| --- | --- |
| Review / adversarial | Read-only structured review |
| Rescue / task | Write-capable or read-only delegated work |
| Transfer | Lossy Claude→Grok transcript handoff |
| Jobs | status · ps · result · cancel |
| Setup | Offline readiness + optional stop-review gate |

CLI help: `node plugins/grok/scripts/grok-companion.mjs --help`

## Commands

| Command | Purpose | Common flags |
| --- | --- | --- |
| `/grok:setup` | Readiness; toggle stop-review gate | `--enable-review-gate`, `--disable-review-gate`, `--json` |
| `/grok:review` | Working-tree or branch review | `--wait`/`--background`, `--base`, `--scope auto\|working-tree\|branch`, `--model`, `--timeout-ms`, `--json` |
| `/grok:adversarial-review` | Review + free-form focus | same as review + focus text |
| `/grok:rescue` | Delegate via `grok:grok-rescue` → `task` | `--wait`/`--background`, `--resume`/`--fresh`, `--read-only`, `--model`, `--effort`, `--timeout-ms`, `--prompt-file`, `--session-id`, `--resume-job` |
| `/grok:transfer` | Lossy handoff (not native import) | `--background`, `--source <jsonl>`, `--timeout-ms`, `--json` |
| `/grok:status` | Running / latest finished / recent; optional log tail | `[job-id]`, `--all`, `--kind`, `--status`, `--limit`, `--progress-lines`, `--logs [N]`, `--wait`, `--with-result`, `--timeout-ms` |
| `/grok:ps` | All-workspace managed processes / PID lookup | `--pid <pid>`, `--include-terminal`, `--json` |
| `/grok:result` | Full stored finished output; optional export | `[job-id]`, `--wait`, `--out <path>`, `--timeout-ms`, `--json` |
| `/grok:cancel` | Kill active job process tree | `[job-id]`, `--all` (current session), `--all-sessions`, `--kind`, `--json` |

Ops-only companion subcommands (no slash command): `cleanup` prunes finished jobs (`--older-than` / `--keep` / `--dry-run`).

Rescue: `--background`/`--wait` stay Claude-side; `--resume` → companion `--resume-last`.

## Agent conventions

- **Delegate** multi-file work, long diagnosis, research, post-review fixes → `/grok:rescue` (skill `delegate-to-grok`)
- **Review** local git → `/grok:review` / `/grok:adversarial-review` (not free-text rescue)
- **Small one-file edits** → do in Claude; skip Grok

### Never run the grok CLI directly

Always use this plugin. Companion already handles:

- stdin via Node `stdio: ["ignore","pipe","pipe"]` (Git Bash `< /dev/null` is unreliable for Windows-native `grok`)
- required flags (`--no-memory`, `--verbatim`, approve/sandbox, `--permission-mode`, `--session-id`)
- Windows `.exe` / `.cmd` spawn without `shell:true`
- job tracking, cancel tree-kill, logs, results, and `/grok:ps` ownership checks

Suspect a stray process? `/grok:ps` or `/grok:ps --pid <pid>` before any kill.

**Background jobs:** start `--background` → `/grok:status <id> --wait --with-result` or `/grok:result <id> --wait` → live `/grok:status <id> --logs` → stop `/grok:cancel`. Optional: `/grok:result <id> --out bundle.json` then companion `cleanup --dry-run` before prune.

| Exit | Meaning |
| --- | --- |
| `0` | Success |
| non-zero | Failure (stderr / JSON) |
| `124` | `--wait` timed out; job may still run — keep job id |

**Defaults:** headless timeout **1h** without `--timeout-ms`; prompt cap **16 MiB** UTF-8 (`--prompt-file`); resume only confirmed ended tasks in current Claude session+workspace; `cancelled` only after signal delivery or confirmed exit; transfer is lossy (source hash + omissions); state under `~/.claude/grok-companion/<repo>-<hash>/`.

**Review evidence:** ≤2 files / ≤256 KiB tracked → inline; larger → `self-collect` via `read_file`/`grep`/`list_dir`; dirty branch scope prefers clean commit-range; true oversize fails closed.

## Development

```bash
npm install && npm test && npm run check-version
```

Fake Grok only — no login or model usage.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
