<system-notice id="session-agents">
User-tagged model agents changed. These `m<N>` pseudonyms are the `agent` names accepted by `task` and eval `agent()`/`workpool()`, each pinned to the model the user tagged. Each stays available on this branch for any number of spawns; tagged models form a pool, and their count sets no number of tasks or split. This lists only what changed; any pseudonym not named here is unaffected.
{{#if added.length}}
Now available:
{{#each added}}
- `{{name}}`: {{description}}
{{/each}}
{{/if}}
{{#if removed.length}}
No longer available; calls fail:
{{#each removed}}
- `{{this}}`
{{/each}}
{{/if}}
</system-notice>
