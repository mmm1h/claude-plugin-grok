---
description: Run a read-only Grok review that challenges the implementation approach and design choices
argument-hint: '[--wait|--background] [--base <ref>] [--scope auto|working-tree|branch] [--model <id>] [--timeout-ms <ms>] [--json] [focus ...]'
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*), AskUserQuestion
---

Run an adversarial Grok review. It must challenge the chosen approach, assumptions, tradeoffs, and failure modes, not merely perform a stricter defect pass.

Raw slash-command arguments:
`$ARGUMENTS`

Core constraint:
- This command is review-only.
- Do not fix issues or apply patches.
- Return the companion's rendered review output verbatim.
- The companion requests `--json-schema` output, runs Grok with `--sandbox read-only`, validates the returned shape, and fails closed before the model call only if evidence was truly truncated.
- Reviews of at most 2 changed files and at most 256 KiB of tracked diff are sent inline. Larger reviews use status, changed paths, diff stat, and explicit self-collection through the unchanged read-only tool allowlist; general shell access remains unavailable.
- **Dirty working tree + branch self-collect:** same as `/grok:review` — prefer the clean commit-range diff when the tree is dirty; fail closed only when that clean evidence still exceeds the budget.

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
- `--model <id>` overrides the Grok model for this review.
- `--timeout-ms <ms>` overrides the Grok process timeout (default is the companion's 1-hour headless timeout when omitted).
- `--json` selects structured JSON output instead of the rendered Markdown report.
- Choose either `--wait` or `--background`, not both.

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
