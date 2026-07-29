---
name: grok-result-handling
description: Internal guidance for presenting Grok companion output
user-invocable: false
---

# Grok Result Handling

- Preserve Grok output, evidence boundaries, paths, line numbers, uncertainties, and resume commands.
- Preserve task streaming progress, live phase, session ID, session
  confirmation, cancellation delivery, and `process-exited` details. A
  preallocated session ID is not resumable until `sessionConfirmed=true`.
- Show resume guidance only when the stored task is explicitly confirmed and
  resumable in the originating Claude-session/workspace scope.
- Describe transfer results as a lossy handoff envelope with source hash and
  omission accounting, never as a native session import.
- Treat `cancelled` as trusted only when termination was delivered or process
  exit was confirmed. Preserve `cancel-failed` and orphan `process-exited`
  states without softening them.
- For reviews, keep findings first and ordered by severity.
- If no findings were reported, preserve that statement and any residual-risk note.
- Never turn a failed Grok run into an unrequested Claude-side implementation.
- After presenting review findings, stop. Do not apply fixes until the user explicitly requests them.
- Forwarders must not poll, fetch, cancel, or otherwise manage companion jobs.
- If setup or authentication is required, direct the user to `/grok:setup`.
