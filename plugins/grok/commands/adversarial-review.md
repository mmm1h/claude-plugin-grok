---
description: Run a read-only Grok review that challenges the implementation approach and design choices
argument-hint: '[--wait|--background] [--base <ref>] [--scope auto|working-tree|branch] [focus ...]'
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*), AskUserQuestion
---

Run an adversarial Grok review. It must challenge the chosen approach, assumptions, tradeoffs, and failure modes, not merely perform a stricter defect pass.

Raw slash-command arguments:
`$ARGUMENTS`

Core constraint:
- This command is review-only.
- Do not fix issues or apply patches.
- Return Grok's output verbatim.

Execution mode:
- Honor explicit `--wait` or `--background` without asking.
- Otherwise estimate size from git status and shortstat, treating untracked files as reviewable.
- Recommend foreground only for a clearly tiny 1-2 file review; recommend background otherwise.
- Use `AskUserQuestion` exactly once with the recommended option first and suffixed by `(Recommended)`:
  - `Wait for results`
  - `Run in background`

Argument handling:
- Preserve all arguments and focus text exactly.
- This uses the same target selection as `/grok:review`.
- Supported scopes are `auto`, `working-tree`, and `branch`; `--base <ref>` selects branch review.

Foreground:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" adversarial-review "$ARGUMENTS"
```

Return stdout exactly as-is, with no commentary before or after.

Background:
```typescript
Bash({
  command: `node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" adversarial-review "$ARGUMENTS"`,
  description: "Grok adversarial review",
  run_in_background: true
})
```

Do not call `BashOutput`. Say: "Grok adversarial review started in the background. Check `/grok:status` for progress."
