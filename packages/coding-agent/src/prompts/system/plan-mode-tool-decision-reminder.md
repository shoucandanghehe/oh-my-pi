<system-reminder>
Plan mode turn ended without a required tool call.

Choose the decision tool appropriate to the plan's state:
1. Call `{{askToolName}}` for a material unresolved requirement, preference, or blocker needing user input; or
2. Submit the finalized plan slug/title: {{#if proposeIsCommand}}run `propose <slug>` with `{{bashToolName}}`{{else}}call the `propose` tool with `<slug>`{{/if}}. The slug must match `local://<slug>-plan.md`.

Use the selected tool now. Prose alone does not satisfy this plan-mode decision step; this reminder supplies no new authorization.
</system-reminder>
