---
description: Run a read-only Grok code review against local git state
argument-hint: '[--wait|--background] [--base <ref>] [--scope auto|working-tree|branch] [--model <id>] [--timeout-ms <ms>] [--json]'
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*), AskUserQuestion
---

Run a Grok review through the companion runtime.

Raw slash-command arguments:
`$ARGUMENTS`

Core constraint:
- This command is review-only.
- Do not fix issues, apply patches, or suggest that you are about to make changes.
- Return the companion's rendered review output verbatim to the user.
- The companion requests `--json-schema` output, runs Grok with `--sandbox read-only`, validates the returned shape, and fails closed before the model call only if evidence was truly truncated.
- Reviews of at most 2 changed files and at most 256 KiB of tracked diff are sent inline. Larger reviews use self-collect mode: Grok receives status, changed paths, diff stat, and explicit instructions to inspect relevant files with its existing read-only tools. General shell access is never enabled.
- **Dirty working tree + branch self-collect:** when branch review needs self-collection and the tree is dirty, the companion first embeds the **clean commit-range** diff (unaffected by uncommitted edits) and warns Grok not to treat working-tree file reads as authoritative. Only if that clean range still exceeds the evidence budget does the review fail closed with recovery options (`--scope working-tree`, stash/commit then re-run, or narrow the range).

Execution mode:
- If the arguments include `--wait`, run in the foreground without asking.
- If they include `--background`, run in a Claude background task without asking.
- Otherwise estimate size with `git status --short --untracked-files=all` and the relevant `git diff --shortstat`.
- Treat untracked files as reviewable work.
- Recommend foreground only for a clearly tiny 1-2 file review; recommend background otherwise.
- Use `AskUserQuestion` exactly once with the recommended option first and suffixed by `(Recommended)`:
  - `Wait for results`
  - `Run in background`

Argument handling:
- Preserve the user's arguments exactly.
- `/grok:review` does not accept focus text. Use `/grok:adversarial-review` for custom focus.
- Supported scopes are `auto`, `working-tree`, and `branch`; `--base <ref>` selects branch review.
- `--model <id>` overrides the Grok model for this review.
- `--timeout-ms <ms>` overrides the Grok process timeout (default is the companion's 1-hour headless timeout when omitted).
- `--json` selects structured JSON output instead of the rendered Markdown report.
- Choose either `--wait` or `--background`, not both.
- The companion enforces both a read-only Grok sandbox and a read-only tool set.

Foreground:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" review "$ARGUMENTS"
```

Return stdout exactly as-is. Do not add commentary or fix findings.

Background:
```typescript
Bash({
  command: `node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" review "$ARGUMENTS"`,
  description: "Grok review",
  run_in_background: true
})
```

Do not call `BashOutput` or wait in this turn. Say: "Grok review started in the background. Check `/grok:status` for progress."
