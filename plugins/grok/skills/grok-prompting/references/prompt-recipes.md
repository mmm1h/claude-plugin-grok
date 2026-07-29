# Grok Prompt Recipes

These are starting points for rescue/task delegation. Keep only the details
needed for the actual request.

## Coding

```xml
<task>
Implement [specific behavior] in [scope] while preserving [existing behavior].
</task>
<grounding_rules>
Inspect the relevant implementation and tests before editing. Treat existing
working-tree changes as user-owned.
</grounding_rules>
<constraints>
Keep the change narrow. Do not commit, push, or perform unrelated cleanup.
</constraints>
<done_when>
[Acceptance behavior] passes and [specific tests/checks] are green.
</done_when>
<output_contract>
Report changed behavior, files, checks, and residual risk.
</output_contract>
```

## Diagnosis

```xml
<task>
Diagnose [failure] without changing files.
</task>
<grounding_rules>
Support the root cause with repository, log, test, or runtime evidence. Label
and test competing hypotheses.
</grounding_rules>
<constraints>
Read-only investigation; do not implement a fix.
</constraints>
<done_when>
The explanation accounts for the observed failure and identifies the smallest
safe next step.
</done_when>
<output_contract>
Return root cause, evidence, ruled-out alternatives, and next step.
</output_contract>
```

## Research

```xml
<task>
Research [decision] within [source/scope boundary] and recommend a path.
</task>
<grounding_rules>
Prefer primary sources. Separate facts, inference, and open questions, with
references for material claims.
</grounding_rules>
<constraints>
Read-only; do not modify the repository or external systems.
</constraints>
<done_when>
The options, tradeoffs, and recommendation are supported by inspected sources.
</done_when>
<output_contract>
Return facts, recommendation, tradeoffs, sources, and open questions.
</output_contract>
```

## Review Finding Follow-Up

```xml
<task>
Act on this accepted structured-review finding: [finding and evidence].
[Investigate further | implement the smallest safe fix].
</task>
<grounding_rules>
Revalidate the finding against the current tree before acting.
</grounding_rules>
<constraints>
Do not rerun or recreate the full review. Stay within the finding's scope.
</constraints>
<done_when>
[Targeted behavior/check] demonstrates that the finding is resolved or
disproved.
</done_when>
<output_contract>
Report disposition, evidence, changes if any, and verification.
</output_contract>
```
