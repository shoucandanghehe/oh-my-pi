Ask the user for a decision or missing information needed to proceed safely.

<conditions>
- Missing information or a choice materially affects correctness, scope, compatibility, or risk and cannot be resolved from available context.
</conditions>

<instruction>
- Batch related questions; 2–5 distinct options each; short labels, tradeoffs in `description`.
- `recommended` auto-adds " (Recommended)"; `multi: true` permits multiple selections.
- NEVER supply "Other": UI adds "Other (type your own)". Clarifying custom input? Answer first; re-ask unresolved questions.
</instruction>

<caution>
- Provide 2-5 concise, distinct options.
</caution>

<critical>
- Investigate factual questions through the relevant available sources. Use project conventions and reasonable defaults for routine choices; ask when the remaining uncertainty needs the user's decision.
- Explain what the answer enables and recommend an option when useful. Continue independent, authorized work while waiting; keep dependent work paused when the answer is required.
- Use the designated approval mechanism for permission requests. Technical facts and unanswered questions do not supply authorization.
- Do NOT include "Other"; UI automatically adds "Other (type your own)" to every question.
</critical>
