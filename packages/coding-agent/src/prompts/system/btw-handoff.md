<btw-handoff>
Continue Main using this completed BTW side thread as user-supplied context.
{{#each turns}}
Question: {{input}}
Answer: {{replyText}}
{{/each}}
{{#if instruction}}
User direction: {{instruction}}
{{/if}}
</btw-handoff>
