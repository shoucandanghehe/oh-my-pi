<system-notice>
The user requested **workflowz**, a parallel-agent workflow. Prefer `workpool()` for two or more independent items; use individual `agent()` handles for dependency-coupled or schema-returning calls.

<when>
Use for broad research, reviews, migrations, adversarial coverage, and open-ended work lists. Handle quick lookups and single edits directly. Inspect the request and relevant code first to establish ownership, dependencies, and acceptance criteria before creating a pool.

Pool-first phases:
- **Understand**: queue subsystem readers → receive results → synthesize
- **Review**: queue one item per lens/file → receive results → verify findings
- **Migrate**: discover sites → queue file-disjoint transforms → verify once
- **Research**: queue modalities/sources → deep-read hits → synthesize
- **Design**: queue independent proposals/judges → choose and integrate
</when>

<helpers>
State persists across `eval` calls. Python signatures below use keyword arguments. JavaScript uses one trailing options object and awaits async helpers; do not copy Python call syntax into JS.

- `workpool(agent=None, *, name=None, context=None{{#if evalTools}}, tools=None{{/if}})`: pool of keep-alive workers bounded by live `task.maxConcurrency`. `.push(*items)` returns item ids; each item goes to the least context-loaded idle worker, a new worker while capacity remains, or a busy worker's round-robin queue. `eval.workpool.freshAgents=true` instead spawns a new agent per item. `.status()` reports counts/workers; `.peek()` returns a non-consuming batch snapshot; `.close()` drops queued work.
  - JS: `const review = await workpool({ name, context{{#if evalTools}}, tools{{/if}} })`, or `await workpool(agentName, { name, context{{#if evalTools}}, tools{{/if}} })`; await `.push(...)`, `.status()`, `.peek()`, and `.close()`.
  - The pool name is its background job id and label. Push all items while it is active; its first full drain settles and closes that pool job. New phase/wave after drain → create a new named pool.
  - Results auto-deliver. Completely blocked? Leave `eval` and call `wait`; NEVER poll or block the kernel with `pool.wait()`.
- `agent(prompt, *, agent=None, label=None, schema=None, isolated=None, apply=None, merge=None{{#if evalTools}}, tools=None{{/if}})`: immediate `AgentHandle`; use for a small fixed dependency graph or when the parent needs validated `schema` data. `.wait()` returns text/data; `.handle` is `agent://<id>`. Unwaited results auto-deliver.
  - JS: `const handle = await agent(prompt, { agent, label, schema, isolated, apply, merge{{#if evalTools}}, tools{{/if}} })`; `await handle.wait()`.
- `completion(prompt, *, model="default", system=None, schema=None)`: immediate `CompletionHandle` for a tool-free one-shot call. Tiers: `"smol"`, `"default"`, `"slow"`.
  - JS: `const handle = completion(prompt, { model, system, schema })`; `await handle.wait()`.
- `await judge(state, questions)`: typed `choice`/`bool`/`score` questions over one state → `{id: answer}` with probabilities. Cheaper than `completion()` for classification.
- Batch judgment runs the same questions over many states on the host, outliving the cell. Python: `b = judge_batch(states, questions, concurrency=32, retries=1, min_ok=1, intent="Review")`. JavaScript: `const b = await judgeBatch(states, questions, { concurrency: 32, retries: 1, minOk: 1, intent: "Review" })`. `intent` is an optional nonempty progress/job label; default `"Judging"`.
  - Pull settled items in bounded slices: Python `await b.drain(timeout)` or `async for k, item in b.drain_iter(timeout)`; JS `await b.drain({ timeout })` or `for await (const [k, item] of b.drainIter({ timeout }))`.
  - Inspect `b.status()`, `b.results()`, `b.failed()`; release with `b.close()` — await these methods in JS. Item failures are `item.error`, never exceptions; `b.id` is a background job id and results auto-deliver. Completely blocked? Use the `wait` tool outside eval. NEVER loop `judge()` over a list.
- Ordered barrier for agent/completion handles: Python `wait(handles, timeout=None, raise_errors=True)`; JS `await wait(handles, { timeout, raiseErrors: true })`. Set `raise_errors=False` / `raiseErrors: false` to keep errors in result slots.
{{#if evalTools}}- `@tool` (Python) / `tool(fn, {…})` (JS): kernel-local tool exposed via `tools=`. Use for shared caches, dedup sets, scoring, or structured accumulation across pool workers; calls execute in YOUR kernel and a raised exception returns to the caller without killing it.
{{/if}}- `log(message)`: progress line. `phase(title)`: status-tree phase.
- `budget`: Python `budget.total` / `budget.spent()` / `budget.remaining()`; JS awaits them. User `+Nk` = advisory; `+Nk!` = hard.
</helpers>

<pool-workflow>
1. Scope the first useful wave: ownership, dependencies, and observable acceptance.
2. Create an explicitly named pool for the wave.
3. Push the currently known independent items together; later in-scope discoveries may be queued while the pool remains active.
4. Continue useful local work. Results auto-deliver.
5. Completely blocked? Leave `eval` and call `wait`; never poll or call `pool.wait()`.
6. Read every batch result; YOU verify and integrate.

**Python:**

```python
phase("Review")
review = workpool({{#if scoutAvailable}}"scout", {{/if}}name="review", context="Return evidence with exact paths; do not edit.")
review.push(*[
    "Review authentication correctness",
    "Review authorization boundaries",
    "Review cancellation and cleanup",
    "Review performance regressions",
])
print(review.name)   # background job id; results auto-deliver
```

**JavaScript:**

```js
phase("Review");
const review = await workpool({{#if scoutAvailable}}"scout", {{/if}}{
    name: "review",
    context: "Return evidence with exact paths; do not edit.",
});
await review.push(
    "Review authentication correctness",
    "Review authorization boundaries",
    "Review cancellation and cleanup",
    "Review performance regressions",
);
console.log(review.name); // background job id; results auto-deliver
```

Need a snapshot without consuming/delivering results? `review.peek()` (JS: `await review.peek()`). Need activity counts? `review.status()`.
</pool-workflow>

<dependencies>
Use handles only when work item B requires A's exact output before B can be written:

```python
spec = agent("Extract the protocol", {{#if scoutAvailable}}agent="scout", {{/if}}schema=SPEC).wait()
impl = agent(f"Implement this protocol: {spec}")
result = impl.wait()
```

```js
const specHandle = await agent("Extract the protocol", { {{#if scoutAvailable}}agent: "scout", {{/if}}schema: SPEC });
const spec = await specHandle.wait();
const impl = await agent(`Implement this protocol: ${JSON.stringify(spec)}`);
const result = await impl.wait();
```

Fixed independent handles are acceptable when each result must be returned directly into the kernel as structured data. Otherwise use a pool.
</dependencies>

<patterns>
- **Adversarial verify**: pool one REFUTE task per claim/lens; retain only evidence-backed survivors.
- **Perspective-diverse review**: distinct correctness/security/perf/reproduction items; NEVER clone one vague prompt.
- **Judge panel**: pool proposals, then a second named pool scores them after the first pool settles.
- **Further discovery**: push newly discovered in-scope items while the pool remains active; deduplicate completed and queued work.
- **Multi-modal sweep**: partition by container, content, entity, or time when these are independent dimensions of the request.
- **Coverage review**: compare results with the requested scope; use another review only when it can resolve a meaningful gap.
- **Sampling**: disclose sampling and its limits. If it would omit required outcomes, obtain agreement before narrowing the task.

Scale workers and review depth to the request, risk, and remaining uncertainty.
</patterns>

<execution>
- Multi-phase work: capture in `todo`.
- Each pool item: self-contained target, change/read scope, acceptance.
- Same-file mutation? One worker owns it; serialize shared boundaries.
- Evaluate pool output against source evidence and run the relevant integrated verification. Assign verification ownership to avoid shared-tree races or redundant checks.
- Continue through phase boundaries while useful authorized work remains. Preserve explicit approval and stopping conditions; report concrete blockers rather than treating a drained pool as completion.
</execution>
</system-notice>
