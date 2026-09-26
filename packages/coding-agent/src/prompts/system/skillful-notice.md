The available skills were omitted from the system prompt and are listed below.
When a task matches an available skill, read `skill://<name>` before the work it governs; reuse content already loaded and unchanged. Apply its specialized knowledge within the requested scope. Honor explicit, applicable approval rules, but do not invent additional tasks or gates from a suggested workflow.
<skills>
{{#each skills}}
- {{name}}: {{description}}
{{/each}}
</skills>
