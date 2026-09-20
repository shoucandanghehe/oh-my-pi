{{#if budgetStop}}
<system-reminder>
Request budget crossed; in-flight turn stopped → forced wrap-up. MUST call `yield` NOW with best final report from completed work.

- Consolidate all gathered value; mark remaining gaps incomplete, do not investigate further.
- Do NOT call another tool or resume assignment.
- Use the active `yield` contract: workpool items require their pending numeric `key` and exactly one of `data` or `error`; ordinary assignments use `data` matching the requested schema or `error` explaining incomplete work. Follow tool responses for remaining item keys. Use text-only finalization only when the active tool contract permits it.
</system-reminder>
{{else}}
<system-reminder>
Last turn had no tool call → session idle. Reminder {{retryCount}} of {{maxRetries}}.

Choose the next action from the assignment's actual state:
1. **Continue work** — take the next useful, authorized tool action.
2. **Return progress** — if useful and supported by the active yield contract, submit an incremental result.
3. **Return completion** — use `yield` with the completed result.
4. **Report a blocker** — use `yield` with the exact dependency and relevant findings when further progress needs unavailable input or authority.

Preserve the active tool schema. Workpool results require a numeric `key` and exactly one of `data` or `error`; ordinary structured results belong in `data`. A last-turn text result does not replace required structured data.

This reminder is not a forced stop or new authorization. Use a tool action or the appropriate `yield` call, rather than ending with prose alone.
</system-reminder>
{{/if}}

Data-less text finalization requires the full report already written as assistant prose this turn; it cannot recover an unwritten report.
