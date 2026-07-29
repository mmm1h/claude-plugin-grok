---
name: grok-prompting
description: Internal guidance for tightening delegated coding, diagnosis, research, and review prompts for Grok
user-invocable: false
---

# Grok Prompting

Use this skill only to tighten the request before the single companion `task` call.

- Keep one concrete task per run.
- State the requested end state and verification.
- Separate observed facts from hypotheses.
- For implementation, specify scope, safety constraints, and the tests that establish completion.
- For diagnosis, require a root cause supported by repository or runtime evidence.
- For read-only work, say explicitly that no files may be changed.
- Preserve the user's task intent and remove redundant narration.
- Do not inspect the repository or solve the request while drafting the prompt.
