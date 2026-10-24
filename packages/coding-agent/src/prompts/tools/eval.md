One cell per call; {{#if js}}JS{{#if py}} and retained Python{{/if}}{{else}}retained Python{{/if}} kernels preserve top-level state, including across compaction.{{#if py}} `python.kernelMode='per-call'` starts fresh for every Python call; include required setup in every Python cell.{{/if}}{{#if spawns}} Subagents have separate kernels.{{/if}}
{{#if spawns}}{{#if eagerDelegation}}For 2+ independent items, use a named `workpool()`; results auto-deliver.{{#if waitTool}} If blocked, leave `eval` and call `wait`.{{/if}}{{/if}}{{/if}}
{{#if py}}Python: plain Python subprocess, not IPython (no `get_ipython()`, `obj?`, or `%matplotlib`). Magics like `%pip`, `%load`, `%time` and `!cmd` are rewritten to Python. Top-level `await` works; `asyncio.run(…)` fails.{{/if}}
{{#if js}}JS: Bun (`Bun.file`, `Bun.write`, `Bun.$`); top-level `await`/`return` work.{{/if}}
After an error, earlier steps may already have taken effect; if you rerun, rerun only what failed.
Printing an image{{#if py}} or figure{{/if}} attaches it.

<prelude>
{{#ifAll py js}}Python helpers: sync, kwargs; JS helpers: async, ONE trailing options object.{{else}}{{#if py}}Sync; kwargs.{{/if}}{{#if js}}Async; ONE trailing options object.{{/if}}{{/ifAll}}
```
print(value, ...)  log(message)  phase(title)
read(path, offset?, limit?)  write(path, content)  env(key?, value?)  output(*ids, format?, query?, offset?, limit?)
await tool.<name>(args) — session tool; `args` is its parameter object
wait(handles, timeout?=None, raise_errors?=True) — agent/completion barrier, ordered results{{#if js}}; JS: wait(handles, { timeout, raiseErrors }){{/if}}; `raise_errors=False` retains failures.
```
</prelude>

{{#if inlineTopics}}
{{{inlineTopics}}}
{{else}}
<namespaces>
More globals; `read` the linked docs before first use:
- `judge`, {{#ifAll py js}}`judge_batch` (Python) / `judgeBatch` (JS){{else}}`{{#if py}}judge_batch{{else}}judgeBatch{{/if}}`{{/ifAll}}, `completion`: classification, bulk judgment, model calls → `xd://eval/judge`
- `%load`{{#if py}}, `%pip`{{/if}}{{#if js}}, `%bun add`{{/if}}, `budget`{{#if evalTools}}, `@tool`/`tool(fn)`{{/if}}: setup, installs, utilities → `xd://eval/helpers`
{{#if spawns}}
- `agent`, `workpool`: background subagents, DAG waves → `xd://eval/agents`
{{/if}}
{{#each preludes}}
- `{{name}}`: {{summary}} → `xd://eval/{{name}}`
{{/each}}
</namespaces>
{{/if}}

<critical>
Persistent kernels: NEVER repeat successful setup. Kernel-loss notice means reload setup.
</critical>

{{#if autoBackgroundEnabled}}Long cells may auto-background and deliver later; the kernel stays busy. `timeout: 0` disables the cell deadline, not the foreground wait.{{/if}}
