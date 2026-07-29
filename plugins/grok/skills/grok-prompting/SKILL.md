---
name: grok-prompting
description: Internal guidance for tightening delegated coding, diagnosis, research, and review prompts for Grok
user-invocable: false
---

# Grok Prompting

Use this skill inside `grok:grok-rescue` to tighten a rescue or delegated task
before the single companion `task` call. Preserve the user's intent, paths,
commands, and acceptance criteria. Remove routing flags and redundant narration,
but do not inspect the repository or solve the task while drafting the prompt.

## Route Before Prompting

- Use `/grok:review` for a normal local-git review.
- Use `/grok:adversarial-review` when the user wants design pressure-testing or
  a review with custom focus.
- Do not recreate either review as a free-text rescue prompt. The slash commands
  already provide the review schema, read-only sandbox, shape validation, and
  fail-closed handling for truncated diffs.
- Use rescue/task for coding, diagnosis, research, planning, or a follow-up to a
  completed review.

## Default Prompt Envelope

Use these five blocks in this order. Keep each block short and concrete.

```xml
<task>
State one job, its relevant context, and the expected end state.
</task>

<grounding_rules>
Name the evidence Grok must inspect. Separate observed facts, hypotheses, and
unknowns. Do not invent repository or runtime facts.
</grounding_rules>

<constraints>
Set scope, write/read-only mode, safety boundaries, and prohibited changes.
</constraints>

<done_when>
List the checks or observable outcomes that establish completion.
</done_when>

<output_contract>
Specify the final answer's fields, ordering, and required evidence.
</output_contract>
```

Omit a block only when it would be empty or duplicate an explicit user
contract. Do not add decorative tags, generic role-play, or requests to "think
harder." Better evidence and completion rules are more useful than verbosity.

## Scenario Guidance

### Coding

- State the smallest functional scope and what existing behavior must remain.
- Make write permission explicit; rescue tasks are write-capable unless
  `--read-only` is selected.
- Put required tests, lint/type checks, and acceptance behavior in `done_when`.
- Prohibit unrelated refactors, dependency additions, commits, pushes, and
  destructive actions when they are outside the user's request.
- Require Grok to implement and verify, not stop after proposing a patch.

### Diagnosis

- Use `--read-only` when the user asked only for a diagnosis.
- Require a root cause supported by file, test, log, or runtime evidence.
- Ask Grok to label hypotheses and disconfirm plausible alternatives.
- Make the output distinguish root cause, evidence, and the smallest safe next
  step. Do not silently turn diagnosis into implementation.

### Research

- Use `--read-only`.
- Define the decision the research must support and any source boundary.
- Require observed facts, reasoned conclusions, tradeoffs, and open questions
  to remain distinct.
- Prefer primary/local evidence and require source references in the output.

### Review Follow-Up

- First use the structured slash review, then delegate a separate task for an
  accepted finding or a focused investigation.
- Include the finding, relevant evidence, and the user's requested response.
- Do not ask Grok to repeat the whole review.
- For a same-session continuation, send only the delta: what changed, what to
  investigate or implement next, and any new completion rule.

## Companion Contract

- Assemble one prompt and invoke companion `task` exactly once.
- Do not call `status`, `result`, `cancel`, `transfer`, review commands, or setup
  from the forwarding agent.
- Do not poll a background job or manage its lifecycle inside this skill.
- `--resume` maps to the companion's scoped `--resume-last`. The companion may
  resume only a confirmed, ended task from the current Claude session and
  workspace; there is no `grok sessions list` fallback.
- A resume prompt is a delta instruction. Do not restate the original prompt
  unless the task direction or constraints materially changed.
- Return companion stdout unchanged. Runtime status, live phase, confirmed
  session identity, and follow-up commands come from the companion.
- Transfer is a lossy handoff envelope into a new Grok session, not native
  session import, and is not performed by the rescue forwarder.

## Assembly Check

Before the call, verify that the prompt:

1. contains one task and an observable end state;
2. distinguishes evidence from assumptions;
3. states whether changes are allowed;
4. includes proportionate verification;
5. preserves user-supplied output requirements; and
6. contains no Claude execution flags or lifecycle instructions for Grok.

Reusable blocks are in
[references/prompt-blocks.md](references/prompt-blocks.md). Compact scenario
templates are in [references/prompt-recipes.md](references/prompt-recipes.md).
