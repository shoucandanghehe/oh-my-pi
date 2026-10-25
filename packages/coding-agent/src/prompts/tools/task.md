{{#if asyncEnabled}}{{#if batchEnabled}}Spawn `tasks[]` concurrently; IDs return immediately.{{else}}Spawn one agent; ID returns immediately.{{/if}}{{#if hasBlockingAgents}} BLOCKING agents return inline.{{/if}}{{else}}{{#if batchEnabled}}Run `tasks[]` synchronously.{{else}}Run one agent synchronously.{{/if}}{{/if}}
{{#if asyncEnabled}}{{#ifAny structured hasStructuredAgents}}

# Results
{{#if structured}}`outputSchema`{{else}}STRUCTURED agents'{{/if}} parsed payload, even invalid: `agent://<id>` (field `/<field>`, nested `/reports/0/data`); invalid preview inline.
{{/ifAny}}

{{asyncGuidance}}
{{/if}}

# Task Design
- **Agent typing:** Pick each item's most specific available agent.{{#if scoutAvailable}} Use `scout` for read-only research.{{/if}} Omit `agent` when the spawn-policy default (`{{defaultAgent}}`) fits; otherwise pass an available specialist or role agent explicitly.
{{#if batchEnabled}}`agent` selectors belong inside each `tasks[]` item; NEVER put `agent` at the top level.
{{/if}}
- **Role agents:** `agent: "default"` or `agent: "slow"` selects a general-purpose identity with its configured role model; use only names in Available Agents below. Available identities by Main tier: `smol` → `default` + `slow`; `default` → `slow`; `slow` → `default`; unclassified → neither. Choose the lowest suitable available identity; keep specialists for specialized work. Only a higher `default`/`slow` identity requires Main's session-scoped approval (`smol` < `default` < `slow`), never a specialist, `m<N>`, or an underlying model choice. Grant/denial persists across resume; cancellation is not denial. Children MUST ask Main rather than invoke a higher `default`/`slow` identity.
{{#if delegation.role}}Current Main tier: `{{delegation.role}}`; higher role-agent approval: `{{delegation.approval}}`.{{#if delegation.subagent}} Need a higher `default`/`slow` identity? Report the blocker to Main.{{else}} Runtime asks once per session before a higher `default`/`slow` identity when approval is `ask`.{{/if}}
{{/if}}
- **Verification ownership:** State who verifies each assignment. In a shared working tree, defer builds, linters, and formatters until concurrent edits settle; the integration owner runs the required combined checks. Isolated assignments may run scoped checks when explicitly assigned and safe for shared resources.
- **One-pass:** For implementation work, prefer an agent that investigates and edits its assigned scope.{{#if scoutAvailable}} Use a read-only scout for research or review that should not change files.{{/if}}
- **Overlap:** Parallelize independent ownership. Same-file edits are not guaranteed to merge.{{#if ircEnabled}} Coordinate shared-file edits through `write agent://<id>`.{{/if}} Name one integration owner and state cross-task contracts in the {{#if batchEnabled}}batch `context`{{else}}task{{/if}} before dispatch. Sequence dependent mutations and follow the project's isolation rules.

# Inputs
{{#if file}}`taskFile`: absolute path or `local://` file; contents become the task, read once at dispatch. Exactly one of `task`/`taskFile`.
{{/if}}
`name`: CamelCase ≤32, auto-generated if omitted; address agent by name.{{#if structured}} `outputSchema` overrides agent/session schemas.{{/if}}
`solutionSpace`: describe how open-ended the child's problem is: whether the fix or design is given, or which causes or designs remain open. Volume of work does not widen it; NEVER mention sibling agents or coordination. (`one fix: rename, names given`; `one fix: slice end in paginate`; `single-flight cache load; races easy to miss`; `several retry API shapes; error classes to choose`; `deadlock cause open, no repro`)
{{#if seanceGuidance}}{{seanceGuidance}}{{/if}}
{{#if evalToolsEnabled}}`tools`: eval-defined, run in your kernel.
{{/if}}{{#if effortEnabled}}`effort`: `"lo"`|`"med"`|`"hi"` by how open-ended the problem is.
{{/if}}{{#if structured}}`schemaMode`: inherits the parent session's mode when omitted (permissive if unset). Permissive warns after retries; strict fails.
{{/if}}{{#if isolationEnabled}}{{#if applyIsolatedChanges}}`isolated`: worktree; successful changes apply to parent.
{{else}}`isolated`: worktree; changes retained, not applied.
{{/if}}{{/if}}Children start blank;{{#if ircEnabled}} parent IRC steers immediately;{{/if}} large payloads via `local://<path>`, NEVER inline.

# Format
{{#if batchEnabled}}`context`: shared (`# Goal`, `# Contract` interfaces); NEVER repeat per task.
{{/if}}`task`{{#if file}} or the contents of `taskFile`{{/if}}: self-contained (`# Target` files/non-goals, `# Change` steps/APIs, `# Acceptance` observable result).

# Available Agents
{{#if spawningDisabled}}Agent spawning is currently disabled.
{{else}}{{#if hasModelMentions}}`m<N>` = user-authorized exact model agent (`<model agent="m<N>" name="…"/>`), not a specialist or tier; spawn only when user names it.
{{/if}}{{#list agents join=""}}- `{{name}}`{{#if readOnly}} (READ-ONLY; investigation only, no edits){{/if}}{{#if blocking}} (BLOCKING; inline result){{/if}}{{#if structured}} (STRUCTURED; schema result){{/if}}: {{description}}
{{/list}}{{/if}}
