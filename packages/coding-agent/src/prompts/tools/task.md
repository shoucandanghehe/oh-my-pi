{{#if asyncEnabled}}{{#if batchEnabled}}Spawn `tasks[]` concurrently; IDs return immediately.{{else}}Spawn one agent; ID returns immediately.{{/if}}{{#if hasBlockingAgents}} BLOCKING agents return inline.{{/if}}{{else}}{{#if batchEnabled}}Run `tasks[]` synchronously.{{else}}Run one agent synchronously.{{/if}}{{/if}}
{{#if asyncEnabled}}

# Results
`outputSchema` parsed payload, even invalid: `agent://<id>` (field `/<field>`, nested `/reports/0/data`); invalid preview inline.
{{/if}}

# Task Design
- **Agent typing:** Pick each item's most specific available agent.{{#if scoutAvailable}} Read-only research MUST run on `scout` (faster model).{{/if}} Omit `agent` only when the spawn-policy default (`{{defaultAgent}}`) fits; otherwise pass the specialist explicitly. NEVER name the default explicitly.
- **Verification ownership:** State who verifies each assignment. In a shared working tree, defer builds, linters, and formatters until concurrent edits settle; the integration owner runs the required combined checks. Isolated assignments may run scoped checks when explicitly assigned and safe for shared resources.
- **One-pass:** For implementation work, prefer an agent that investigates and edits its assigned scope.{{#if scoutAvailable}} Use a read-only scout for research or review that should not change files.{{/if}}
- **Overlap:** Parallelize independent ownership. Same-file edits are not guaranteed to merge.{{#if ircEnabled}} Coordinate shared-file edits through `write agent://<id>`.{{/if}} Name one integration owner and state cross-task contracts in the {{#if batchEnabled}}batch `context`{{else}}task{{/if}} before dispatch. Sequence dependent mutations and follow the project's isolation rules.

# Inputs
`name`: CamelCase ≤32, auto-generated if omitted; address agent by name. `outputSchema` overrides agent/session schemas.
{{#if evalToolsEnabled}}`tools`: eval-defined, run in your kernel.
{{/if}}{{#if effortEnabled}}`effort`: `"lo"`|`"med"`|`"hi"` by complexity.
{{/if}}`schemaMode`: default permissive warns after retries; strict fails.
{{#if isolationEnabled}}{{#if applyIsolatedChanges}}`isolated`: worktree; successful changes apply to parent.
{{else}}`isolated`: worktree; changes retained, not applied.
{{/if}}{{/if}}Children start blank;{{#if ircEnabled}} parent IRC steers immediately;{{/if}} large payloads via `local://<path>`, NEVER inline.

# Format
{{#if batchEnabled}}`context`: shared (`# Goal`, `# Constraints`, `# Contract` interfaces); NEVER repeat per task.
{{/if}}`task`: self-contained (`# Target` files/non-goals, `# Change` steps/APIs, `# Acceptance` observable result).

# Available Agents
{{#if spawningDisabled}}Agent spawning is currently disabled.
{{else}}{{#if hasModelMentions}}`m<N>` = user-tagged model (`<model agent="m<N>" name="…"/>`), not specialist; spawn only when user names it.
{{/if}}{{#list agents join=""}}- `{{name}}`{{#if readOnly}} (READ-ONLY; investigation only, no edits){{/if}}{{#if blocking}} (BLOCKING; inline result){{/if}}: {{description}}
{{/list}}{{/if}}
