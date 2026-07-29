---
description: Check whether the local Grok CLI is ready and optionally toggle the stop-time review gate
argument-hint: '[--enable-review-gate|--disable-review-gate]'
allowed-tools: Bash(node:*)
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" setup --json $ARGUMENTS
```

Output rules:
- Present the final setup output to the user.
- Do not run a paid probe or send a model prompt during setup.
- If Grok is missing, preserve the instruction to install the Grok CLI and put `grok` on `PATH`.
- If authentication is missing or uncertain, preserve the guidance to run `grok login`.
- State that the stop-time review gate remains disabled by default and is enabled only with `--enable-review-gate`.
- Warn that the optional stop-time review gate can create long Claude/Grok loops and consume usage quickly.
