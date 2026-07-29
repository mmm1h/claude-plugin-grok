---
name: grok-result-handling
description: Internal guidance for presenting Grok companion output
user-invocable: false
---

# Grok Result Handling

- Preserve Grok output, evidence boundaries, paths, line numbers, uncertainties, and resume commands.
- For reviews, keep findings first and ordered by severity.
- If no findings were reported, preserve that statement and any residual-risk note.
- Never turn a failed Grok run into an unrequested Claude-side implementation.
- After presenting review findings, stop. Do not apply fixes until the user explicitly requests them.
- If setup or authentication is required, direct the user to `/grok:setup`.
