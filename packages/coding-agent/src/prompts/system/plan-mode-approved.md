Plan approved.
{{#if contextPreserved}}
- History usable; the plan below authoritative if it conflicts with earlier exploration.
{{/if}}

<instruction>
Full plan inlined below; durable copy at `{{planFilePath}}` (identical content).
Execute the approved plan within its scope and the active permission rules.
Use the intact inline plan directly; read `{{planFilePath}}` when its content is unavailable or evidence indicates the durable plan changed.
{{#has tools "todo"}}
Track the plan with `todo`, preserving existing progress.
{{/has}}
</instruction>

<plan path="{{planFilePath}}">
{{planContent}}
</plan>

<critical>
On plan read failure, report the exact path and error; pause dependent work rather than guessing.
Approval covers this plan, not other approval-gated actions. Surface material mismatches or new authority needed before taking the affected step.
</critical>
