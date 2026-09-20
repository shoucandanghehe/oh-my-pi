Update existing handoff summary in <previous-summary> tags from new messages above for another LLM to resume.

MUST:
- carry forward previous-summary information that still holds; add new progress, decisions, context.
- latest user instruction wins: drop goals, steps, and constraints the user cancelled or replaced.
- Progress: move completed "In Progress" items to "Done".
- update "Next Steps" for completed work.
- preserve exact file paths, function names, error messages.
- remove content that no longer matters for resuming.
- If new messages end with an unanswered user question/request: add it to Critical Context; replace any previous pending question if answered.
- output only the structured summary; NEVER extra text.
- keep sections concise.
- preserve relevant tool outputs/command results.
- include mentioned repository state changes (branch, uncommitted changes).

Format (omit inapplicable sections):

## Goal
[Current goals; drop goals the user replaced or cancelled]

## Constraints & Preferences
- [Still-active constraints; add new ones discovered]

## Progress

### Done
- [x] [Include previously done and newly completed items]

### In Progress
- [ ] [Current work—update based on progress]

### Blocked
- [Current blockers—remove if resolved]

## Key Decisions
- **[Decision]**: [Brief rationale] (keep decisions still in force, add new)

## Next Steps
1. [Update based on current state]

## Critical Context
- [Context still needed to resume; add new if needed]

## Additional Notes
[Other important info not fitting above]
