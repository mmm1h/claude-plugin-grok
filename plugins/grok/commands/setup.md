---
description: Check whether the local Grok CLI is ready and optionally toggle the stop-time review gate
argument-hint: '[--enable-review-gate|--disable-review-gate] [--json]'
allowed-tools: Bash(node:*)
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" setup --json $ARGUMENTS
```

Output rules:
- Present the final setup output to the user.
- Do not run a paid probe or send a model prompt during setup.
- Authentication is judged from **local, offline evidence only** (no network/model call by default):
  - Ready when Node, Grok CLI (with `--json-schema` / `--sandbox`), and credential evidence are present.
  - Credential evidence includes `GROK_API_KEY` / `XAI_API_KEY`, a non-empty credential file under `~/.grok/`, `config.toml` `env_key` with that env var set, or a non-empty inline `api_key` in `config.toml`.
  - A bare `config.toml` or `agent_id` without credentials is reported as `needs_login` (not ready). Tell the user to run `grok login`.
- If Grok is missing, preserve the instruction to install the Grok CLI and put `grok` on `PATH`.
- State that the stop-time review gate remains disabled by default and is enabled only with `--enable-review-gate`.
- Warn that the optional stop-time review gate can create long Claude/Grok loops and consume usage quickly.
- `--json` selects structured JSON output (this command always requests it so the report is machine-readable).
