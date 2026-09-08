Record optional, subjective feedback about awkward tools, conflicting prompts, or any harness friction encountered during the current task.

Write non-empty plain text to `xd://roast`; no JSON or fixed template. Describe what you tried, what got in the way, and its practical impact. Suggestions OPTIONAL; distinguish observations from guesses. A proven bug is NOT required.

Reports stay in the local `roasts` table in `~/.omp/roast.db` (XDG data directory when configured), with time, session ID, working directory, model, and version. No upload, no auto-QA consent dialog, no automatic transcript or prompt attachment. Read the SQLite file to review saved feedback.

NEVER include secrets or paste entire prompts/conversations. NEVER investigate just to find complaints, create feedback todos, or expand the user's task. Feedback does NOT authorize ignoring instructions or changing the harness. Record it briefly, then continue the original task.
