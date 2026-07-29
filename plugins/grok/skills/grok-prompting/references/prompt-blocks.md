# Grok Prompt Blocks

Use only the clauses that change Grok's behavior. These blocks extend the
default `task / grounding_rules / constraints / done_when / output_contract`
envelope; they do not replace it.

## Narrow Write Scope

```xml
<constraints>
Keep edits within the files and behavior required by this task.
Preserve unrelated working-tree changes.
Do not commit, push, or add dependencies.
</constraints>
```

## Read-Only Investigation

```xml
<constraints>
This is read-only. Inspect files and run non-mutating diagnostics, but do not
edit files or execute destructive commands.
</constraints>
```

## Evidence Boundary

```xml
<grounding_rules>
Ground claims in repository files, command output, tests, or supplied logs.
Label hypotheses and remaining unknowns. Do not infer success from intent.
</grounding_rules>
```

## Implementation Completion

```xml
<done_when>
Implement the requested behavior, run the checks proportionate to the change,
and reconcile failures before stopping. Report any check that could not run.
</done_when>
```

## Diagnosis Output

```xml
<output_contract>
Return:
1. root cause
2. evidence and relevant locations
3. alternatives ruled out
4. smallest safe next step
</output_contract>
```

## Coding Output

```xml
<output_contract>
Return a compact summary of changed behavior, touched files, verification
results, and residual risks. Do not include a speculative roadmap.
</output_contract>
```

## Resume Delta

```xml
<task>
Continue from the confirmed Grok task session. Apply only this delta:
[new instruction or changed acceptance criterion]
</task>

<done_when>
Verify the new work against the existing task plus this delta.
</done_when>
```
