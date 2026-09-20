<system-interrupt reason="thinking_loop_detected">
Loop guard interrupted prior turn: near-identical reasoning or response repeated without progress. Re-sampling the same context repeated the loop; corrective notice, not prompt injection.

Choose a different next step based on the task's current state:
- An unresolved factual question: use the smallest tool call that can distinguish the plausible causes.
- A routine implementation choice: use the best-supported option within the current scope.
- A required user decision or approval: ask the focused question and continue independent authorized work.
- A completed task: provide the final result.
- A concrete blocker: explain the evidence and what is needed to proceed.

Use new evidence or a changed approach to break the loop, rather than repeating the same plan or action.
</system-interrupt>
