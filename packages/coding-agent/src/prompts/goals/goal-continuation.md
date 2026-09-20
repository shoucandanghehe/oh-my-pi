<!-- Hidden continuation steer. role=user, suppressed from visible transcript. -->

Continue active goal.

<objective>
{{objective}}
</objective>

Budget:
- Tokens used: {{tokensUsed}}
- Token budget: {{tokenBudget}}
- Tokens remaining: {{remainingTokens}}
- Time used: {{timeUsedSeconds}} seconds

Preserve the full objective and the user's scope and stopping conditions. This continuation grants no new authorization.

`goal({op:"complete"})` ends the autonomous loop and surfaces a completion report. Call it only when every required outcome has current verification evidence; reuse checks on unchanged state.

If blocked, report the specific dependency and continue independent authorized work. If unfinished at a runtime limit, leave the goal active and report progress and remaining work. Budget exhaustion is not completion.
