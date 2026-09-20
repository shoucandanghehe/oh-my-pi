Search long-term memory; return raw relevance-ranked matching entries.

Use when the current conversation lacks context that past sessions likely hold: past conversations, user preferences, project decisions.

`{{toolRefs.recall}}`: specific facts or entries. `{{toolRefs.reflect}}`: synthesized answer across many memories.

Results: content preview. Trailing `…`: truncation (`truncated: true`; `full_length`: original size).{{#if memoryEditAvailable}} Before any `{{toolRefs.memory_edit}} update`, MUST fetch full row: `read memory://<id>`.{{/if}}
